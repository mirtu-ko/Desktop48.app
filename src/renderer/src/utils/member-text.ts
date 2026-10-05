/** 成员自由文本字段的解析（纯函数，可脱离 Electron 单测）。解析口径收在这里，页面与详情抽屉共用 */

/** 特长 / 兴趣爱好的分隔符：中英文逗号、顿号、分号、斜杠、竖线都出现过 */
const TAG_SPLIT_REGEX = /[,，、;；/|]+/

/** 经历字段的换行标记：接口用 <br> / <br/> 分行 */
const EXPERIENCE_BREAK_REGEX = /<br\s*\/?>/i

/** 自由文本 → 药丸标签数组：按常见分隔符拆分、去空白、丢空项 */
export function toTags(value: string | undefined): string[] {
  return (value || '').split(TAG_SPLIT_REGEX).map(tag => tag.trim()).filter(Boolean)
}

/** 经历 → 行数组：按 <br> 拆行后去空白、丢空行。返回数组而非拼 HTML，避免 v-html 引入 XSS */
export function toExperienceLines(value: string | undefined): string[] {
  return (value || '').split(EXPERIENCE_BREAK_REGEX).map(line => line.trim()).filter(Boolean)
}
