import { describe, expect, it } from 'vitest'
import { parsePinnedIds, togglePinnedId } from '../src/renderer/src/utils/room-pin'

describe('parsePinnedIds（左列置顶存量解析）', () => {
  it('正常存量：按写入顺序还原', () => {
    expect(parsePinnedIds('[10003,10001]')).toEqual([10003, 10001])
  })

  it('历史字符串 id 一并认（旧库 / 手改过 localStorage 都可能出现）', () => {
    expect(parsePinnedIds('["10001",10002]')).toEqual([10001, 10002])
  })

  it('重复 id 只留一份，顺序按首次出现', () => {
    expect(parsePinnedIds('[10002,10001,10002]')).toEqual([10002, 10001])
  })

  it('缺失 / 空串 / 非 JSON / 非数组：一律空名单，不抛错', () => {
    expect(parsePinnedIds(null)).toEqual([])
    expect(parsePinnedIds(undefined)).toEqual([])
    expect(parsePinnedIds('')).toEqual([])
    expect(parsePinnedIds('not json')).toEqual([])
    expect(parsePinnedIds('{"userId":10001}')).toEqual([])
  })

  it('脏元素丢弃：非数字、NaN、Infinity 都进不了名单', () => {
    expect(parsePinnedIds('[10001,"abc",null,"",1e999]')).toEqual([10001])
  })
})

describe('togglePinnedId（置顶幂等切换）', () => {
  it('未置顶 → 追加到末尾', () => {
    expect(togglePinnedId([10001], 10002)).toEqual([10001, 10002])
  })

  it('已置顶 → 移除，其余顺序不变', () => {
    expect(togglePinnedId([10001, 10002, 10003], 10002)).toEqual([10001, 10003])
  })

  it('不改动入参：返回新数组', () => {
    const ids = [10001]
    const next = togglePinnedId(ids, 10002)
    expect(next).not.toBe(ids)
    expect(ids).toEqual([10001])
  })

  it('非法 id 原样返回（渲染层传来的值可能是空串 / 非数字）', () => {
    expect(togglePinnedId([10001], Number.NaN)).toEqual([10001])
  })
})
