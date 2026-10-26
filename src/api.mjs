/**
 * The four calls the site makes, in the same order, with the same fields:
 *   POST /api/image-edit/upload   → { upload_url, headers, file_id }
 *   PUT  <upload_url>             → the bytes
 *   POST /api/image-edit/jobs     → { jobId, status }        (Idempotency-Key required)
 *   GET  /api/image-edit/jobs/:id → { status, progress, result }
 *   GET  /api/image-edit/results/:id → the bytes (durable copy, survives the provider's link)
 */
import { MAX_UPLOAD_BYTES, baseUrl } from './config.mjs';

async function call(path, token, { method = 'GET', body, headers = {}, timeout = 60000 } = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body,
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const whoami = (token) => call('/api/me', token);

/**
 * The website creates the profile (and the signup credits) on first signed-in load. A command-line
 * client has no page load, so it has to ask: without this the API answers "Account is not initialized".
 */
export const bootstrap = (token) => call('/api/me/bootstrap', token, { method: 'POST' });

/** Upload one picture and return its file id. */
export async function upload(token, { buffer, fileName, contentType, width, height }) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`That file is ${(buffer.length / 1048576).toFixed(1)} MiB; the ceiling is 10 MiB.`), { code: 'TOO_LARGE' });
  }
  const ticket = await call('/api/image-edit/upload', token, {
    method: 'POST',
    body: JSON.stringify({ fileName, contentType, size: buffer.length, width, height, model: 'flux-klein' })
  });
  const put = await fetch(ticket.upload_url, {
    method: 'PUT',
    headers: ticket.headers || {},
    body: buffer,
    signal: AbortSignal.timeout(120000)
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status}). Nothing was submitted.`);
  return ticket.file_id;
}

export async function submitEnhance(token, { fileId, width, height, factor, seed = 42, steps = 4, format = 'webp', idempotencyKey }) {
  const data = await call('/api/image-edit/jobs', token, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      mode: 'enhance',
      image_ids: [fileId],
      factor,
      source_width: width,
      source_height: height,
      seed,
      num_inference_steps: steps,
      output_format: format
    })
  });
  return data; // { jobId, status, width, height }
}

export const jobStatus = (token, jobId) => call(`/api/image-edit/jobs/${encodeURIComponent(jobId)}`, token);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the job settles, or give up at the deadline. */
export async function waitForJob(token, jobId, { pollMs = 2000, timeoutMs = 10 * 60 * 1000, onTick = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await jobStatus(token, jobId);
    onTick(state);
    if (state.status === 'SUCCEEDED' || state.status === 'FAILED') return state;
    if (Date.now() > deadline) {
      throw Object.assign(new Error(`Still ${state.status} after ${Math.round(timeoutMs / 60000)} min. The job keeps running on the server; check the site's history later.`), { code: 'TIMEOUT' });
    }
    await sleep(pollMs);
  }
}

/** The result bytes, from the stored copy when it exists and the provider link when it does not. */
export async function downloadResult(token, jobId, state) {
  const response = await fetch(`${baseUrl()}/api/image-edit/results/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000)
  });
  if (response.ok) {
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'application/octet-stream'
    };
  }
  const url = state?.result?.images?.[0]?.url;
  if (!url) throw new Error('The job succeeded but no result came back.');
  const direct = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!direct.ok) throw new Error(`Could not fetch the result (${direct.status}).`);
  return {
    buffer: Buffer.from(await direct.arrayBuffer()),
    contentType: direct.headers.get('content-type') || 'application/octet-stream'
  };
}
