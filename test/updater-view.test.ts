/**
 * 更新界面的文案 / 按钮 / 横幅推导。
 *
 * 这些是纯函数：给一个状态，出一个字符串或一个动作。之所以单独测，
 * 是因为「设置页说什么话」过去散在组件里，改动一次就得靠肉眼核对四个分支。
 */
import type { UpdaterState } from '../src/main/updater/types'
import { describe, expect, it } from 'vitest'

const { DOWNLOAD_PAGE_URL, bannerContent, describeUpdater, downloadSizeText, formatBytes, relativeCheckedAt, resolveUpdaterAction } = await import('../src/renderer/src/utils/updater-view')

function state(overrides: Partial<UpdaterState> = {}): UpdaterState {
  return {
    phase: 'idle',
    currentVersion: '1.0.0',
    checkedAt: null,
    candidate: null,
    download: null,
    error: null,
    unsupported: null,
    notice: null,
    ...overrides,
  }
}

const inApp = { version: '1.1.0', releaseNotes: '', delivery: 'in-app' as const, source: 'mirror' as const }
const manual = { version: '1.1.0', releaseNotes: '', delivery: 'manual' as const, url: 'https://dl.v2ing.com/Desktop48-1.1.0-arm64.dmg', source: 'mirror' as const }

describe('describeUpdater', () => {
  it('idle 提示还没查过', () => {
    expect(describeUpdater(state())).toBe('检查是否有可用的新版本')
  })

  it('up-to-date 带上上次检查的相对时间', () => {
    const now = Date.parse('2026-11-26T10:00:00Z')
    expect(describeUpdater(state({ phase: 'up-to-date', checkedAt: now - 3 * 60_000 }), now))
      .toBe('当前已是最新版本（3 分钟前检查）')
  })

  it('available 说清需要手动下载', () => {
    expect(describeUpdater(state({ phase: 'available', candidate: manual })))
      .toBe('发现新版本 v1.1.0，需手动下载安装')
  })

  it('ready 提示重启生效', () => {
    expect(describeUpdater(state({ phase: 'ready', candidate: inApp })))
      .toBe('新版本 v1.1.0 已下载完成，重启后生效')
  })

  it('error 用主进程给的结论，unsupported 用不支持的原因', () => {
    expect(describeUpdater(state({ phase: 'error', error: '网络连接超时，请检查网络后重试' })))
      .toBe('网络连接超时，请检查网络后重试')
    expect(describeUpdater(state({ phase: 'unsupported', unsupported: { reason: '开发模式下不检查更新' } })))
      .toBe('开发模式下不检查更新')
  })
})

describe('resolveUpdaterAction', () => {
  it('进行中的阶段只给禁用的状态按钮', () => {
    expect(resolveUpdaterAction(state({ phase: 'checking' }))).toMatchObject({ label: '检查中', kind: 'none', disabled: true, loading: true })
    expect(resolveUpdaterAction(state({ phase: 'downloading', candidate: inApp }))).toMatchObject({ label: '下载中', disabled: true })
  })

  it('ready 给「立即重启」', () => {
    expect(resolveUpdaterAction(state({ phase: 'ready', candidate: inApp }))).toMatchObject({ label: '立即重启', kind: 'install' })
  })

  it('available 给「去下载」，优先候选版本自带的直链', () => {
    expect(resolveUpdaterAction(state({ phase: 'available', candidate: manual })))
      .toMatchObject({ label: '去下载', kind: 'open-page', url: manual.url })
  })

  it('available 没有直链时退回官网', () => {
    expect(resolveUpdaterAction(state({ phase: 'available', candidate: { ...manual, url: undefined } })))
      .toMatchObject({ kind: 'open-page', url: DOWNLOAD_PAGE_URL })
  })

  it('下载失败给「重试下载」，检查失败给「重新检查」', () => {
    expect(resolveUpdaterAction(state({ phase: 'error', candidate: inApp }))).toMatchObject({ label: '重试下载', kind: 'download' })
    expect(resolveUpdaterAction(state({ phase: 'error' }))).toMatchObject({ label: '重新检查', kind: 'check' })
  })

  it('不支持自动更新的环境给官网出路，连官网都没有就禁用', () => {
    expect(resolveUpdaterAction(state({ phase: 'unsupported', unsupported: { reason: 'x', url: DOWNLOAD_PAGE_URL } })))
      .toMatchObject({ label: '去下载', kind: 'open-page', url: DOWNLOAD_PAGE_URL })
    expect(resolveUpdaterAction(state({ phase: 'unsupported', unsupported: { reason: 'x' } })))
      .toMatchObject({ label: '检查更新', disabled: true })
  })
})

describe('bannerContent', () => {
  it('没有 notice 就没有横幅', () => {
    expect(bannerContent(state({ phase: 'ready', candidate: inApp }))).toBeNull()
  })

  it('ready 提示重启安装', () => {
    expect(bannerContent(state({ phase: 'ready', candidate: inApp, notice: { version: '1.1.0', kind: 'ready' } })))
      .toMatchObject({ title: '新版本 v1.1.0 已下载', primaryLabel: '立即重启', kind: 'install' })
  })

  it('available 指向下载页', () => {
    expect(bannerContent(state({ phase: 'available', candidate: manual, notice: { version: '1.1.0', kind: 'available' } })))
      .toMatchObject({ title: '发现新版本 v1.1.0', primaryLabel: '去下载', kind: 'open-page', url: manual.url })
  })
})

describe('格式化', () => {
  it('formatBytes 按 1024 进位，超过 100 取整', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
  })

  it('downloadSizeText 拼出已传 / 总量 · 速率', () => {
    expect(downloadSizeText({ percent: 30, bytesPerSecond: 1024 * 1024, transferred: 3 * 1024 * 1024, total: 10 * 1024 * 1024 }))
      .toBe('3.0 MB / 10.0 MB · 1.0 MB/s')
    expect(downloadSizeText(null)).toBe('')
  })

  it('relativeCheckedAt 按分钟 / 小时 / 天分档', () => {
    const now = Date.parse('2026-11-26T10:00:00Z')
    expect(relativeCheckedAt(null, now)).toBe('')
    expect(relativeCheckedAt(now - 5_000, now)).toBe('（刚刚检查）')
    expect(relativeCheckedAt(now - 2 * 3_600_000, now)).toBe('（2 小时前检查）')
    expect(relativeCheckedAt(now - 3 * 86_400_000, now)).toBe('（3 天前检查）')
  })
})
