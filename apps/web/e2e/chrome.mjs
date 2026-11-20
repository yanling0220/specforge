import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const quote = JSON.stringify;

export async function chrome(work) {
  const profile = join(work, 'chrome');
  const process = spawn(chromePath, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1280,950', 'about:blank'], { stdio: 'ignore' });
  let spawnError;
  process.once('error', (error) => { spawnError = error; });
  let socket;
  const close = async () => {
    socket?.close();
    if (spawnError || process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit');
    process.kill();
    const forced = setTimeout(() => process.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(forced); }
  };
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      if (spawnError) throw spawnError;
      if (process.exitCode !== null) break;
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, 'utf8').split('\n')[0];
        target = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json())
          .then((targets) => targets.find(({ type }) => type === 'page')).catch(() => undefined);
      }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Chrome 未启动');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    const pending = new Map();
    const requests = [];
    const responses = [];
    let next = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP 超时 ' + method));
      }, 15_000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
      socket.send(quote({ id, method, params }));
    });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request);
      if (message.method === 'Network.responseReceived') responses.push(message.params.response);
      if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: [
      'window.button = (text) => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text && !b.disabled)',
      'window.setField = (field, value) => {',
      '  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, value);',
      '  field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));',
      '}',
      'window.contains = (sel, text) => document.querySelector(sel)?.textContent.includes(text) ?? false',
    ].join('\n') });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (expression, reason, timeout = 9000) => {
      for (const start = Date.now(); Date.now() - start < timeout; await sleep(100)) {
        try { if (await evaluate(expression)) return; }
        catch (error) { if (!/context|navigat/i.test(error.message)) throw error; }
      }
      throw new Error(reason + '\n' + await evaluate('document.body.innerText.slice(0, 1400)'));
    };
    return {
      evaluate, wait, requests, responses, send, close,
      async go(url) {
        await send('Page.navigate', { url });
        await wait('location.href === ' + quote(url) + ' && !!window.button', '浏览器导航 ' + url);
      },
      async click(label) {
        const target = 'button(' + quote(label) + ')';
        await wait('!!' + target, '按钮 ' + label);
        await evaluate(target + '.click(), true');
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
