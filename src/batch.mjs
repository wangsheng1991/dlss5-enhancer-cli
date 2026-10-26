/**
 * The batch engine, shared by the command line and the desktop window.
 *
 * It owns exactly one thing: take a list of files, and for each one either skip it because the
 * output already exists, refuse it because it cannot be measured, or run the real flow and write
 * the result. Everything a caller sees is an event, so the terminal can print a line and the window
 * can move a row — the same code, no second implementation to drift.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { planOutput, readDimensions } from './geometry.mjs';
import { CONTENT_TYPES, MAX_PIXELS } from './config.mjs';
import { downloadResult, submitEnhance, upload, waitForJob } from './api.mjs';

export const outputName = (file, { format = 'webp', out = '' } = {}) => {
  const stem = basename(file, extname(file));
  const dir = out ? out : dirname(file);
  return join(dir, `${stem}-enhanced.${format === 'jpeg' ? 'jpg' : format}`);
};

/** Everything that can be decided without spending a credit. */
export async function inspect(file, options) {
  const buffer = await readFile(file);
  const dims = readDimensions(buffer);
  if (!dims) {
    return { file, buffer, error: 'Could not read the image size (not a JPEG, PNG or WebP?)' };
  }
  if (dims.width * dims.height > MAX_PIXELS) {
    const mp = Math.round((dims.width * dims.height) / 1e6);
    return { file, buffer, dims, error: `${dims.width} × ${dims.height} (${mp} MP) is over the 16 MP ceiling; shrink it first.` };
  }
  const plan = planOutput(dims.width, dims.height, options.factor);
  const target = outputName(file, options);
  const exists = options.force ? null : await stat(target).catch(() => null);
  return { file, buffer, dims, plan, target, exists: Boolean(exists) };
}

/**
 * One key per (account, upload, settings). The provider keeps keys forever and refuses a key whose
 * body changed with 409 — and every upload has a new file id, so a key derived from the bytes alone
 * would collide on the second run of the same picture. A retry of *this* submission reuses the same
 * upload, hence the same key, so the protection still holds where it is needed.
 */
export const idempotencyKey = (scope, fileId, { factor, format, seed, steps }) =>
  createHash('sha256')
    .update(`${scope}|${fileId}|${factor}|${format}|${seed}|${steps}`)
    .digest('hex')
    .slice(0, 64);

/**
 * Run one file to completion. Never throws for a per-file problem: the failure comes back on the
 * returned row so a batch of fifty keeps going past a broken file.
 */
export async function runOne(file, options, token, onProgress = () => {}) {
  const row = { file, ok: false, error: null, out: null, width: null, height: null, skipped: false };
  let inspected;
  try {
    inspected = await inspect(file, options);
  } catch (error) {
    row.error = error.message;
    return row;
  }
  if (inspected.error) {
    row.error = inspected.error;
    return row;
  }
  const { buffer, dims, plan, target } = inspected;
  row.width = plan.width;
  row.height = plan.height;
  row.clamped = plan.clamped;
  row.target = target;

  if (options.dryRun) {
    row.ok = true;
    row.out = target;
    return row;
  }
  if (inspected.exists) {
    row.ok = true;
    row.out = target;
    row.skipped = true;
    return row;
  }

  try {
    const fileId = await upload(token, {
      buffer,
      fileName: basename(file),
      contentType: CONTENT_TYPES[extname(file).slice(1).toLowerCase()],
      width: dims.width,
      height: dims.height
    });
    onProgress({ file, phase: 'submitted' });
    const accepted = await submitEnhance(token, {
      fileId,
      width: dims.width,
      height: dims.height,
      factor: options.factor,
      seed: options.seed,
      steps: options.steps,
      format: options.format,
      idempotencyKey: idempotencyKey(options.accountId || '', fileId, options)
    });
    const state = await waitForJob(token, accepted.jobId, {
      timeoutMs: options.timeoutMin * 60 * 1000,
      onTick: (tick) => onProgress({ file, phase: 'running', status: tick.status, progress: tick.progress })
    });
    if (state.status !== 'SUCCEEDED') {
      row.error = state.error || 'The job failed.';
      return row;
    }
    onProgress({ file, phase: 'downloading' });
    const result = await downloadResult(token, accepted.jobId, state);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, result.buffer);
    row.ok = true;
    row.out = target;
    row.bytes = result.buffer.length;
    row.contentType = result.contentType;
    return row;
  } catch (error) {
    row.error = error.message;
    return row;
  }
}

/** Run every file, at most `concurrency` at a time, reporting each outcome as it lands. */
export async function runBatch(files, options, { token, onEvent = () => {} } = {}) {
  const rows = [];
  const queue = [...files];
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, queue.length)) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      onEvent({ type: 'start', file });
      const row = await runOne(file, options, token, (progress) => onEvent({ type: 'progress', ...progress }));
      rows.push(row);
      onEvent({ type: 'done', row });
    }
  });
  await Promise.all(workers);
  return rows;
}
