// The window and the terminal share this engine, so it is tested on its own — no Electron, no
// network, a local stand-in for the four API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESULT_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function startMock() {
  const calls = { uploads: 0, submits: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    for await (const _chunk of req) void _chunk;
    if (url.pathname === '/api/image-edit/upload') {
      calls.uploads += 1;
      return json(200, { upload_url: `http://127.0.0.1:${server.address().port}/put/abc`, headers: { 'Content-Type': 'image/png' }, file_id: 'file-1' });
    }
    if (url.pathname === '/put/abc') {
      res.writeHead(200);
      return res.end('ok');
    }
    if (url.pathname === '/api/image-edit/jobs') {
      calls.submits += 1;
      return json(202, { jobId: 'job-1', status: 'QUEUED' });
    }
    if (url.pathname === '/api/image-edit/jobs/job-1') {
      calls.polls = (calls.polls || 0) + 1;
      return json(200, calls.polls < 2 ? { jobId: 'job-1', status: 'RUNNING', progress: 60 } : { jobId: 'job-1', status: 'SUCCEEDED' });
    }
    if (url.pathname === '/api/image-edit/results/job-1') {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      return res.end(RESULT_BYTES);
    }
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

function png(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

const settings = (over = {}) => ({ factor: 2, format: 'webp', out: '', seed: 42, steps: 4, timeoutMin: 1, concurrency: 1, force: false, dryRun: false, ...over });

test('one start and one done per file, and a broken file does not stop the batch', async () => {
  const { server, calls, port } = await startMock();
  process.env.DLSS5_BASE_URL = `http://127.0.0.1:${port}`;
  const { runBatch } = await import(`../src/batch.mjs?t=${Math.random()}`);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-batch-'));
    const good = join(dir, 'good.png');
    const broken = join(dir, 'broken.png');
    await writeFile(good, png(800, 600));
    await writeFile(broken, Buffer.from('not an image at all'));

    const events = [];
    const rows = await runBatch([good, broken], settings(), { token: 'token-1', onEvent: (event) => events.push(event) });

    assert.deepEqual(events.filter((event) => event.type === 'start').map((event) => event.file).sort(), [good, broken].sort());
    assert.equal(events.filter((event) => event.type === 'done').length, 2);

    const byFile = Object.fromEntries(rows.map((row) => [row.file, row]));
    assert.equal(byFile[good].ok, true);
    assert.equal(byFile[good].width, 1536, 'the 1536 px edge decides the plan');
    assert.match(byFile[good].out, /good-enhanced\.webp$/);
    assert.equal(byFile[broken].ok, false);
    assert.match(byFile[broken].error, /Could not read the image size/);
    assert.equal(calls.uploads, 1, 'the broken file is refused before upload');
  } finally {
    server.close();
  }
});

test('a second run over a finished folder skips without uploading again', async () => {
  const { server, calls, port } = await startMock();
  process.env.DLSS5_BASE_URL = `http://127.0.0.1:${port}`;
  const { runBatch } = await import(`../src/batch.mjs?t=${Math.random()}`);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-skip-'));
    const source = join(dir, 'shot.png');
    await writeFile(source, png(1000, 800));

    await runBatch([source], settings(), { token: 'token-1' });
    const uploadsAfterFirst = calls.uploads;
    const rows = await runBatch([source], settings(), { token: 'token-1' });

    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].skipped, true);
    assert.equal(calls.uploads, uploadsAfterFirst, 'nothing is uploaded for a file whose output exists');

    const forced = await runBatch([source], settings({ force: true }), { token: 'token-1' });
    assert.equal(forced[0].skipped, false);
    assert.equal(calls.uploads, uploadsAfterFirst + 1);
  } finally {
    server.close();
  }
});

test('progress events carry the phases the window paints', async () => {
  const { server, port } = await startMock();
  process.env.DLSS5_BASE_URL = `http://127.0.0.1:${port}`;
  const { runBatch } = await import(`../src/batch.mjs?t=${Math.random()}`);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-phases-'));
    const source = join(dir, 'phase.png');
    await writeFile(source, png(640, 480));
    const phases = [];
    await runBatch([source], settings(), {
      token: 'token-1',
      onEvent: (event) => {
        if (event.type === 'progress') phases.push(event.phase);
      }
    });
    assert.ok(phases.includes('submitted'));
    assert.ok(phases.includes('running'));
    assert.ok(phases.includes('downloading'));
  } finally {
    server.close();
  }
});

test('the idempotency key follows the upload, not the bytes', async () => {
  const { idempotencyKey } = await import('../src/batch.mjs');
  const settings = { factor: 2, format: 'webp', seed: 42, steps: 4 };
  const key = idempotencyKey('uid-1', 'file-1', settings);
  assert.equal(key.length, 64);
  assert.equal(key, idempotencyKey('uid-1', 'file-1', settings), 'a retry of the same submission replays');
  assert.notEqual(key, idempotencyKey('uid-1', 'file-2', settings), 'a new upload is a new operation');
  assert.notEqual(key, idempotencyKey('uid-2', 'file-1', settings), 'the same picture for another account is its own operation');
  assert.notEqual(key, idempotencyKey('uid-1', 'file-1', { ...settings, seed: 43 }));
  assert.notEqual(key, idempotencyKey('uid-1', 'file-1', { ...settings, factor: 4 }));
});
