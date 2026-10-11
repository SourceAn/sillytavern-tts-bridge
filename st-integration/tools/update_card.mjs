/**
 * 原地更新酒馆里已存在的角色卡（不新建、不删聊天记录）。
 *
 * ⚠️ 踩过的坑（务必保留这段说明）：
 *   `/api/characters/edit` 的服务端用 `charaFormatData()` 重建整张卡，它从**独立表单字段**
 *   取值，例如 `_.set(char, 'data.system_prompt', data.system_prompt || '')`。
 *   `json_data` 只是基底。所以**只发 json_data 会把没发的字段清成空字符串** ——
 *   我第一次就是这么把这张卡的 system_prompt 抹掉的。
 *
 *   结论：必须把卡里每个字段都按服务端期望的**字段名**发过去。
 *
 * 用法：
 *   node tools/update_card.mjs --avatar 四季夏目.png --spec card/natsume.card.json --dry-run
 *   node tools/update_card.mjs --avatar 四季夏目.png --spec card/natsume.card.json
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = value('--base', process.env.ST_URL || 'http://127.0.0.1:8000');
const USER = value('--user', process.env.ST_USER || 'harness');
const PASS = value('--pass', process.env.ST_PASS || 'Nu1ThBFsnmqb08FUk9jVNB7D');
const AVATAR = value('--avatar');
const SPEC = value('--spec', join(here, '..', 'card', 'natsume.card.json'));
const IMAGE = value('--image', join(here, '..', 'card', '四季夏目.png'));
const DRY = flag('--dry-run');

if (!AVATAR) {
    console.error('需要 --avatar <角色卡文件名，含 .png>');
    process.exit(2);
}

const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const authHeaders = { Authorization: auth };

async function csrf() {
    const res = await fetch(`${BASE}/csrf-token`, { headers: authHeaders });
    if (!res.ok) throw new Error(`csrf-token 失败: ${res.status}`);
    const { token } = await res.json();
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { token, cookie };
}

async function call(path, { form, json, token, cookie } = {}) {
    const headers = { ...authHeaders, Cookie: cookie };
    if (token) headers['X-CSRF-Token'] = token;
    if (json) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: form ?? (json ? JSON.stringify(json) : undefined) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const session = await csrf();
const getCard = () => call('/api/characters/get', { json: { avatar_url: AVATAR }, ...session });

/**
 * 把「读回来的卡」翻译成服务端期望的表单字段。
 * 字段名取自 charaFormatData() 读取的名字；漏一个就会把它清空。
 */
function cardToForm(card) {
    const d = card.data || {};
    const ext = d.extensions || {};
    return {
        ch_name: card.name ?? d.name ?? '',
        description: card.description ?? d.description ?? '',
        personality: card.personality ?? d.personality ?? '',
        scenario: card.scenario ?? d.scenario ?? '',
        first_mes: card.first_mes ?? d.first_mes ?? '',
        mes_example: card.mes_example ?? d.mes_example ?? '',
        creator_notes: card.creator_notes ?? d.creator_notes ?? '',
        system_prompt: d.system_prompt ?? '',
        post_history_instructions: d.post_history_instructions ?? '',
        creator: card.creator ?? d.creator ?? '',
        character_version: card.character_version ?? d.character_version ?? '',
        tags: Array.isArray(card.tags) ? card.tags.join(', ') : (card.tags ?? ''),
        talkativeness: String(ext.talkativeness ?? 0.5),
        fav: String(ext.fav ?? false),
        depth_prompt_prompt: ext.depth_prompt?.prompt ?? '',
        depth_prompt_depth: String(ext.depth_prompt?.depth ?? 4),
        depth_prompt_role: ext.depth_prompt?.role ?? 'system',
        // 服务端会把 data.extensions 与这个 JSON 深合并；空对象安全
        extensions: JSON.stringify({}),
        // ★ 不发 world：一旦发了，服务端会用世界书文件覆盖我们附带的 character_book
        alternate_greetings: JSON.stringify(card.alternate_greetings || d.alternate_greetings || []),
        avatar_url: AVATAR,
        json_data: JSON.stringify(card),   // 基底：保住 character_book 等未知字段
    };
}

const before = await getCard();
console.log('读回现有卡 :', before.name, '| system_prompt', (before.data?.system_prompt || '').length, '字');
console.log('目标 spec  :', 'system_prompt', spec.data.system_prompt.length, '字');

const next = JSON.parse(JSON.stringify(before));
next.data.system_prompt = spec.data.system_prompt;
next.data.character_book = spec.data.character_book;

const form = new FormData();
for (const [k, v] of Object.entries(cardToForm(next))) form.append(k, v);
form.append('avatar', new Blob([readFileSync(IMAGE)], { type: 'image/png' }), basename(AVATAR));

console.log('\n将提交的表单字段:');
for (const [k, v] of form.entries()) {
    if (typeof v === 'string') {
        const shown = k === 'json_data' ? `${v.length} 字节` : (v.length > 40 ? `${v.slice(0, 37)}…` : v);
        console.log(`  ${k.padEnd(26)} ${shown}`);
    } else {
        console.log(`  ${k.padEnd(26)} <文件 ${v.name} ${v.size} 字节>`);
    }
}

if (DRY) {
    console.log('\n（--dry-run：不写回）');
    process.exit(0);
}

await call('/api/characters/edit', { form, ...session });

const after = await getCard();
const problems = [];
const checks = [
    ['name', after.name, before.name],
    ['description', after.description, before.description],
    ['personality', after.personality, before.personality],
    ['scenario', after.scenario, before.scenario],
    ['first_mes', after.first_mes, before.first_mes],
    ['mes_example', after.mes_example, before.mes_example],
    ['creator_notes', after.creator_notes, before.creator_notes],
    ['data.system_prompt', after.data?.system_prompt, spec.data.system_prompt],
    ['data.post_history_instructions', after.data?.post_history_instructions, before.data?.post_history_instructions],
    ['世界书条目数', after.data?.character_book?.entries?.length, spec.data.character_book.entries.length],
];
console.log('\n复核:');
for (const [label, got, want] of checks) {
    const ok = String(got ?? '') === String(want ?? '');
    if (!ok) problems.push(label);
    const shown = String(got ?? '').slice(0, 36).replace(/\n/g, ' ');
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(30)} ${shown}${ok ? '' : `  ← 期望 ${String(want ?? '').slice(0, 36)}`}`);
}

if (problems.length) {
    console.error(`\n❌ 有字段不一致：${problems.join(', ')}`);
    process.exit(1);
}
console.log('\n✅ 原地更新完成，所有字段一致，聊天记录未动');
