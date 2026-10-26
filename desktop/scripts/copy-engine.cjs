/**
 * The window imports the engine from `desktop/src`, and `desktop/src` is generated from the
 * repository's `src/` — never edited, never committed (`desktop/src/` is git-ignored). A packaged app
 * cannot import from outside its own directory, so the copy is what the dmg carries; running it
 * before every start is what keeps a development window from testing yesterday's engine.
 *
 * Same files, byte for byte, from the one source of truth.
 */
const { cp, rm } = require('node:fs/promises');
const { join } = require('node:path');

const from = join(__dirname, '..', '..', 'src');
const to = join(__dirname, '..', 'src');

async function syncEngine() {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  return { from, to };
}

exports.default = syncEngine;

if (require.main === module) {
  syncEngine().then(({ from: source, to: target }) => console.log(`engine: ${source} -> ${target}`));
}
