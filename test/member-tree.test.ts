import type { GroupRecord, MemberRecord, TeamRecord } from '../src/main/domain/member-tree'
import { describe, expect, it } from 'vitest'
import { addBlockedMemberId, isBlockedId, removeBlockedId, resolveBlockedMembers } from '../src/main/domain/blocked-members'
import { buildMemberTree } from '../src/main/domain/member-tree'

describe('buildMemberTree（database.ts 抽出的纯函数）', () => {
  const members: MemberRecord[] = [
    { userId: 1, groupId: 10, groupName: 'SNH48', teamId: 100, teamName: 'TEAM SII', realName: '成员一', teamColor: '#old1' },
    { userId: 2, groupId: 10, groupName: 'SNH48', teamId: 100, teamName: 'TEAM SII', realName: '成员二' },
    { userId: 3, groupId: 10, groupName: 'SNH48', teamId: 101, teamName: 'TEAM NII', realName: '成员三' },
    { userId: 4, groupId: 11, groupName: 'BEJ48', teamId: 110, teamName: 'TEAM B', realName: '成员四' },
    { userId: 5, groupName: 'SNH48', realName: '无队伍成员' },
    { userId: 6, realName: '无团体成员' },
  ]
  const teams: TeamRecord[] = [
    { teamId: 100, groupId: 10, teamSort: 2, teamColor: '#f00', seineTeamBadge: 'badge-sii.png' },
    { teamId: 101, groupId: 10, teamSort: 1, teamColor: '#0f0' },
    { teamId: 110, groupId: 11, teamSort: 1 },
  ]
  const groups: GroupRecord[] = [
    { groupId: 10, groupSort: 2 },
    { groupId: 11, groupSort: 1 },
  ]

  it('按 groupName/teamName 分组，缺省归入 未分组/未分队', () => {
    const tree = buildMemberTree(members, teams, groups)
    expect(tree.map(g => g.groupName)).toEqual(['BEJ48', 'SNH48', '未分组'])

    const snh = tree.find(g => g.groupName === 'SNH48')!
    // 队伍按 teamSort 排序：NII(1) 在 SII(2) 前
    expect(snh.children.map(t => t.teamName)).toEqual(['TEAM NII', 'TEAM SII', '未分队'])
    expect(snh.children.find(t => t.teamName === '未分队')!.children[0].label).toBe('无队伍成员')
  })

  it('团体按 groupSort 排序，查不到的排到末尾', () => {
    const tree = buildMemberTree(members, teams, groups)
    expect(tree.map(g => g.groupName)[0]).toBe('BEJ48')
    expect(tree[tree.length - 1].groupName).toBe('未分组')
    expect(tree[tree.length - 1].groupId).toBeUndefined()
  })

  it('teamColor 纯派生：优先队伍色，回退成员自带色，原始数据不被改写', () => {
    const tree = buildMemberTree(members, teams, groups)
    const sii = tree.find(g => g.groupName === 'SNH48')!.children.find(t => t.teamName === 'TEAM SII')!

    expect(sii.teamBadge).toBe('badge-sii.png')
    // 有队伍色的成员：覆盖旧色
    expect(sii.children[0].teamColor).toBe('#f00')
    // 无队伍色记录的成员：取队伍色
    expect(sii.children[1].teamColor).toBe('#f00')

    // 查不到队伍的（未分队）：回退成员自带色
    const noTeam = tree.find(g => g.groupName === 'SNH48')!.children.find(t => t.teamName === '未分队')!
    expect(noTeam.children[0].teamColor).toBe('')

    // 原始数据零改动
    expect(members[0].teamColor).toBe('#old1')
  })

  it('value 用 id 字符串，成员节点展开原始字段', () => {
    const tree = buildMemberTree(members, teams, groups)
    const snh = tree.find(g => g.groupName === 'SNH48')!
    expect(snh.value).toBe('10')
    expect(snh.children[0].value).toBe('101')
    // 成员节点展开原始字段
    expect(snh.children.find(t => t.teamName === 'TEAM SII')!.children[0].realName).toBe('成员一')
  })

  it('团体别名：「明星殿堂」(groupId 19) 归入 SNH48，与同 teamId 队友并成一队', () => {
    const aliased: MemberRecord[] = [
      // 别名成员排在前面：分组名不能取自它自带的 groupName，否则会另起一个「明星殿堂」团体
      { userId: 2, groupId: 19, groupName: '明星殿堂', teamId: 1008, teamName: '明星殿堂', realName: '袁一琦' },
      { userId: 1, groupId: 10, groupName: 'SNH48', teamId: 1008, teamName: '明星殿堂', realName: '孙芮' },
    ]
    const tree = buildMemberTree(aliased, [], [{ groupId: 10, groupName: 'SNH48', groupSort: 1 }])

    expect(tree).toHaveLength(1)
    expect(tree[0].groupName).toBe('SNH48')
    expect(tree[0].groupId).toBe(10)
    // 两个成员同 teamId 1008：并进同一个队伍节点，不各占一队
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].value).toBe('1008')
    expect(tree[0].children[0].children.map(m => m.label)).toEqual(['袁一琦', '孙芮'])
    // 叶子上的 groupId/groupName 跟着分组走，不与所在团体矛盾
    expect(tree[0].children[0].children[0].groupId).toBe(10)
    expect(tree[0].children[0].children[0].groupName).toBe('SNH48')
    // 原始数据零改动
    expect(aliased[0].groupId).toBe(19)

    // 兜底：groupInfo 查不到归属团体名时用成员自带的 groupName，成员不会丢
    const noGroupInfo = buildMemberTree([aliased[0]], [], [])
    expect(noGroupInfo.map(g => g.groupName)).toEqual(['明星殿堂'])
  })

  it('空输入返回空树', () => {
    expect(buildMemberTree(undefined, undefined, undefined)).toEqual([])
    expect(buildMemberTree([], [], [])).toEqual([])
  })
})

describe('blocked-members 纯函数', () => {
  const starInfo: MemberRecord[] = [
    { userId: 1, realName: '甲' },
    { userId: 2, realName: '乙' },
  ]

  it('addBlockedMemberId 幂等，已存在返回 null', () => {
    expect(addBlockedMemberId([], 1)).toEqual([1])
    expect(addBlockedMemberId([1], 1)).toBeNull()
    expect(addBlockedMemberId(undefined, 3)).toEqual([3])
    // 不改动入参
    const list = [1]
    addBlockedMemberId(list, 2)
    expect(list).toEqual([1])
  })

  it('isBlockedId / removeBlockedId 做数值归一化（历史数据可能存字符串 id）', () => {
    expect(isBlockedId(['1', 2], 1)).toBe(true)
    expect(removeBlockedId(['1', 2], 1)).toEqual([2])
    expect(removeBlockedId(undefined, 1)).toEqual([])
  })

  it('resolveBlockedMembers 跳过查不到的 id，成员表缺失时为空', () => {
    expect(resolveBlockedMembers([1, 999], starInfo)).toEqual([starInfo[0]])
    expect(resolveBlockedMembers(undefined, starInfo)).toEqual([])
    expect(resolveBlockedMembers([1], undefined)).toEqual([])
  })
})
