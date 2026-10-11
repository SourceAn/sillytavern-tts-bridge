/**
 * 替身：酒馆的 public/scripts/script.js
 * 只实现本扩展用到的那几个导出。
 */
function context() {
    return globalThis.SillyTavern.getContext();
}

export const chat_metadata = new Proxy({}, {
    get: (_target, key) => context().chat_metadata[key],
    set: (_target, key, value) => { context().chat_metadata[key] = value; return true; },
    has: (_target, key) => key in context().chat_metadata,
});

export function saveMetadataDebounced() {}
export function saveSettingsDebounced() {}
export function substituteParams(text) { return text; }
export function getRequestHeaders() { return {}; }
