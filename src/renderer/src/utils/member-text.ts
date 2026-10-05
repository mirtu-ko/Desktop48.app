/**
 * 成员自由文本字段的解析（纯函数：无状态、无 DOM，可脱离 Electron 直接单测）。
 *
 * 接口下发的是「人写的」文本，分隔符和换行都不规整，解析口径收在这里，
 * 页面与详情抽屉共用同一份，不各写一遍 split。
 */

/** 特长 / 兴趣爱好的分隔符：中英文逗号、顿号、分号、斜杠、竖线都出现过 */
const TAG_SPLIT_REGEX = /[,，、;；/|]+/

/** 经历字段的换行标记：接口用 <br> / <br/> 分行 */
const EXPERIENCE_BREAK_REGEX = /<br\s*\/?>/i

/**
 * 自由文本 → 药丸标签数组：按常见分隔符拆分、去空白、丢空项。
 * 空值返回空数组（模板里靠 length 判断要不要渲染这一块）。
 */
export function toTags(value: string | undefined): string[] {
  return (value || '').split(TAG_SPLIT_REGEX).map(tag => tag.trim()).filter(Boolean)
}

/**
 * 经历 → 行数组：按 <br> 拆行后去空白、丢空行。
 * 返回数组而不是拼 HTML —— 模板用 v-for 逐行渲染，避免 v-html 引入 XSS。
 */
export function toExperienceLines(value: string | undefined): string[] {
  return (value || '').split(EXPERIENCE_BREAK_REGEX).map(line => line.trim()).filter(Boolean)
}
