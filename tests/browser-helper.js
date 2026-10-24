import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out: ' + method));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

export async function startBrowser() {
  const executable = [
    process.env.CHROMIUM_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
  ].find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error('Install Chrome/Brave or set CHROMIUM_PATH to run browser tests.');
  const profile = await mkdtemp(join(tmpdir(), 'xob-test-'));
  const child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser failed to start: ' + logs)), 15000);
    child.stderr.on('data', (chunk) => {
      logs += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(logs);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Browser exited ' + code + ': ' + logs)); });
  }).catch(async (error) => {
    child.kill();
    await rm(profile, { recursive: true, force: true });
    throw error;
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const connection = new Connection(socket);
  return {
    async page(html, url = 'https://x.com/i/lists/123/members') {
      const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
      const send = (method, params) => connection.send(method, params, sessionId);
      const intercept = (message) => {
        if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
        const isDocument = message.params.resourceType === 'Document';
        void send('Fetch.fulfillRequest', {
          requestId: message.params.requestId,
          responseCode: isDocument ? 200 : 204,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(isDocument ? html : '').toString('base64')
        }).catch(() => {});
      };
      connection.listeners.add(intercept);
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await send('Page.enable');
      await send('Page.navigate', { url });
      await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          if (location.href === ${JSON.stringify(url)} && document.readyState === 'complete') resolve(true);
          else if (Date.now() > deadline) reject(new Error('Fixture navigation timed out'));
          else setTimeout(check, 20);
        }; check();
      })`);
      return {
        evaluate,
        async wait(expression) {
          return evaluate(`new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const check = () => {
              const value = (${expression});
              if (value) resolve(value);
              else if (Date.now() > deadline) reject(new Error('Condition timed out: ' + ${JSON.stringify(expression)}));
              else setTimeout(check, 20);
            }; check();
          })`);
        },
        async click(selector) {
          const point = await evaluate(`(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            node.scrollIntoView({ block: 'center' });
            const box = node.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          })()`);
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        },
        async close() {
          connection.listeners.delete(intercept);
          await connection.send('Target.closeTarget', { targetId });
        }
      };
    },
    async close() {
      try { await connection.send('Browser.close'); } catch { child.kill(); }
      socket.close();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      await rm(profile, { recursive: true, force: true });
    }
  };
}
