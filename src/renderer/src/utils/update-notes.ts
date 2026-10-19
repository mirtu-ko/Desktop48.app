/** 更新说明预览结果：纯文本行 + 是否被截断。 */
export interface ReleaseNotesPreview {
  lines: string[]
  truncated: boolean
}

/**
 * 把 GitHub Release / electron-updater 的 markdown 说明收敛成纯文本预览。
 * 剥掉标题 / 列表 / 链接 / 加粗等标记，并过滤 GitHub 自动追加的
 * `Full Changelog` 汇总行（它只是 compare 链接的文本形式，不会让用户点击）。
 */
export function previewReleaseNotes(raw: string, maxLines = 4): ReleaseNotesPreview {
  const lines = raw
    .split('\n')
    .map(line => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .trim())
    .filter(line => Boolean(line) && !/^full changelog/i.test(line))

  return { lines: lines.slice(0, maxLines), truncated: lines.length > maxLines }
}
