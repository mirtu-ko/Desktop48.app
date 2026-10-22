/**
 * 成员「总选排名」的唯一来源：随包的历届总选结果（data/elections.ts）。
 *
 * 为什么要有这一步：卡片皇冠 / 详情抽屉 / 数据看板的排名原本只来自 h5.48.cn 的 allmembers
 * （`ranking` 字段）。那份数据不稳定（实测 2026-10-22 直接 502），而且实测量级只有 14 人；
 * 用历届总选表反算则离线可用、覆盖 211 人，全新安装（库为空）也能看到排名。
 *
 * 口径是**最近一次参加的总选名次**，不是「最新一届」：已退团 / 荣誉毕业生保留最后一次
 * 参赛成绩（与旧数据源一致），所以年份要跟名次一起带出去，展示时标清楚届次避免误读。
 */
import type { Election } from '@renderer/data/elections'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { ELECTIONS } from '@renderer/data/elections'

/** 一次总选成绩 */
export interface ElectionRank {
  /** 名次（1 起） */
  rank: number
  /** 结果公布年份 */
  year: number
  /** 届数 */
  ordinal: number
}

/**
 * userId → 最近一次参加的总选成绩。
 * @param elections 须按届数升序（data/elections.ts 的 ELECTIONS 即此序），后者覆盖前者
 */
export function latestElectionRanks(elections: Election[]): Map<number, ElectionRank> {
  const ranks = new Map<number, ElectionRank>()
  for (const election of elections) {
    for (const member of election.members) {
      ranks.set(member.userId, { rank: member.rank, year: election.year, ordinal: election.ordinal })
    }
  }
  return ranks
}

/** 模块级派生一次：纯数据派生，不必每次合并成员时重算 */
export const ELECTION_RANKS = latestElectionRanks(ELECTIONS)

/**
 * 给合并后的成员名录补排名：**只填本地空着的**，官网名单有值时一律以它为准。
 *
 * 名录的生产方只有两处（Members.vue 与 stores/member-directory），合并完都得过一遍，
 * 否则「官网名单不可用」时排名会整片缺失。`ranks` 参数只为可测性留的注入口，生产调用不必传。
 */
export function applyElectionRanks(
  members: MemberDetail[],
  ranks: ReadonlyMap<number, ElectionRank> = ELECTION_RANKS,
): MemberDetail[] {
  return members.map((member) => {
    if (member.ranking || member.userId === undefined)
      return member
    const rank = ranks.get(member.userId)
    // 名次与年份必须同源增减：官网名单那份排名不带年份，这里补的才带
    return rank ? { ...member, ranking: String(rank.rank), rankingYear: rank.year } : member
  })
}
