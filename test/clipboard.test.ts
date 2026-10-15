/**
 * 剪贴板写入（utils/clipboard.ts）：主路径 navigator.clipboard、
 * 权限被拒 / 环境不支持时退回 textarea + execCommand。
 *
 * 测试环境是 node（无 DOM），document / navigator 全部用桩：
 * 断言的重点不是「真的复制成功」，而是「失败时是否退回」与「是否静默吞掉异常」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/renderer/src/utils/clipboard'

/** 兜底路径用到的 document 桩：只实现 createElement / body / execCommand */
function stubLegacyDocument(copyResult: boolean, copyThrows = false) {
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
  }
  const body = { appendChild: vi.fn(), removeChild: vi.fn() }
  const execCommand = vi.fn(() => {
    if (copyThrows)
      throw new Error('execCommand 不可用')
    return copyResult
  })
  vi.stubGlobal('document', { createElement: vi.fn(() => area), body, execCommand })
  return { area, body, execCommand }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clipboard / copyText', () => {
  it('空白内容直接判失败，不碰剪贴板', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('   ')).toBe(false)
    expect(await copyText('')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('主路径：navigator.clipboard 写入并去掉首尾空白', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    stubLegacyDocument(true)
    expect(await copyText('  https://mp4.48.cn/a.mp4  ')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://mp4.48.cn/a.mp4')
  })

  it('环境没有 clipboard 时走 textarea 兜底', async () => {
    vi.stubGlobal('navigator', {})
    const { area, execCommand } = stubLegacyDocument(true)
    expect(await copyText('兜底内容')).toBe(true)
    expect(area.value).toBe('兜底内容')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('clipboard 被拒（如窗口失焦）时退回兜底，仍能复制成功', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { body, execCommand } = stubLegacyDocument(true)
    expect(await copyText('被拒后的内容')).toBe(true)
    expect(writeText).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalled()
    // 兜底的 textarea 用完必须移除，否则留在 DOM 里会抢焦点
    expect(body.removeChild).toHaveBeenCalled()
  })

  it('两条路径都失败时返回 false，不把异常抛给调用方', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    stubLegacyDocument(true, true)
    expect(await copyText('终究失败的内容')).toBe(false)
  })
})
