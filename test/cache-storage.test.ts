import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CACHE_DIRS,
  CACHE_AUTO_CLEAN_THRESHOLD_BYTES,
  clearBrowserCache,
  collectStorageUsage,
  directorySize,
  DISK_CACHE_LIMIT_BYTES,
} from '../src/main/cache-storage'

// mock electron：用可控的 clearData 把两次调用卡在同一时刻，验证并发守卫
const electronMock = vi.hoisted(() => {
  let userDataDir = ''
  return {
    setUserDataDir: (dir: string) => {
      userDataDir = dir
    },
    getUserDataDir: () => userDataDir,
    clearData: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => electronMock.getUserDataDir() },
  session: { defaultSession: { clearData: electronMock.clearData } },
}))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'desktop48-cache-'))
}

/** 造一个指定大小的文件（内容为填充字节，大小即体积） */
function writeSizedFile(filePath: string, size: number): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.alloc(size))
}

describe('directorySize 递归统计', () => {
  it('累加多层目录里的文件', async () => {
    const root = tempDir()
    writeSizedFile(join(root, 'a.bin'), 10)
    writeSizedFile(join(root, 'nested', 'b.bin'), 20)
    writeSizedFile(join(root, 'nested', 'deeper', 'c.bin'), 30)

    expect(await directorySize(root)).toBe(60)
  })

  it('目录不存在时返回 0（缓存目录常常还没生成）', async () => {
    expect(await directorySize(join(tempDir(), 'missing'))).toBe(0)
  })

  it('不跟随符号链接：跟出去会把别的目录算进来', async () => {
    const root = tempDir()
    const outside = tempDir()
    writeSizedFile(join(outside, 'big.bin'), 100)
    writeSizedFile(join(root, 'own.bin'), 5)
    symlinkSync(outside, join(root, 'linked'))

    expect(await directorySize(root)).toBe(5)
  })
})

describe('collectStorageUsage 口径', () => {
  it('分别统计浏览器缓存、成员库（含备份/隔离文件）与 ffmpeg', async () => {
    const userData = tempDir()
    writeSizedFile(join(userData, 'Cache', 'data_0'), 100)
    writeSizedFile(join(userData, 'Code Cache', 'js', 'index'), 50)
    writeSizedFile(join(userData, 'database.json'), 30)
    writeSizedFile(join(userData, 'database.json.bak'), 20)
    writeSizedFile(join(userData, 'database.json.corrupt'), 10)
    writeSizedFile(join(userData, 'database.json.corrupt.1700000000000'), 7)
    writeSizedFile(join(userData, 'ffmpeg', 'ffmpeg'), 500)
    // 不属于数据库前缀的文件不该被算进 databaseBytes
    writeSizedFile(join(userData, 'app-config.json'), 999)

    const usage = await collectStorageUsage(userData)

    expect(usage.cacheBytes).toBe(150)
    expect(usage.databaseBytes).toBe(67)
    expect(usage.ffmpegBytes).toBe(500)
    expect(usage.cacheLimitBytes).toBe(DISK_CACHE_LIMIT_BYTES)
  })

  it('localStorage / Session Storage / IndexedDB 不算缓存：清了就是清用户设置', async () => {
    const userData = tempDir()
    writeSizedFile(join(userData, 'Local Storage', 'leveldb', '000003.log'), 400)
    writeSizedFile(join(userData, 'Session Storage', '000003.log'), 200)
    writeSizedFile(join(userData, 'IndexedDB', 'https_x.indexeddb.leveldb', '000003.log'), 100)
    writeSizedFile(join(userData, 'GPUPersistentCache', 'blob'), 300)
    writeSizedFile(join(userData, 'Cache', 'data_1'), 8)

    const usage = await collectStorageUsage(userData)

    expect(usage.cacheBytes).toBe(8)
    for (const dir of ['Local Storage', 'Session Storage', 'IndexedDB', 'GPUPersistentCache']) {
      expect(BROWSER_CACHE_DIRS as readonly string[]).not.toContain(dir)
    }
  })

  it('userData 不存在时全为 0，不抛错（首启竞态）', async () => {
    const usage = await collectStorageUsage(join(tempDir(), 'nope'))

    expect(usage.cacheBytes).toBe(0)
    expect(usage.databaseBytes).toBe(0)
    expect(usage.ffmpegBytes).toBe(0)
  })
})

describe('常量约束', () => {
  it('自动清理阈值至少是磁盘上限的两倍：否则会反复清空热缓存', () => {
    expect(CACHE_AUTO_CLEAN_THRESHOLD_BYTES).toBeGreaterThanOrEqual(2 * DISK_CACHE_LIMIT_BYTES)
    expect(DISK_CACHE_LIMIT_BYTES).toBeGreaterThanOrEqual(512 * 1024 * 1024)
  })
})

describe('clearBrowserCache 并发守卫', () => {
  beforeEach(() => {
    electronMock.clearData.mockReset()
    electronMock.clearData.mockImplementation(() => Promise.resolve())
  })

  it('手动与启动兜底同时触发时只清一次，两个调用方拿同一结果', async () => {
    const userData = tempDir()
    writeSizedFile(join(userData, 'Cache', 'data_0'), 100)
    electronMock.setUserDataDir(userData)

    let release!: () => void
    electronMock.clearData.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve
    }))

    const first = clearBrowserCache()
    const second = clearBrowserCache()
    // 守卫同步生效，不依赖异步统计的完成时点
    expect(second).toBe(first)

    await vi.waitFor(() => expect(electronMock.clearData).toHaveBeenCalledTimes(1))
    // 先删文件再放行：释放量只按这一轮计算
    rmSync(join(userData, 'Cache'), { recursive: true, force: true })
    release()

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.freedBytes).toBe(100)
  })

  it('清理结束后锁释放，下一次调用会重新执行清理', async () => {
    electronMock.setUserDataDir(tempDir())

    await clearBrowserCache()
    await clearBrowserCache()

    expect(electronMock.clearData).toHaveBeenCalledTimes(2)
  })

  it('清理失败也释放锁，下一次调用不会被卡住', async () => {
    electronMock.setUserDataDir(tempDir())
    electronMock.clearData.mockRejectedValueOnce(new Error('session 未就绪'))

    await expect(clearBrowserCache()).rejects.toThrow('session 未就绪')
    await expect(clearBrowserCache()).resolves.toBeDefined()
    expect(electronMock.clearData).toHaveBeenCalledTimes(2)
  })
})
