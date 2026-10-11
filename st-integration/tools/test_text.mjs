/**
 * 文本层回归测试：直接跑酒馆扩展里的 text.js（不是副本）。
 *
 *   node tools/test_text.mjs
 *
 * 覆盖：标签解析、断句、拟声分流、超长截断、标签剥离、好感度计分、阶段换算、状态注入。
 * 这些都是「猜错就悄悄坏掉」的地方 —— 坏了不会报错，只会让她说错话或不出声。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
// here = .../Code/Harness/Natsume_TTS/st-integration/tools
//   ↑1 st-integration ↑2 Natsume_TTS ↑3 Harness ↑4 Code
const CODE_DIR = join(here, '..', '..', '..', '..');
const extensionDir = join(CODE_DIR, 'SillyTavern', 'data', 'default-user', 'extensions', 'natsume-tts');
const natsumeRoot = join(here, '..', '..');

const source = readFileSync(join(extensionDir, 'text.js'), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

mod.configure({
    getSettings: () => ({
        splitOnomatopoeia: true,
        maxSegments: 3,
        maxCharsPerSegment: 60,
        showChips: true,
        showChinese: true,
    }),
});

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✅ ${name}`);
    } catch (error) {
        failures.push({ name, message: error.message });
        console.log(`  ❌ ${name}\n     ${error.message}`);
    }
}

console.log('\n【1】协议标签解析');

const firstMes = [
    '……いらっしゃいませ。',
    '[声:cold][译:……欢迎光临。]',
    '',
    '（她把菜单放到你面前，指尖在纸面上停了半秒）',
    '[声:calm][译:（她把菜单放到你面前）]',
    '',
    '……別に。あんたを待ってたわけじゃない。',
    '[声:tsukkomi][拟声:ふぅ][译:……没什么。我又不是在等你。]',
].join('\n');

test('开场白：按「一条台词行 = 一个语音单元」分段（动作行不出声）', () => {
    const parsed = mod.parseMessage(firstMes);
    const speech = parsed.segments.filter(s => s.kind === 'speech').map(s => s.text);
    const ono = parsed.segments.filter(s => s.kind === 'ono').map(s => s.text);
    assert.equal(speech.length, 2, `开场白 4 行里有 1 行是中文动作行，应剩 2 条台词，实际 ${speech.length}：${JSON.stringify(speech)}`);
    assert.deepEqual(ono, ['ふぅ'], `拟声段应为 ['ふぅ']，实际 ${JSON.stringify(ono)}`);
    assert.equal(parsed.emotion, 'tsukkomi', '最后出现的 [声:…] 胜出');
    // ★ 译文必须全部保留：以前只留最后一句，用户会以为「没有译文」
    assert.deepEqual(parsed.translations,
        ['……欢迎光临。', '（她把菜单放到你面前）', '……没什么。我又不是在等你。'],
        `每句的 [译:…] 都要收进来，实际 ${JSON.stringify(parsed.translations)}`);
    assert.equal(parsed.translation.split('\n').length, 3, 'translation 兼容字段应是全部译文的拼接');
});

test('中文括号动作行不会被当成台词念出来', () => {
    const parsed = mod.parseMessage(firstMes);
    const all = parsed.segments.map(s => s.text).join('|');
    assert.ok(!all.includes('她把菜单'), `动作行漏进朗读文本：${all}`);
});

test('拟声词映射到专用音色角度', () => {
    const cases = [
        ['はぁ', 'natsume-sigh'],
        ['ふふっ', 'natsume-laugh'],
        ['うん', 'natsume-nod'],
        ['あっ', 'natsume-surprise'],
        ['んっ', 'natsume-surprise'],
    ];
    for (const [text, expected] of cases) {
        const voice = mod.voiceFor({ text, kind: 'ono' }, 'neutral');
        assert.equal(voice, expected, `${text} 应映射到 ${expected}，实际 ${voice}`);
    }
});

test('未登记的情绪角度回落 neutral', () => {
    assert.equal(mod.voiceFor({ text: 'テスト。', kind: 'speech' }, 'nonsense'), 'natsume-default');
    assert.equal(mod.voiceFor({ text: 'テスト。', kind: 'speech' }, 'murmur'), 'natsume-murmur');
});

console.log('\n【2】长度约束（TTS 可合成性）');

test('超过每段上限的句子被截断，并如实报告截掉多少字', () => {
    const long = 'あ'.repeat(80) + '。';
    const parsed = mod.parseMessage(`[声:calm]${long}`);
    assert.ok(parsed.segments.length >= 1);
    const len = mod.japaneseLength(parsed.segments[0].text);
    assert.ok(len <= 60, `截断后应 ≤ 60 字，实际 ${len}`);
    assert.ok(parsed.truncated > 0, 'truncated 应记录被截字数');
});

test('同一行不按句号切（一条台词 = 一段），且不超过条数上限', () => {
    // 一行 5 句、总长 < 60：应合成 **1 段**（旧实现按句号切成 5 段，听感是"拼接"）
    const one = mod.parseMessage('[声:calm]いち。に。さん。よん。ご。');
    assert.equal(one.segments.length, 1, `同一行只应 1 段，实际 ${one.segments.length}`);
    // 5 行台词：受 maxSegments=3 限制，只取前 3 条
    const many = mod.parseMessage(
        ['[声:calm]いち。', '[声:calm]に。', '[声:calm]さん。', '[声:calm]よん。', '[声:calm]ご。'].join('\n'));
    assert.equal(many.segments.length, 3, `应只保留 3 条台词，实际 ${many.segments.length}`);
});

test('每条台词带自己的 [声:]，不串音色', () => {
    const src = ['……ワタシのため、とか。そういうの、やめてよ。', '[声:tsukkomi][译:……说什么为了我。]',
                 '', '……でも。まあ、気持ちは、無駄じゃなかったけど。', '[声:shy][译:……不过。]'].join('\n');
    const parsed = mod.parseMessage(src);
    assert.equal(parsed.segments.length, 2, `应 2 段，实际 ${parsed.segments.length}`);
    assert.equal(parsed.segments[0].voice, 'tsukkomi', `第 1 条应是 tsukkomi，实际 ${parsed.segments[0].voice}`);
    assert.equal(parsed.segments[1].voice, 'shy', `第 2 条应是 shy，实际 ${parsed.segments[1].voice}`);
});

test('标签写在同一行也能取到音色', () => {
    const parsed = mod.parseMessage(['こんにちは。[声:cold][译:你好。]', '', 'さようなら。[声:shy][译:再见。]'].join('\n'));
    assert.deepEqual(parsed.segments.map(x => x.voice), ['cold', 'shy']);
});

test('截断优先切在句读处（句读落在后半段时）', () => {
    const text = 'あ'.repeat(40) + '、' + 'い'.repeat(40);
    const parsed = mod.parseMessage(`[声:calm]${text}`);
    assert.ok(parsed.segments[0].text.endsWith('、'),
        `应在「、」处收尾，实际结尾：${parsed.segments[0].text.slice(-3)}`);
});

test('句读落在前半段时不做无意义的强切，宁可切在字数上限', () => {
    // 「、」在 61 字的第 31 位：在它前面收尾反而丢掉后半句的大半内容
    const text = 'あ'.repeat(30) + '、' + 'い'.repeat(30);
    const parsed = mod.parseMessage(`[声:calm]${text}`);
    assert.equal(Array.from(parsed.segments[0].text).length, 60, '应切满字数上限');
    assert.equal(mod.japaneseLength(parsed.segments[0].text), 59, 'japaneseLength 不数标点');
    assert.equal(parsed.truncated, 1, '只应丢掉 1 个字');
});

test('japaneseLength 不计空白', () => {
    assert.equal(mod.japaneseLength('あ い\nう'), 3);
});

console.log('\n【3】显示层：标签必须被抹掉');

test('stripTags 保留拟声词、抹掉其它标签', () => {
    const out = mod.stripTags('……別に。\n[声:tsukkomi][拟声:ふぅ][译:……没什么。]\n[心动]');
    assert.ok(!out.includes('[声'), '仍残留 [声:…]');
    assert.ok(!out.includes('[译'), '仍残留 [译:…]');
    assert.ok(!out.includes('[心动]'), '仍残留 [心动]');
    assert.ok(out.includes('ふぅ'), '拟声词应保留在正文里');
    assert.ok(out.includes('……別に。'), '台词本体应保留');
});

test('TAG_TEST 能识别中文全角冒号写法', () => {
    assert.ok(mod.TAG_TEST.test('[声：cold]'));
    assert.ok(mod.TAG_TEST.test('[拟声:はぁ]'));
    assert.ok(!mod.TAG_TEST.test('普通的一句话。'));
});

console.log('\n【4】好感度');

test('新回合 +1，且 lastTurnAt 被推进', () => {
    const r = mod.scoreUserMessage('在吗', { lastTurnAt: 0, now: 1_000_000 });
    assert.equal(r.delta, 1, `应为 +1，实际 ${r.delta}`);
    assert.equal(r.lastTurnAt, 1_000_000);
});

test('60 秒内连发不重复计回合分', () => {
    const r = mod.scoreUserMessage('在吗', { lastTurnAt: 1_000_000, now: 1_030_000 });
    assert.equal(r.delta, 0, `应不再计回合分，实际 ${r.delta}（${r.reasons}）`);
});

test('长消息 + 礼貌词叠加，冒犯词扣分', () => {
    const nice = mod.scoreUserMessage('今天辛苦了，我先去把外面的灯关掉，你慢慢收拾就好。', { lastTurnAt: 1, now: 9_999_999 });
    assert.equal(nice.delta, 3, `礼貌长消息应 +3，实际 ${nice.delta}（${nice.reasons}）`);
    const rude = mod.scoreUserMessage('闭嘴，少管我，你这笨蛋。', { lastTurnAt: 1, now: 9_999_999 });
    assert.ok(rude.delta < 3, `冒犯消息应被扣分，实际 ${rude.delta}`);
});

test('阶段门槛换算正确', () => {
    assert.equal(mod.stageForPoints(0), '初识');
    assert.equal(mod.stageForPoints(19), '初识');
    assert.equal(mod.stageForPoints(20), '暧昧初期');
    assert.equal(mod.stageForPoints(49), '暧昧初期');
    assert.equal(mod.stageForPoints(50), '确认关系');
    assert.equal(mod.stageForPoints(80), '亲密期');
    assert.equal(mod.stageForPoints(100), '亲密期');
});

console.log('\n【5】生成前注入');

test('affinityBlock 含点数、阶段、下一阶段差值与阶段要求', () => {
    const block = mod.affinityBlock({ points: 25, stage: '暧昧初期', scene: '私下' });
    assert.ok(block.startsWith('<natsume_state>') && block.endsWith('</natsume_state>'));
    assert.ok(block.includes('25/100'));
    assert.ok(block.includes('暧昧初期'));
    assert.ok(block.includes('私下'));
    assert.ok(block.includes('还差 25 点'), `应算出距确认关系还差 25 点：${block}`);
});

test('最终阶段不再提示「下一阶段」', () => {
    const block = mod.affinityBlock({ points: 100, stage: '亲密期', scene: '独处' });
    assert.ok(block.includes('已是最终阶段'), block);
});

console.log('\n【5.5】译文渲染：日文行 + 紧跟的中文对照');

test('每句译文跟在它自己的日文行后面（不是堆在末尾）', () => {
    const src = '……こんにちは。で、何か用？\n[声:cold][译:……你好。所以，有什么事吗？]\n\n注文が決まったら、呼んで。\n[声:calm][译:决定好点什么了，就叫我。]';
    const html = mod.pairLines(src);
    const lines = html.split('<br>').filter(Boolean);
    assert.equal(lines.length, 2, `应是 2 行（每行 = 日文 + 该行译文），实际 ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes('こんにちは') && lines[0].includes('你好'), '第 1 行 = 第 1 句日文 + 它的中文');
    assert.ok(lines[1].includes('呼んで') && lines[1].includes('就叫我'), '第 2 行 = 第 2 句日文 + 它的中文');
    assert.ok(lines[0].indexOf('こんにちは') < lines[0].indexOf('你好'), '中文在该行日文之后');
});

test('没有标签的消息不会渲染成 [object Object]', () => {
    const html = mod.pairLines('……苦いのは、好んで飲まないだけ。\n\n……あんたこそ、どうするの。');
    assert.ok(!html.includes('[object Object]'), `渲染结果被对象污染：${html}`);
    assert.ok(html.includes('苦いのは'), '正文要保留');
});

test('动作行的译文也能单独成行', () => {
    const html = mod.pairLines('（她把菜单放到你面前）\n[声:calm][译:（她把菜单放到你面前）]');
    assert.ok(html.includes('她把菜单放到你面前'), '动作行正文保留');
    assert.ok(html.includes('natsume-zh'), '动作行的译文也要显示');
});

console.log('\n【6】节奏同步的判定（先出声后出字）');

test('短消息不藏字（藏了像卡顿）', () => {
    const parsed = mod.parseMessage('[声:calm]……別に。');
    const chars = parsed.segments.reduce((n, seg) => n + mod.japaneseLength(seg.text), 0);
    assert.ok(chars < 30, `这篇样例应低于藏字阈值，实际 ${chars} 字`);
});

test('长消息字数统计会把拟声段也算进去', () => {
    const parsed = mod.parseMessage('[声:calm]' + 'あ'.repeat(40) + '。[拟声:はぁ]');
    const chars = parsed.segments.reduce((n, seg) => n + mod.japaneseLength(seg.text), 0);
    assert.ok(chars >= 40, `应统计到 40 字以上，实际 ${chars}`);
});

console.log('\n【7】与 TTS 服务的声音对齐');

test('扩展里的每个音色角度，服务端 st_voices.py 都有', () => {
    const stVoices = readFileSync(
        join(natsumeRoot, '_run', 'st_voices.py'),
        'utf8',
    );
    const declared = [...stVoices.matchAll(/"(natsume-[a-z]+)":\s*\(/g)].map(m => m[1]);
    const used = new Set([
        ...Object.values(mod.EMOTIONS).map(e => e.voice),
        ...mod.ONO_VOICE.map(r => r.voice),
    ]);
    const missing = [...used].filter(v => !declared.includes(v));
    assert.deepEqual(missing, [], `扩展用到但服务端没有的角度：${missing.join(', ')}`);
    console.log(`     服务端 ${declared.length} 个角度，扩展用到 ${used.size} 个，全部对上`);
});

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败\n`);
if (failures.length) {
    for (const f of failures) console.log(`  ❌ ${f.name}: ${f.message}`);
    process.exit(1);
}
