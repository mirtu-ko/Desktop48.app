import type { FfmpegProblem } from '@preload/ipc-contract'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ffmpegBinaryPath, inspectFfmpegDir, resolveFfmpegBinary } from '../src/main/ffmpeg/ffmpeg-process'
import { describeFfmpegProblem } from '../src/renderer/src/composables/use-ffmpeg-setup'

// use-ffmpeg-setup 顶层引入 element-plus（提示）与 use-app-config（打开目录），
// 被测的 describeFfmpegProblem 是纯函数，把提示替换成空实现即可
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))

describe('inspectFfmpegDir（FFmpeg 就绪判定的唯一口径）', () => {
  let workDir = ''

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-status-'))
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('未配置（空串 / 全空白）判定为 unset，且不返回目录', () => {
    for (const dir of ['', '   ']) {
      const status = inspectFfmpegDir(dir)
      expect(status.ok).toBe(false)
      expect(status.problem).toBe('unset')
      expect(status.directory).toBe('')
    }
  })

  it('目录不存在判定为 missing-dir，并保留原路径供提示使用', () => {
    const missing = path.join(workDir, 'not-created')
    const status = inspectFfmpegDir(missing)
    expect(status).toMatchObject({ ok: false, problem: 'missing-dir', directory: missing, binaryPath: '' })
  })

  it('目录存在但没有可执行文件判定为 missing-binary', () => {
    const status = inspectFfmpegDir(workDir)
    expect(status).toMatchObject({ ok: false, problem: 'missing-binary', directory: workDir, binaryPath: '' })
  })

  it('目录内存在 ffmpeg 可执行文件时才判定为就绪，并给出完整路径', () => {
    const binary = ffmpegBinaryPath(workDir)
    fs.writeFileSync(binary, '')

    const status = inspectFfmpegDir(workDir)
    expect(status).toMatchObject({ ok: true, problem: null, directory: workDir, binaryPath: binary })
  })

  it('判定通过后 resolveFfmpegBinary 返回同一路径（拉流 / 任务链路共用该结论）', () => {
    const binary = ffmpegBinaryPath(workDir)
    fs.writeFileSync(binary, '')
    expect(resolveFfmpegBinary(workDir)).toBe(binary)
  })

  it('不可用时 resolveFfmpegBinary 抛出的信息与原因一一对应', () => {
    expect(() => resolveFfmpegBinary('')).toThrow('尚未设置 ffmpeg 目录')
    expect(() => resolveFfmpegBinary(path.join(workDir, 'not-created'))).toThrow('ffmpeg 目录不存在')
    expect(() => resolveFfmpegBinary(workDir)).toThrow('ffmpeg 二进制文件不存在')
  })
})

describe('describeFfmpegProblem（状态 → 用户文案）', () => {
  it('三类不可用原因给出各自的状态标签与下一步动作', () => {
    const cases: Array<[FfmpegProblem, string]> = [
      ['unset', '未配置'],
      ['missing-dir', '目录不存在'],
      ['missing-binary', '缺少 ffmpeg'],
    ]
    for (const [problem, label] of cases) {
      const copy = describeFfmpegProblem(problem, '/Users/z/ffmpeg')
      expect(copy.label).toBe(label)
      expect(copy.title).not.toBe('')
      expect(copy.action).toContain('FFmpeg 目录')
    }
  })

  it('失效类原因在说明里带上具体路径，用户能直接照着找', () => {
    expect(describeFfmpegProblem('missing-dir', '/Users/z/ffmpeg').hint).toContain('/Users/z/ffmpeg')
    expect(describeFfmpegProblem('missing-binary', '/Users/z/ffmpeg').hint).toContain('/Users/z/ffmpeg')
  })

  it('就绪（problem 为 null）时按可用处理，不产生修复引导', () => {
    const copy = describeFfmpegProblem(null, '/Users/z/ffmpeg')
    expect(copy.label).toBe('FFmpeg 检测ok 👌')
    expect(copy.action).toBe('')
  })
})
