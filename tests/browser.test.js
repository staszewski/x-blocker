import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { blockProfile } from '../block-profile.js';
import { startBrowser } from './browser-helper.js';

const script = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../content.css', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await startBrowser(); });
after(async () => { await browser?.close(); });

function row(handle, action = 'follow') {
  return `<div data-testid="UserCell" style="display:flex;gap:16px;margin:20px">
    <a href="/${handle}"><span data-testid="UserAvatar-Container-${handle}">Avatar</span></a>
    <div><a href="/${handle}">Display name</a><br><a href="/${handle}">@${handle}</a>
    <p>My bio mentions <a href="/someone_else">@someone_else</a></p></div>
    <div><button data-testid="123-${action}">${action === 'unblock' ? 'Blocked' : 'Follow'}</button></div>
  </div>`;
}
async function contentPage(html) {
  const page = await browser.page(`<style>${css}</style>${html}`);
  await page.evaluate(`window.calls = []; window.reply = { ok: true };
    window.chrome = { runtime: { sendMessage: async (message) => {
      window.calls.push(message);
      if (window.pause) return new Promise((resolve) => { window.finish = resolve; });
      return window.reply;
    } } };`);
  await page.evaluate(script);
  return page;
}

test('adds one button beside Follow, ignores bio handles and already blocked rows', async () => {
  const page = await contentPage(row('Alice') + row('bob', 'unfollow') + row('claude', 'unblock'));
  try {
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.xob-block')].map(b => ({
      handle: b.dataset.handle, previous: b.previousElementSibling.dataset.testid, label: b.textContent
    }))`), [
      { handle: 'Alice', previous: '123-follow', label: 'Block' },
      { handle: 'bob', previous: '123-unfollow', label: 'Block' }
    ]);
    await page.evaluate(script);
    assert.equal(await page.evaluate(`document.querySelectorAll('.xob-block').length`), 2);
  } finally { await page.close(); }
});

test('one trusted click sends exactly the displayed handle and waits for confirmation', async () => {
  const page = await contentPage(row('Alice'));
  try {
    await page.evaluate('window.pause = true');
    await page.click('.xob-block');
    await page.wait(`document.querySelector('.xob-block').textContent === 'Blocking…'`);
    assert.deepEqual(await page.evaluate('window.calls'), [{ type: 'XOB_BLOCK', handle: 'Alice' }]);
    assert.equal(await page.evaluate(`document.querySelector('.xob-block').disabled`), true);
    await page.evaluate('window.finish({ ok: true })');
    await page.wait(`document.querySelector('.xob-block').textContent === 'Blocked'`);
    assert.match(await page.evaluate(`document.querySelector('#xob-notice').textContent`), /Blocked @Alice/);
  } finally { await page.close(); }
});

test('synthetic page clicks cannot initiate a block', async () => {
  const page = await contentPage(row('alice'));
  try {
    await page.evaluate(`document.querySelector('.xob-block').click()`);
    assert.deepEqual(await page.evaluate('window.calls'), []);
  } finally { await page.close(); }
});

test('incomplete rows and bio-only handles never get a Block button', async () => {
  const page = await contentPage(`<div data-testid="UserCell">
    <p>Working with <a href="/someone_else">@someone_else</a></p>
    <button data-testid="123-follow">Follow</button></div>`);
  try {
    assert.equal(await page.evaluate(`document.querySelector('.xob-block')`), null);
    await page.evaluate(`document.querySelector('[data-testid="UserCell"]').insertAdjacentHTML('afterbegin',
      '<a href="/alice"><span data-testid="UserAvatar-Container-alice">Avatar</span></a>')`);
    // Even after the avatar loads, a bio mention must not identify the row.
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    assert.equal(await page.evaluate(`document.querySelector('.xob-block')`), null);
    await page.evaluate(`document.querySelector('[data-testid="UserCell"]').insertAdjacentHTML('afterbegin',
      '<a href="/alice">@alice</a>')`);
    await page.wait(`document.querySelector('.xob-block')?.dataset.handle === 'alice'`);
  } finally { await page.close(); }
});

test('errors display Retry and allow a later successful click', async () => {
  const page = await contentPage(row('alice'));
  try {
    await page.evaluate(`window.reply = { ok: false, error: 'X did not confirm the block' }`);
    await page.click('.xob-block');
    await page.wait(`document.querySelector('.xob-block').textContent === 'Retry'`);
    assert.match(await page.evaluate(`document.querySelector('.xob-block').title`), /did not confirm/);
    await page.evaluate('window.reply = { ok: true }');
    await page.click('.xob-block');
    await page.wait(`document.querySelector('.xob-block').textContent === 'Blocked'`);
    assert.equal(await page.evaluate('window.calls.length'), 2);
  } finally { await page.close(); }
});

test('handles scrolling and recycled rows without blocking the previous account', async () => {
  const page = await contentPage(row('alice'));
  try {
    await page.evaluate(`document.querySelector('[data-testid="UserCell"]').outerHTML = ${JSON.stringify(row('bob'))}`);
    await page.wait(`document.querySelector('.xob-block')?.dataset.handle === 'bob'`);
    await page.evaluate(`for (const link of document.querySelectorAll('a[href="/bob"]')) {
      link.href = '/carol'; if (link.textContent === '@bob') link.textContent = '@carol';
    }`);
    await page.wait(`document.querySelector('.xob-block').dataset.handle === 'carol'`);
    await page.click('.xob-block');
    await page.wait('window.calls.length === 1');
    assert.equal(await page.evaluate('window.calls[0].handle'), 'carol');
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(row('dave'))})`);
    await page.wait(`document.querySelectorAll('.xob-block').length === 2`);
  } finally { await page.close(); }
});

test('removes the added button when X changes Follow to its native Blocked button', async () => {
  const page = await contentPage(row('alice'));
  try {
    await page.evaluate(`document.querySelector('[data-testid="123-follow"]').dataset.testid = '123-unblock'`);
    await page.wait(`document.querySelector('.xob-block') === null`);
  } finally { await page.close(); }
});

function profile({ blocked = false, mismatch = false, redirect = false } = {}) {
  return `<main data-testid="primaryColumn">
    <div data-testid="UserName"><span>Alice</span><span>@alice</span></div>
    <button data-testid="123-${blocked ? 'unblock' : 'follow'}">${blocked ? 'Blocked' : 'Follow'}</button>
    <button data-testid="userActions">More</button>
  </main><script>
    window.actions = [];
    document.querySelector('[data-testid="userActions"]').onclick = () => {
      window.actions.push('more');
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
      menu.innerHTML = '<button role="menuitem" data-testid="block">Block @alice</button>';
      document.body.append(menu);
      menu.firstChild.onclick = () => {
        window.actions.push('block'); menu.remove();
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'alertdialog');
        dialog.innerHTML = '<h2>Block @${mismatch ? 'bob' : 'alice'}?</h2><button data-testid="confirmationSheetConfirm">Block</button>';
        document.body.append(dialog);
        ${redirect ? "history.replaceState(null, '', '/bob');" : ''}
        dialog.querySelector('button').onclick = () => {
          window.actions.push('confirm'); dialog.remove();
          document.querySelector('[data-testid="123-follow"]').dataset.testid = '123-unblock';
        };
      };
    };
  </script>`;
}
const runBlock = (page) => page.evaluate(`(${blockProfile.toString()})('alice')`);

test('native flow opens More, selects Block, confirms, and verifies Blocked', async () => {
  const page = await browser.page(profile(), 'https://x.com/alice');
  try {
    assert.deepEqual(await runBlock(page), { ok: true });
    assert.deepEqual(await page.evaluate('window.actions'), ['more', 'block', 'confirm']);
  } finally { await page.close(); }
});

test('native flow never clicks Unblock on an already blocked profile', async () => {
  const page = await browser.page(profile({ blocked: true }), 'https://x.com/alice');
  try {
    assert.deepEqual(await runBlock(page), { ok: true, alreadyBlocked: true });
    assert.deepEqual(await page.evaluate('window.actions'), []);
  } finally { await page.close(); }
});

test('native flow refuses a confirmation for a different account', async () => {
  const page = await browser.page(profile({ mismatch: true }), 'https://x.com/alice');
  try {
    const result = await runBlock(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /not identify @alice/);
    assert.deepEqual(await page.evaluate('window.actions'), ['more', 'block']);
  } finally { await page.close(); }
});

test('native flow stops if the page navigates to a different account', async () => {
  const page = await browser.page(profile({ redirect: true }), 'https://x.com/alice');
  try {
    const result = await runBlock(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /left the requested profile/);
    assert.deepEqual(await page.evaluate('window.actions'), ['more', 'block']);
  } finally { await page.close(); }
});

test('native flow reports an error when X never confirms success', async () => {
  const page = await browser.page(profile(), 'https://x.com/alice');
  try {
    // Advance only the deadline clock: do not make a test wait 20 seconds.
    await page.evaluate(`window.originalNow = Date.now; window.clockOffset = 0;
      Date.now = () => window.originalNow() + window.clockOffset;
      document.addEventListener('click', (event) => {
        if (event.target.dataset.testid === 'confirmationSheetConfirm') {
          event.stopImmediatePropagation(); window.clockOffset = 21000;
        }
      }, true);`);
    const result = await runBlock(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm the block/);
  } finally { await page.close(); }
});
