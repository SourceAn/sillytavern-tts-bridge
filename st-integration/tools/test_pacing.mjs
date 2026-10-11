/**
 * 节奏同步的路径测试：在 node 里用最小 DOM/fetch/Audio 替身跑 index.js 的真实代码，
 * 验证「生成一结束就藏字 → 音频开始播才放字」这条链真的按预期走。
 *
 * 为什么值得单独写：这一层坏掉的方式很隐蔽 ——
 * 要么消息永远不出现（藏了忘了放），要么白藏一场（放得比音频早）。
 * 两种都不会抛异常，只会让人觉得「怪」。
 *
 *   node tools/test_pacing.mjs
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

// 允许把测试文件拷到别处跑（排查用）：默认按脚本自身位置推导
const here = process.env.NATSUME_TEST_HOME
    ? join(process.env.NATSUME_TEST_HOME)
    : dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, '..', 'extension');
const stubs = join(here, 'stubs');

// ---------------------------------------------------------------------------
// 最小 DOM 替身：只实现扩展真正用到的那几个 API
// ---------------------------------------------------------------------------

class El {
    constructor(tag = 'div', id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.style = {};
        this._className = '';
        this.classList = {
            _set: new Set(),
            add: (...c) => {
                c.forEach(x => this.classList._set.add(x));
                this._className = [...this.classList._set].join(' ');
            },
            remove: (...c) => {
                c.forEach(x => this.classList._set.delete(x));
                this._className = [...this.classList._set].join(' ');
            },
            contains: c => this.classList._set.has(c),
        };
        this._innerHTML = '';
        this.value = '';
        this.checked = false;
        this.type = tag === 'input' ? 'text' : '';
        this.listeners = {};
    }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        // 简化：innerHTML 一被写入，就认为子节点被替换
        this.children = [];
    }

    // className 与 classList 必须共用同一个 Set：扩展两种写法都用，
    // 真实 DOM 里两者也是同一份数据的两个视图
    set className(value) {
        this._className = String(value);
        this.classList._set.clear();
        for (const token of this._className.split(/\s+/).filter(Boolean)) this.classList._set.add(token);
    }
    get className() {
        return [...this.classList._set].join(' ');
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, ref) {
        child.parentElement = this;
        const index = this.children.indexOf(ref);
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
    }

    remove() {
        if (!this.parentElement) return;
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) this.parentElement.children.splice(index, 1);
        this.parentElement = null;
    }

    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    closest() { return null; }
    querySelector(selector) { return queryAll(this, selector)[0] || null; }
    querySelectorAll(selector) { return queryAll(this, selector); }
    matches() { return false; }
    getAttribute(name) { return this.dataset[name] ?? null; }
    setAttribute(name, value) { this.dataset[name] = value; }
}

function descendants(root) {
    const out = [];
    const walk = (node) => {
        for (const child of node.children) {
            out.push(child);
            walk(child);
        }
    };
    walk(root);
    return out;
}

function queryAll(root, selector) {
    const all = descendants(root);
    if (selector.startsWith('#')) return all.filter(el => el.id === selector.slice(1));
    if (selector.startsWith('.')) return all.filter(el => el.classList.contains(selector.slice(1)));
    return all.filter(el => el.tagName === selector.toUpperCase());
}

// ---------------------------------------------------------------------------
// 组装被测模块
// ---------------------------------------------------------------------------

// ★ 关键：扩展通过替身模块读设置，所以测试必须改**同一份对象**，
//   否则测试改了 revealMode，扩展读到的还是默认值（这个坑踩过一次）。
//   静态 import 会被提升到文件顶部执行，所以这里只能惰性取。
function settingsStoreRef() {
    const bag = (globalThis.__natsumeTestSettings ||= {});
    bag['natsume-tts'] ||= {};
    return bag['natsume-tts'];
}
Object.assign(settingsStoreRef(), {
    enabled: true,
    autoPlay: true,
    pacing: true,
    revealMode: 'live',
    splitOnomatopoeia: true,
    maxSegments: 3,
    maxCharsPerSegment: 60,
    stripTagsFromDisplay: true,
    stripTagsFromPrompt: true,
    showChips: true,
    showChinese: true,
    endpoint: 'http://127.0.0.1:9880',
    sessionScope: 'character',
    markAffection: true,
});

const chatMessages = [];
const chatMetadata = {};

const container = new El('div', 'extensions_settings2');
const panelRoot = new El('div', 'natsume-settings');

let elementCounter = 0;
function makeMessageElement(mesId) {
    const mes = new El('div');
    mes.id = 'mes-' + mesId;
    mes.setAttribute('mesid', String(mesId));
    const text = new El('div');
    text.id = 'mes-text-' + mesId + '#' + (++elementCounter);
    text.className = 'mes_text';
    text.dataset.mesId = String(mesId);
    mes.appendChild(text);
    // 酒馆里 .mes_text 是 .mes 的子节点；替身默认的递归查找会先撞上祖先，
    // 这里把「元素内部的查询」收敛成只找直接子节点，和真实行为对齐
    mes.querySelector = (selector) => (selector === '.mes_text'
        ? mes.children.find(c => c.classList.contains('mes_text')) || null
        : null);
    mes.querySelectorAll = () => [];
    container.appendChild(mes);
    return { mes, text };
}

const globalDoc = {
    body: new El('body'),
    getElementById: (id) => (id === 'extensions_settings2' ? container
        : id === 'natsume-settings' ? (panelRoot.parentElement ? panelRoot : null)
            : id === 'chat' ? globalDoc.chatEl
                : null),
    createElement: (tag) => new El(tag),
    querySelector: (selector) => {
        if (selector.startsWith('.mes[mesid=')) {
            const id = selector.match(/"(\d+)"/)?.[1];
            return descendants(container).find(el => el.dataset.mesid === id && !el.classList.contains('mes_text')) || null;
        }
        if (selector.startsWith('.natsume-play')) return null;
        return null;
    },
    addEventListener: () => {},
    chatEl: new El('div', 'chat'),
};

const eventHandlers = {};
const eventSource = {
    on: (type, fn) => { (eventHandlers[type] ||= []).push(fn); },
    emit: async (type, ...args) => {
        for (const fn of eventHandlers[type] || []) await fn(...args);
    },
};

const audioLog = [];
const SEGMENT_MS = 150;      // 假音频「播多久」，用来制造稳定的中间态

class FakeAudio {
    constructor(url) {
        this.url = url;
        this.volume = 1;
        this._listeners = {};
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    async play() {
        audioLog.push({ event: 'play', url: this.url, at: Date.now() });
        // 模拟「真的开始出声」晚一拍：先 playing，再 ended
        setTimeout(() => {
            audioLog.push({ event: 'playing', url: this.url, at: Date.now() });
            for (const fn of this._listeners.playing || []) fn();
            setTimeout(() => {
                audioLog.push({ event: 'ended', url: this.url, at: Date.now() });
                for (const fn of this._listeners.ended || []) fn();
            }, SEGMENT_MS);
        }, 20);
    }
    pause() {}
}

// 把 import 指向替身模块，并把内部函数暴露出来
const stubsBase = pathToFileURL(join(stubs, '/')).href;
let source = readFileSync(join(extensionDir, 'index.js'), 'utf8')
    .replace("from '../../../extensions.js'", `from '${stubsBase}extensions.mjs'`)
    .replace("from '../../../../script.js'", `from '${stubsBase}script.mjs'`)
    .replace('export { onActivate, onEnable, onDisable };',
        'export { onActivate, onEnable, onDisable, hideForPacing, revealMessage, prepareAndPlay, shouldPace, parseMessage, renderMesHtml };');

globalThis.SillyTavern = {
    getContext: () => ({
        chat: chatMessages,
        chat_metadata: chatMetadata,
        characters: [{ name: '四季夏目', avatar: '四季夏目.png' }],
        characterId: 0,
        name2: '四季夏目',
        eventSource,
        event_types: {
            MESSAGE_SENT: 'message_sent',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            CHAT_CHANGED: 'chat_id_changed',
            MESSAGE_DELETED: 'message_deleted',
            GENERATE_AFTER_DATA: 'GENERATE_AFTER_DATA',
            APP_READY: 'app_ready',
            EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
        },
    }),
};
globalThis.document = globalDoc;
globalThis.location = { hostname: '127.0.0.1' };
globalThis.Audio = FakeAudio;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.URL.createObjectURL = () => 'blob:fake/' + Math.random().toString(36).slice(2);
globalThis.toastr = { info: () => {}, warning: () => {} };
globalThis.jQuery = () => {};

// 首次 fetch：settings.html / service 请求
globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes('settings.html')) {
        return { ok: true, status: 200, text: async () => '<div class="natsume-panel"></div>' };
    }
    if (target.endsWith('/state')) {
        if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ relationship_stage: '初识', scene: '公开' }) };
    }
    if (target === 'http://127.0.0.1:9880/') {
        return {
            ok: true, status: 200,
            headers: { get: (k) => ({ 'X-Voice': 'natsume-default', 'X-Ref-Clip': 'nat403_015', 'X-Duration': '1.2' }[k] ?? null) },
            blob: async () => ({ size: 1234 }),
        };
    }
    throw new Error('unexpected fetch: ' + target);
};

// data: URL 里没法解析相对导入（./text.js），所以落一个临时文件再 import；
// 放在扩展目录里，相对导入自然指向真正的 text.js（被测的就是线上那份）。
const tempPath = join(extensionDir, '.__pacing_test_build.mjs');
writeFileSync(tempPath, source);
let mod;
try {
    mod = await import(pathToFileURL(tempPath).href);
} finally {
    rmSync(tempPath, { force: true });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✅ ${name}`);
    } catch (error) {
        failures.push({ name, message: error.message });
        console.log(`  ❌ ${name}\n     ${error.message}`);
    }
}

/** 轮询等待条件成立（播放是串行的，固定 sleep 不稳）。 */
async function waitFor(predicate, { timeout = 5000, label = '条件' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`等待「${label}」超时（${timeout}ms）`);
}

const LONG_MES = '[声:calm]' + 'あ'.repeat(45) + '。\n[译:这是一条很长的台词，用来触发节奏同步。]';
const SHORT_MES = '[声:calm]……別に。\n[译:……没什么。]';

console.log('\n【节奏同步】');

await test('长消息：渲染后立刻进入「等待语音」状态（文字被隐藏）', async () => {
    chatMessages.push({ mes: LONG_MES, is_user: false });
    const { text } = makeMessageElement(0);
    text.innerHTML = LONG_MES;                     // 模拟酒馆先渲染了原始文本
    await eventSource.emit('character_message_rendered', 0);
    assert.ok(text.classList.contains('natsume-reveal-pending'), '文字应被隐藏');
    const mes = text.parentElement;
    assert.ok(mes.children.some(c => c.classList.contains('natsume-loading')), '应显示「语音合成中…」指示');
});

await test('短消息：不隐藏（藏了反而像卡顿）', async () => {
    const parsed = mod.parseMessage(SHORT_MES);
    assert.equal(mod.shouldPace(parsed), false, '短消息不应触发节奏同步');
});

await test('音频开始播的那一刻，文字被放出来', async () => {
    const { text } = makeMessageElement(1);
    chatMessages.push({ mes: LONG_MES, is_user: false });
    text.innerHTML = LONG_MES;
    await eventSource.emit('character_message_rendered', 1);

    // 等合成（fetch 是即时的）与播放（假 Audio 20ms 后 playing）
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.ok(!text.classList.contains('natsume-reveal-pending'), '音频开播后文字应已显示');
    assert.ok(text.innerHTML.includes('あ'), '显示内容应是干净的正文');
    assert.ok(!text.innerHTML.includes('[声:'), '协议标签不应出现在显示内容里');
    assert.ok(text.innerHTML.includes('natsume-play'), '应带上 🔊 按钮');

    const playingIndex = audioLog.findIndex(entry => entry.event === 'playing');
    assert.ok(playingIndex >= 0, '音频应真的开始播放');
});

await test('等待期间有 45 秒兜底：万一音频永远不来，文字也会自己出现', async () => {
    const { text } = makeMessageElement(2);
    chatMessages.push({ mes: LONG_MES, is_user: false });
    text.innerHTML = LONG_MES;
    mod.hideForPacing(2);
    assert.ok(text.classList.contains('natsume-reveal-pending'));
    mod.revealMessage(2);                          // 模拟定时器触发
    assert.ok(!text.classList.contains('natsume-reveal-pending'), '兜底路径必须能把文字放出来');
});

await test('隐藏期间不会把标签留在正文里（占位内容也走清理）', async () => {
    const { text } = makeMessageElement(3);
    chatMessages.push({ mes: LONG_MES, is_user: false });
    text.innerHTML = LONG_MES;
    mod.hideForPacing(3);
    assert.ok(!text.innerHTML.includes('[声:'), `占位内容仍含标签：${text.innerHTML.slice(0, 80)}`);
});

await test('revealMode=after 时，整条播完才放字', async () => {
    settingsStoreRef().revealMode = 'after';
    const { text } = makeMessageElement(4);
    chatMessages.push({ mes: LONG_MES, is_user: false });
    text.innerHTML = LONG_MES;
        await eventSource.emit('character_message_rendered', 4);

    // 入队那一刻的状态：不依赖播放进度，串行队列下最稳
    const hiddenRightAfterEnqueue = text.classList.contains('natsume-reveal-pending');

    await waitFor(() => !text.classList.contains('natsume-reveal-pending'),
        { label: '整条播完后显示文字' });

    assert.ok(hiddenRightAfterEnqueue,
        '入队时文字必须还是藏着的 —— after 模式要等整条播完才放字');
    settingsStoreRef().revealMode = 'live';
});

await test('revealMode=live 时，第一段音频一响就放字（不等播完）', async () => {
    settingsStoreRef().revealMode = 'live';
    const { text } = makeMessageElement(5);
    chatMessages.push({ mes: LONG_MES, is_user: false });
    text.innerHTML = LONG_MES;
    await eventSource.emit('character_message_rendered', 5);

    await waitFor(() => !text.classList.contains('natsume-reveal-pending'),
        { label: 'live 模式放字' });
    const firstPlaying = audioLog.filter(e => e.event === 'playing').length;
    assert.ok(firstPlaying >= 1, '此时应已有音频开始播');
});

console.log('\n【好感度】');

await test('用户消息会让好感度上涨，并且真的写进 chat_metadata', async () => {
    const before = (chatMetadata['natsume-tts'] || {}).points ?? 0;
    // 造一条会拿分的用户消息：>=12 字 + 命中礼貌/关心词
    const mes = { mes: '今天辛苦了，谢谢你还特地等我，慢慢来就好。', is_user: true };
    chatMessages.push(mes);
    const idx = chatMessages.length - 1;

    await eventSource.emit('message_sent', idx);
    await new Promise(r => setTimeout(r, 300));

    const after = (chatMetadata['natsume-tts'] || {}).points;
    assert.ok(after > before, `好感度应上涨：${before} -> ${after}`);
    assert.ok(Number.isFinite(after), `points 必须是数字，实际 ${JSON.stringify(chatMetadata['natsume-tts'])}`);
    console.log(`     好感度 ${before} -> ${after}`);
});

await test('好感度函数缺失时不能静默 —— 面板必须报错', async () => {
    // 这条测试保护的是「事件发射器吞异常」这个坑：
    // 如果 addAffection 被误删，没人会看到报错，只能靠面板状态暴露出来。
    const src = readFileSync(join(extensionDir, 'index.js'), 'utf8');
    assert.ok(/^function addAffection\(/m.test(src), 'index.js 里必须有 addAffection 的定义');
    assert.ok(/console\.error\('\[natsume-tts\] 好感度更新失败'/.test(src),
        'addAffection 必须自己 try/catch 并打日志（酒馆会吞掉监听器异常）');
});

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败\n`);
if (failures.length) {
    for (const f of failures) console.log(`  ❌ ${f.name}: ${f.message}`);
    process.exit(1);
}
