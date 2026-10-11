/**
 * 模块图对照探针：把浏览器实际请求的**脚本 URL 列表与顺序**打出来。
 *
 * 为什么是它：崩溃报在 slash-commands.js:107（模块循环里读到未初始化的
 * SlashCommandParser，即 TDZ）。这类错误的成因只有一个 —— 循环依赖里
 * 「谁先被求值」变了。而「谁先被求值」由模块图的**入口与依赖顺序**决定。
 * 所以需要的证据不是「哪个变量相关」，而是**完整的脚本请求序列**：
 * 两次加载（能跑的 data / 崩的 data）一比，第一个分叉点就是根因所在。
 *
 *   PORT=9360 TARGET="http://127.0.0.1:8000/" OUT=/tmp/mods.json node tools/probe_modules.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9360);
const TARGET = process.env.TARGET || 'http://127.0.0.1:8000/';
const OUT = process.env.OUT || '';
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);

const profile = mkdtempSync(join(tmpdir(), 'probemod-'));
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

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

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
await send('Page.navigate', { url: TARGET });
await loaded;
await new Promise(r => setTimeout(r, SETTLE_MS));

// 按请求发生顺序，收集所有 .js（含 type=module）
const scriptOrder = [];
const seen = new Set();
const methodCounts = {};
for (const e of events) methodCounts[e.method] = (methodCounts[e.method] || 0) + 1;
if (process.env.DUMP_EVENTS) console.error('事件统计:', JSON.stringify(methodCounts));

for (const e of events) {
    if (e.method !== 'Network.requestWillBeSent' && e.method !== 'Network.responseReceived') continue;
    const url = e.params?.request?.url || e.params?.response?.url || '';
    if (!/\.js(\?|$)/.test(url)) continue;
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    // 扩展版本号查询参数不影响身份，去掉
    const key = path;
    if (seen.has(key)) continue;
    seen.add(key);
    scriptOrder.push({ index: scriptOrder.length, path, type: e.params.type });
}

const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ st: typeof SillyTavern, readyState: document.readyState })`,
    returnByValue: true,
});
const exceptions = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => (e.params.exceptionDetails.exception?.description || '').split('\n')[0]);

const report = {
    target: TARGET,
    state: state.result?.value,
    exceptionCount: exceptions.length,
    exceptions: [...new Set(exceptions)],
    scriptCount: scriptOrder.length,
    scriptOrder,
};

if (OUT) {
    writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log('已写出:', OUT);
}
console.log('目标    :', TARGET);
console.log('页面    :', report.state);
console.log('异常    :', report.exceptionCount ? report.exceptions : '（无）');
console.log('脚本数  :', report.scriptCount);
console.log('前 25 个脚本（按加载顺序）:');
for (const s of scriptOrder.slice(0, 25)) {
    console.log(`  ${String(s.index).padStart(3)} ${s.type.padEnd(6)} ${s.path}`);
}

cleanup();
process.exit(0);
