import { describe, expect, it } from 'vitest'
import { joinTimeKey, sidKey, sortMembers } from '../src/renderer/src/utils/member-sort'
import { makeMember, memberNames } from './fixtures/member'

describe('joinTimeKey（入团时间 → 可比较的数值键）', () => {
  it('兼容横杠 / 中文 / 点号 / 紧凑四种写法，同一日期得到同一个键', () => {
    expect(joinTimeKey('2016-09-15')).toBe(20160915)
    expect(joinTimeKey('2016年9月15日')).toBe(20160915)
    expect(joinTimeKey('2016.9.15')).toBe(20160915)
    expect(joinTimeKey('20160915')).toBe(20160915)
  })

  it('月日不补零的写法必须按数值分段还原（剔非数字会得到 201695，排到 20160905 之后）', () => {
    // 同一个坑的正反两面：朴素实现剔掉非数字后 201695 > 20160915，顺序会反过来
    expect(joinTimeKey('2016-9-5')).toBe(20160905)
    expect(joinTimeKey('2016-9-5')).toBeLessThan(joinTimeKey('2016-09-15'))
    expect(joinTimeKey('2016.9.5')).toBeLessThan(joinTimeKey('2016.10.1'))
  })

  it('只写年份时按该年年初算，同年内排在具体日期之前', () => {
    expect(joinTimeKey('2016')).toBe(20160000)
    expect(joinTimeKey('2016')).toBeLessThan(joinTimeKey('2016-01-01'))
  })

  it('空值 / 脏数据返回最大整数，统一沉到末尾', () => {
    expect(joinTimeKey(undefined)).toBe(Number.MAX_SAFE_INTEGER)
    expect(joinTimeKey('')).toBe(Number.MAX_SAFE_INTEGER)
    expect(joinTimeKey('   ')).toBe(Number.MAX_SAFE_INTEGER)
    expect(joinTimeKey('待定')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('sidKey（入团时间缺失时的兜底键）', () => {
  it('数字字符串取数值', () => {
    expect(sidKey(makeMember({ realName: '甲', sid: '10001' }))).toBe(10001)
  })

  it('非数字 / 空 / 非正数一律返回最大整数', () => {
    expect(sidKey(makeMember({ realName: '甲', sid: '' }))).toBe(Number.MAX_SAFE_INTEGER)
    expect(sidKey(makeMember({ realName: '甲', sid: 'abc' }))).toBe(Number.MAX_SAFE_INTEGER)
    expect(sidKey(makeMember({ realName: '甲', sid: '0' }))).toBe(Number.MAX_SAFE_INTEGER)
    expect(sidKey(makeMember({ realName: '甲', sid: '-3' }))).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('sortMembers · 默认口径（入团时间，兼任沉底）', () => {
  it('按入团时间升序', () => {
    const list = [
      makeMember({ realName: '丙', sid: '3', joinTime: '2020.3.7' }),
      makeMember({ realName: '乙', sid: '2', joinTime: '2013-11-02' }),
      makeMember({ realName: '甲', sid: '1', joinTime: '2016-09-15' }),
    ]
    expect(memberNames(sortMembers(list, 'default'))).toEqual(['乙', '甲', '丙'])
  })

  it('兼任记录（有 adjunctId）统一沉到末尾，与入团时间无关', () => {
    const list = [
      makeMember({ realName: '兼任的', sid: '9', joinTime: '2013-01-01', adjunctId: 77 }),
      makeMember({ realName: '本队的', sid: '8', joinTime: '2020-01-01' }),
    ]
    expect(memberNames(sortMembers(list, 'default'))).toEqual(['本队的', '兼任的'])
  })

  it('入团时间相同时用 sid 兜底；都没有时保持原顺序（稳定排序）', () => {
    const sameTime = [
      makeMember({ realName: '晚登记', sid: '200', joinTime: '2016-01-01' }),
      makeMember({ realName: '早登记', sid: '100', joinTime: '2016-01-01' }),
    ]
    expect(memberNames(sortMembers(sameTime, 'default'))).toEqual(['早登记', '晚登记'])

    const noTime = [
      makeMember({ realName: '先来的', sid: '100' }),
      makeMember({ realName: '后来的', sid: '200' }),
    ]
    expect(memberNames(sortMembers(noTime, 'default'))).toEqual(['先来的', '后来的'])
  })

  it('缺入团时间的排在最后，不参与时间比较', () => {
    const list = [
      makeMember({ realName: '没时间', sid: '1' }),
      makeMember({ realName: '有时间', sid: '2', joinTime: '2030-01-01' }),
    ]
    expect(memberNames(sortMembers(list, 'default'))).toEqual(['有时间', '没时间'])
  })

  it('不原地修改入参（members 是响应式源，就地排会污染其它消费者）', () => {
    const list = [
      makeMember({ realName: '丙', sid: '3', joinTime: '2020-01-01' }),
      makeMember({ realName: '乙', sid: '2', joinTime: '2013-01-01' }),
    ]
    const sorted = sortMembers(list, 'default')
    expect(memberNames(list)).toEqual(['丙', '乙'])
    expect(memberNames(sorted)).toEqual(['乙', '丙'])
    expect(sorted).not.toBe(list)
  })
})

describe('sortMembers · 排名口径', () => {
  it('名次小者在前，无排名（0 / 空）的沉到末尾', () => {
    const list = [
      makeMember({ realName: '无排名', sid: '1', ranking: '0' }),
      makeMember({ realName: '第三', sid: '2', ranking: '3' }),
      makeMember({ realName: '第一', sid: '3', ranking: '1' }),
      makeMember({ realName: '空排名', sid: '4', ranking: '' }),
    ]
    expect(memberNames(sortMembers(list, 'rank'))).toEqual(['第一', '第三', '无排名', '空排名'])
  })

  it('只有一方有名次时，有名次的排在前面', () => {
    const list = [
      makeMember({ realName: '无', sid: '1', ranking: '0' }),
      makeMember({ realName: '有', sid: '2', ranking: '48' }),
    ]
    expect(memberNames(sortMembers(list, 'rank'))).toEqual(['有', '无'])
  })

  it('都没有名次时保持原顺序（rankB - rankA 恒为 0，交给稳定排序）', () => {
    const list = [
      makeMember({ realName: '甲', sid: '1' }),
      makeMember({ realName: '乙', sid: '2' }),
      makeMember({ realName: '丙', sid: '3' }),
    ]
    expect(memberNames(sortMembers(list, 'rank'))).toEqual(['甲', '乙', '丙'])
  })
})

describe('sortMembers · 姓名口径', () => {
  it('按拼音排序，而不是按码位', () => {
    // 码位序是 包(U+5305) < 安(U+5B89) < 陈(U+9648)，拼音序是 安(an) < 包(bao) < 陈(chen)
    const list = [
      makeMember({ realName: '陈', sid: '1' }),
      makeMember({ realName: '安', sid: '2' }),
      makeMember({ realName: '包', sid: '3' }),
    ]
    expect(memberNames(sortMembers(list, 'name'))).toEqual(['安', '包', '陈'])
  })

  it('姓名缺失不抛错', () => {
    const list = [
      makeMember({ realName: '', sid: '1' }),
      makeMember({ realName: '王', sid: '2' }),
    ]
    expect(memberNames(sortMembers(list, 'name'))).toEqual(['', '王'])
  })
})
