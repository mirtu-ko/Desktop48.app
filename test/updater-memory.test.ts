/**
 * 更新记忆文件（userData/updater-memory.json）的读写。
 *
 * 这个文件决定「下次启动要不要静默装」，所以两条边界必须钉住：
 * 磁盘上的内容不可信（手改 / 旧版本 / 写到一半被杀）时要能安全降级，写失败不能影响本次会话。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { createMemoryStore, defaultMemory, parseMemory } = await import('../src/main/updater/memory')

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop48-updater-memory-'))
  dirs.push(dir)
  return join(dir, 'updater-memory.json')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseMemory', () => {
  it('空对象落到默认记忆', () => {
    expect(parseMemory({})).toEqual(defaultMemory())
    expect(parseMemory(null)).toEqual(defaultMemory())
    expect(parseMemory('garbage')).toEqual(defaultMemory())
  })

  it('逐字段校验：类型不对的字段丢弃，不牵连其它字段', () => {
    const parsed = parseMemory({
      lastCheckAt: 1_700_000_000_000,
      lastResult: 'nonsense',
      downloadedVersion: '1.1.0',
      dismissedVersion: 42,
      dismissedAt: 'yesterday',
      installAttempt: { version: '1.1.0', at: 'yesterday' },
    })

    expect(parsed.lastCheckAt).toBe(1_700_000_000_000)
    expect(parsed.lastResult).toBeNull()
    expect(parsed.downloadedVersion).toBe('1.1.0')
    expect(parsed.dismissedVersion).toBeNull()
    expect(parsed.dismissedAt).toBeNull()
    expect(parsed.installAttempt).toBeNull()
  })

  it('保留合法的试装记录', () => {
    const parsed = parseMemory({ installAttempt: { version: '1.2.0', at: 1_700_000_000_000 } })
    expect(parsed.installAttempt).toEqual({ version: '1.2.0', at: 1_700_000_000_000 })
  })
})

describe('createMemoryStore', () => {
  it('文件不存在时读默认记忆', () => {
    expect(createMemoryStore(tempFile()).read()).toEqual(defaultMemory())
  })

  it('write 合并字段并落盘，read 之后命中缓存', () => {
    const file = tempFile()
    const store = createMemoryStore(file)

    store.write({ downloadedVersion: '1.1.0' })
    store.write({ dismissedVersion: '1.1.0', dismissedAt: 1_700_000_000_000 })

    expect(store.read()).toMatchObject({ downloadedVersion: '1.1.0', dismissedVersion: '1.1.0', dismissedAt: 1_700_000_000_000 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ downloadedVersion: '1.1.0' })
  })

  it('文件内容损坏时按空记忆处理，不影响读写', () => {
    const file = tempFile()
    writeFileSync(file, '{ broken', 'utf8')
    const store = createMemoryStore(file)

    expect(store.read()).toEqual(defaultMemory())
    expect(store.write({ downloadedVersion: '2.0.0' }).downloadedVersion).toBe('2.0.0')
  })

  it('写失败只记日志，返回值仍反映内存中的状态', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // 用一个不存在的目录当文件路径，writeFileSync 必然失败
    const store = createMemoryStore(join(tmpFileDir(), 'missing', 'updater-memory.json'))

    expect(() => store.write({ lastCheckAt: 123 })).not.toThrow()
    expect(store.read().lastCheckAt).toBe(123)
  })
})

function tmpFileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop48-updater-memory-'))
  dirs.push(dir)
  return dir
}
