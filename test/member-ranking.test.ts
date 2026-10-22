import type { Election } from '../src/renderer/src/data/elections'
import { describe, expect, it } from 'vitest'
import { applyElectionRanks, latestElectionRanks } from '../src/renderer/src/utils/member-ranking'
import { makeMember } from './fixtures/member'

/** 构造一届总选：只填被测逻辑用到的字段（名次 + userId） */
function makeElection(ordinal: number, year: number, rows: Array<[number, number]>): Election {
  return {
    ordinal,
    year,
    theme: '',
    date: `${year}-08-01`,
    members: rows.map(([rank, userId]) => ({ rank, userId, name: '', group: 'SNH48' })),
    newcomers: [],
  }
}

describe('latestElectionRanks（userId → 最近一次参加的总选成绩）', () => {
  it('同一人参加多届时取最后一届', () => {
    const ranks = latestElectionRanks([
      makeElection(1, 2014, [[5, 1], [9, 2]]),
      makeElection(2, 2015, [[3, 1]]),
    ])
    expect(ranks.get(1)).toEqual({ rank: 3, year: 2015, ordinal: 2 })
    // 只参加过首届的人保留首届成绩
    expect(ranks.get(2)).toEqual({ rank: 9, year: 2014, ordinal: 1 })
  })

  it('最新一届没上榜不清空旧成绩（退团 / 荣誉毕业生保留最后一次参赛名次）', () => {
    const ranks = latestElectionRanks([
      makeElection(1, 2014, [[5, 1]]),
      makeElection(2, 2015, [[3, 2]]),
    ])
    expect(ranks.get(1)?.rank).toBe(5)
    expect(ranks.get(1)?.year).toBe(2014)
  })

  it('新人榜不参与排名（总选名次才进这张表）', () => {
    const election = makeElection(1, 2014, [])
    election.newcomers = [{ rank: 1, userId: 9, name: '', group: 'SNH48' }]
    expect(latestElectionRanks([election]).has(9)).toBe(false)
  })

  it('空输入返回空表', () => {
    expect(latestElectionRanks([]).size).toBe(0)
  })
})

describe('applyElectionRanks（给合并后的名录补排名）', () => {
  const ranks = new Map([
    [1, { rank: 6, year: 2026, ordinal: 13 }],
    [2, { rank: 3, year: 2015, ordinal: 2 }],
  ])

  it('本地没有排名时补上，并带上届次年', () => {
    const [member] = applyElectionRanks([makeMember({ realName: '甲', userId: 1 })], ranks)
    expect(member.ranking).toBe('6')
    expect(member.rankingYear).toBe(2026)
  })

  it('官网名单已有排名时不覆盖，也不混入年份（两个来源的年份口径不同）', () => {
    const [member] = applyElectionRanks([makeMember({ realName: '甲', userId: 1, ranking: '12' })], ranks)
    expect(member.ranking).toBe('12')
    expect(member.rankingYear).toBeUndefined()
  })

  it('总选表里没有的人原样返回（同一个对象引用，不制造无谓的整表重建）', () => {
    const input = makeMember({ realName: '乙', userId: 3 })
    expect(applyElectionRanks([input], ranks)[0]).toBe(input)
  })

  it('没有 userId 的官网独有成员不参与补排名', () => {
    const input = makeMember({ realName: '丙' })
    expect(applyElectionRanks([input], ranks)[0].ranking).toBe('')
  })
})
