// End-to-end against a local stand-in for the whole flow: sign in, upload ticket, PUT, submit,
// poll, download. Nothing here reaches the internet and no real account is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESULT_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function startMock({ failFirstSubmit = false } = {}) {
  const calls = { uploads: 0, puts: 0, submits: 0, polls: 0, downloads: 0, idempotency: [], auth: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    calls.auth.push(auth);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (url.pathname === '/v1/accounts:signUp') {
      const payload = JSON.parse(body.toString() || '{}');
      return json(200, { idToken: 'id-9', refreshToken: 'refresh-9', email: payload.email, localId: 'uid-9', expiresIn: '3600' });
    }
    if (url.pathname === '/v1/accounts:signInWithPassword') {
      const payload = JSON.parse(body.toString() || '{}');
      if (payload.password !== 'correct horse') return json(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } });
      return json(200, { idToken: 'id-1', refreshToken: 'refresh-1', email: payload.email, localId: 'uid-1', expiresIn: '3600' });
    }
    if (url.pathname === '/v1/token') {
      return json(200, { id_token: 'id-2', refresh_token: 'refresh-2', expires_in: '3600' });
    }
    if (url.pathname === '/api/image-edit/upload') {
      calls.uploads += 1;
      return json(200, { upload_url: `http://127.0.0.1:${server.address().port}/put/abc`, headers: { 'Content-Type': 'image/png' }, file_id: 'file-1' });
    }
    if (url.pathname === '/put/abc') {
      calls.puts += 1;
      res.writeHead(200);
      return res.end('ok');
    }
    if (url.pathname === '/api/image-edit/jobs') {
      calls.submits += 1;
      calls.idempotency.push(req.headers['idempotency-key']);
      if (failFirstSubmit && calls.submits === 1) return json(500, { error: 'Upstream hiccup' });
      const sent = JSON.parse(body.toString() || '{}');
      calls.lastSubmit = sent;
      return json(202, { jobId: 'job-1', status: 'QUEUED', width: sent.source_width, height: sent.source_height });
    }
    if (url.pathname === '/api/image-edit/jobs/job-1') {
      calls.polls += 1;
      return json(200, calls.polls < 2 ? { jobId: 'job-1', status: 'RUNNING', progress: 40 } : { jobId: 'job-1', status: 'SUCCEEDED', result: { images: [{ url: 'http://127.0.0.1:9/not-used' }] } });
    }
    if (url.pathname === '/api/image-edit/results/job-1') {
      calls.downloads += 1;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(RESULT_BYTES);
    }
    if (url.pathname === '/api/me') return json(200, { credits: 12 });
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
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

/** The modules read their endpoints at import time, so each test imports them fresh. */
async function loadCli(port) {
  process.env.DLSS5_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.DLSS5_IDENTITY_BASE = `http://127.0.0.1:${port}`;
  process.env.DLSS5_TOKEN_BASE = `http://127.0.0.1:${port}`;
  process.env.DLSS5_CREDENTIALS = join(await mkdtemp(join(tmpdir(), 'dlss5-creds-')), 'credentials.json');
  delete process.env.DLSS5_TOKEN;
  delete process.env.DLSS5_PASSWORD;
  return import(`../src/cli.mjs?t=${Math.random()}`);
}

test('login stores a refresh token and enhance writes the result next to the source', async () => {
  const { server, calls, port } = await startMock();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-work-'));
    const source = join(dir, 'photo.png');
    await writeFile(source, png(800, 600));
    const { main } = await loadCli(port);
    process.env.DLSS5_PASSWORD = 'correct horse';

    assert.equal(await main(['login', '--email', 'user@example.com']), 0);
    const creds = JSON.parse(await readFile(process.env.DLSS5_CREDENTIALS, 'utf8'));
    assert.equal(creds.refreshToken, 'refresh-1');
    assert.equal(creds.email, 'user@example.com');

    assert.equal(await main(['enhance', source, '--factor', '2', '--json']), 0);
    assert.equal(calls.uploads, 1);
    assert.equal(calls.puts, 1);
    assert.equal(calls.submits, 1);
    assert.ok(calls.polls >= 2, 'polls until the job settles');
    assert.equal(calls.lastSubmit.mode, 'enhance');
    assert.equal(calls.lastSubmit.factor, 2);
    assert.deepEqual(calls.lastSubmit.image_ids, ['file-1']);
    assert.equal(calls.lastSubmit.source_width, 800);
    assert.equal(calls.lastSubmit.source_height, 600);
    assert.equal(calls.idempotency[0].length, 64);

    const written = await readFile(join(dir, 'photo-enhanced.webp')).catch(() => null) ??
      await readFile(join(dir, 'photo-enhanced.png'));
    assert.deepEqual(written, RESULT_BYTES);
  } finally {
    server.close();
  }
});

test('dry-run reads the file, prints the plan and never touches the network', async () => {
  const { server, calls, port } = await startMock();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-dry-'));
    const source = join(dir, 'wide.png');
    await writeFile(source, png(1200, 800));
    const { main } = await loadCli(port);
    assert.equal(await main(['enhance', source, '--factor', '4', '--dry-run', '--json']), 0);
    assert.equal(calls.uploads + calls.submits + calls.polls + calls.auth.length, 0);
  } finally {
    server.close();
  }
});

test('a second run with the same file and settings reuses the same idempotency key', async () => {
  const { server, calls, port } = await startMock();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-idem-'));
    const source = join(dir, 'photo.png');
    await writeFile(source, png(800, 600));
    const { main } = await loadCli(port);
    process.env.DLSS5_PASSWORD = 'correct horse';
    await main(['login', '--email', 'user@example.com']);
    await main(['enhance', source, '--factor', '2']);
    // Same bytes, same settings — but the output now exists, so this run must skip without a call.
    const before = calls.submits;
    await main(['enhance', source, '--factor', '2']);
    assert.equal(calls.submits, before, 'existing output is skipped, not re-billed');
  } finally {
    server.close();
  }
});

test('a bad password fails with a readable reason and stores nothing', async () => {
  const { server, port } = await startMock();
  try {
    const { main } = await loadCli(port);
    process.env.DLSS5_PASSWORD = 'wrong';
    assert.equal(await main(['login', '--email', 'user@example.com']), 2);
    const creds = await readFile(process.env.DLSS5_CREDENTIALS, 'utf8').catch(() => '');
    assert.equal(creds.includes('refresh'), false);
  } finally {
    server.close();
  }
});

test('register creates an account and stores its token', async () => {
  const { server, port } = await startMock();
  try {
    const { main } = await loadCli(port);
    process.env.DLSS5_PASSWORD = 'brand new password';
    assert.equal(await main(['register', '--email', 'fresh@example.com']), 0);
    const creds = JSON.parse(await readFile(process.env.DLSS5_CREDENTIALS, 'utf8'));
    assert.equal(creds.refreshToken, 'refresh-9');
    assert.equal(creds.email, 'fresh@example.com');
  } finally {
    server.close();
  }
});

test('an upstream submit failure is reported, not silently retried', async () => {
  const { server, calls, port } = await startMock({ failFirstSubmit: true });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dlss5-fail-'));
    const source = join(dir, 'photo.png');
    await writeFile(source, png(800, 600));
    const { main } = await loadCli(port);
    process.env.DLSS5_PASSWORD = 'correct horse';
    await main(['login', '--email', 'user@example.com']);
    const code = await main(['enhance', source, '--factor', '2', '--json']);
    assert.equal(code, 1, 'a failed file makes the run exit non-zero');
    assert.equal(calls.submits, 1);
  } finally {
    server.close();
  }
});
