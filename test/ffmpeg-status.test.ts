import type { FfmpegProblem } from '@preload/ipc-contract'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ffmpegBinaryPath, findSystemFfmpeg, inspectFfmpegDir, resolveFfmpegBinary, resolveFfmpegEnvironment } from '../src/main/ffmpeg/ffmpeg-process'
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
    expect(resolveFfmpegBinary(workDir, () => null)).toBe(binary)
  })

  it('不可用时 resolveFfmpegBinary 抛出的信息与原因一一对应', () => {
    expect(() => resolveFfmpegBinary('', () => null)).toThrow('尚未设置 ffmpeg 目录')
    expect(() => resolveFfmpegBinary(path.join(workDir, 'not-created'), () => null)).toThrow('ffmpeg 目录不存在')
    expect(() => resolveFfmpegBinary(workDir, () => null)).toThrow('ffmpeg 二进制文件不存在')
  })
})

describe('findSystemFfmpeg（linux 系统 ffmpeg 探测）', () => {
  let workDir = ''

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-system-'))
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('只在 linux 上探测：其它平台即使路径存在也返回 null', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const found = findSystemFfmpeg({ platform, pathValue: '/usr/bin', isExecutable: () => true })
      expect(found).toBeNull()
    }
  })

  it('按 PATH 顺序取第一个可执行的 ffmpeg', () => {
    const found = findSystemFfmpeg({
      platform: 'linux',
      pathValue: '/opt/a:/opt/b:/opt/c',
      isExecutable: p => p === '/opt/b/ffmpeg' || p === '/opt/c/ffmpeg',
    })
    expect(found).toBe('/opt/b/ffmpeg')
  })

  it('未匹配 PATH 时回落到常见安装目录（从桌面启动的 PATH 可能缺 /usr/local/bin）', () => {
    const found = findSystemFfmpeg({
      platform: 'linux',
      pathValue: '/opt/none',
      isExecutable: p => p === '/usr/bin/ffmpeg',
    })
    expect(found).toBe('/usr/bin/ffmpeg')
  })

  it('真实文件：没有执行位不算可用，补上执行位后命中', () => {
    const binary = path.join(workDir, 'ffmpeg')
    fs.writeFileSync(binary, '')
    fs.chmodSync(binary, 0o644)
    expect(findSystemFfmpeg({ platform: 'linux', pathValue: workDir })).toBeNull()

    fs.chmodSync(binary, 0o755)
    expect(findSystemFfmpeg({ platform: 'linux', pathValue: workDir })).toBe(binary)
  })

  it('目录本身不算命中（只有普通文件才可能是二进制）', () => {
    fs.mkdirSync(path.join(workDir, 'ffmpeg'))
    expect(findSystemFfmpeg({ platform: 'linux', pathValue: workDir })).toBeNull()
  })
})

describe('resolveFfmpegEnvironment（显式目录 → 系统 ffmpeg 回落）', () => {
  let workDir = ''

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-env-'))
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('显式目录可用时优先使用它，不触发系统探测', () => {
    const binary = ffmpegBinaryPath(workDir)
    fs.writeFileSync(binary, '')
    const probe = vi.fn(() => '/usr/bin/ffmpeg')

    const status = resolveFfmpegEnvironment(workDir, probe)
    expect(status).toMatchObject({ ok: true, source: 'directory', binaryPath: binary })
    expect(probe).not.toHaveBeenCalled()
  })

  it('显式目录不可用时回落到系统 ffmpeg，并给出其所在目录', () => {
    const status = resolveFfmpegEnvironment(workDir, () => '/usr/bin/ffmpeg')
    expect(status).toMatchObject({ ok: true, problem: null, source: 'system', directory: '/usr/bin', binaryPath: '/usr/bin/ffmpeg' })
  })

  it('系统也没有时原样返回显式目录的判定，不掩盖用户配错的路径', () => {
    expect(resolveFfmpegEnvironment(workDir, () => null)).toMatchObject({ ok: false, problem: 'missing-binary', source: 'directory' })
    expect(resolveFfmpegEnvironment('', () => null)).toMatchObject({ ok: false, problem: 'unset' })
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

  it('系统安装来源单列文案，避免用户把 /usr/bin 当成配错的目录', () => {
    const copy = describeFfmpegProblem(null, '/usr/bin', 'system')
    expect(copy.label).toBe('系统 FFmpeg')
    expect(copy.hint).toContain('/usr/bin')
    expect(copy.action).toBe('')
  })
})
