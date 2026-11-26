/**
 * 手动更新源（镜像 → GitHub）的取版本逻辑。
 *
 * 只验证「拿到的 JSON / 响应形态怎么变成候选版本」，网络一律替身；
 * 真实可达性不是单测能覆盖的东西。
 */
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }))

const { DOWNLOAD_PAGE_URL, fetchLatestManualRelease, fetchMirrorReleaseNotes, pickMirrorDownloadUrl, readVersion } = await import('../src/main/updater/sources')

const originalFetch = globalThis.fetch
let fetchMock: Mock

function jsonResponse(body: unknown, init: { status?: number, url?: string } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? '',
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('readVersion', () => {
  it('允许 v 前缀并去掉空白', () => {
    expect(readVersion('  v1.2.3 ', '清单')).toBe('1.2.3')
  })

  it('缺失版本号视为清单损坏', () => {
    expect(() => readVersion(undefined, '镜像版本清单')).toThrowError('镜像版本清单 缺少版本号')
  })
})

describe('pickMirrorDownloadUrl', () => {
  const originalArch = process.arch
  const originalPlatform = process.platform
  const originalAppImage = process.env.APPIMAGE

  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    if (originalAppImage === undefined)
      delete process.env.APPIMAGE
    else
      process.env.APPIMAGE = originalAppImage
  })

  it('按当前架构挑 dmg 直链', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    expect(pickMirrorDownloadUrl([{ name: 'Desktop48-1.1.0-x64.dmg' }, { name: 'Desktop48-1.1.0-arm64.dmg' }]))
      .toBe('https://dl.v2ing.com/Desktop48-1.1.0-arm64.dmg')
  })

  it('linux 非 AppImage 环境挑对应架构 deb 直链', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.APPIMAGE
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    expect(pickMirrorDownloadUrl([{ name: 'Desktop48_1.1.0_amd64.deb' }, { name: 'Desktop48_1.1.0_arm64.deb' }]))
      .toBe('https://dl.v2ing.com/Desktop48_1.1.0_amd64.deb')
  })

  it('linux AppImage 环境按当前架构与优先级挑 AppImage 直链，绝不跨架构错配', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.APPIMAGE = '/tmp/Desktop48.AppImage'
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    expect(pickMirrorDownloadUrl([{ name: 'Desktop48-1.1.0-x86_64.AppImage' }, { name: 'Desktop48-1.1.0-arm64.AppImage' }]))
      .toBe('https://dl.v2ing.com/Desktop48-1.1.0-arm64.AppImage')
    // 清单只有 x64 时，arm64 必须退回官网下载页，不能把 x64 包推给 arm64
    expect(pickMirrorDownloadUrl([{ name: 'Desktop48-1.1.0-x64.AppImage' }, { name: 'Desktop48-1.1.0-x86_64.AppImage' }]))
      .toBe(DOWNLOAD_PAGE_URL)
  })

  it('清单里没有对应架构时退回官网下载页', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    expect(pickMirrorDownloadUrl([{ name: 'Desktop48-1.1.0-arm64.dmg' }])).toBe(DOWNLOAD_PAGE_URL)
    expect(pickMirrorDownloadUrl(undefined)).toBe(DOWNLOAD_PAGE_URL)
  })
})

describe('fetchLatestManualRelease', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('镜像清单可用时一次请求就拿到版本、说明与安装包', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    fetchMock.mockResolvedValueOnce(jsonResponse({
      version: 'v1.1.0',
      notes: '- 修好了若干问题',
      files: [{ name: 'Desktop48-1.1.0-arm64.dmg' }, { name: 'Desktop48-1.1.0-x64.dmg' }],
    }))

    const release = await fetchLatestManualRelease()
    expect(release.version).toBe('1.1.0')
    expect(release.releaseNotes).toBe('- 修好了若干问题')
    expect(release.source).toBe('mirror')
    expect(release.url).toMatch(/Desktop48-1\.1\.0-(arm64|x64)\.dmg$/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('镜像不可用时回落 GitHub API，下载仍指向官网', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.2.0', body: 'notes from github' }))

    const release = await fetchLatestManualRelease()
    expect(release.version).toBe('1.2.0')
    expect(release.releaseNotes).toBe('notes from github')
    expect(release.source).toBe('github')
    expect(release.url).toBe(DOWNLOAD_PAGE_URL)
  })

  it('gitHub API 限流时退到 release 页面解析 tag（只看最终 URL）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({}, {
        status: 200,
        url: 'https://github.com/mirtu-ko/Desktop48.app/releases/tag/v1.3.0',
      }))

    const release = await fetchLatestManualRelease()
    expect(release.version).toBe('1.3.0')
    // 页面解析拿不到更新说明，绝不编造
    expect(release.releaseNotes).toBe('')
    expect(release.url).toBe(DOWNLOAD_PAGE_URL)
  })
})

describe('fetchMirrorReleaseNotes', () => {
  it('版本一致时返回镜像说明', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 'v1.1.0', notes: ' - 补上更新日志\n' }))

    await expect(fetchMirrorReleaseNotes('1.1.0')).resolves.toBe('- 补上更新日志')
  })

  it('版本不一致时宁可为空，也不张冠李戴', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '1.2.0', notes: '- 别的版本' }))

    await expect(fetchMirrorReleaseNotes('1.1.0')).resolves.toBe('')
  })

  it('清单不可用或说明缺失都只当没有', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
    await expect(fetchMirrorReleaseNotes('1.1.0')).resolves.toBe('')

    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '1.1.0' }))
    await expect(fetchMirrorReleaseNotes('1.1.0')).resolves.toBe('')
  })

  it('网络异常被吞掉，不影响更新流程', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'))

    await expect(fetchMirrorReleaseNotes('1.1.0')).resolves.toBe('')
  })
})
