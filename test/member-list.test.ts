import { describe, expect, it } from 'vitest'
import Constants from '../src/renderer/src/utils/constants'
import { buildSections, groupByTeam, memberCardKey, memberMatches } from '../src/renderer/src/utils/member-list'
import { makeMember, memberNames } from './fixtures/member'

function sii(realName: string, extra: Partial<Parameters<typeof makeMember>[0]> = {}) {
  return makeMember({ realName, groupId: 10, groupName: 'SNH48', teamName: 'TEAM SII', teamBadge: '/badge/sii.png', teamColor: '8FD3F6', ...extra })
}

function teamG(realName: string, extra: Partial<Parameters<typeof makeMember>[0]> = {}) {
  return makeMember({ realName, groupId: 12, groupName: 'GNZ48', teamName: 'TEAM G', teamBadge: '/badge/g.png', teamColor: 'ABCA14', ...extra })
}

describe('memberMatches（姓名 / 昵称 / 拼音缩写命中判定）', () => {
  const member = makeMember({ realName: '张三', nickname: '小张', abbr: 'zs' })

  it('三个字段任一包含关键词即命中', () => {
    expect(memberMatches(member, '张')).toBe(true)
    expect(memberMatches(member, '小张')).toBe(true)
    expect(memberMatches(member, 'zs')).toBe(true)
    expect(memberMatches(member, '李')).toBe(false)
  })

  it('大小写不敏感（拼音缩写是小写字母，输入常是大写）', () => {
    expect(memberMatches(member, 'ZS')).toBe(true)
    expect(memberMatches(member, 'Zs')).toBe(true)
  })

  it('空关键词与纯空白关键词视为「未搜索」，全员命中', () => {
    expect(memberMatches(member, '')).toBe(true)
    expect(memberMatches(member, '   ')).toBe(true)
    expect(memberMatches(member, ' 张 ')).toBe(true)
  })

  it('字段缺失（undefined）不抛错', () => {
    expect(memberMatches(makeMember({ realName: '' }), '张')).toBe(false)
  })
})

describe('groupByTeam（按队伍分区，保住首现顺序）', () => {
  it('同一队伍归入同一分区，分区按首现顺序排列', () => {
    const sections = groupByTeam([sii('甲'), teamG('乙'), sii('丙')], false)
    expect(sections.map(section => section.key)).toEqual(['SNH48/TEAM SII', 'GNZ48/TEAM G'])
    expect(memberNames(sections[0].members)).toEqual(['甲', '丙'])
    expect(memberNames(sections[1].members)).toEqual(['乙'])
  })

  it('withGroup 决定标题带不带团体名', () => {
    expect(groupByTeam([sii('甲')], false)[0].title).toBe('TEAM SII')
    expect(groupByTeam([sii('甲')], true)[0].title).toBe('SNH48 · TEAM SII')
  })

  it('分区强调色取自队色并补上 #（接口下发的是裸 HEX）', () => {
    expect(groupByTeam([sii('甲')], false)[0].accent).toBe('#8FD3F6')
    expect(groupByTeam([makeMember({ realName: '无队色' })], false)[0].accent).toBe('')
  })

  it('分区图标优先队伍徽章；查不到团体的回退 GroupLogoFallback', () => {
    expect(groupByTeam([sii('甲')], false)[0].groupLogo)
      .toBe(Constants.GroupTabs.find(tab => tab.key === '10')?.logoPng)

    const unknown = makeMember({ realName: '杂项', groupId: 99, groupName: 'IDFT', teamName: 'TEAM X' })
    expect(groupByTeam([unknown], false)[0].groupLogo).toBe(Constants.GroupLogoFallback)
  })

  it('空列表返回空数组', () => {
    expect(groupByTeam([], false)).toEqual([])
  })
})

describe('buildSections（分组在未排序列表上做，分区顺序与排序口径无关）', () => {
  // 入团时间顺序：乙(2013) < 甲(2016) < 丙(2020)
  const list = [
    sii('丙', { sid: '3', joinTime: '2020-01-01' }),
    teamG('甲', { sid: '1', joinTime: '2016-01-01' }),
    sii('乙', { sid: '2', joinTime: '2013-01-01' }),
  ]

  it('排序只作用于分区内部', () => {
    const sections = buildSections(list, false, 'default')
    expect(memberNames(sections[0].members)).toEqual(['乙', '丙'])
    expect(memberNames(sections[1].members)).toEqual(['甲'])
  })

  it('切换排序口径时分区顺序不变（否则切一次排序整页队伍块就重排一次）', () => {
    const keysOf = (sortKey: 'default' | 'rank' | 'name') =>
      buildSections(list, false, sortKey).map(section => section.key)

    expect(keysOf('default')).toEqual(['SNH48/TEAM SII', 'GNZ48/TEAM G'])
    expect(keysOf('rank')).toEqual(keysOf('default'))
    expect(keysOf('name')).toEqual(keysOf('default'))
  })

  it('姓名口径下分区内按拼音重排', () => {
    const sections = buildSections(list, false, 'name')
    // 丙(bing) < 乙(yi)
    expect(memberNames(sections[0].members)).toEqual(['丙', '乙'])
  })
})

describe('memberCardKey（卡片 key）', () => {
  it('兼任记录用档案主键并加前缀，避免与 userId 数值相撞', () => {
    expect(memberCardKey(makeMember({ realName: '甲', userId: 100, sid: '5', adjunctId: 77 })))
      .toBe('adjunct-77')
  })

  it('普通成员用 userId；官网独有的补充成员没有 userId，退到 sid', () => {
    expect(memberCardKey(makeMember({ realName: '甲', userId: 100, sid: '5' }))).toBe(100)
    expect(memberCardKey(makeMember({ realName: '乙', sid: '5' }))).toBe('5')
  })
})
