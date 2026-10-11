/**
 * 四季夏目 · 语音与好感度（Natsume TTS × SillyTavern）
 *
 * 这个扩展做四件事：
 *   1. 解析角色消息里的【协议标签】（情绪角度 / 拟声词 / 中文对照 / 场景 / 心动），
 *      把它们从显示文本里抹掉（保留在消息原文里，便于重播与复盘）；
 *   2. 调本机 Natsume TTS 服务（GPT-SoVITS，四季夏目音色）逐句合成、顺序播放，
 *      不同情绪走不同的音色参考，拟声词单独成段；
 *   3. 维护「好感度」——点数、阶段，并与 TTS 服务的 relationship_stage 同步；
 *   4. 把当前好感度/阶段/场景注入生成提示，让模型知道此刻该冷到什么程度。
 *
 * 协议标签（写在角色卡里，模型照此输出）：
 *   [声:tsukkomi]  情绪角度 → 选哪个音色参考
 *   [拟声:はぁ]    拟声词 → 单独合成一小段（更易听清）
 *   [译:中文]      中文对照，不合成
 *   [场景:私下]    切换场合
 *   [心动]         追加好感度（默认 +2）
 */

// saveMetadataDebounced 由 extensions.js 导出（script.js 没有它）；
// 从 script.js 导入一个不存在的具名导出会让浏览器在**链接期**拒绝整个模块 ——
// 表现就是扩展装上了但面板里什么都不显示。这是本扩展踩过的最贵的一个坑。
import {
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    chat_metadata,
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../script.js';

import {
    STAGES,
    SCENES,
    EMOTIONS,
    TAG_TEST,
    DEFAULT_TEXT_SETTINGS,
    configure as configureText,
    parseMessage,
    stripTags,
    voiceFor,
    stageForPoints,
    stageIndex,
    scoreUserMessage,
    affinityBlock,
    japaneseLength,
    pairLines,
    escapeHtml,
} from './text.js';

const MODULE = 'natsume-tts';

const DEFAULT_SETTINGS = {
    enabled: true,
    endpoint: '',
    autoPlay: true,
    splitOnomatopoeia: true,
    maxSegments: 3,
    maxCharsPerSegment: 60,
    stripTagsFromDisplay: true,
    stripTagsFromPrompt: true,
    showChips: true,
    showChinese: true,
    sessionScope: 'character',
    markAffection: true,
    // 节奏：先出声、后出字。生成一结束就把消息藏起来，等音频备好再露出来。
    pacing: true,
    // live = 音频开始播就放出文字（默认）；after = 整条播完才放出文字
    revealMode: 'live',
};

const segmentCache = new Map();
let audioQueue = Promise.resolve();
let currentAudio = null;
let panelRoot = null;

// ---------------------------------------------------------------------------
// 设置与状态
// ---------------------------------------------------------------------------

function settings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') {
        extension_settings[MODULE] = {};
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = value;
        }
    }
    return extension_settings[MODULE];
}

/** 好感度存在聊天元数据里：每个聊天一份，互不干扰。 */
function affinity() {
    if (!chat_metadata[MODULE] || typeof chat_metadata[MODULE] !== 'object') {
        chat_metadata[MODULE] = { points: 0, stage: '初识', scene: '公开', lastTurnAt: 0 };
    }
    const state = chat_metadata[MODULE];
    if (typeof state.points !== 'number' || !Number.isFinite(state.points)) state.points = 0;
    if (!STAGES.some(s => s.id === state.stage)) state.stage = stageForPoints(state.points);
    if (!SCENES.includes(state.scene)) state.scene = '公开';
    return state;
}

// ---------------------------------------------------------------------------
// 服务连接
// ---------------------------------------------------------------------------

/**
 * 端点自动推断：本机开酒馆打 127.0.0.1；从别的设备访问酒馆时，
 * TTS 跑在**酒馆服务端那台机器**上，所以用页面主机名。
 */
function resolveEndpoint() {
    const configured = String(settings().endpoint || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const host = location.hostname || '127.0.0.1';
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return `http://${isLocal ? '127.0.0.1' : host}:9880`;
}

/**
 * 会话 ID（会作为 HTTP 头 X-Session-Id 发出去，所以必须是 ASCII）。
 * 中文角色名会被整个替换成下划线，那样所有中文角色会共用同一个会话 ——
 * 所以这里保留可读部分，并拼一段原串的哈希兜底。
 */
function asciiId(raw) {
    const text = String(raw ?? '');
    const slug = text
        .replace(/\.(png|jpg|jpeg|webp|json)$/i, '')       // 头像是 xxx.png，去掉扩展名更可读
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    const suffix = (hash >>> 0).toString(36).slice(0, 6);
    return slug ? `${slug}-${suffix}` : suffix;
}

function sessionId() {
    const scope = settings().sessionScope;
    if (scope === 'global') return 'default';
    if (scope === 'chat') {
        const id = chat_metadata?.chat_id || chat_metadata?.file_name || 'chat';
        return `chat-${asciiId(id)}`;
    }
    const context = SillyTavern.getContext();
    const character = context?.characters?.[context?.characterId];
    // 优先用头像文件名（酒馆里通常是 ASCII 的稳定标识），退回角色名
    const raw = character?.avatar || context?.name2 || character?.name || 'character';
    return `char-${asciiId(raw)}`;
}

async function serviceFetch(path, options = {}) {
    const headers = Object.assign({ 'X-Session-Id': sessionId() }, options.headers || {});
    const response = await fetch(`${resolveEndpoint()}${path}`, Object.assign({}, options, { headers }));
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${response.status} ${response.statusText} ${detail.slice(0, 160)}`);
    }
    return response;
}

async function serviceJson(path, options) {
    const response = await serviceFetch(path, options);
    return await response.json();
}

async function pushStage(stage, scene) {
    try {
        await serviceJson('/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ relationship_stage: stage, scene }),
        });
        return true;
    } catch (error) {
        console.warn('[natsume-tts] 阶段同步失败', error);
        return false;
    }
}

// ---------------------------------------------------------------------------
// 合成与播放
// ---------------------------------------------------------------------------

async function synthesize(text, voiceId) {
    const key = `${voiceId}\u0001${text}`;
    if (segmentCache.has(key)) return segmentCache.get(key);

    const response = await serviceFetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            prompt_text: voiceId,
            ref_audio_path: `./参考音频/${voiceId}.wav`,
            text_lang: 'ja',
            prompt_lang: 'ja',
            text_split_method: 'cut0',
            batch_size: 1,
            media_type: 'ogg',
            streaming_mode: 'false',
        }),
    });

    const blob = await response.blob();
    const meta = {
        blob,
        voice: response.headers.get('X-Voice') || voiceId,
        refClip: response.headers.get('X-Ref-Clip') || '',
        duration: Number.parseFloat(response.headers.get('X-Duration') || '0'),
        url: URL.createObjectURL(blob),
    };
    segmentCache.set(key, meta);
    if (segmentCache.size > 60) evictCache();
    return meta;
}

function evictCache() {
    for (const [key, meta] of segmentCache) {
        if (segmentCache.size <= 40) break;
        URL.revokeObjectURL(meta.url);
        segmentCache.delete(key);
    }
}

/**
 * 播一段音频。
 * onStart：音频**真的开始出声**的那一刻回调（不是调 play() 的那一刻）——
 * 节奏同步就挂在这里，早一点晚一点都会露馅。
 */
function playUrl(url, mesId, { onStart } = {}) {
    return new Promise((resolve) => {
        if (currentAudio) {
            try { currentAudio.pause(); } catch { /* 忽略 */ }
            currentAudio = null;
        }
        const audio = new Audio(url);
        audio.volume = clampVolume(extension_settings.tts?.volume);
        currentAudio = audio;
        const chip = document.querySelector(`.natsume-play[data-mesid="${mesId}"]`);
        chip?.classList.add('natsume-playing');
        let started = false;
        const fireStart = () => {
            if (started) return;
            started = true;
            try { onStart?.(); } catch (error) { console.warn('[natsume-tts] onStart 出错', error); }
        };
        const done = () => {
            chip?.classList.remove('natsume-playing');
            if (currentAudio === audio) currentAudio = null;
            fireStart();        // 万一没触发 playing/timeupdate，也别把文字永远藏着
            resolve();
        };
        audio.addEventListener('playing', fireStart, { once: true });
        audio.addEventListener('timeupdate', fireStart, { once: true });
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        audio.play().catch((error) => {
            console.warn('[natsume-tts] 播放被拦截', error);
            setStatus('播放被浏览器拦截：先点页面任意处，或用消息上的 🔊', 'bad');
            done();
        });
    });
}

function clampVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return 1;
    return Math.min(1, Math.max(0, volume));
}

// ---------------------------------------------------------------------------
// 节奏同步：先出声，后出字
// ---------------------------------------------------------------------------

/**
 * 为什么要有这一层：模型出字比语音合成快得多（合成一句 1.5~4 秒），
 * 用户会先读完文字、再干等声音，完全对不上拍子。
 * 做法：一条新消息刚渲染出来就先藏起来 → 合成 → 音频开始播的那一刻再放出来。
 *
 * 隐藏用 .natsume-reveal-pending（CSS class，不是 style.display），
 * 并挂一个安全定时器兜底 —— 任何异常路径都不该让消息永久消失。
 */
const REVEAL_TIMEOUT_MS = 45_000;

/**
 * 什么时候值得藏字。
 * 短消息合成也就 1.5 秒左右，藏了反而像卡了一下；长消息要等好几秒，才值得藏。
 * 阈值按实测：合成墙钟 ≈ 0.19s × 日文字符数 + 0.8s。
 */
const PACING_MIN_CHARS = 30;
const PACING_MIN_SYNTH_MS = 3000;

function prepareCostMs(parsed) {
    const chars = parsed.segments.reduce((sum, segment) => sum + japaneseLength(segment.text), 0);
    return 190 * chars + 800;
}

function shouldPace(parsed) {
    if (!settings().pacing) return false;
    const chars = parsed.segments.reduce((sum, segment) => sum + japaneseLength(segment.text), 0);
    return chars >= PACING_MIN_CHARS || prepareCostMs(parsed) >= PACING_MIN_SYNTH_MS;
}

function mesElement(mesId) {
    return document.querySelector(`.mes[mesid="${mesId}"]`);
}

function hideForPacing(mesId) {
    const element = mesElement(mesId);
    if (!element) return false;
    const text = element.querySelector('.mes_text');
    if (!text) return false;

    element.dataset.natsumePacing = '1';
    text.classList.add('natsume-reveal-pending');

    // 藏之前先从「消息原文」重画一遍，确保占位内容不含协议标签；
    // 同时清掉清理标记 —— 放出来的时候还要再清一次（两条事件链谁先谁后不确定）
    const context = SillyTavern.getContext();
    const message = context?.chat?.[mesId];
    if (typeof message?.mes === 'string' && TAG_TEST.test(message.mes)) {
        text.innerHTML = renderMesHtml(message.mes, mesId);
    }
    delete text.dataset.natsumeSanitized;

    if (!element.querySelector('.natsume-loading')) {
        const loader = document.createElement('div');
        loader.className = 'natsume-loading';
        loader.innerHTML = '<span class="natsume-dot"></span>语音合成中…';
        text.parentElement?.insertBefore(loader, text);
    }

    clearTimeout(Number(element.dataset.natsumeRevealTimer || 0));
    const timer = setTimeout(() => revealMessage(mesId), REVEAL_TIMEOUT_MS);
    // 浏览器里不需要 unref；但 node 下跑测试时它会吊住进程（实测：测试 10 秒跑完，进程 45 秒才退）
    timer?.unref?.();
    element.dataset.natsumeRevealTimer = String(timer);
    return true;
}

function revealMessage(mesId) {
    const element = mesElement(mesId);
    if (!element) return;
    clearTimeout(Number(element.dataset.natsumeRevealTimer || 0));
    delete element.dataset.natsumeRevealTimer;
    element.querySelector('.natsume-loading')?.remove();
    const text = element.querySelector('.mes_text');
    if (text) {
        text.classList.remove('natsume-reveal-pending');
        text.dataset.natsumeSanitized = '1';
        // 从消息原文重画（而不是放回藏起来时的那份 HTML）：
        // 这样不管清理跑在隐藏之前还是之后，露出来的都是干净版本
        const context = SillyTavern.getContext();
        const message = context?.chat?.[mesId];
        if (typeof message?.mes === 'string') {
            text.innerHTML = renderMesHtml(message.mes, mesId);
        }
    }
    delete element.dataset.natsumePacing;
}

/**
 * 合成全部片段 → 顺序播放。文字什么时候放出来由 revealMode 决定：
 *   live  → 第一段音频真正出声时放出（默认，读和听同时开始）
 *   after → 整条播完再放出
 */
async function prepareAndPlay(parsed, mesId, { reveal = false } = {}) {
    const prepared = [];
    for (const [index, segment] of parsed.segments.entries()) {
        // 每条台词用自己的 [声:]（segment.voice），没有才回退整条消息的情绪
        const voice = voiceFor(segment, segment.voice || parsed.emotion);
        setStatus(`合成 ${index + 1}/${parsed.segments.length}：${segment.text.slice(0, 16)}…`, 'busy');
        const meta = await synthesize(segment.text, voice);
        prepared.push({ segment, meta });
    }
    if (!prepared.length) return;

    // 注意：after 模式**不能**在这里就置为已放出 ——
    // 它要等整条播完才放字（这个 bug 写出来时踩过一次：文字比声音早到）
    const mode = settings().revealMode === 'after' ? 'after' : 'live';
    let revealed = !reveal;

    for (const [index, item] of prepared.entries()) {
        setStatus(`播放 ${index + 1}/${prepared.length}：${item.meta.voice}`
            + (item.meta.duration ? ` · ${item.meta.duration.toFixed(1)}s` : ''));
        await playUrl(item.meta.url, mesId, {
            onStart: () => {
                if (!revealed) {
                    revealed = true;
                    revealMessage(mesId);
                }
            },
        });
    }

    if (!revealed) revealMessage(mesId);
    setStatus('就绪', 'ok');
}

// ---------------------------------------------------------------------------
// 好感度
// ---------------------------------------------------------------------------

function syncStageFromService(remote) {
    if (!remote || typeof remote !== 'object') return;
    const state = affinity();
    let dirty = false;
    if (STAGES.some(s => s.id === remote.relationship_stage) && remote.relationship_stage !== state.stage) {
        state.stage = remote.relationship_stage;
        const floor = STAGES[stageIndex(state.stage)].min;
        if (state.points < floor) state.points = floor;
        dirty = true;
    }
    if (SCENES.includes(remote.scene) && remote.scene !== state.scene) {
        state.scene = remote.scene;
        dirty = true;
    }
    if (dirty) {
        saveMetadataDebounced();
        renderPanel();
    }
}

// ---------------------------------------------------------------------------
// 生成提示注入
// ---------------------------------------------------------------------------

/**
 * OpenAI 兼容后端的 prompt 是消息数组。做法：
 *   · 抹掉历史里残留的协议标签（否则模型会照抄标签当台词）
 *   · 把 <natsume_state> 追加到**最后一条**消息（离生成最近，权重最高）
 */
function onGenerateAfterData(generateData, dryRun) {
    if (dryRun || !settings().enabled) return;
    const prompt = generateData?.prompt;
    if (!Array.isArray(prompt) || !prompt.length) return;

    if (settings().stripTagsFromPrompt) {
        for (const message of prompt) {
            if (typeof message?.content === 'string' && TAG_TEST.test(message.content)) {
                message.content = stripTags(message.content);
            }
        }
    }

    const block = affinityBlock();
    const target = prompt[prompt.length - 1];
    if (typeof target?.content !== 'string') return;
    if (target.content.includes('<natsume_state>')) {
        target.content = target.content.replace(/<natsume_state>[\s\S]*?<\/natsume_state>/, block);
    } else {
        target.content = `${target.content}\n\n${block}`;
    }
}

// ---------------------------------------------------------------------------
// 显示层：抹掉标签（保留原文，只改渲染结果）
// ---------------------------------------------------------------------------

const observer = new MutationObserver((mutations) => {
    if (!settings().enabled || !settings().stripTagsFromDisplay) return;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const candidates = node.matches?.('.mes_text') ? [node] : Array.from(node.querySelectorAll?.('.mes_text') || []);
            for (const element of candidates) sanitizeMesText(element);
        }
    }
});

/**
 * 把带标签的消息原文渲染成显示用 HTML。
 *
 * 正文用 pairLines() 输出「日文行 + 紧跟它的中文对照」，而不是把一串中文
 * 堆在整段末尾 —— 后者会让人以为没有译文（一串中文里只有最后一句，
 * 且和日文句子对不上号）。
 */
function renderMesHtml(source, mesId) {
    const parsed = parseMessage(source);
    const bodyHtml = settings().showChinese
        ? pairLines(source)
        : escapeHtml(stripTags(source)).replace(/\n/g, '<br>');
    const button = `<span class="natsume-play" data-mesid="${mesId}" title="播放这一句">🔊</span>`;
    return `${bodyHtml}${button}${chipHtml(parsed)}`;
}

function sanitizeMesText(element) {
    if (element.dataset.natsumeSanitized === '1') return;
    const html = element.innerHTML;
    if (!TAG_TEST.test(html)) return;
    element.dataset.natsumeSanitized = '1';

    const mesId = Number.parseInt(element.closest('.mes')?.getAttribute('mesid') ?? '-1', 10);
    const context = SillyTavern.getContext();
    const message = context?.chat?.[mesId];
    const source = typeof message?.mes === 'string' ? message.mes : html;
    element.innerHTML = renderMesHtml(source, mesId);
}

function chipHtml(parsed) {
    if (!settings().showChips) return '';
    const chips = [];
    if (parsed.emotion && parsed.emotion !== 'neutral') {
        chips.push(`<span class="natsume-chip natsume-chip-emo">声：${EMOTIONS[parsed.emotion].zh}</span>`);
    }
    for (const ono of parsed.onomatopoeia) {
        chips.push(`<span class="natsume-chip natsume-chip-ono">拟声：${escapeHtml(ono)}</span>`);
    }
    if (parsed.affection) {
        chips.push(`<span class="natsume-chip natsume-chip-aff">心动 +${parsed.affection}</span>`);
    }
    if (parsed.truncated) {
        chips.push(`<span class="natsume-chip natsume-chip-bad">超长已截 ${parsed.truncated} 字</span>`);
    }
    return chips.length ? `<span class="natsume-chips">${chips.join('')}</span>` : '';
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

/**
 * 状态要同时写到两个地方：
 *   1. 扩展设置面板里的一行（面板藏在折叠抽屉里，不一定看得见）
 *   2. 一个常驻页面的小徽章（右下角）—— 「TTS 到底上线没有」一眼可答
 */
function setStatus(text, state) {
    const element = document.getElementById('natsume-status');
    if (element) element.textContent = text;
    updateBadge(text, state);
}

const BADGE_STATES = {
    ok: '#7fc18a',
    busy: '#c9a0b4',
    bad: '#d08b8b',
    unknown: '#9aa0a6',
};

function ensureBadge() {
    let badge = document.getElementById('natsume-badge');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'natsume-badge';
    badge.className = 'natsume-badge natsume-badge-unknown';
    badge.innerHTML = '<i></i><span>四季夏目 · 待连接</span>';
    badge.title = '四季夏目语音扩展状态（点一下重新检测）';
    badge.addEventListener('click', () => {
        refreshServiceState().catch(() => {});
    });
    document.body.appendChild(badge);
    return badge;
}

function updateBadge(text, state) {
    const badge = ensureBadge();
    if (state && BADGE_STATES[state]) {
        badge.className = `natsume-badge natsume-badge-${state}`;
        badge.dataset.state = state;
    }
    const label = badge.querySelector('span');
    if (label) label.textContent = text;
}

async function buildPanel() {
    if (document.getElementById('natsume-settings')) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        console.warn('[natsume-tts] 未找到扩展设置容器');
        return;
    }

    const response = await fetch('/scripts/extensions/third-party/natsume-tts/settings.html', { headers: getRequestHeaders() });
    if (!response.ok) {
        console.error('[natsume-tts] settings.html 加载失败', response.status);
        return;
    }
    const html = await response.text();

    panelRoot = document.createElement('div');
    panelRoot.className = 'extension_container';
    panelRoot.id = 'natsume-settings';
    panelRoot.innerHTML = html;
    container.appendChild(panelRoot);
    bindPanel(panelRoot);
    renderPanel();
}

function bindPanel(root) {
    const current = settings();

    const bindings = [
        ['#natsume-enabled', 'enabled', 'checked'],
        ['#natsume-autoplay', 'autoPlay', 'checked'],
        ['#natsume-ono-split', 'splitOnomatopoeia', 'checked'],
        ['#natsume-chips', 'showChips', 'checked'],
        ['#natsume-zh', 'showChinese', 'checked'],
        ['#natsume-mark', 'markAffection', 'checked'],
        ['#natsume-pacing', 'pacing', 'checked'],
        ['#natsume-reveal-mode', 'revealMode', 'value'],
        ['#natsume-strip-display', 'stripTagsFromDisplay', 'checked'],
        ['#natsume-strip-prompt', 'stripTagsFromPrompt', 'checked'],
        ['#natsume-max-segments', 'maxSegments', 'number'],
        ['#natsume-max-chars', 'maxCharsPerSegment', 'number'],
        ['#natsume-scope', 'sessionScope', 'value'],
        ['#natsume-endpoint', 'endpoint', 'value'],
    ];

    for (const [selector, key, kind] of bindings) {
        const element = root.querySelector(selector);
        if (!element) continue;
        if (kind === 'checked') element.checked = Boolean(current[key]);
        else element.value = current[key];

        element.addEventListener('change', () => {
            if (kind === 'checked') current[key] = element.checked;
            else if (kind === 'number') current[key] = Number.parseInt(element.value, 10) || DEFAULT_SETTINGS[key];
            else current[key] = element.value;
            saveSettingsDebounced();
            if (key === 'endpoint' || key === 'sessionScope') refreshServiceState().catch(() => {});
        });
    }

    root.querySelector('#natsume-scene')?.addEventListener('change', (event) => {
        const state = affinity();
        state.scene = event.target.value;
        saveMetadataDebounced();
        pushStage(state.stage, state.scene).then(ok => {
            setStatus(ok ? `场合已同步：${state.scene}` : '场合同步失败，检查 TTS 服务', ok ? 'ok' : 'bad');
        });
    });

    root.querySelector('#natsume-resync')?.addEventListener('click', async () => {
        const state = affinity();
        const ok = await pushStage(state.stage, state.scene);
        setStatus(ok ? `已同步：${state.stage} / ${state.scene}` : '同步失败，检查 TTS 服务', ok ? 'ok' : 'bad');
        renderPanel();
    });

    root.querySelector('#natsume-health')?.addEventListener('click', async () => {
        setStatus('检测中…', 'busy');
        try {
            await checkServiceHealth();
        } catch { /* setStatus 已经写了原因 */ }
    });

    root.querySelector('#natsume-test')?.addEventListener('click', async () => {
        setStatus('测试合成中…', 'busy');
        try {
            const meta = await synthesize('……別に。あんたを待ってたわけじゃない。', 'natsume-default');
            await playUrl(meta.url, -1);
            setStatus(`测试成功：${meta.voice} · 参考 ${meta.refClip} · ${meta.duration.toFixed(2)}s`, 'ok');
        } catch (error) {
            setStatus(`测试失败：${error.message}`, 'bad');
        }
    });

    root.querySelector('#natsume-reset')?.addEventListener('click', () => {
        const state = affinity();
        state.points = 0;
        state.stage = '初识';
        state.scene = '公开';
        state.lastTurnAt = 0;
        saveMetadataDebounced();
        renderPanel();
        pushStage(state.stage, state.scene);
        setStatus('好感度已清零（只影响当前聊天）');
    });
}

function renderPanel() {
    if (!panelRoot) return;
    const state = affinity();
    const points = panelRoot.querySelector('#natsume-points');
    const meter = panelRoot.querySelector('#natsume-meter-fill');
    const stage = panelRoot.querySelector('#natsume-stage');
    const scene = panelRoot.querySelector('#natsume-scene');
    const endpoint = panelRoot.querySelector('#natsume-endpoint');

    if (points) points.textContent = `${state.points}/100`;
    if (meter) meter.style.width = `${Math.max(0, Math.min(100, state.points))}%`;
    if (stage) stage.textContent = state.stage;
    if (scene && scene.value !== state.scene) scene.value = state.scene;
    if (endpoint && document.activeElement !== endpoint) endpoint.value = settings().endpoint || '';
}

/**
 * 「TTS 上线了吗」—— 一次把三件事查清：进程活着、模型加载完、有多少音色。
 * 这比只报「连不上」有用得多：模型还在加载时的表现和进程没起来是一样的，
 * 但处理方式完全不同。
 */
async function checkServiceHealth() {
    const endpoint = resolveEndpoint();
    try {
        const health = await serviceJson('/health');
        if (!health.ready) {
            setStatus(`${endpoint} 有响应，但模型还没加载完（engine_loaded=false）—— 再等十几秒`, 'busy');
            return health;
        }
        let voiceCount = 0;
        try {
            const speakers = await serviceJson('/speakers');
            voiceCount = Array.isArray(speakers) ? speakers.length : 0;
        } catch { /* /speakers 失败不影响结论 */ }
        setStatus(`${endpoint} 在线 · 模型已加载（${health.gpt || '?'}）· ${voiceCount} 个音色`, 'ok');
        return health;
    } catch (error) {
        setStatus(`${endpoint} 连不上：${error.message}`, 'bad');
        throw error;
    }
}

async function refreshServiceState() {
    try {
        const remote = await serviceJson('/state');
        syncStageFromService(remote);
        setStatus(`已连接 ${resolveEndpoint()} · 服务端阶段：${remote.relationship_stage}`, 'ok');
        return remote;
    } catch (error) {
        setStatus(`连不上 TTS 服务（${resolveEndpoint()}）：${error.message}`, 'bad');
        throw error;
    }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

/**
 * 好感度计分的落库与阶段推进。
 *
 * 这里必须自己 try/catch：酒馆的 eventemitter 会**吞掉监听器抛出的异常**
 * （public/lib/eventemitter.js 里逐个监听器 try/catch），
 * 所以哪怕这个函数不存在、或内部报错，页面也一声不响 ——
 * 表现就是「聊了很多次，好感度一次没涨」。这种静默失败必须自己吵出来。
 */
function addAffection(delta, reasons) {
    try {
        if (!delta) return null;
        const state = affinity();
        const before = state.points;
        state.points = Math.max(0, Math.min(100, state.points + delta));
        const nextStage = stageForPoints(state.points);
        const advanced = nextStage !== state.stage;
        if (advanced) state.stage = nextStage;

        saveMetadataDebounced();
        renderPanel();

        if (advanced) {
            setStatus(`好感度 ${before} → ${state.points}，关系推进：${nextStage}`, 'ok');
            if (typeof toastr !== 'undefined') {
                toastr.info(`${state.points}/100 · 关系推进到「${nextStage}」`, '四季夏目');
            }
            pushStage(state.stage, state.scene);
        } else if (reasons?.length) {
            setStatus(`好感度 ${state.points}/100（${delta > 0 ? '+' : ''}${delta}：${reasons.join('、')}）`, 'ok');
        }
        return { points: state.points, stage: state.stage, advanced };
    } catch (error) {
        console.error('[natsume-tts] 好感度更新失败', error);
        setStatus(`好感度更新失败：${error.message}`, 'bad');
        return null;
    }
}

function onMessageSent(mesId) {
    if (!settings().enabled || !settings().markAffection) return;
    const context = SillyTavern.getContext();
    const message = context?.chat?.[mesId];
    if (!message || message.is_user !== true) return;
    const state = affinity();
    const { delta, reasons, lastTurnAt } = scoreUserMessage(message.mes, { lastTurnAt: state.lastTurnAt });
    state.lastTurnAt = lastTurnAt;
    addAffection(delta, reasons);
}

function onCharacterMessageRendered(mesId) {
    const context = SillyTavern.getContext();
    const message = context?.chat?.[mesId];
    if (!message || message.is_user) return;
    const parsed = parseMessage(message.mes);

    if (!parsed.segments.length) {
        // 没有可朗读内容：最常见的原因是「模型把 token 全用在推理上，正文为空」。
        // 这种时候页面会「思考完就没动静」—— 必须把原因说出来，不能静默。
        const reasoning = message.extra?.reasoning || '';
        const empty = !String(message.mes || '').trim();
        if (empty && reasoning) {
            setStatus('她这轮只输出了思考、正文是空的 —— 把「回复长度上限」调大（当前被推理吃光了）', 'bad');
            if (typeof toastr !== 'undefined') {
                toastr.warning('模型只输出了推理内容，正文为空：请调大回复 token 上限', '四季夏目');
            }
        } else if (empty) {
            setStatus('她这轮没有输出内容（回复为空）', 'bad');
        }
        return;
    }

    // 模型自己打的心动值
    if (settings().markAffection && parsed.affection) addAffection(parsed.affection, ['台词心动']);
    if (parsed.scene) {
        const state = affinity();
        if (state.scene !== parsed.scene) {
            state.scene = parsed.scene;
            saveMetadataDebounced();
            pushStage(state.stage, state.scene);
        }
    }
    if (!settings().enabled) return;

    if (settings().autoPlay) {
        // 短消息不藏（藏了像卡顿），长消息才等声音
        const paced = shouldPace(parsed) && hideForPacing(mesId);
        // 串行到播放队列：这样「听」和「读」共用同一条时间线，
        // 上一条还没听完，下一条不会插进来
        audioQueue = audioQueue.then(
            () => prepareAndPlay(parsed, mesId, { reveal: paced }),
            () => prepareAndPlay(parsed, mesId, { reveal: paced }),
        );
        audioQueue.catch((error) => {
            console.error('[natsume-tts] 播放链路出错', error);
            setStatus(`播放失败：${error.message}`, 'bad');
            revealMessage(mesId);       // 出错也要把字放出来
        });
    }
}

function onChatChanged() {
    renderPanel();
    refreshServiceState().catch(() => {});
}

function onMessageDeleted() {
    renderPanel();
}

function bindDelegatedClicks() {
    document.addEventListener('click', (event) => {
        const target = event.target?.closest?.('.natsume-play');
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();

        if (currentAudio) {
            try { currentAudio.pause(); } catch { /* 忽略 */ }
            currentAudio = null;
            return;
        }

        const mesId = Number.parseInt(target.dataset.mesid, 10);
        const context = SillyTavern.getContext();
        const message = context?.chat?.[mesId];
        const parsed = parseMessage(message?.mes || '');
        if (!parsed.segments.length) {
            setStatus('这条消息没有可朗读的日文台词');
            return;
        }
        audioQueue = audioQueue.then(
            () => prepareAndPlay(parsed, mesId, { reveal: false }),
            () => prepareAndPlay(parsed, mesId, { reveal: false }),
        );
    });
}

function onEnable() {
    settings().enabled = true;
    saveSettingsDebounced();
    observer.observe(document.getElementById('chat') || document.body, { childList: true, subtree: true });
}

function onDisable() {
    settings().enabled = false;
    saveSettingsDebounced();
}

async function onActivate() {
    settings();
    configureText({ getSettings: settings });   // text.js 是纯函数模块，设置由这里注入
    await buildPanel();
    onEnable();
    refreshServiceState().catch(() => {});
}

const context = SillyTavern.getContext();
context.eventSource.on(context.event_types.MESSAGE_SENT, onMessageSent);
context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
context.eventSource.on(context.event_types.CHAT_CHANGED, onChatChanged);
context.eventSource.on(context.event_types.MESSAGE_DELETED, onMessageDeleted);
context.eventSource.on(context.event_types.GENERATE_AFTER_DATA, onGenerateAfterData);
bindDelegatedClicks();

// 面板要在设置抽屉容器出现之后再建：早于 APP_READY 时容器可能还不存在。
let activated = false;
async function tryActivate() {
    if (activated) return;
    try {
        await onActivate();
    } catch (error) {
        console.error('[natsume-tts] 初始化失败', error);
        // 失败也要让用户看见：徽章变红并写明原因，而不是「什么都没发生」
        setStatus(`扩展初始化失败：${error.message}`, 'bad');
        return;
    }
    activated = Boolean(panelRoot);
    if (!activated) {
        setTimeout(tryActivate, 1000);
    }
}

// 连不上就每 30 秒自己重试一次：TTS 服务重启、开机没起来，都不用手动刷新页面
const retryTimer = setInterval(() => {
    if (!settings().enabled) return;
    const badge = document.getElementById('natsume-badge');
    if (badge?.dataset.state === 'bad') refreshServiceState().catch(() => {});
}, 30_000);
// 在 node 里跑测试时不要因为这个定时器吊住进程（浏览器里 unref 不存在，所以判一下）
retryTimer?.unref?.();

context.eventSource.on(context.event_types.APP_READY, () => { tryActivate(); });
context.eventSource.on(context.event_types.EXTENSIONS_FIRST_LOAD, () => { tryActivate(); });
setTimeout(() => { tryActivate(); }, 1000);

export { onActivate, onEnable, onDisable };
