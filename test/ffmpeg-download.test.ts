import { describe, expect, it, vi } from 'vitest'
import { pickFfmpegSource } from '../src/main/ffmpeg/ffmpeg-download'

// ffmpeg-download 顶层引入 electron（app/net）与 ipc/trace（ipcMain），
// 纯 Node 测试环境用空实现替换；被测的 pickFfmpegSource 是纯函数，不依赖它们
vi.mock('electron', () => ({ app: {}, net: {}, ipcMain: {} }))

describe('ffmpeg-download.pickFfmpegSource', () => {
  it('darwin arm64（Apple Silicon）选择 darwin-arm64 构建，落盘为 ffmpeg', () => {
    const source = pickFfmpegSource('darwin', 'arm64')
    expect(source.url).toBe('https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-darwin-arm64.gz')
    expect(source.filename).toBe('ffmpeg')
  })

  it('darwin x64（Intel）选择 darwin-x64 构建', () => {
    const source = pickFfmpegSource('darwin', 'x64')
    expect(source.url).toContain('ffmpeg-darwin-x64.gz')
    expect(source.filename).toBe('ffmpeg')
  })

  it('windows 一律 win32-x64，落盘为 ffmpeg.exe', () => {
    const source = pickFfmpegSource('win32', 'x64')
    expect(source.url).toContain('ffmpeg-win32-x64.gz')
    expect(source.filename).toBe('ffmpeg.exe')
  })

  it('linux 区分 x64 与 arm64', () => {
    expect(pickFfmpegSource('linux', 'x64').url).toContain('ffmpeg-linux-x64.gz')
    expect(pickFfmpegSource('linux', 'arm64').url).toContain('ffmpeg-linux-arm64.gz')
  })

  it('未知平台抛出可读错误', () => {
    expect(() => pickFfmpegSource('sunos', 'x64')).toThrow('暂不支持的平台')
  })
})
