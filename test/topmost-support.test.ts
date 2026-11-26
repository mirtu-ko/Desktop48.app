import { describe, expect, it } from 'vitest'
import { computeTopmostSupported } from '../src/main/window/topmost-support'

describe('computeTopmostSupported（置顶能力判定）', () => {
  it('windows 与 macOS 原生支持应用内窗口置顶', () => {
    expect(computeTopmostSupported('win32')).toBe(true)
    expect(computeTopmostSupported('darwin')).toBe(true)
  })

  it('linux 不提供应用内窗口置顶（由系统窗口菜单承担）', () => {
    expect(computeTopmostSupported('linux')).toBe(false)
  })
})
