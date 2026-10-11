/**
 * 用无头 Chrome 打开酒馆页面，直接看扩展到底加载了没有。
 *
 * 为什么需要它：扩展跑在浏览器里，服务端日志只能看到「有没有请求过来」，
 * 看不到「模块有没有报错」。而这个扩展最可能的失败方式恰恰是静默的：
 * 模块顶层抛异常 → 页面什么都不显示 → 从外面看和「没装」一模一样。
 *
 *   node tools/browser_probe.mjs            # 打开页面、等加载、收集证据
 *
 * 用 Chrome 的 DevTools Protocol（Node 22+ 自带 WebSocket，不需要装 puppeteer）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const USER = process.env.ST_USER || 'harness';
const PASS = process.env.ST_PASS || '';
const TARGET = process.env.ST_URL || 'http://127.0.0.1:8000/';
const WAIT_MS = Number(process.env.WAIT_MS || 12000);

const profile = mkdtempSync(join(tmpdir(), 'natsume-probe-'));

const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1600,1000',
    'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForEndpoint() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
            if (res.ok) return await res.json();
        } catch { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('Chrome 调试端口没起来');
}

/** 极简 CDP 客户端：够跑 Runtime.evaluate 与 Page.navigate。 */
class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            return { error: result.exceptionDetails.exception?.description || 'eval error' };
        }
        return { value: result.result?.value };
    }
}

const version = await waitForEndpoint();
console.log('Chrome:', version.Browser);

// 新建标签页（带 basic auth 的 URL）
const authUrl = TARGET.replace('://', `://${USER}:${encodeURIComponent(PASS)}@`);
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(authUrl)}`, { method: 'PUT' })).json();
const cdp = new CDP(created.webSocketDebuggerUrl);
await cdp.ready;

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');

console.log(`等待页面加载 ${WAIT_MS}ms…`);
await new Promise(r => setTimeout(r, WAIT_MS));

const probe = await cdp.evaluate(`(() => {
    const out = {
        url: location.href,
        title: document.title,
        badge: null,
        panel: null,
        scripts: [],
        readyState: document.readyState,
    };

    const badge = document.getElementById('natsume-badge');
    if (badge) {
        out.badge = {
            className: badge.className,
            state: badge.dataset.state || null,
            text: badge.querySelector('span')?.textContent || null,
            visible: getComputedStyle(badge).display !== 'none',
        };
    }

    const panel = document.getElementById('natsume-settings');
    if (panel) {
        out.panel = {
            exists: true,
            children: panel.children.length,
            textSample: (panel.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
        };
    }

    // 扩展脚本标签有没有插进来
    for (const s of document.querySelectorAll('script[src*="natsume"]')) {
        out.scripts.push(s.src);
    }
    for (const l of document.querySelectorAll('link[href*="natsume"]')) {
        out.scripts.push('CSS ' + l.href);
    }

    // 顺带看看扩展设置容器在不在
    out.containers = {
        extensions_settings: !!document.getElementById('extensions_settings'),
        extensions_settings2: !!document.getElementById('extensions_settings2'),
    };
    return out;
})()`);

const health = await cdp.evaluate(`fetch('http://127.0.0.1:9880/health')
    .then(r => r.json()).then(j => ({ ok: true, ready: j.ready, gpt: j.gpt }))
    .catch(e => ({ ok: false, error: String(e) }))`);

const consoleErrors = cdp.events
    .filter(e => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params?.entry?.level))
    .map(e => `[${e.params.entry.level}] ${e.params.entry.text} ${e.params.entry.url || ''}`.trim());

const exceptions = cdp.events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params?.exceptionDetails?.exception?.description
        || e.params?.exceptionDetails?.text || '(未知异常)');

console.log('\n=== 页面 ===');
console.log('URL      :', probe.value?.url);
console.log('标题     :', probe.value?.title);
console.log('readyState:', probe.value?.readyState);
console.log('扩展脚本 :', probe.value?.scripts?.length ? probe.value.scripts : '（没找到任何 natsume 脚本/CSS 标签）');
console.log('容器     :', JSON.stringify(probe.value?.containers));

console.log('\n=== 扩展状态 ===');
console.log('面板     :', probe.value?.panel ? JSON.stringify(probe.value.panel) : '❌ 没有 #natsume-settings（面板没建出来）');
console.log('右下徽章 :', probe.value?.badge ? JSON.stringify(probe.value.badge) : '❌ 没有 #natsume-badge（模块没跑或很早就抛了）');

console.log('\n=== 浏览器里能不能连到 TTS ===');
console.log(JSON.stringify(health.value));

console.log('\n=== 控制台错误 ===');
if (consoleErrors.length) consoleErrors.slice(0, 20).forEach(e => console.log(' -', e));
else console.log('（无）');

console.log('\n=== 页面异常 ===');
if (exceptions.length) exceptions.slice(0, 20).forEach(e => console.log(' -', e.split('\n')[0]));
else console.log('（无）');

cleanup();
process.exit(0);
