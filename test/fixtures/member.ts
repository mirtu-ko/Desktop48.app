import type { MemberDetail } from '../../src/renderer/src/utils/member-merge'

/**
 * 测试用的成员构造器：只填被测逻辑用得到的字段，其余给空值。
 * MemberDetail 有 30+ 个字段，逐个在用例里写全会把断言淹没在噪音里；
 * 空值口径与「接口没下发这个字段」一致，不改变被测逻辑的分支走向。
 */
export function makeMember(overrides: Partial<MemberDetail> & { realName: string }): MemberDetail {
  return {
    sid: '0',
    nickname: '',
    abbr: '',
    avatar: '',
    groupName: '',
    teamName: '',
    teamBadge: '',
    teamColor: '',
    status: 1,
    birthday: '',
    constellation: '',
    bloodType: '',
    height: '',
    birthplace: '',
    joinTime: '',
    periodName: '',
    specialty: '',
    hobbies: '',
    wbName: '',
    wbUid: '',
    photos: [],
    ranking: '',
    experience: '',
    catchPhrase: '',
    company: '',
    ...overrides,
  }
}

/** 取姓名序列：排序类断言一律比对它，失败信息比比对整个对象可读得多 */
export function memberNames(list: MemberDetail[]): string[] {
  return list.map(item => item.realName)
}
