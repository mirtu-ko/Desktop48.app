import { describe, expect, it } from 'vitest'
import { previewReleaseNotes } from '../src/renderer/src/utils/update-notes'

describe('previewReleaseNotes', () => {
  it('把 markdown 链接收敛成纯文本，并过滤 GitHub 自动生成的 Full Changelog 行', () => {
    const result = previewReleaseNotes('**Full Changelog**: [v0.2.4...v0.2.5](https://github.com/mirtu-ko/Desktop48.app/compare/v0.2.4...v0.2.5)\n- 修复播放器闪退\n\n### What Changed')
    expect(result.lines).toEqual(['修复播放器闪退', 'What Changed'])
    expect(result.truncated).toBe(false)
  })

  it('超过 4 行时报 truncated，让 UI 提示去 Release 页看完整内容', () => {
    const content = Array.from({ length: 6 }, (_, index) => `- 第 ${index + 1} 项`)
    const result = previewReleaseNotes(content.join('\n'))
    expect(result.lines).toHaveLength(4)
    expect(result.truncated).toBe(true)
  })

  it('空内容返回空结果', () => {
    expect(previewReleaseNotes('')).toEqual({ lines: [], truncated: false })
  })
})
