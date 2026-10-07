import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_GROUP_COUNT,
  EXCLUDED_GROUP_LABELS,
  excludeMembers,
  isExcludedMember,
} from '../src/renderer/src/utils/member-exclude'
import { makeMember } from './fixtures/member'

describe('isExcludedMember（非 48 系衍生团体不纳入成员页）', () => {
  it('按 groupId 命中：上游改显示名也拦得住', () => {
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 20 }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 22 }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 80 }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 81 }))).toBe(true)
  })

  it('groupId 以字符串下发时同样命中（接口两种写法都出现过）', () => {
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: '80' }))).toBe(true)
  })

  it('按团体名命中：上游改 id 也拦得住', () => {
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: '丝芭影视' }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: 'Error404Girls' }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: '燃烧吧团魂' }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: '新星闪耀计划' }))).toBe(true)
  })

  it('「团魂」是「燃烧吧团魂」的简称，作为别名一并命中（它是该团的 periodName）', () => {
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: '团魂' }))).toBe(true)
  })

  it('名称比较前归一化：大小写与空白差异不影响命中', () => {
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: 'error404girls' }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: 'Error404 Girls' }))).toBe(true)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: ' 丝芭影视 ' }))).toBe(true)
  })

  it('48 系正式团体与其他团体都不受影响（只排除点名的四个）', () => {
    for (const [groupId, groupName] of [[10, 'SNH48'], [11, 'BEJ48'], [12, 'GNZ48'], [13, 'SHY48'], [14, 'CKG48'], [21, 'CGT48'], [15, 'IDFT'], [19, '明星殿堂'], [16, '海外练习生']] as const) {
      expect(isExcludedMember(makeMember({ realName: '甲', groupId, groupName }))).toBe(false)
    }
  })

  it('团体名与队伍名同名时只按团体判：SNH48 下名为「明星殿堂」的队伍成员要保留', () => {
    // 明星殿堂既是 SNH48 的一支队伍，也是独立的 groupId 19；只有后者才该被特殊对待（且未被点名排除）
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 10, groupName: 'SNH48', teamName: '明星殿堂' }))).toBe(false)
    expect(isExcludedMember(makeMember({ realName: '甲', groupId: 19, groupName: '明星殿堂', teamName: '明星殿堂' }))).toBe(false)
  })

  it('团体信息全缺时不误伤', () => {
    expect(isExcludedMember(makeMember({ realName: '甲' }))).toBe(false)
    expect(isExcludedMember(makeMember({ realName: '甲', groupName: '' }))).toBe(false)
  })
})

describe('excludeMembers（列表过滤）', () => {
  const list = [
    makeMember({ realName: 'SNH 甲', groupId: 10, groupName: 'SNH48', teamName: 'TEAM SII' }),
    makeMember({ realName: '影视 乙', groupId: 20, groupName: '丝芭影视', teamName: '丝芭影视' }),
    makeMember({ realName: '团魂 丙', groupId: 80, groupName: '燃烧吧团魂', teamName: '燃烧吧团魂' }),
    makeMember({ realName: 'IDFT 丁', groupId: 15, groupName: 'IDFT', teamName: 'IDFT' }),
    makeMember({ realName: '404 戊', groupId: 22, groupName: 'Error404Girls', teamName: 'Error404Girls' }),
    makeMember({ realName: '新星 己', groupId: 81, groupName: '新星闪耀计划', teamName: '新星闪耀计划' }),
  ]

  it('四个团体的成员全部滤掉，其余原样保留且顺序不变', () => {
    expect(excludeMembers(list).map(member => member.realName)).toEqual(['SNH 甲', 'IDFT 丁'])
  })

  it('空列表与全命中列表都能正确处理', () => {
    expect(excludeMembers([])).toEqual([])
    expect(excludeMembers(list.filter(member => member.groupId !== 10 && member.groupId !== 15))).toEqual([])
  })
})

describe('导出给页头文案用的常量', () => {
  it('数量与显示名列表保持同步（文案不写死数字）', () => {
    expect(EXCLUDED_GROUP_COUNT).toBe(4)
    expect(EXCLUDED_GROUP_LABELS).toEqual(['丝芭影视', 'Error404Girls', '燃烧吧团魂', '新星闪耀计划'])
    expect(EXCLUDED_GROUP_LABELS).toHaveLength(EXCLUDED_GROUP_COUNT)
  })
})
