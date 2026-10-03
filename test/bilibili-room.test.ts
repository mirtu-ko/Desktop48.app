import { describe, expect, it } from 'vitest'
import { resolveBilibiliRoomId } from '../src/renderer/src/utils/bilibili-room'
import Constants from '../src/renderer/src/utils/constants'

/**
 * 房间号是人工确认后写死的，映射本身即契约，按字面量独立表达：
 * 改动 utils/bilibili-room.ts 的表时这些用例应当失败，提醒「改的是线上房间」。
 */
const EXPECTED: Record<string, number> = {
  SNH48: 63727,
  BEJ48: 383045,
  GNZ48: 391199,
  CKG48: 6015846,
  CGT48: 27848865,
}

/** 接口返回的真实 teamList 片段（2026-10-02 实测）：只有队伍名，没有团体名 */
const TEAM_SII = { groupId: 10, teamName: 'TEAM SII' }
const TEAM_E = { groupId: 11, teamName: 'TEAM E' }
const TEAM_G = { groupId: 12, teamName: 'TEAM G' }
const TEAM_C = { groupId: 14, teamName: 'TEAM C' }

describe('resolveBilibiliRoomId / groupId 为主', () => {
  it('五个分团各自映射到约定房间号', () => {
    for (const [label, roomId] of Object.entries(EXPECTED)) {
      const tab = Constants.GroupTabs.find(item => item.label === label)!
      expect(resolveBilibiliRoomId({ groupId: Number(tab.key) })).toBe(roomId)
    }
  })

  it('带队伍名的真实条目按 groupId 命中，不依赖 teamName', () => {
    expect(resolveBilibiliRoomId({ groupId: TEAM_SII.groupId })).toBe(63727)
    expect(resolveBilibiliRoomId({ groupId: TEAM_E.groupId })).toBe(383045)
    expect(resolveBilibiliRoomId({ groupId: TEAM_G.groupId })).toBe(391199)
    expect(resolveBilibiliRoomId({ groupId: TEAM_C.groupId })).toBe(6015846)
  })

  it('groupId 优先于标题：标题写错团体也以 groupId 为准', () => {
    expect(resolveBilibiliRoomId({ groupId: 12, texts: ['CKG48 TEAM C《第一人称》'] })).toBe(391199)
  })
})

describe('resolveBilibiliRoomId / 标题兜底', () => {
  it('teamList 为空数组时用副标题里的团体全名（CGT48 的真实场景）', () => {
    expect(resolveBilibiliRoomId({
      texts: ['CGT48剧场公演', 'CGT48 《偶像进阶计划-追光组》·首演第二场'],
    })).toBe(27848865)
  })

  it('teamList 为空但副标题带团体名（CKG48《域》）', () => {
    expect(resolveBilibiliRoomId({ texts: ['CKG48剧场公演', 'CKG48《域》·第二场'] })).toBe(6015846)
  })

  it('groupId 为 0（「全部」档）落到标题兜底，而不是直接判无', () => {
    expect(resolveBilibiliRoomId({ groupId: 0, texts: ['CGT48 《偶像进阶计划-逐梦组》'] })).toBe(27848865)
  })

  it('未知 groupId 落到标题兜底', () => {
    expect(resolveBilibiliRoomId({ groupId: 999, texts: ['BEJ48 Team E剧场公演'] })).toBe(383045)
  })

  it('联合公演取 GroupTabs 里靠前的那个（CKG48 x CGT48 → CKG48）', () => {
    expect(resolveBilibiliRoomId({
      texts: ['CKG48 x CGT48 《偶像进阶计划-逐梦组》·重庆巡演'],
    })).toBe(6015846)
  })

  it('大小写不敏感', () => {
    expect(resolveBilibiliRoomId({ texts: ['gnz48 剧场公演'] })).toBe(391199)
  })
})

describe('resolveBilibiliRoomId / 判无', () => {
  it('teamName 不含团体名，单独拿它匹配一个都命中不了（本次回归的根因）', () => {
    expect(resolveBilibiliRoomId({ texts: ['TEAM SII 剧场公演', '《INTO THE LIGHT》刘增艳季度MVP公演'] })).toBeUndefined()
    expect(resolveBilibiliRoomId({ texts: ['《别卷了G》TEAM G周年庆特别公演'] })).toBeUndefined()
  })

  it('空入参 / 空数组 / 空串 / undefined 元素都返回 undefined', () => {
    expect(resolveBilibiliRoomId({})).toBeUndefined()
    expect(resolveBilibiliRoomId({ texts: [] })).toBeUndefined()
    expect(resolveBilibiliRoomId({ texts: ['', undefined] })).toBeUndefined()
  })

  it('表外团体与无团体的场次返回 undefined', () => {
    expect(resolveBilibiliRoomId({ texts: ['IDFT 剧场公演'] })).toBeUndefined()
    expect(resolveBilibiliRoomId({ texts: ['燃烧吧团魂'] })).toBeUndefined()
    expect(resolveBilibiliRoomId({ texts: ['处女座&天蝎座生日冷餐会'] })).toBeUndefined()
  })

  it('「全部」这一档没有房间（它不是团体，只是筛选器）', () => {
    const allLabel = Constants.GroupTabs[0].label
    expect(allLabel).toBe('全部')
    expect(resolveBilibiliRoomId({ texts: [allLabel] })).toBeUndefined()
  })

  it('映射覆盖的团体名都能在 GroupTabs 里找到（防止表里写了错字）', () => {
    const labels = Constants.GroupTabs.map(tab => tab.label)
    for (const label of Object.keys(EXPECTED))
      expect(labels).toContain(label)
  })
})
