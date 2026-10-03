import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildWbiKey, buildWbiQuery } from '../src/main/bilibili/wbi'

/**
 * 取自 bilibili-API-collect 文档的实测样本：同一对 wbi_img 必须始终推出同一口令，
 * 一旦重排表被改动，这里立刻失败（协议未公开，没有别的地方能兜住）。
 */
const SAMPLE_IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
const SAMPLE_SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
const SAMPLE_KEY = 'ea1db124af3c7062474693fa704f4ff8'

/** 独立算一遍 md5，避免用被测实现自证 */
function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

describe('buildWbiKey', () => {
  it('按重排表从两段文件名拼出口令', () => {
    expect(buildWbiKey(SAMPLE_IMG_URL, SAMPLE_SUB_URL)).toBe(SAMPLE_KEY)
  })

  it('口令恒为 32 位', () => {
    expect(buildWbiKey(SAMPLE_IMG_URL, SAMPLE_SUB_URL)).toHaveLength(32)
  })

  it('只取路径最后一段，带查询串 / 无扩展名同样可用', () => {
    expect(buildWbiKey('https://x/y/7cd084941338484aae1ad9425b84077c', SAMPLE_SUB_URL)).toBe(SAMPLE_KEY)
    expect(buildWbiKey(`${SAMPLE_IMG_URL}?t=1`, SAMPLE_SUB_URL)).toBe(SAMPLE_KEY)
  })

  it('两段互换会得到不同口令（不是对称拼接）', () => {
    expect(buildWbiKey(SAMPLE_SUB_URL, SAMPLE_IMG_URL)).not.toBe(SAMPLE_KEY)
  })
})

describe('buildWbiQuery', () => {
  it('签名串是「键升序的 urlencode 结果 + 口令」的 md5', () => {
    const query = buildWbiQuery({ foo: 114, bar: 514 }, 'key', 1702204169)

    expect(query).toBe(`bar=514&foo=114&wts=1702204169&w_rid=${md5('bar=514&foo=114&wts=1702204169key')}`)
  })

  it('无业务参数时只签 wts', () => {
    expect(buildWbiQuery({}, 'k', 123)).toBe(`wts=123&w_rid=${md5('wts=123k')}`)
  })

  it('口令参与签名：换口令即换 w_rid', () => {
    const a = buildWbiQuery({ room_id: 63727 }, 'k1', 100)
    const b = buildWbiQuery({ room_id: 63727 }, 'k2', 100)

    expect(a).not.toBe(b)
    expect(a.split('&w_rid=')[0]).toBe(b.split('&w_rid=')[0])
  })

  it('wts 由调用方传入并参与签名（实现不读系统时钟）', () => {
    const query = buildWbiQuery({ a: 1 }, 'k', 111)

    expect(query).toContain('wts=111')
    expect(query).toContain(md5('a=1&wts=111k'))
  })

  it('值里的 !\'()* 被剔除，空格转 +（对齐 Python quote_plus）', () => {
    // 剔除后是 "he llo"，encodeURIComponent 给 %20，再按 quote_plus 转成 +
    const query = buildWbiQuery({ a: 'he llo!\'()*' }, 'k', 1)

    expect(query.startsWith('a=he+llo&')).toBe(true)
  })

  it('不修改传入的参数对象（调用方可能复用）', () => {
    const params = { foo: 1 }
    buildWbiQuery(params, 'k', 1)

    expect(params).toEqual({ foo: 1 })
  })

  it('不覆盖业务参数里的同名 wts（签名用的是传入值）', () => {
    const query = buildWbiQuery({ wts: 'hijack' }, 'k', 7)

    expect(query.startsWith('wts=7&')).toBe(true)
    expect(query).toContain(md5('wts=7k'))
  })
})
