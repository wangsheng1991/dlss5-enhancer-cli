/**
 * The window. It is a thin shell around the same engine the terminal uses: `src/batch.mjs` decides
 * what happens to a file, this file only moves bytes between that engine and the page.
 *
 * Nothing here talks to a provider, holds a model, or stores a password. The session is the same
 * refresh token in the same 0600 file the CLI writes, so signing in either place signs in both.
 */
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTENT_TYPES, DEFAULT_JOB_TIMEOUT_MS, FACTORS, OUTPUT_FORMATS } from '../src/config.mjs';
import { accountScope, credentialPath, getToken, readCredentials, register as createAccount, signIn } from '../src/auth.mjs';
import { account, bootstrap } from '../src/api.mjs';
import { inspect, runBatch } from '../src/batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
/** `--shot=<file>` writes one PNG of the real window; used to look at the thing, not just its logs. */
const shotPath = process.argv.find((argument) => argument.startsWith('--shot='))?.slice('--shot='.length) || '';
/** `--demo` paints fabricated rows so a screenshot can show the states without an account. */
const demo = process.argv.includes('--demo');
/** `--e2e` signs a throwaway account up and pushes one real image through the window's own UI. */
const e2e = process.argv.includes('--e2e');
const e2eFile = process.argv.find((argument) => argument.startsWith('--file='))?.slice('--file='.length) || '';

// `dlss5file://` serves a picture the user picked, and nothing else. The page needs it because a
// `file://` page cannot read arbitrary paths under the sandbox, and a data URL of a 12 MP photo
// would be megabytes per row.
protocol.registerSchemesAsPrivileged([
  { scheme: 'dlss5file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const optionsFrom = (raw = {}) => ({
  factor: FACTORS.includes(Number(raw.factor)) ? Number(raw.factor) : 2,
  format: OUTPUT_FORMATS.includes(raw.format) ? raw.format : 'webp',
  out: raw.out ? resolve(String(raw.out)) : '',
  force: Boolean(raw.force),
  concurrency: Math.min(4, Math.max(1, Number(raw.concurrency) || 1)),
  seed: 42,
  steps: 4,
  timeoutMin: DEFAULT_JOB_TIMEOUT_MS / 60000,
  dryRun: false
});

async function accountState() {
  const record = await readCredentials();
  if (!record?.refreshToken && !process.env.DLSS5_TOKEN) {
    return { signedIn: false, email: null, credits: null, credentials: credentialPath(), version: app.getVersion() };
  }
  const me = await getToken()
    .then((token) => account(token))
    .catch(() => null);
  return {
    signedIn: Boolean(me || record?.refreshToken || process.env.DLSS5_TOKEN),
    email: record?.email || null,
    credits: me?.credits ?? null,
    tier: me?.tier ?? null,
    credentials: credentialPath(),
    version: app.getVersion()
  };
}

function registerHandlers() {
  ipcMain.handle('app:status', () => accountState());

  ipcMain.handle('auth:login', async (_event, { email, password }) => {
    const record = await signIn(String(email || '').trim(), String(password || ''));
    await bootstrap(record.idToken).catch(() => null);
    return accountState();
  });

  ipcMain.handle('auth:register', async (_event, { email, password }) => {
    const record = await createAccount(String(email || '').trim(), String(password || ''));
    await bootstrap(record.idToken).catch(() => null);
    return accountState();
  });

  ipcMain.handle('auth:logout', async () => {
    const file = credentialPath();
    await writeFile(file, '{}', { mode: 0o600 });
    return accountState();
  });

  ipcMain.handle('dialog:files', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(window, {
      title: 'Choose images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: [...new Set(Object.keys(CONTENT_TYPES))] }]
    });
    return picked.canceled ? [] : picked.filePaths;
  });

  ipcMain.handle('dialog:outdir', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(window, { title: 'Where should results go?', properties: ['openDirectory', 'createDirectory'] });
    return picked.canceled ? '' : picked.filePaths[0];
  });

  /**
   * The plan, before a credit is spent: dimensions, the capped target size, whether an output is
   * already there. The window calls this whenever files are added or the factor changes, so the
   * list never promises something the run will refuse.
   */
  ipcMain.handle('files:inspect', async (_event, { files = [], options } = {}) => {
    const settings = optionsFrom(options);
    const rows = [];
    for (const file of files.slice(0, 500)) {
      const checked = await inspect(file, settings).catch((error) => ({ file, error: error.message }));
      rows.push({
        file: checked.file,
        error: checked.error || null,
        bytes: checked.buffer?.length ?? null,
        width: checked.dims?.width ?? null,
        height: checked.dims?.height ?? null,
        target: checked.target ?? null,
        targetWidth: checked.plan?.width ?? null,
        targetHeight: checked.plan?.height ?? null,
        clamped: checked.plan?.clamped ?? false,
        exists: Boolean(checked.exists)
      });
    }
    return rows;
  });

  ipcMain.handle('batch:start', async (event, { files = [], options } = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const settings = optionsFrom(options);
    const token = await getToken();
    await bootstrap(token).catch(() => null);
    settings.accountId = await accountScope(token);
    const rows = await runBatch(files, settings, {
      token,
      onEvent: (payload) => {
        if (!window.isDestroyed()) window.webContents.send('batch:event', payload);
      }
    });
    const me = await account(token).catch(() => null);
    return { rows, credits: me?.credits ?? null, failed: rows.filter((row) => !row.ok).length };
  });

  ipcMain.handle('shell:reveal', (_event, path) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path);
  });

  ipcMain.handle('shell:site', () => shell.openExternal('https://www.dlss5nvidia.com/visual-enhancer'));
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0b0b0c',
    title: 'DLSS5 Enhance',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => window.show());
  await window.loadFile(join(here, 'renderer', 'index.html'));
  return window;
}

async function runSmoke(window, shot = '') {
  const problems = [];
  window.webContents.on('console-message', (event) => {
    const level = event.level ?? event.params?.level;
    const message = event.message ?? event.params?.message;
    if (level === 'error' || level === 3) problems.push(`console: ${message}`);
  });
  window.webContents.on('preload-error', (_event, path, error) => problems.push(`preload ${path}: ${error.message}`));

  const dir = await mkdtemp(join(tmpdir(), 'dlss5-smoke-'));
  const source = join(dir, 'smoke.png');
  // A real 2×2 PNG, so the renderer's preview pipeline is exercised with bytes, not a placeholder.
  await writeFile(
    source,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxAADEA0kBgYAj0oDAYtBsFoAAAAASUVORK5CYII=', 'base64')
  );

  const report = e2e ? null : await window.webContents
    .executeJavaScript(`window.__dlss5Test.addFiles(${JSON.stringify([source])}).then(() => window.__dlss5Test.selfTest())`)
    .catch((error) => ({ error: error.message }));

  if (e2e) {
    if (!e2eFile) problems.push('renderer: --e2e needs --file=<an image>');
    else {
      // A copy, so a run never writes its result into a source tree that happens to be a repo.
      const workFile = join(await mkdtemp(join(tmpdir(), 'dlss5-e2e-')), e2eFile.split('/').pop());
      await copyFile(e2eFile, workFile);
      const email = `desktop-smoke-${Date.now()}@example.com`;
      const outcome = await window.webContents
        .executeJavaScript(
          `(async () => {
             const account = await window.__dlss5Test.register(${JSON.stringify(email)}, 'desktop-smoke-2026');
             await window.__dlss5Test.addFiles([${JSON.stringify(workFile)}]);
             await window.__dlss5Test.run();
             const summary = await window.__dlss5Test.wait();
             const compared = window.__dlss5Test.openCompare('${workFile.split('/').pop()}');
             return { account, summary, compared, events: window.__dlss5Test.events(), rows: window.__dlss5Test.rows(), last: window.__dlss5Test.lastResult() };
           })()`
        )
        .catch((error) => ({ error: error.message }));
      console.log(`E2E ${JSON.stringify(outcome)}`);
      if (outcome?.error) problems.push(`renderer: ${outcome.error}`);
      const row = outcome?.rows?.[0];
      if (!row || row.status !== 'done') problems.push(`result: ${row ? row.status + ' ' + row.error : 'no row'}`);
    }
  }

  if (demo) {
    const showAuth = process.argv.includes('--auth');
    await window.webContents.executeJavaScript(
      `window.__dlss5Test.demo(${JSON.stringify(source)}, { auth: ${showAuth} })`,
      false
    );
  }
  if (report?.error) problems.push(`renderer: ${report.error}`);
  console.log(`SMOKE ${JSON.stringify(report)}`);

  if (shot) {
    // A window that was not painting can hand back the previous frame, so take the picture twice and
    // keep the second one. No requestAnimationFrame here: it never fires for an unfocused window.
    window.show();
    window.focus();
    await new Promise((done) => setTimeout(done, 900));
    await window.webContents.capturePage();
    await new Promise((done) => setTimeout(done, 500));
    const image = await window.webContents.capturePage();
    await writeFile(shot, image.toPNG());
    console.log(`SHOT ${shot}`);
  }
  // Only after the picture: the demo rows point their thumbnails at this file.
  await rm(dir, { recursive: true, force: true });
  return problems;
}

app.whenReady().then(async () => {
  app.setName('DLSS5 Enhance');
  protocol.handle('dlss5file', (request) => {
    const path = new URL(request.url).searchParams.get('path');
    if (!path) return new Response('missing path', { status: 400 });
    // A missing file is a 404, not a thrown request: a row whose source vanished must not spray
    // errors into the log.
    return net.fetch(pathToFileURL(path).toString()).catch(() => new Response('not found', { status: 404 }));
  });

  registerHandlers();
  const window = await createWindow();

  if (smoke) {
    const problems = await runSmoke(window, shotPath);
    if (problems.length) console.log(`SMOKE FAIL ${problems.join(' | ')}`);
    app.exit(problems.length ? 1 : 0);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || smoke) app.quit();
});
