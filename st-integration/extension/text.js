/**
 * 四季夏目 · 文本层（纯函数，不依赖酒馆运行时）
 *
 * 从 index.js 抽出来的原因：这一层最容易被改坏（正则、断句、截断），
 * 而它又完全不碰 DOM / fetch / 酒馆 API —— 抽出来就能用 node 直接跑回归测试
 * （见 tools/test_text.mjs）。
 *
 * 调用方要先 configure({ getSettings }) 把设置来源注入进来。
 */

export const STAGES = [
    { id: '初识', min: 0, hint: '客气、简短、保持距离；被搭话会应付但不热络。' },
    { id: '暧昧初期', min: 20, hint: '开始在意但绝不承认；用吐槽和否认式关心掩盖。' },
    { id: '确认关系', min: 50, hint: '承认了关系，关心变直接但依旧简短、不肉麻。' },
    { id: '亲密期', min: 80, hint: '允许温柔与轻微撒娇；底色仍偏冷、话仍然短。' },
];

export const SCENES = ['公开', '私下', '独处', '被注视', '亲密场景'];

export const ONO_VOICE = [
    { re: /^(はぁ|はあ|ふぅ|ふう|ふー|ため息)/, voice: 'natsume-sigh', label: '叹气' },
    { re: /^(ふふ|ふっ|くす|はは)/, voice: 'natsume-laugh', label: '轻笑' },
    { re: /^(うん|ええ|はい)/, voice: 'natsume-nod', label: '应声' },
    { re: /^(あっ|えっ|うっ|んっ|ひっ)/, voice: 'natsume-surprise', label: '短促' },
    { re: /^(ねぇ|あのね|ちょっと)/, voice: 'natsume-question', label: '招呼' },
];

export const EMOTIONS = {
    neutral: { voice: 'natsume-default', zh: '默认' },
    cold: { voice: 'natsume-cold', zh: '冷淡质问' },
    tsukkomi: { voice: 'natsume-tsukkomi', zh: '冷静吐槽' },
    calm: { voice: 'natsume-calm', zh: '平静叙述' },
    question: { voice: 'natsume-question', zh: '疑问' },
    warm: { voice: 'natsume-warm', zh: '温柔泄露' },
    shy: { voice: 'natsume-shy', zh: '害羞掩饰' },
    low: { voice: 'natsume-low', zh: '独处低落' },
    murmur: { voice: 'natsume-murmur', zh: '小声嘟囔' },
};

export const TAG_RE = /\[\s*(声|音|voice|拟声|ono|译|zh|场景|scene|心动|affection)\s*[:：]?\s*([^\]]*)\]/gi;
export const TAG_TEST = /\[\s*(声|音|voice|拟声|ono|译|zh|场景|scene|心动|affection)\s*[:：]?/i;

export const DEFAULT_TEXT_SETTINGS = {
    splitOnomatopoeia: true,
    maxSegments: 3,
    maxCharsPerSegment: 60,
    showChips: true,
    showChinese: true,
};

let getSettings = () => DEFAULT_TEXT_SETTINGS;

export function configure({ getSettings: provider }) {
    if (typeof provider === 'function') getSettings = provider;
}

export function stageForPoints(points) {
    let current = STAGES[0];
    for (const stage of STAGES) {
        if (points >= stage.min) current = stage;
    }
    return current.id;
}

export function stageIndex(id) {
    const index = STAGES.findIndex(stage => stage.id === id);
    return index < 0 ? 0 : index;
}

/**
 * 把「（动作）后面的台词」这种混排切成两段。
 * 为什么需要：模型常把动作和台词写在相邻两行、且台词末尾没有句号，
 * 分句器会把它们并成一段 —— 那样动作就会被念出来。
 */
export function splitActionRuns(text) {
    const raw = String(text || '');
    const out = [];
    let buffer = '';
    for (const ch of Array.from(raw)) {
        if (ch === '（' || ch === '(') {
            if (buffer.trim()) out.push(buffer);
            buffer = ch;
            continue;
        }
        if ((ch === '）' || ch === ')') && /^[（(]/.test(buffer)) {
            buffer += ch;
            out.push(buffer);
            buffer = '';
            continue;
        }
        buffer += ch;
    }
    if (buffer.trim()) out.push(buffer);
    return out;
}

/**
 * 动作描写行：整段被中文括号包起来、且里面没有日文假名的行。
 * 这类行是给她「演」的旁白，不该送去合成（念出来会变成中文朗读腔）。
 */
export function isActionLine(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    const wrapped = /^[（(][\s\S]*[）)]$/.test(t);
    if (!wrapped) return false;
    return !/[\u3040-\u309f\u30a0-\u30ff]/.test(t);
}

/** 按句末标点断句，保留标点；过滤空白与纯标点。 */
export function splitSentences(text) {
    const out = [];
    let buffer = '';
    for (const ch of Array.from(text)) {
        buffer += ch;
        if ('。！？!?'.includes(ch)) {
            out.push(buffer.trim());
            buffer = '';
        }
    }
    if (buffer.trim()) out.push(buffer.trim());
    return out
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(s => s && /[^\s。、，！？…—・「」『』（）()\[\]{}"']/.test(s));
}

export function clipAtBoundary(chars, limit) {
    const slice = chars.slice(0, limit);
    const breakers = ['。', '！', '？', '、', '，', '…', '!', '?', ' '];
    for (let i = slice.length - 1; i > limit * 0.6; i--) {
        if (breakers.includes(slice[i])) return slice.slice(0, i + 1).join('');
    }
    return slice.join('');
}

/**
 * 把带标签的原文拆成：可朗读片段（含拟声）+ 标签清单 + 译文。
 * 不做「引号抽取」这种猜测——模型按角色卡只输出台词，标签只用来分流。
 */
export function parseMessage(raw) {
    const settings = Object.assign({}, DEFAULT_TEXT_SETTINGS, getSettings() || {});
    const text = String(raw ?? '');
    const tags = [];
    const cleaned = text.replace(TAG_RE, (_match, kind, value) => {
        const key = String(kind).toLowerCase();
        const val = String(value || '').trim();
        tags.push({ kind: key, value: val });
        return (key === '拟声' || key === 'ono') ? `\u0000ONO:${val}\u0000` : '';
    });

    const onomatopoeia = [];
    const translations = [];      // 每一句的 [译:…]，按出现顺序全部保留
    let emotion = 'neutral';
    let scene = null;
    let affection = 0;

    for (const tag of tags) {
        switch (tag.kind) {
            case '声':
            case '音':
            case 'voice': {
                const key = tag.value.toLowerCase();
                if (EMOTIONS[key]) emotion = key;
                break;
            }
            case '译':
            case 'zh':
                if (tag.value) translations.push(tag.value);
                break;
            case '场景':
            case 'scene':
                if (SCENES.includes(tag.value)) scene = tag.value;
                break;
            case '心动':
            case 'affection':
                affection += Number.parseInt(tag.value, 10) || 2;
                break;
            default:
                break;
        }
    }

    // ── 分段策略（2026-09-21 重写）────────────────────────────────────────
    // 用户的要求是「一句一个音声」。旧实现按**句号**全局切分，有三个毛病：
    //   ① 一条台词被切成多段 —— 听感上像"拼接的"；
    //   ② maxSegments 是全局配额，被前几句吃光后，**第二条台词整个丢掉**；
    //   ③ emotion 取"最后一个 [声:]"，导致第一条台词用错音色。
    // 现在改为：**一条台词（一个正文行）= 一个语音单元**，跨行不切；
    // 只有单行超过 maxCharsPerSegment 时才在行内按句读继续切（同一音色）。
    const maxChars = Math.max(4, Number(settings.maxCharsPerSegment) || 60);
    const maxLines = Math.max(1, Number(settings.maxSegments) || 3);
    const segments = [];
    let truncated = 0;

    // ★ 逐行处理必须用**原文**：标签在 cleaned 里已被删掉，
    //   那样逐行扫描永远取不到 [声:]，每条的音色就会全丢（踩过）。
    //   行内的正文/标签/拟声都在这个循环里就地拆。
    const rawLines = text.split('\n');

    const pushSpeech = (text, voice) => {
        if (segments.length >= maxLines) return;      // 只限制台词条数，不再全局配额
        const chars = Array.from(text);
        if (chars.length > maxChars) {
            const clipped = clipAtBoundary(chars, maxChars);
            truncated += chars.length - clipped.length;
            segments.push({ text: clipped, kind: 'speech', voice });
        } else {
            segments.push({ text, kind: 'speech', voice });
        }
    };

    // 模型常把标签写在**台词行的下一行**，所以台词不能立刻定音色：
    // 先挂起（pending），等后面出现 [声:] 或下一条台词时再落定。
    let pending = null;
    const settle = () => {
        if (!pending) return;
        pushSpeech(pending.text, pending.voice);
        // ★ 必须把 voice 清掉：pushSpeech 内部若因超长走了 clip 分支，
        //   会复用同一个对象引用；不清就会让**下一条台词继承上一条的音色**（踩过）。
        pending.voice = null;
        pending = null;
    };

    for (const rawLine of rawLines) {
        // ★ 顺序要紧：必须**先在原始行上**扫 [声:] 与 [拟声:]，
        //   因为下一步的 replace 会把所有标签剥掉。
        let lineVoice = null;
        TAG_RE.lastIndex = 0;
        let mm;
        while ((mm = TAG_RE.exec(rawLine)) !== null) {
            const kind = String(mm[1]).toLowerCase();
            if (kind === '声' || kind === '音' || kind === 'voice') {
                const key = String(mm[2] || '').trim().toLowerCase();
                if (EMOTIONS[key]) lineVoice = key;
            }
        }

        // 剥标签，同时把 [拟声:…] 收集出来
        const onoTexts = [];
        const body = rawLine.replace(TAG_RE, (_m, kind, value) => {
            const k = String(kind).toLowerCase();
            if (k === '拟声' || k === 'ono') {
                const t = String(value || '').trim();
                if (t) onoTexts.push(t);
            }
            return '';
        }).trim();

        if (onoTexts.length && pending && lineVoice) pending.voice = lineVoice;

        for (const ono of onoTexts) {
            onomatopoeia.push(ono);
            if (settings.splitOnomatopoeia) {
                settle();                       // 先落定它所属的那条台词
                segments.push({ text: ono, kind: 'ono', voice: null });
            }
        }

        if (!body) {
            // ★ 只有「纯标签行」才把音色回填给上一条尚未落定的台词。
            //   正文行绝不能回填 —— 否则当前行的 [声:] 会盖掉上一条的音色（踩过，
            //   日志表现为 settle 时 voice 从 cold 变成 shy）。
            if (lineVoice && pending) pending.voice = lineVoice;
            continue;
        }

        if (isActionLine(body)) {
            settle();                                  // ★ 动作行也要落定上一条：
                                                       //   否则上一条一直挂着，被后面每个 [声:] 反复改写
            continue;
        }

        // 新台词开始前，先把上一条落定（它已经吃到了自己的尾随标签）
        settle();
        pending = { text: body, voice: lineVoice || null };
    }

    // 收尾：最后一条挂起的台词
    settle();

    // 兜底：删掉因条数上限而溢出的（上面已用 maxLines 拦住，这里保持返回结构稳定）
    const limited = segments;

    return {
        segments: limited,
        onomatopoeia,
        translations,
        // 兼容旧字段：把所有译文按顺序拼起来（不再只留最后一句）
        translation: translations.join('\n'),
        emotion,
        scene,
        affection,
        truncated,
    };
}

/** 抹掉协议标签，保留拟声词与台词正文（用于显示与上下文清理）。 */
export function stripTags(raw) {
    return String(raw ?? '')
        .replace(TAG_RE, (_match, kind, value) => {
            const key = String(kind).toLowerCase();
            return (key === '拟声' || key === 'ono') ? String(value || '') : '';
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 把消息原文切成「显示用」的行序列：日文行 + 紧跟它的中文对照。
 *
 * 为什么不能只丢一个中文块在末尾：她一条回复常有 1~3 句，每句各有译文；
 * 只显示最后一句会让人以为「没有译文」，显示在末尾则和日文句子对不上号。
 * 规则：译文跟随它前面最近的那个非空正文行。
 */
export function pairLines(raw) {
    const lines = String(raw ?? '').split('\n');
    const out = [];
    let pending = null;                   // 最近一个待配译文的正文行

    const flushPending = () => {
        if (pending !== null) {
            out.push(pending);            // pending 本身就是 {ja, zh}，别把对象塞进 ja
            pending = null;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 收集本行所有 [译:…]
        const zhParts = [];
        TAG_RE.lastIndex = 0;
        let m;
        while ((m = TAG_RE.exec(line)) !== null) {
            const kind = String(m[1]).toLowerCase();
            if ((kind === '译' || kind === 'zh') && String(m[2]).trim()) {
                zhParts.push(String(m[2]).trim());
            }
        }

        const isOnlyTags = line.replace(TAG_RE, '').trim() === '';
        if (isOnlyTags) {
            // 纯标签行（可能带拟声词）：译文挂到前一个正文行上
            if (zhParts.length && pending !== null) {
                pending = { ja: pending.ja, zh: zhParts.join(' ') };
                out.push(pending);
                pending = null;
            } else if (zhParts.length) {
                out.push({ ja: '', zh: zhParts.join(' ') });
            }
            continue;
        }

        const isAction = isActionLine(line);
        if (!isAction) {
            flushPending();
            pending = { ja: line, zh: null };
            if (zhParts.length) {
                pending.zh = zhParts.join(' ');
                out.push(pending);
                pending = null;
            }
        } else if (zhParts.length) {
            // 动作行：正文保留，但译文只在它自己带 [译:] 时才显示
            flushPending();
            out.push({ ja: line, zh: zhParts.join(' ') });
        }
    }

    flushPending();

    // 组装成 HTML：日文行原样（标签抹掉、保留拟声词），中文行单独一行
    return out.map(({ ja, zh }) => {
        const jaText = stripTags(ja);
        const zhHtml = zh ? `<div class="natsume-zh">${escapeHtml(zh)}</div>` : '';
        return jaText ? `${escapeHtml(jaText)}${zhHtml}` : zhHtml;
    }).filter(Boolean).join('<br>');
}

export function voiceFor(segment, emotion) {
    if (segment.kind === 'ono') {
        for (const rule of ONO_VOICE) {
            if (rule.re.test(segment.text)) return rule.voice;
        }
        return 'natsume-low';
    }
    return (EMOTIONS[emotion] || EMOTIONS.neutral).voice;
}

/**
 * 「会被念出来的」日文字符数：只数平假名/片假名/汉字。
 * 标点、括号、空白都不算 —— 它们不产生语音，但会让「字数」看起来超标。
 * 实测合成耗时 ≈ 0.17s × この値（20 字 3.4s / 49 字 9.2s / 79 字 15.2s）。
 */
export function japaneseLength(text) {
    return Array.from(String(text || '')).filter(ch => /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(ch)).length;
}

export function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

// ---------------------------------------------------------------------------
// 好感度（纯计算部分；写回 chat_metadata 由调用方负责）
// ---------------------------------------------------------------------------

export const POSITIVE_HINTS = [
    '谢谢', '多谢', '拜托', '请问', '麻烦你', '辛苦了', '我等你', '陪你', '喜欢',
    '在意', '担心', '想你', '一起', '别勉强', '休息', '慢慢来', '不勉强', '尊重',
    '对不起', '抱歉', '我请', '给你', '送你', '注意身体',
];

export const NEGATIVE_HINTS = [
    '闭嘴', '滚开', '烦人', '讨厌你', '蠢', '笨', '白痴', '恶心', '少管', '命令你',
    '必须', '废物', '垃圾', '跪下',
];

/**
 * 好感度规则（三条都印在设置面板上，不做暗箱）：
 *   +1 每轮对话（60 秒内连发只算一次）
 *   +1 用户消息 ≥ 12 字（认真说话）
 *   +1 命中礼貌/关心词；-1 命中冒犯词
 *   +[心动:n] 由模型标记时额外给（在 index.js 处理）
 */
export function scoreUserMessage(text, { lastTurnAt = 0, now = Date.now() } = {}) {
    const reasons = [];
    let delta = 0;

    if (now - Number(lastTurnAt || 0) > 60_000) {
        delta += 1;
        reasons.push('新回合 +1');
    }
    const content = String(text || '');
    if (Array.from(content.replace(/\s+/g, '')).length >= 12) {
        delta += 1;
        reasons.push('认真说话 +1');
    }
    if (POSITIVE_HINTS.some(word => content.includes(word))) {
        delta += 1;
        reasons.push('礼貌关心 +1');
    }
    if (NEGATIVE_HINTS.some(word => content.includes(word))) {
        delta -= 1;
        reasons.push('冒犯 -1');
    }
    return { delta, reasons, lastTurnAt: now };
}

/** 生成前注入的 <natsume_state> 段落。 */
export function affinityBlock(state) {
    const stage = STAGES[stageIndex(state.stage)];
    const next = STAGES[stageIndex(state.stage) + 1];
    const lines = [
        '<natsume_state>',
        `好感度：${state.points}/100　关系阶段：${state.stage}　场合：${state.scene}`,
        `本阶段语气要求：${stage.hint}`,
        next
            ? `距「${next.id}」还差 ${Math.max(0, next.min - state.points)} 点——没到就别演出更亲密的语气。`
            : '已是最终阶段：依旧简短克制，不写肉麻长句。',
        '</natsume_state>',
    ];
    return lines.join('\n');
}
