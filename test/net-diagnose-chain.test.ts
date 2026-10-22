import type { SourceOutcome } from '../src/main/net-diagnose-chain'
import { describe, expect, it } from 'vitest'
import { resolveSources } from '../src/main/net-diagnose-chain'

/**
 * 成员名单的主备链结论：主源挂、备源顶上仍算该行正常，全部挂掉才判不可用。
 * 背景见 src/main/net-diagnose.ts 的 memberListTarget——快照为主、jsonp 接口为备。
 */
function source(overrides: Partial<SourceOutcome>): SourceOutcome {
  return { label: '成员名单', url: 'https://h5.48.cn/snapshot', status: 200, ms: 120, ...overrides }
}

const SNAPSHOT = source({ label: '成员名单快照', url: 'https://h5.48.cn/snapshot' })
const JSONP = source({ label: '成员名单 jsonp', url: 'https://h5.48.cn/jsonp' })

describe('resolveSources：主备链结论', () => {
  it('主源可用时原样返回，不追加说明', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [SNAPSHOT])
    expect(result.status).toBe(200)
    expect(result.url).toBe('https://h5.48.cn/snapshot')
    expect(result.detail).toBeUndefined()
  })

  it('主源 502、备源可用：结论正常，说明指出已走备源', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [
      source({ ...SNAPSHOT, status: 502, detail: 'nginx' }),
      JSONP,
    ])
    expect(result.status).toBe(200)
    expect(result.url).toBe('https://h5.48.cn/jsonp')
    expect(result.label).toBe('成员名单（快照 / jsonp）')
    expect(result.detail).toContain('主源不可用（HTTP 502）')
    expect(result.detail).toContain('已由备源接通')
  })

  it('主源不可达、备源可用：仍算正常（不会被主源的 null 带成不可达）', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [
      source({ ...SNAPSHOT, status: null, error: '超时（8 秒无响应）' }),
      JSONP,
    ])
    expect(result.status).toBe(200)
    expect(result.detail).toContain('超时（8 秒无响应）')
  })

  it('4xx 也不算可用，继续走备源', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [
      source({ ...SNAPSHOT, status: 403 }),
      JSONP,
    ])
    expect(result.status).toBe(200)
    expect(result.url).toBe('https://h5.48.cn/jsonp')
  })

  it('两源都挂：才判不可用，结论取主源、说明列出两条状态', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [
      source({ ...SNAPSHOT, status: null, error: '连接被拒绝' }),
      source({ ...JSONP, status: 502 }),
    ])
    expect(result.status).toBeNull()
    expect(result.error).toBe('连接被拒绝')
    expect(result.detail).toBe('主备全部不可用：主源 连接被拒绝；备源1 HTTP 502')
  })

  it('两源都是 5xx：状态码取主源，说明里两条都在', () => {
    const result = resolveSources('成员名单（快照 / jsonp）', [
      source({ ...SNAPSHOT, status: 503 }),
      source({ ...JSONP, status: 502 }),
    ])
    expect(result.status).toBe(503)
    expect(result.detail).toBe('主备全部不可用：主源 HTTP 503；备源1 HTTP 502')
  })

  it('单源目标失败时保持原样，不拼主备文案', () => {
    const result = resolveSources('头像/封面媒体', [source({ label: '头像/封面媒体', status: 500 })])
    expect(result.status).toBe(500)
    expect(result.detail).toBeUndefined()
  })
})
