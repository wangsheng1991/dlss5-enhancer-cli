/**
 * Everything that is a constant, and the only place an endpoint is written down.
 *
 * The client talks to the same public HTTP API the website uses — no private routes, no provider
 * keys. The Firebase web API key below ships in the site's own client bundle, so it is public by
 * design (it identifies the project; it grants nothing without an account). Override it if you run
 * the client against a different deployment.
 */
export const DEFAULT_BASE_URL = 'https://www.dlss5nvidia.com';
export const DEFAULT_FIREBASE_WEB_API_KEY = 'AIzaSyDqQX8vY6j52wH5E7vOU8xwrqj3wrfYWAs';

// Read at call time, not at import time: a caller that sets an environment variable after requiring
// the module (tests, wrappers, a CI step) must still get it honoured.
export const baseUrl = () => (process.env.DLSS5_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
export const firebaseKey = () => process.env.DLSS5_FIREBASE_KEY || DEFAULT_FIREBASE_WEB_API_KEY;
export const identityBase = () =>
  (process.env.DLSS5_IDENTITY_BASE || 'https://identitytoolkit.googleapis.com').replace(/\/$/, '');
export const secureTokenBase = () =>
  (process.env.DLSS5_TOKEN_BASE || 'https://securetoken.googleapis.com').replace(/\/$/, '');

/** Mirrors the server: 10 MiB per file, 1536 px output edge, factors 2 and 4. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_EDGE = 1536;
export const FACTORS = [2, 4];
/** The editor's own pixel ceiling, refused before a byte is uploaded. */
export const MAX_PIXELS = 16_000_000;

export const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

export const OUTPUT_FORMATS = ['webp', 'png', 'jpeg'];

/** A queued task can wait minutes on the provider's spare machines. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_POLL_MS = 2000;
