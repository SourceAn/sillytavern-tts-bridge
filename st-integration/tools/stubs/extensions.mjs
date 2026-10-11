/**
 * 替身：酒馆的 public/scripts/extensions.js
 * 只实现本扩展用到的那两个导出。
 *
 * 注意设置对象是**共享**的：测试改它就是改扩展读的那份，
 * 不要在测试里另建一个同名对象 —— 那样改了也不生效。
 */
export const extension_settings = (globalThis.__natsumeTestSettings ||= {});
extension_settings['natsume-tts'] ||= {};

export async function renderExtensionTemplateAsync() {
    return '<div></div>';
}

// index.js 从这里导入它（script.js 没有这个导出，那是曾经的 bug）
export function saveMetadataDebounced() {}
