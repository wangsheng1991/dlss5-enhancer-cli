import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Drive the shipped renderer's real handlers with an offline DOM/IPC fixture.
const source = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
async function renderer() {
  const nodes = new Map();
  const node = () => ({
    textContent: '', value: '', hidden: false, disabled: false,
    listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    append() {},
  });
  let account = { signedIn: false, credits: null };
  const bridge = { status: async () => account, onEvent() {}, pickFiles: async () => [] };
  const context = vm.createContext({
    window: { dlss5: bridge, addEventListener() {} },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      createElement: node,
    },
    setTimeout,
  });
  vm.runInContext(source, context);
  const evaluate = code => vm.runInContext(code, context);
  await evaluate('refreshAccount()');
  return { nodes, evaluate, setAccount(next) { account = next; } };
}

test('canceling the native file picker preserves the previous run summary', async () => {
  const app = await renderer();
  app.nodes.get('#summary-line').textContent = '3 enhanced in 45s · 7 credits left';
  await app.nodes.get('#pick').listeners.get('click')();
  assert.equal(app.nodes.get('#summary-line').textContent, '3 enhanced in 45s · 7 credits left');
  assert.equal(app.evaluate('state.order.length'), 0);
});

test('restoring an account refreshes a queued file summary and enables the action', async () => {
  const app = await renderer();
  app.evaluate("state.order.push('C:/photos/a.png'); state.rows.set('C:/photos/a.png', {targetWidth: 1024});");
  app.nodes.get('#summary-line').textContent = '1 of 1 ready to send · sign in to use your credits.';
  app.setAccount({ signedIn: true, email: 'test@example.com', credits: 7 });
  await app.evaluate('refreshAccount()');
  assert.equal(app.nodes.get('#summary-line').textContent, '1 of 1 ready to send · 7 credits on the account.');
  assert.equal(app.nodes.get('#signin-open').hidden, true);
  assert.equal(app.nodes.get('#run').disabled, false);
});

test('account refresh preserves the completed batch result summary', async () => {
  const app = await renderer();
  app.evaluate("state.order.push('C:/photos/a.png'); state.rows.set('C:/photos/a.png', {targetWidth: 1024}); state.lastResult = {failed: 0};");
  app.nodes.get('#summary-line').textContent = '1 enhanced in 14s · 7 credits left';
  app.setAccount({ signedIn: true, credits: 7 });
  await app.evaluate('refreshAccount()');
  assert.equal(app.nodes.get('#summary-line').textContent, '1 enhanced in 14s · 7 credits left');
});

test('account refresh does not overwrite live batch progress', async () => {
  const app = await renderer();
  app.evaluate("state.order.push('C:/photos/a.png'); state.rows.set('C:/photos/a.png', {targetWidth: 1024}); state.running = true;");
  app.nodes.get('#summary-line').textContent = 'Sending 1 file…';
  app.setAccount({ signedIn: true, credits: 7 });
  await app.evaluate('refreshAccount()');
  assert.equal(app.nodes.get('#summary-line').textContent, 'Sending 1 file…');
});
