/**
 * The command surface. Kept deliberately small: log in, look up who you are, enhance files,
 * log out. `--dry-run` never touches the network, so the geometry and the file checks can be
 * inspected before a single credit is spent.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { planOutput, readDimensions } from './geometry.mjs';
import { CONTENT_TYPES, DEFAULT_JOB_TIMEOUT_MS, FACTORS, MAX_PIXELS, OUTPUT_FORMATS } from './config.mjs';
import { credentialPath, getToken, readCredentials, register as createAccount, signIn } from './auth.mjs';
import { bootstrap, downloadResult, submitEnhance, upload, waitForJob, whoami } from './api.mjs';

const USAGE = `dlss5-enhance — batch-enhance images from your own machine

  dlss5-enhance login [--email <email>] [--password-stdin]
  dlss5-enhance register [--email <email>] --password-stdin
  dlss5-enhance whoami
  dlss5-enhance enhance <file|dir ...> [options]
  dlss5-enhance logout

enhance options
  --factor <2|4>      target scale (default 2; the 1536 px edge caps it)
  --out <dir>         write results here (default: next to each source)
  --format <f>        webp (default) | png | jpeg
  --seed <n>          default 42
  --steps <n>         inference steps (default 4)
  --force             re-run files whose output already exists
  --dry-run           print what would happen; no network, no credits
  --compare           also write a side-by-side HTML next to each result
  --json              machine-readable summary on stdout
  --concurrency <n>   files in flight (default 1)
  --timeout <min>     per-file wait (default 10)

  Credentials live in ${credentialPath()} — a refresh token, mode 0600.
  Environment: DLSS5_TOKEN (skip the login file), DLSS5_BASE_URL, DLSS5_CREDENTIALS.
`;

function parseArgs(argv) {
  const options = {
    factor: 2,
    out: '',
    format: 'webp',
    seed: 42,
    steps: 4,
    force: false,
    dryRun: false,
    compare: false,
    json: false,
    concurrency: 1,
    timeoutMin: DEFAULT_JOB_TIMEOUT_MS / 60000,
    email: '',
    passwordStdin: false
  };
  const files = [];
  const takesValue = new Set(['factor', 'out', 'format', 'seed', 'steps', 'concurrency', 'timeout', 'email']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      files.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=');
    const value = inline ?? argv[i + 1];
    if (name === 'factor' || name === 'seed' || name === 'steps' || name === 'concurrency' || name === 'timeout' || name === 'out' || name === 'format' || name === 'email') {
      if (inline === undefined) i += 1;
      if (takesValue.has(name) && (value === undefined || value.startsWith('--'))) {
        throw new Error(`--${name} needs a value`);
      }
    }
    if (name === 'factor') options.factor = Number(value);
    else if (name === 'out') options.out = value;
    else if (name === 'format') options.format = value;
    else if (name === 'seed') options.seed = Number(value);
    else if (name === 'steps') options.steps = Number(value);
    else if (name === 'concurrency') options.concurrency = Math.max(1, Number(value));
    else if (name === 'timeout') options.timeoutMin = Number(value);
    else if (name === 'email') options.email = value;
    else if (name === 'force') options.force = true;
    else if (name === 'dry-run') options.dryRun = true;
    else if (name === 'compare') options.compare = true;
    else if (name === 'json') options.json = true;
    else if (name === 'password-stdin') options.passwordStdin = true;
    else if (name === 'help') options.help = true;
    else throw new Error(`Unknown option --${name}`);
  }
  return { options, files };
}

const isImage = (file) => Object.hasOwn(CONTENT_TYPES, extname(file).slice(1).toLowerCase());

async function collectFiles(inputs) {
  const found = [];
  for (const input of inputs) {
    const absolute = resolve(input);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`No such file or directory: ${input}`);
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !isImage(entry.name)) continue;
        if (/-(enhanced|compare)\.(png|jpe?g|webp|html)$/i.test(entry.name)) continue;
        found.push(join(absolute, entry.name));
      }
    } else if (isImage(absolute)) {
      found.push(absolute);
    } else {
      throw new Error(`Not a supported image: ${input} (jpeg, png, webp only)`);
    }
  }
  return [...new Set(found)];
}

/** Stable across retries: the same bytes with the same settings is the same job. */
const idempotencyKey = (buffer, { factor, format, seed, steps }) =>
  createHash('sha256').update(buffer).update(`|${factor}|${format}|${seed}|${steps}`).digest('hex').slice(0, 64);

async function readPassword(options) {
  if (process.env.DLSS5_PASSWORD) return process.env.DLSS5_PASSWORD.trim();
  if (!options.passwordStdin) {
    throw new Error('Pass the password on stdin: `echo "$PASS" | dlss5-enhance login --password-stdin` (or set DLSS5_PASSWORD).');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (!value) throw new Error('Empty password.');
  return value;
}

async function login(options) {
  const email = options.email || process.env.DLSS5_EMAIL;
  if (!email) throw new Error('Give the account email: --email you@example.com');
  const record = await signIn(email, await readPassword(options));
  const account = await bootstrap(record.idToken).catch(() => null);
  console.log(`Signed in as ${record.email}. Credentials: ${credentialPath()}`);
  if (account) console.log(`Account: ${account.tier || 'free'} · ${account.credits} credits${account.bonusCredits ? ` (+${account.bonusCredits} bonus)` : ''}`);
}

async function register(options) {
  const email = options.email || process.env.DLSS5_EMAIL;
  if (!email) throw new Error('Give the email to register: --email you@example.com');
  const record = await createAccount(email, await readPassword(options));
  const account = await bootstrap(record.idToken).catch(() => null);
  console.log(`Created ${record.email} and signed in.${account ? ` Credits: ${account.credits}.` : ''}`);
}

async function logout() {
  const record = await readCredentials();
  if (!record) {
    console.log('No saved session.');
    return;
  }
  await writeFile(credentialPath(), '{}', { mode: 0o600 });
  console.log('Signed out locally. The site account is unchanged.');
}

async function whoamiCommand(options) {
  const token = await getToken();
  const me = await whoami(token).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  const record = await readCredentials();
  if (options.json) {
    console.log(JSON.stringify({ email: record?.email || null, me }, null, 2));
    return;
  }
  console.log(record?.email ? `Account: ${record.email}` : 'Account: token from DLSS5_TOKEN');
  if (me) console.log(`Server says: ${JSON.stringify(me)}`);
}

async function enhance(files, options) {
  if (!FACTORS.includes(options.factor)) throw new Error('--factor must be 2 or 4');
  if (!OUTPUT_FORMATS.includes(options.format)) throw new Error('--format must be webp, png or jpeg');
  const sources = await collectFiles(files);
  if (sources.length === 0) throw new Error('No images found in the given paths.');

  const summary = [];
  const token = options.dryRun ? null : await getToken();
  if (token) await bootstrap(token).catch(() => null);

  const runOne = async (file) => {
    const buffer = await readFile(file);
    const dims = readDimensions(buffer);
    const row = { file, ok: false, error: null, out: null, width: null, height: null };
    if (!dims) {
      row.error = 'Could not read the image size (not a JPEG, PNG or WebP?)';
      return row;
    }
    if (dims.width * dims.height > MAX_PIXELS) {
      row.error = `${dims.width} × ${dims.height} (${Math.round((dims.width * dims.height) / 1e6)} MP) is over the 16 MP ceiling; shrink it first.`;
      return row;
    }
    const plan = planOutput(dims.width, dims.height, options.factor);
    const dir = options.out ? resolve(options.out) : dirname(file);
    const stem = basename(file, extname(file));
    // The output name is decided before the call, from the format we asked for, so a rerun can skip
    // a file it already paid for — and `--dry-run` can print the real path.
    const target = join(dir, `${stem}-enhanced.${options.format === 'jpeg' ? 'jpg' : options.format}`);
    const existing = options.force ? null : await stat(target).catch(() => null);
    row.width = plan.width;
    row.height = plan.height;

    if (options.dryRun) {
      row.ok = true;
      row.out = target;
      row.note = plan.clamped ? `factor ${options.factor} clamped to ${plan.factor} by the 1536 px edge` : `factor ${plan.factor}`;
      return row;
    }
    if (existing) {
      row.ok = true;
      row.skipped = true;
      row.out = target;
      return row;
    }

    const fileId = await upload(token, {
      buffer,
      fileName: basename(file),
      contentType: CONTENT_TYPES[extname(file).slice(1).toLowerCase()],
      width: dims.width,
      height: dims.height
    });
    const accepted = await submitEnhance(token, {
      fileId,
      width: dims.width,
      height: dims.height,
      factor: options.factor,
      seed: options.seed,
      steps: options.steps,
      format: options.format,
      idempotencyKey: idempotencyKey(buffer, options)
    });
    const state = await waitForJob(token, accepted.jobId, {
      timeoutMs: options.timeoutMin * 60 * 1000
    });
    if (state.status !== 'SUCCEEDED') {
      row.error = state.error || 'The job failed.';
      return row;
    }
    const result = await downloadResult(token, accepted.jobId, state);
    const outputPath = target;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.buffer);
    row.ok = true;
    row.out = outputPath;
    row.contentType = result.contentType;
    row.bytes = result.buffer.length;
    if (options.compare) {
      row.compare = await writeCompare(outputPath, file, stem);
    }
    return row;
  };

  const queue = [...sources];
  const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      let row;
      try {
        row = await runOne(file);
      } catch (error) {
        row = { file, ok: false, error: error.message };
      }
      summary.push(row);
      if (!options.json) {
        const label = row.ok ? (row.skipped ? 'skip ' : 'ok   ') : 'FAIL ';
        const target = row.out ? ` → ${row.out}` : '';
        const detail = row.error ? ` — ${row.error}` : row.width ? ` (${row.width} × ${row.height})` : '';
        console.log(`${label}${basename(file)}${target}${detail}`);
      }
    }
  });
  await Promise.all(workers);

  const failed = summary.filter((row) => !row.ok);
  if (options.json) {
    console.log(JSON.stringify({ dryRun: options.dryRun, total: summary.length, failed: failed.length, results: summary }, null, 2));
  } else {
    console.log(`\n${summary.length - failed.length}/${summary.length} done${failed.length ? `, ${failed.length} failed` : ''}.`);
  }
  return failed.length === 0 ? 0 : 1;
}

async function writeCompare(resultPath, sourcePath, stem) {
  const html = `<!doctype html><meta charset="utf-8"><title>${stem} — before / after</title>
<style>body{margin:0;background:#0b0b0c;color:#e5e5e5;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}figure{margin:0}img{width:100%;height:auto;display:block;border-radius:8px}
figcaption{padding:8px 2px;color:#9ca3af}</style>
<main><figure><img src="file://${sourcePath}" alt="before"><figcaption>before — ${basename(sourcePath)}</figcaption></figure>
<figure><img src="file://${resultPath}" alt="after"><figcaption>after — ${basename(resultPath)}</figcaption></figure></main>`;
  const target = join(dirname(resultPath), `${stem}-compare.html`);
  await writeFile(target, html);
  return target;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === 'help') {
      console.log(USAGE);
      return 0;
    }
    const { options, files } = parseArgs(rest);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
    if (command === 'login') return await login(options), 0;
    if (command === 'register') return await register(options), 0;
    if (command === 'logout') return await logout(), 0;
    if (command === 'whoami') return await whoamiCommand(options), 0;
    if (command === 'enhance') return await enhance(files, options);
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    return 2;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 2;
  }
}
