import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlockHandler } from '../background.js';

function fixture(overrides = {}) {
  const events = [];
  let nextId = 100;
  const tabs = new Map();
  const api = {
    runtime: { id: 'test-extension' },
    tabs: {
      async create(options) {
        events.push(['create', options]);
        const tab = { id: nextId++, url: options.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async get(id) { return tabs.get(id); },
      async remove(id) { events.push(['remove', id]); tabs.delete(id); }
    },
    scripting: {
      async executeScript(options) {
        events.push(['execute', options.args[0]]);
        return [{ result: { ok: true } }];
      },
      ...overrides
    }
  };
  const sender = {
    id: api.runtime.id, frameId: 0,
    url: 'https://x.com/i/lists/123/members',
    tab: { id: 7, windowId: 1 }
  };
  return { api, sender, events, request: createBlockHandler(api) };
}

test('opens an inactive profile, injects only in that tab, then closes it', async () => {
  const { request, sender, events } = fixture();
  assert.deepEqual(await request({ handle: 'Alice' }, sender), { ok: true });
  assert.deepEqual(events, [
    ['create', { url: 'https://x.com/Alice', active: false, windowId: 1, openerTabId: 7 }],
    ['execute', 'Alice'], ['remove', 100]
  ]);
});

test('rejects malformed handles, other sites, subframes, and other extensions', async () => {
  const { request, sender, events } = fixture();
  for (const handle of ['', '../alice', 'a/b', 'alice?x', 'a'.repeat(16), null]) {
    assert.equal((await request({ handle }, sender)).ok, false);
  }
  for (const patch of [
    { url: 'https://example.com/' }, { url: 'http://x.com/alice' },
    { frameId: 1 }, { id: 'another-extension' }, { tab: null }
  ]) {
    assert.equal((await request({ handle: 'alice' }, { ...sender, ...patch })).ok, false);
  }
  assert.deepEqual(events, []);
});

test('deduplicates rapid clicks on the same account and serializes other accounts', async () => {
  let release;
  const { request, sender, events } = fixture({
    async executeScript({ args }) {
      events.push(['execute', args[0]]);
      if (args[0] === 'alice') await new Promise((resolve) => { release = resolve; });
      return [{ result: { ok: true } }];
    }
  });
  const first = request({ handle: 'alice' }, sender);
  const duplicate = request({ handle: 'ALICE' }, sender);
  const second = request({ handle: 'bob' }, sender);
  assert.equal(first, duplicate);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter(([type]) => type === 'create').length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events.map(([type]) => type), [
    'create', 'execute', 'remove', 'create', 'execute', 'remove'
  ]);
});

test('a failure closes the temporary tab and does not stop the next block', async () => {
  let attempts = 0;
  const { request, sender, events } = fixture({
    async executeScript() {
      if (++attempts === 1) throw new Error('Page closed');
      return [{ result: { ok: true } }];
    }
  });
  const [failed, next] = await Promise.all([
    request({ handle: 'alice' }, sender), request({ handle: 'bob' }, sender)
  ]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Page closed/);
  assert.equal(next.ok, true);
  assert.equal(events.filter(([type]) => type === 'remove').length, 2);
});

test('never injects when X redirects to sign-in or another account', async () => {
  const { request, sender, api, events } = fixture();
  api.tabs.get = async () => ({ status: 'complete', url: 'https://x.com/i/flow/login' });
  const result = await request({ handle: 'alice' }, sender);
  assert.equal(result.ok, false);
  assert.deepEqual(events.map(([type]) => type), ['create', 'remove']);
});

test('missing script results are errors, not successful blocks', async () => {
  const { request, sender } = fixture({ async executeScript() { return []; } });
  assert.equal((await request({ handle: 'alice' }, sender)).ok, false);
});
