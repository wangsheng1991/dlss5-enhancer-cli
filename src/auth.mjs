/**
 * Credentials: sign in once with the account you use on the site, then keep a refresh token.
 *
 * Only the refresh token is stored (mode 0600). It is the same mechanism the website uses —
 * Firebase email/password auth — so no new server route is needed and nothing here is a private
 * back door. An account created with Google has no password, so it cannot be used from a terminal
 * until a password is set on it; `DLSS5_TOKEN` exists for callers that already hold a fresh ID
 * token (CI, scripts) and is never written to disk.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { firebaseKey, identityBase, secureTokenBase } from './config.mjs';

export const credentialPath = () =>
  process.env.DLSS5_CREDENTIALS ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dlss5-enhance', 'credentials.json');

const explain = (code) => {
  const map = {
    EMAIL_NOT_FOUND: 'No account with that email.',
    INVALID_PASSWORD: 'Wrong password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    USER_DISABLED: 'That account is disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes.'
  };
  return map[code] || code || 'Sign-in failed.';
};

async function identity(path, body) {
  const response = await fetch(`${identityBase()}/v1/accounts:${path}?key=${encodeURIComponent(firebaseKey())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(explain(code.split(' ')[0]));
  }
  return data;
}

export async function signIn(email, password) {
  const data = await identity('signInWithPassword', { email, password, returnSecureToken: true });
  const record = {
    email: data.email,
    uid: data.localId,
    refreshToken: data.refreshToken,
    idToken: data.idToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000
  };
  await saveCredentials(record);
  return record;
}

export async function saveCredentials(record) {
  const file = credentialPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function readCredentials() {
  try {
    return JSON.parse(await readFile(credentialPath(), 'utf8'));
  } catch {
    return null;
  }
}

async function refresh(record) {
  const response = await fetch(`${secureTokenBase()}/v1/token?key=${encodeURIComponent(firebaseKey())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('The saved session expired. Run `dlss5-enhance login` again.');
  return {
    ...record,
    idToken: data.id_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
}

/** A usable ID token: `DLSS5_TOKEN` wins, then a cached one, then a refresh. */
export async function getToken({ force = false } = {}) {
  if (process.env.DLSS5_TOKEN) return process.env.DLSS5_TOKEN;
  const record = await readCredentials();
  if (!record?.refreshToken) {
    throw new Error('Not signed in. Run `dlss5-enhance login` first (or set DLSS5_TOKEN).');
  }
  if (!force && record.idToken && record.expiresAt - Date.now() > 60_000) return record.idToken;
  const next = await refresh(record);
  await saveCredentials(next);
  return next.idToken;
}
