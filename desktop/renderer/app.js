/**
 * The window's own logic. It renders a queue, forwards settings, and paints the events the shared
 * engine emits — no network call, no filesystem, no token lives here.
 */
const bridge = window.dlss5;

const $ = (selector) => document.querySelector(selector);
const el = {
  account: $('#account'),
  signinOpen: $('#signin-open'),
  signout: $('#signout'),
  drop: $('#drop'),
  pick: $('#pick'),
  factor: $('#factor'),
  format: $('#format'),
  out: $('#out'),
  pickOut: $('#pick-out'),
  clearOut: $('#clear-out'),
  concurrency: $('#concurrency'),
  force: $('#force'),
  run: $('#run'),
  rows: $('#rows'),
  empty: $('#empty'),
  summary: $('#summary-line'),
  clearQueue: $('#clear-queue'),
  site: $('#site'),
  auth: $('#auth'),
  authForm: $('#auth-form'),
  authTitle: $('#auth-title'),
  authEmail: $('#auth-email'),
  authPassword: $('#auth-password'),
  authError: $('#auth-error'),
  authSwitch: $('#auth-switch'),
  authSubmit: $('#auth-submit'),
  authCancel: $('#auth-cancel'),
  credPath: $('#cred-path'),
  compare: $('#compare'),
  compareTitle: $('#compare-title'),
  compareBefore: $('#compare-before'),
  compareAfter: $('#compare-after'),
  compareClose: $('#compare-close')
};

const state = {
  order: [],
  rows: new Map(),
  nodes: new Map(),
  options: { factor: 2, format: 'webp', out: '', concurrency: 1, force: false },
  account: { signedIn: false, email: null, credits: null },
  running: false,
  mode: 'login',
  startedAt: 0,
  finishedAt: 0
};

const mediaUrl = (path) => `dlss5file://media/?path=${encodeURIComponent(path)}`;
const baseName = (path) => path.split(/[\\/]/).pop();
const extensions = ['jpg', 'jpeg', 'png', 'webp'];
const isImage = (path) => extensions.includes((path.split('.').pop() || '').toLowerCase());
const humanBytes = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(bytes > 10 * 1048576 ? 0 : 1)} MiB`;
};

function optionsPayload() {
  return {
    factor: Number(el.factor.value),
    format: el.format.value,
    out: state.options.out,
    concurrency: Number(el.concurrency.value),
    force: el.force.checked
  };
}

function rowFor(path) {
  if (!state.rows.has(path)) {
    state.rows.set(path, {
      path,
      name: baseName(path),
      status: 'queued',
      progress: 0,
      out: '',
      error: '',
      bytes: null,
      width: null,
      height: null,
      targetWidth: null,
      targetHeight: null,
      clamped: false,
      exists: false,
      phase: '',
      format: el.format.value
    });
    state.order.push(path);
  }
  return state.rows.get(path);
}

/** Patch one row in place — a running batch emits several updates a second per file. */
function paint(row) {
  const node = state.nodes.get(row.path);
  if (!node) return;
  const { name, sub, track, fill, pill, compare, reveal } = node;

  name.textContent = row.name;
  name.title = row.path;

  let text = '';
  let tone = '';
  if (row.error) {
    text = row.error;
    tone = 'bad';
  } else if (row.targetWidth) {
    const from = row.width && row.height ? `${row.width} × ${row.height} → ` : '';
    const scale = row.clamped ? ' · capped at 1536 px' : '';
    text = `${from}${row.targetWidth} × ${row.targetHeight}${scale} · ${row.format === 'jpeg' ? 'jpg' : row.format}${row.bytes ? ` · ${humanBytes(row.bytes)} in` : ''}`;
  } else if (row.bytes) {
    text = humanBytes(row.bytes);
  }
  if (!row.error && row.exists && row.status === 'queued') text += ' · already saved, will be skipped';
  sub.textContent = text;
  sub.className = `sub${tone ? ` ${tone}` : ''}`;

  const percent = row.status === 'done' || row.status === 'skip' || row.status === 'fail' ? 100 : row.progress;
  fill.style.width = `${percent}%`;
  track.className = `track${row.status === 'done' ? ' done' : row.status === 'fail' ? ' fail' : row.status === 'skip' ? ' skip' : ''}`;
  track.style.visibility = row.status === 'queued' ? 'hidden' : 'visible';

  const labels = {
    queued: 'queued',
    running: row.phase === 'submitted' ? 'in queue' : row.phase === 'downloading' ? 'downloading' : `${row.progress}%`,
    done: 'done',
    skip: 'skipped',
    fail: 'failed'
  };
  pill.textContent = labels[row.status] || row.status;
  pill.className = `pill${row.status === 'running' ? ' running wait' : ''}${row.status === 'done' ? ' done' : ''}${row.status === 'skip' ? ' skip' : ''}${row.status === 'fail' ? ' fail' : ''}`;

  compare.disabled = !row.out || !(row.status === 'done' || row.status === 'skip');
  reveal.disabled = !row.out;
  reveal.hidden = !row.out;
}

function buildRow(row) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.path = row.path;
  li.innerHTML = `
    <div class="thumb"><img alt="" loading="lazy"></div>
    <div class="meta">
      <div class="name"></div>
      <div class="sub"></div>
      <div class="track"><i></i></div>
    </div>
    <div class="state"><span class="pill">queued</span></div>
    <div class="actions">
      <button type="button" class="btn small ghost" data-act="compare" disabled>Compare</button>
      <button type="button" class="btn small" data-act="reveal" hidden>Show</button>
    </div>`;

  const nodes = {
    li,
    name: li.querySelector('.name'),
    sub: li.querySelector('.sub'),
    track: li.querySelector('.track'),
    fill: li.querySelector('.track i'),
    pill: li.querySelector('.pill'),
    compare: li.querySelector('[data-act="compare"]'),
    reveal: li.querySelector('[data-act="reveal"]'),
    thumb: li.querySelector('.thumb img')
  };
  nodes.thumb.src = mediaUrl(row.thumbPath || row.path);
  nodes.thumb.addEventListener('error', () => {
    nodes.thumb.remove();
    nodes.li.querySelector('.thumb').textContent = 'n/a';
  });
  nodes.compare.addEventListener('click', () => openCompare(row));
  nodes.reveal.addEventListener('click', () => bridge.reveal(state.rows.get(row.path)?.out));
  state.nodes.set(row.path, nodes);
  return li;
}

function renderQueue() {
  state.nodes.clear();
  el.rows.textContent = '';
  for (const path of state.order) {
    const row = state.rows.get(path);
    el.rows.append(buildRow(row));
    paint(row);
  }
  el.empty.hidden = state.order.length > 0;
  refreshRunButton();
}

function refreshRunButton() {
  const pending = state.order.length;
  el.run.textContent = state.running ? 'Running…' : pending ? `Enhance ${pending} file${pending === 1 ? '' : 's'}` : 'Enhance';
  el.run.disabled = state.running || pending === 0 || !state.account.signedIn;
  el.run.title = !state.account.signedIn && pending ? 'Sign in first — every image is one credit on your account' : '';
}

function setSummary(text) {
  el.summary.textContent = text;
}

async function addFiles(paths) {
  const known = new Set(state.order);
  let added = 0;
  for (const path of paths) {
    if (!path || known.has(path) || !isImage(path)) continue;
    known.add(path);
    rowFor(path);
    added += 1;
  }
  if (!added) {
    setSummary(`${paths.length} item${paths.length === 1 ? '' : 's'} ignored — only jpg, png and webp files are read.`);
    return;
  }
  renderQueue();
  setSummary(`Reading ${added} file${added === 1 ? '' : 's'}…`);
  await reinspect();
}

/** Ask the main process for dimensions and the capped target, so nothing promises the impossible. */
let inspectToken = 0;
async function reinspect() {
  const mine = ++inspectToken;
  const payload = optionsPayload();
  const files = [...state.order];
  if (!files.length) return;
  const checked = await bridge.inspect(files, payload).catch((error) => {
    setSummary(`Could not read the queue: ${error.message}`);
    return [];
  });
  if (mine !== inspectToken) return;
  for (const item of checked) {
    const row = state.rows.get(item.file);
    if (!row) continue;
    row.width = item.width;
    row.height = item.height;
    row.targetWidth = item.targetWidth;
    row.targetHeight = item.targetHeight;
    row.clamped = item.clamped;
    row.exists = item.exists;
    row.bytes = item.bytes;
    row.format = payload.format;
    if (item.error && row.status === 'queued') {
      row.error = item.error;
      row.status = 'fail';
    }
    if (!item.error && row.status === 'fail' && !row.error) row.status = 'queued';
    paint(row);
  }
  const ready = [...state.rows.values()].filter((row) => row.targetWidth).length;
  if (!state.running) setSummary(`${ready} of ${state.order.length} ready to send · ${state.account.signedIn ? `${state.account.credits ?? '?'} credits on the account` : 'sign in to use your credits'}.`);
  refreshRunButton();
}

async function runBatch() {
  if (state.running || !state.account.signedIn) return;
  const files = [...state.order];
  state.running = true;
  state.startedAt = Date.now();
  for (const path of files) {
    const row = state.rows.get(path);
    row.status = 'queued';
    row.progress = 0;
    row.out = '';
    row.error = '';
    row.phase = '';
    paint(row);
  }
  refreshRunButton();
  setSummary(`Sending ${files.length} file${files.length === 1 ? '' : 's'}…`);

  try {
    const result = await bridge.start(files, optionsPayload());
    state.lastResult = result;
    state.finishedAt = Date.now();
    if (result.credits != null) state.account.credits = result.credits;
    const seconds = Math.max(1, Math.round((state.finishedAt - state.startedAt) / 1000));
    const done = result.rows.filter((row) => row.ok && !row.skipped).length;
    const skipped = result.rows.filter((row) => row.skipped).length;
    setSummary(
      `${done} enhanced${skipped ? `, ${skipped} skipped` : ''}${result.failed ? `, ${result.failed} failed` : ''} in ${seconds}s · ${state.account.credits ?? '?'} credits left`
    );
    await publishAccount();
  } catch (error) {
    setSummary(`Stopped: ${error.message}`);
  } finally {
    state.running = false;
    refreshRunButton();
  }
}

function openCompare(row) {
  if (!row.out) return;
  el.compareTitle.textContent = baseName(row.path);
  el.compareBefore.src = mediaUrl(row.path);
  el.compareAfter.src = `${mediaUrl(row.out)}&v=${Date.now()}`;
  el.compare.showModal();
}

async function publishAccount(next) {
  if (next) state.account = next;
  const { signedIn, email, credits, credentials } = state.account;
  el.account.textContent = '';
  if (signedIn) {
    const who = document.createElement('span');
    who.append('Signed in as ');
    const strong = document.createElement('b');
    strong.textContent = email || 'this machine';
    who.append(strong, credits == null ? '' : ` · ${credits} credits`);
    el.account.append(who);
  } else {
    el.account.textContent = 'Not signed in';
  }
  el.signinOpen.hidden = Boolean(signedIn);
  el.signout.hidden = !signedIn;
  el.credPath.textContent = credentials || '';
  refreshRunButton();
}

async function refreshAccount() {
  await publishAccount(await bridge.status().catch(() => ({ signedIn: false, email: null, credits: null })));
}

function openAuth(mode) {
  state.mode = mode;
  el.authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create an account';
  el.authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  el.authSwitch.textContent = mode === 'login' ? 'Create an account' : 'I already have one';
  el.authError.hidden = true;
  el.authPassword.value = '';
  el.auth.showModal();
  el.authEmail.focus();
}

async function submitAuth(event) {
  event.preventDefault();
  const email = el.authEmail.value.trim();
  const password = el.authPassword.value;
  if (!email || !password) return;
  el.authSubmit.disabled = true;
  el.authError.hidden = true;
  try {
    const next = state.mode === 'login' ? await bridge.login(email, password) : await bridge.register(email, password);
    el.authPassword.value = '';
    el.auth.close();
    await publishAccount(next);
    setSummary(`Signed in as ${next.email} · ${next.credits ?? '?'} credits`);
  } catch (error) {
    el.authError.textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    el.authError.hidden = false;
  } finally {
    el.authSubmit.disabled = false;
  }
}

/* ---------- wiring ---------- */
el.pick.addEventListener('click', async () => addFiles(await bridge.pickFiles()));
el.pickOut.addEventListener('click', async () => {
  const dir = await bridge.pickOutDir();
  if (!dir) return;
  state.options.out = dir;
  el.out.value = dir;
  await reinspect();
});
el.clearOut.addEventListener('click', async () => {
  state.options.out = '';
  el.out.value = '';
  await reinspect();
});
for (const control of [el.factor, el.format]) control.addEventListener('change', reinspect);
el.force.addEventListener('change', reinspect);
el.run.addEventListener('click', runBatch);
el.clearQueue.addEventListener('click', () => {
  if (state.running) return;
  state.order = [];
  state.rows.clear();
  renderQueue();
  setSummary('No run yet.');
});
el.site.addEventListener('click', () => bridge.openSite());
el.signinOpen.addEventListener('click', () => openAuth('login'));
el.signout.addEventListener('click', async () => {
  await bridge.logout();
  await refreshAccount();
  setSummary('Signed out. Files already enhanced stay where they are.');
});
el.authForm.addEventListener('submit', submitAuth);
el.authSwitch.addEventListener('click', () => openAuth(state.mode === 'login' ? 'register' : 'login'));
el.authCancel.addEventListener('click', () => el.auth.close());
el.compareClose.addEventListener('click', () => el.compare.close());

for (const type of ['dragover', 'dragenter']) {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    el.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'dragend']) {
  window.addEventListener(type, () => el.drop.classList.remove('over'));
}
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  el.drop.classList.remove('over');
  const paths = [...(event.dataTransfer?.files || [])].map((file) => bridge.pathForFile(file)).filter(Boolean);
  await addFiles(paths);
});

const eventLog = [];
bridge.onEvent((payload) => {
  eventLog.push(`${payload.type}:${payload.phase || ''}:${(payload.row && payload.row.status) || ''}:${(payload.file || '').split('/').pop()}`);
  // `start`/`progress` carry the path; `done` carries the finished row, path included there.
  const row = state.rows.get(payload.file || payload.row?.file);
  if (!row) return;
  if (payload.type === 'start') {
    row.status = 'running';
    row.progress = 0;
    row.phase = 'uploading';
  } else if (payload.type === 'progress') {
    row.phase = payload.phase;
    if (payload.phase === 'running') row.progress = Math.max(row.progress, Math.round(Number(payload.progress) || 0));
    else if (payload.phase === 'submitted') row.progress = 5;
    else if (payload.phase === 'downloading') row.progress = 95;
  } else if (payload.type === 'done') {
    const finished = payload.row || {};
    row.out = finished.out || '';
    row.error = finished.error || '';
    row.status = finished.ok ? (finished.skipped ? 'skip' : 'done') : 'fail';
    row.progress = 100;
    if (row.out && (row.status === 'done' || row.status === 'skip')) {
      state.nodes.get(row.path)?.thumb?.setAttribute('src', `${mediaUrl(row.out)}&v=${Date.now()}`);
    }
  }
  paint(row);
});

/* A small hook so a headless smoke run can drive the real page and read the real result back. */
window.__dlss5Test = {
  addFiles,
  register: async (email, password) => {
    state.mode = 'register';
    el.authEmail.value = email;
    el.authPassword.value = password;
    if (!el.auth.open) el.auth.showModal();
    await submitAuth({ preventDefault() {} });
    return { signedIn: state.account.signedIn, email: state.account.email, credits: state.account.credits };
  },
  run: () => runBatch(),
  /** Wait until no row is in flight — used by the end-to-end smoke to read a settled queue. */
  wait: async (limitMs = 180000) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline && [...state.rows.values()].some((row) => row.status === 'running' || row.status === 'queued')) {
      await new Promise((done) => setTimeout(done, 500));
    }
    return el.summary.textContent;
  },
  events: () => eventLog.slice(),
  lastResult: () => state.lastResult || null,
  rows: () =>
    [...state.rows.values()].map(({ path, status, out, error, width, height, targetWidth, targetHeight }) => ({
      path,
      status,
      out,
      error,
      width,
      height,
      targetWidth,
      targetHeight
    })),
  openCompare: (name) => {
    const row = [...state.rows.values()].find((candidate) => candidate.name === name);
    if (row) openCompare(row);
    return Boolean(row);
  },
  demo: (source, { auth = false } = {}) => {
    state.order = [];
    state.rows.clear();
    const spec = [
      { name: 'night-drive.jpg', status: 'running', progress: 62, phase: 'running', width: 4032, height: 3024, targetWidth: 1536, targetHeight: 1152, clamped: true, bytes: 5400000, format: 'webp', thumbPath: source },
      { name: 'portrait.png', status: 'done', progress: 100, width: 1200, height: 1600, targetWidth: 1152, targetHeight: 1536, bytes: 902144, format: 'webp', out: source, thumbPath: source },
      { name: 'old-shot.webp', status: 'skip', progress: 100, width: 1600, height: 900, targetWidth: 1536, targetHeight: 864, bytes: 700416, exists: true, format: 'webp', out: source, thumbPath: source },
      { name: 'corrupt.png', status: 'fail', progress: 100, error: 'Could not read the image size (not a JPEG, PNG or WebP?)', thumbPath: source }
    ];
    for (const item of spec) {
      const path = `/demo/${item.name}`;
      Object.assign(rowFor(path), item, { path });
    }
    renderQueue();
    setSummary('3 of 4 done, 1 failed in 19s · 9 credits left');
    if (auth) {
      state.account = { signedIn: true, email: 'you@example.com', credits: 9, credentials: '~/.config/dlss5-enhance/credentials.json' };
      publishAccount();
      openAuth('login');
    }
    return true;
  },
  selfTest: () => ({
    title: document.title,
    bridge: Object.keys(window.dlss5 || {}).length,
    rows: el.rows.children.length,
    firstRow: el.rows.querySelector('.row .sub')?.textContent || '',
    firstPill: el.rows.querySelector('.pill')?.textContent || '',
    thumb: el.rows.querySelector('.thumb img')?.getAttribute('src') || '',
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    background: getComputedStyle(document.body).backgroundColor,
    authClosed: !el.auth.open,
    runLabel: el.run.textContent,
    signInVisible: !el.signinOpen.hidden,
    account: el.account.textContent,
    cssRules: document.styleSheets.length
  })
};

refreshAccount();
setSummary('No run yet.');
