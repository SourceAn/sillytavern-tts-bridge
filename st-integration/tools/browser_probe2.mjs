/**
 * 认真的浏览器探针（v2）：先挂 CDP、再导航、等 load 事件 + 额外静置，然后取状态。
 *
 * v1 的教训：`/json/new?url` 之后直接 sleep，可能在页面还没跑完模块图时就取样，
 * 于是「st: undefined」既可能是真崩溃，也可能只是取早了 —— 这两种必须分清，
 * 否则会得出完全错误的结论（我因此误判过一轮）。
 *
 *   PORT=9350 TARGET="http://user:pass@127.0.0.1:8000/" node tools/browser_probe2.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9350);
const TARGET = process.env.TARGET || 'http://127.0.0.1:8000/';
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);

const profile = mkdtempSync(join(tmpdir(), 'probe2-'));
const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { /* 等 */ }
    await new Promise(r => setTimeout(r, 250));
}

const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
        events.push(msg);
    }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'eval error' };
    return { value: r.result?.value };
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

// 关键：先挂监听，再导航，等 load 事件
const loaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    const check = setInterval(() => {
        if (events.some(e => e.method === 'Page.loadEventFired')) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
        }
    }, 200);
});

const t0 = Date.now();
await send('Page.navigate', { url: TARGET });
await loaded;
const loadMs = Date.now() - t0;
await new Promise(r => setTimeout(r, SETTLE_MS));   // 再静置一会，等模块图跑完

const state = await evaluate(`JSON.stringify({
    st: typeof SillyTavern,
    readyState: document.readyState,
    badge: !!document.getElementById('natsume-badge'),
    badgeState: document.getElementById('natsume-badge')?.dataset?.state || null,
    badgeText: document.getElementById('natsume-badge')?.textContent || null,
    panel: !!document.getElementById('natsume-settings'),
    scripts: [...document.querySelectorAll('script[src*="natsume"],link[href*="natsume"]')].map(x => x.src || x.href),
    extensionsMenuButton: !!document.getElementById('extensionsMenuButton'),
    // 打开角色后，聊天区里的中文对照块数量（这是「译文有没有真的渲染出来」的直接证据）
    zhBlocks: document.querySelectorAll('.natsume-zh').length,
    zhSample: (document.querySelector('.natsume-zh')?.textContent || '').slice(0, 40),
    mesCount: document.querySelectorAll('#chat .mes').length,
})`);

const failedRequests = events
    .filter(e => e.method === 'Network.loadingFailed')
    .map(e => `${e.params.type} ${e.params.errorText}`);

const httpErrors = events
    .filter(e => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
    .map(e => `${e.params.response.status} ${e.params.response.url.slice(-70)}`);

const exceptions = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || '').split('\n').slice(0, 3).join(' | '));

const consoleMsgs = events
    .filter(e => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params?.entry?.level))
    .map(e => `[${e.params.entry.level}] ${e.params.entry.text}`);

console.log('目标      :', TARGET);
console.log('load 用时 :', loadMs + 'ms');
console.log('页面状态  :', state.value ?? state.error);
console.log('\n失败请求  :', failedRequests.length ? failedRequests.slice(0, 10) : '（无）');
console.log('HTTP ≥400 :', httpErrors.length ? httpErrors.slice(0, 10) : '（无）');
console.log('未捕获异常:', exceptions.length ? [...new Set(exceptions)].slice(0, 5) : '（无）');
console.log('控制台    :', consoleMsgs.length ? [...new Set(consoleMsgs)].slice(0, 10) : '（无）');

cleanup();
process.exit(0);
