import { describe, expect, it } from 'vitest'
import { ELECTIONS } from '../src/renderer/src/data/elections'
import Constants from '../src/renderer/src/utils/constants'
import {
  avatarUrl,
  buildSections,
  formatElectionDate,
  formatVotes,
  groupColor,
  ordinalLabel,
} from '../src/renderer/src/utils/election'

/** 造 n 个连续名次的假成员，用于分段测试 */
function makeMembers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    name: `成员${i + 1}`,
    group: 'SNH48',
  }))
}

describe('ordinalLabel（届数的中文写法）', () => {
  it('个位、整十、十几、二十以上各自的读法', () => {
    expect(ordinalLabel(1)).toBe('第一届')
    expect(ordinalLabel(9)).toBe('第九届')
    expect(ordinalLabel(10)).toBe('第十届')
    expect(ordinalLabel(11)).toBe('第十一届')
    expect(ordinalLabel(12)).toBe('第十二届')
    expect(ordinalLabel(13)).toBe('第十三届')
    expect(ordinalLabel(20)).toBe('第二十届')
    expect(ordinalLabel(99)).toBe('第九十九届')
  })

  it('超出 1-99 或非整数返回空串', () => {
    expect(ordinalLabel(0)).toBe('')
    expect(ordinalLabel(-1)).toBe('')
    expect(ordinalLabel(100)).toBe('')
    expect(ordinalLabel(1.5)).toBe('')
    expect(ordinalLabel(Number.NaN)).toBe('')
  })
})

describe('formatVotes（票数千分位）', () => {
  it('整数按三位一组加逗号', () => {
    expect(formatVotes(19281)).toBe('19,281')
    expect(formatVotes(1222641)).toBe('1,222,641')
    expect(formatVotes(999)).toBe('999')
    expect(formatVotes(1000)).toBe('1,000')
  })

  it('保留官方公布的小数位', () => {
    expect(formatVotes(230752.7)).toBe('230,752.7')
    expect(formatVotes(174020.18)).toBe('174,020.18')
  })

  it('非有限值返回空串（Infinity 会绕过 || 短路，必须显式挡）', () => {
    expect(formatVotes(Number.NaN)).toBe('')
    expect(formatVotes(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('buildSections（名次分段）', () => {
  it('16 人只有星光组，32 人再加高飞组', () => {
    expect(buildSections(makeMembers(16)).map(section => section.title)).toEqual(['星光组'])
    expect(buildSections(makeMembers(32)).map(section => section.title)).toEqual(['星光组', '高飞组'])
  })

  it('66 人四段齐全，每段 16/16/16/18 且组内名次连续升序', () => {
    const sections = buildSections(makeMembers(66))
    expect(sections.map(section => section.title)).toEqual(['星光组', '高飞组', '梦想组', '未来组'])
    expect(sections.map(section => section.members.length)).toEqual([16, 16, 16, 18])
    expect(sections.map(section => section.range)).toEqual(['TOP16', 'TOP32', 'TOP48', 'TOP66'])
    for (const section of sections) {
      const ranks = section.members.map(member => member.rank)
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    }
  })

  it('空名单不产出任何分区', () => {
    expect(buildSections([])).toEqual([])
  })
})

describe('groupColor（团体徽章色）', () => {
  it('现役五团与成员页 tab 共用同一份色值', () => {
    for (const tab of Constants.GroupTabs.slice(1))
      expect(groupColor(tab.label)).toBe(tab.color)
  })

  it('已解散团体走历史色表', () => {
    expect(groupColor('SHY48')).toBe('#5b8def')
    expect(groupColor('IDFT')).toBe('#9b8ec4')
  })

  it('查不到的团体返回空串（交给中性灰兜底）', () => {
    expect(groupColor('UNKNOWN')).toBe('')
    expect(groupColor('')).toBe('')
  })
})

describe('avatarUrl / formatElectionDate', () => {
  it('有 sid 拼官网头像地址，没有则空串', () => {
    expect(avatarUrl('10013')).toBe('https://www.snh48.com/images/member/zp_10013.jpg')
    expect(avatarUrl(undefined)).toBe('')
    expect(avatarUrl('')).toBe('')
  })

  it('日期改成点号分隔，无法解析时原样返回', () => {
    expect(formatElectionDate('2014-07-26')).toBe('2014.07.26')
    expect(formatElectionDate('')).toBe('')
  })
})

describe('elections 数据集自检', () => {
  it('十三届，届数升序且与年份一一对应', () => {
    expect(ELECTIONS).toHaveLength(13)
    ELECTIONS.forEach((election, index) => {
      expect(election.ordinal).toBe(index + 1)
      expect(election.year).toBe(2014 + index)
      expect(election.theme).toBeTruthy()
      expect(election.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(election.date.slice(0, 4)).toBe(String(election.year))
    })
  })

  it('每届总选名次从 1 起连续递增，入选人数符合当届规模', () => {
    const expectedCount = [16, 32, 48, 66, 66, 48, 48, 48, 48, 48, 48, 48, 66]
    ELECTIONS.forEach((election, index) => {
      expect(election.members).toHaveLength(expectedCount[index])
      expect(election.members.map(member => member.rank))
        .toEqual(Array.from({ length: expectedCount[index] }, (_, i) => i + 1))
    })
  })

  it('新人榜名次从 1 起连续，届次覆盖与官方一致（第 8 届起才有）', () => {
    const expectedCount = [0, 0, 0, 0, 0, 0, 0, 7, 7, 16, 16, 16, 16]
    ELECTIONS.forEach((election, index) => {
      expect(election.newcomers).toHaveLength(expectedCount[index])
      expect(election.newcomers.map(member => member.rank))
        .toEqual(Array.from({ length: expectedCount[index] }, (_, i) => i + 1))
    })
  })

  it('每份名单内不重名（兼任成员只留一条）', () => {
    for (const election of ELECTIONS) {
      for (const list of [election.members, election.newcomers]) {
        const names = list.map(member => member.name)
        expect(new Set(names).size).toBe(names.length)
      }
    }
  })

  it('每条记录的团体都能查到徽章色，姓名与 sid 格式合法', () => {
    for (const election of ELECTIONS) {
      for (const member of [...election.members, ...election.newcomers]) {
        expect(member.name.trim()).not.toBe('')
        expect(groupColor(member.group)).not.toBe('')
        // 姓名里残留的 HTML 实体说明抓取没清洗干净
        expect(member.name).not.toContain('&nbsp;')
        // sid 直接拼进头像地址，非数字会让 el-image 直接报错
        if (member.sid !== undefined)
          expect(member.sid).toMatch(/^\d+$/)
      }
    }
  })

  it('票数只公布前若干名：有票的名次是从 1 起的连续段', () => {
    for (const election of ELECTIONS) {
      const ranked = election.members
        .filter(member => member.votes !== undefined)
        .map(member => member.rank)
      expect(ranked).toEqual(Array.from({ length: ranked.length }, (_, i) => i + 1))
    }
  })

  it('新人榜不记票数（官方只公布名次）', () => {
    for (const election of ELECTIONS) {
      for (const member of election.newcomers)
        expect(member.votes).toBeUndefined()
    }
  })
})
