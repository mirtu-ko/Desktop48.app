/**
 * 两个成员数据源的合并（纯函数：无状态、无 IO，可脱离 Electron 直接单测）。
 *
 * - 成员树（getMemberTree，源自 starInfo）：主键 userId，带头像 / 写真 / 微博 / 精确状态
 * - h5.48.cn allmembers：带排名 / 经历 / Catch Phrase / 所属公司等官网字段
 *
 * 两者是同一批人但键不同，按可靠度分四轮认领（每轮只处理上一轮没配上的记录）：
 *   1. pocket_id === userId  —— 最可靠，实测 236 条全部精确命中
 *   2. sid === 头像里的 zp_<sid> —— 官网头像即 sid
 *   3. 姓名 + 分团 —— 同名成员（如「李想」跨团两条）靠 gid 映射回 groupId 消歧
 *   4. 姓名
 * 收尾：allmembers 对同一个人会留两条（首次登记的 SNH 体系 + 现属分团），
 * 除已配对的那条外按「同名 + 同期数」判为镜像重复丢弃；仍配不上的（官网独有的
 * 离团成员）作为补充记录追加，能展示、能进「成员库」，但没有 userId 因此不能
 * 屏蔽也不会出现在回放筛选里。
 *
 * 兼任成员（starAdjunctInfo）不在这里合并：见文件末尾的 buildAdjuncts ——
 * 它以合并结果里的本人档案为底、只覆盖队伍定位字段。
 */
import type { AllMemberItem, StarAdjunctItem } from '../../../preload/ipc-contract'
import Constants from '@renderer/utils/constants'
import Tools from '@renderer/utils/tools'

/** 合并后的成员记录：starInfo 字段为主，allmembers 补齐官网字段 */
export interface MemberDetail {
  /** 口袋 48 用户 id：屏蔽名单与回放筛选的唯一键；官网独有的补充成员没有此值 */
  userId?: number
  /** 48 官网成员 id（头像地址 zp_<sid>.jpg 里的数字） */
  sid: string
  realName: string
  nickname: string
  /** 姓名拼音缩写（如 zyg） */
  abbr: string
  /** 已归一化（相对路径 → source.48.cn） */
  avatar: string
  groupId?: number | string
  groupName: string
  teamName: string
  /** 已归一化的队伍徽章 */
  teamBadge: string
  /** 队伍色（HEX 无 #）：与 teamName 同一支队伍的颜色 */
  teamColor: string
  /**
   * 头像圆环强调色（HEX 无 #），仅兼任记录有值。
   * 兼任记录展示在「兼任队伍」的分区里（teamName/teamColor 都是兼任队伍的），
   * 但圆环改用成员本人所属队伍（主队）的颜色，一眼看出兼任成员的来源队伍。
   * 取值来源见本文件 buildAdjuncts；为空时圆环回退 teamColor / 默认渐变。
   */
  ringColor?: string
  /** 兼职档案主键（starAdjunctInfo.adjunctId），仅兼任记录有值：卡片 key 用它，与本人记录区分 */
  adjunctId?: number
  /** 1 在团 2 暂休 3 退团，取值见 Constants.MemberStatus */
  status: number
  birthday: string
  constellation: string
  bloodType: string
  height: string
  birthplace: string
  joinTime: string
  periodName: string
  specialty: string
  hobbies: string
  wbName: string
  wbUid: string
  /** 写真 1-4（已归一化，空值已过滤） */
  photos: string[]
  /** ===== 以下仅 allmembers 提供 ===== */
  /** 总选举排名（'0' 表示无排名） */
  ranking: string
  /** 经历（接口用 <br> 分行） */
  experience: string
  catchPhrase: string
  /** 所属公司 */
  company: string
  [key: string]: unknown
}

/** 合并用到的成员树结构（getMemberTree 返回值的子集，只声明用得上的字段） */
export interface MemberTreeLike {
  groupName: string
  groupId?: number | string
  children: Array<{
    teamName: string
    /** 队伍 id：兼任记录按 id 归位时用；官网补充数据里可能没有 */
    value?: string
    teamBadge?: string
    children: TreeMemberLike[]
  }>
}

/** 树叶子节点（starInfo 全量字段的 spread） */
interface TreeMemberLike {
  userId?: number | string
  realName?: string
  nickname?: string
  avatar?: string
  teamColor?: string
  status?: number
  birthday?: string
  constellation?: string
  bloodType?: string
  height?: string
  birthplace?: string
  joinTime?: string
  periodName?: string
  specialty?: string
  hobbies?: string
  wbName?: string
  wbUid?: string
  fullPhoto1?: string
  fullPhoto2?: string
  fullPhoto3?: string
  fullPhoto4?: string
  [key: string]: unknown
}

/** 树里一行成员 + 其团体 / 队伍上下文 */
interface MemberRow {
  groupName: string
  groupId: number | string | undefined
  teamName: string
  teamBadge: string
  member: TreeMemberLike
}

/** allmembers.gid（48 官网分团 id）→ starInfo.groupId（口袋分团 id），用于同名成员消歧与补充记录归团 */
const GID_TO_GROUP_ID: Record<string, number> = {
  10: 10, // SNH48
  20: 11, // BEJ48
  30: 12, // GNZ48
  40: 13, // SHY48
  50: 14, // CKG48
  60: 21, // CGT48
  70: 15, // IDFT
}

/** 头像地址里的 48 官网成员 id：.../member/zp_10019.jpg → 10019 */
const AVATAR_SID_REGEX = /zp_(\d+)\.jpg/

/** 头像兜底地址：starInfo 无头像时按 sid 拼官网图（与官网命名一致） */
const SNH48_AVATAR_PREFIX = 'https://www.snh48.com/images/member/zp_'

/** 接口用 '0' / 空串表示「无」 */
function text(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return value === '0' ? '' : value
}

/** 姓名去空白后作比较键（两侧可能带全角空格） */
function nameKey(name: unknown): string {
  return String(name ?? '').replace(/\s+/g, '')
}

/** 镜像重复判据：同名 + 同期数（同一人在官网留下的两条记录期数一致）；姓名为空时无从判断 */
function mirrorKey(record: AllMemberItem): string {
  const name = nameKey(record.sname)
  return name ? `${name}|${text(record.pname)}` : ''
}

/** 认领一轮：命中的记录配给行；未命中或该行已被占用的留给下一轮 */
function claim(
  pending: AllMemberItem[],
  paired: Map<number, AllMemberItem>,
  pick: (record: AllMemberItem) => number | undefined,
): AllMemberItem[] {
  const rest: AllMemberItem[] = []
  for (const record of pending) {
    const index = pick(record)
    if (index === undefined || paired.has(index)) {
      rest.push(record)
      continue
    }
    paired.set(index, record)
  }
  return rest
}

/** 组装一条合并记录：row 缺失 = 官网独有的补充成员，record 缺失 = 官网没有的成员 */
function buildMember(
  row: MemberRow | undefined,
  record: AllMemberItem | undefined,
  groupNames: Map<string, string>,
): MemberDetail {
  const member = row?.member || {}
  const extra = record || {}
  const sid = text(extra.sid) || AVATAR_SID_REGEX.exec(member.avatar || '')?.[1] || ''
  const groupId = row ? row.groupId : GID_TO_GROUP_ID[text(extra.gid)]
  // userId 是屏蔽与回放筛选的唯一键，只有树里的成员才有
  const userId = text(member.userId) ? Number(member.userId) : undefined

  return {
    userId: Number.isFinite(userId) ? userId : undefined,
    sid,
    realName: text(member.realName) || text(extra.sname),
    nickname: text(member.nickname) || text(extra.nickname),
    abbr: text(member.abbr) || text(extra.abbr),
    avatar: Tools.sourceUrl(text(member.avatar)) || (sid ? `${SNH48_AVATAR_PREFIX}${sid}.jpg` : ''),
    groupId,
    groupName: row?.groupName || groupNames.get(String(groupId)) || text(extra.gname),
    teamName: row?.teamName || text(extra.tname),
    teamBadge: row?.teamBadge || '',
    teamColor: text(member.teamColor) || text(extra.tcolor) || text(extra.gcolor),
    // 状态以 starInfo 为准（在团 / 暂休 / 退团三态）；官网独有的记录只有 99 / 44 两态
    status: typeof member.status === 'number'
      ? member.status
      : (text(extra.status) === '99' ? Constants.MemberStatus.Active : Constants.MemberStatus.Left),
    birthday: text(member.birthday) || text(extra.birth_day),
    constellation: text(member.constellation) || text(extra.star_sign_12),
    bloodType: text(member.bloodType) || text(extra.blood_type),
    height: text(member.height) || text(extra.height),
    birthplace: text(member.birthplace) || text(extra.birth_place),
    joinTime: text(member.joinTime) || text(extra.join_day),
    periodName: text(member.periodName) || text(extra.pname),
    specialty: text(member.specialty) || text(extra.speciality),
    hobbies: text(member.hobbies) || text(extra.hobby),
    wbName: text(member.wbName),
    wbUid: text(member.wbUid) || text(extra.weibo_uid),
    photos: [member.fullPhoto1, member.fullPhoto2, member.fullPhoto3, member.fullPhoto4]
      .map(photo => Tools.sourceUrl(text(photo)))
      .filter(Boolean),
    ranking: text(extra.ranking),
    experience: text(extra.experience),
    catchPhrase: text(extra.catch_phrase),
    company: text(extra.company),
  }
}

/**
 * 合并成员树与 allmembers 名单，返回按树顺序排列的成员列表
 * （官网独有的补充成员追加在末尾）。
 */
export function mergeMembers(
  tree: MemberTreeLike[] | undefined,
  allmembers: AllMemberItem[] | undefined,
): MemberDetail[] {
  const rows: MemberRow[] = []
  const groupNames = new Map<string, string>()
  for (const group of tree || []) {
    if (group.groupId !== undefined)
      groupNames.set(String(group.groupId), group.groupName)
    for (const team of group.children || []) {
      for (const member of team.children || []) {
        rows.push({
          groupName: group.groupName,
          groupId: group.groupId,
          teamName: team.teamName,
          teamBadge: Tools.sourceUrl(team.teamBadge || ''),
          member,
        })
      }
    }
  }

  // 三张索引表：pocket_id(=userId) / 头像 sid / 姓名（同名多值时按树顺序排列）
  const byUserId = new Map<string, number>()
  const bySid = new Map<string, number>()
  const byName = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const userId = text(row.member.userId)
    if (userId)
      byUserId.set(userId, index)
    const sid = AVATAR_SID_REGEX.exec(row.member.avatar || '')?.[1]
    if (sid)
      bySid.set(sid, index)
    const name = nameKey(row.member.realName)
    if (name)
      byName.set(name, [...(byName.get(name) || []), index])
  })

  const paired = new Map<number, AllMemberItem>()
  const unclaimed = (record: AllMemberItem) =>
    (byName.get(nameKey(record.sname)) || []).filter(index => !paired.has(index))

  let pending = allmembers || []
  pending = claim(pending, paired, record => byUserId.get(text(record.pocket_id)))
  pending = claim(pending, paired, record => bySid.get(text(record.sid)))
  pending = claim(pending, paired, (record) => {
    const groupId = GID_TO_GROUP_ID[text(record.gid)]
    if (groupId === undefined)
      return undefined
    return unclaimed(record).find(index => Number(rows[index].groupId) === groupId)
  })
  pending = claim(pending, paired, record => unclaimed(record)[0])

  // 已配对记录占用的「同名 + 同期数」，用于剔除官网里同一人的镜像记录
  const mirrored = new Set([...paired.values()].map(mirrorKey))
  const extras = pending.filter(record => !mirrored.has(mirrorKey(record)))

  return [
    ...rows.map((row, index) => buildMember(row, paired.get(index), groupNames)),
    ...extras.map(record => buildMember(undefined, record, groupNames)),
  ]
}

/**
 * 由兼职成员档案（starAdjunctInfo）构造兼任成员的展示记录（纯函数，可单测）。
 *
 * 详情字段不另起炉灶：整条以 `members` 里该成员本人的合并记录（主队档案）打底，
 * 与普通卡片共用同一份数据源 —— 于是点开抽屉能看到完整的生日 / 写真 / 经历 / 排名，
 * 而不是一堆空字段。兼职档案只负责「这张卡归到哪支队伍」：
 *   - 覆盖队伍定位字段（groupId/groupName/teamName/teamColor/teamBadge → 兼任队伍）
 *   - 带出档案主键 adjunctId（卡片 key 用）
 * 档案里只有 id，队伍名 / 队色从成员树查表（队色逐成员派生在叶子上，同队必然同色）。
 *
 * 两个例外：
 *   - 头像圆环取**主队色** ringColor：卡片排在兼任队伍分区里，圆环用来标示来源队伍
 *   - 有效兼任一律按在团（status=1）展示：本人档案可能是暂休 / 退团态
 *
 * 被丢弃的两类档案：定位不到队伍（团队名查不到）；兼任队伍与本人主队相同
 * （不产生任何额外信息，留下只会让同一人在同一分区出现两张卡）。
 *
 * @param members  合并后的成员列表（兼任记录的详情来源）
 * @param tree     成员树：提供队伍名 / 队色 / 徽章，以及「成员 → 本人主队 id」
 * @param adjuncts starAdjunctInfo 原始数据，仅 status===1 的记录会被展示
 */
export function buildAdjuncts(
  members: MemberDetail[],
  tree: MemberTreeLike[] | undefined,
  adjuncts: StarAdjunctItem[] | undefined,
): MemberDetail[] {
  if (!adjuncts?.length)
    return []

  // 队伍 id → 队伍名 / 队色 / 徽章，团体 id → 团体名（档案里只有 id，得回成员树查）
  const teamNameById = new Map<string, string>()
  const teamColorById = new Map<string, string>()
  const teamBadgeById = new Map<string, string>()
  const groupNameById = new Map<string, string>()
  // userId → 本人主队 id：识别「兼任队伍 == 主队」的档案（叶子在树里天然带所属队伍，反查即可）
  const ownTeamIdByUserId = new Map<string, string>()
  for (const group of tree || []) {
    if (group.groupId !== undefined)
      groupNameById.set(String(group.groupId), group.groupName)
    for (const team of group.children || []) {
      if (!team.value)
        continue
      teamNameById.set(team.value, team.teamName)
      const badge = text(team.teamBadge)
      if (badge)
        teamBadgeById.set(team.value, Tools.sourceUrl(badge))
      const color = text(team.children.find(child => text(child.teamColor))?.teamColor)
      if (color)
        teamColorById.set(team.value, color)
      for (const leaf of team.children) {
        const uid = text(leaf.userId)
        if (uid)
          ownTeamIdByUserId.set(uid, team.value)
      }
    }
  }

  // userId → 本人（主队）档案：兼任记录详情字段的唯一来源
  const byUserId = new Map<number, MemberDetail>()
  for (const member of members) {
    if (member.userId !== undefined)
      byUserId.set(member.userId, member)
  }

  return adjuncts
    // 只看有效兼任数据
    .filter(a => Number(a.status) === 1)
    // 兼任队伍就是本人主队：该条不带来任何新信息，跳过（否则同一分区出现同一人两张卡）
    .filter(a => ownTeamIdByUserId.get(text(a.userId)) !== String(a.teamId ?? ''))
    .map((a) => {
      const teamId = String(a.teamId ?? '')
      // 本人（主队）档案：详情字段的来源；库里查不到这个人时，下面逐项退回兼职档案
      const own = byUserId.get(Number(a.userId))
      const ownUserId = Number(a.userId)
      return {
        // 本人档案打底：与普通卡片同一份数据，抽屉里资料是齐的
        ...own,
        // —— 定位覆盖：卡片归入兼任队伍的分区 ——
        groupId: a.groupId,
        groupName: groupNameById.get(String(a.groupId ?? '')) || own?.groupName || '',
        teamName: teamNameById.get(teamId) || '',
        teamColor: teamColorById.get(teamId) || '',
        teamBadge: teamBadgeById.get(teamId) || '',
        // 圆环取主队色（兼任队伍色由分区标题承担）
        ringColor: own?.teamColor || '',
        // 有效兼任按在团处理（本人档案可能是暂休 / 退团态）
        status: Constants.MemberStatus.Active,
        realName: own?.realName || text(a.starName),
        nickname: own?.nickname || text(a.nickname),
        abbr: own?.abbr || text(a.abbr),
        avatar: own?.avatar || text(a.headImg),
        sid: own?.sid || '',
        ranking: own?.ranking || '',
        // 本人档案缺失时仍保留档案里的 userId：屏蔽与回放入口依赖它
        userId: own?.userId ?? (Number.isFinite(ownUserId) && ownUserId > 0 ? ownUserId : undefined),
        // 档案主键：卡片 key 用它（见 Members.vue cardKey）
        adjunctId: a.adjunctId,
      } as MemberDetail
    })
    // 兼任成员必须能定位队伍，否则无法归位展示
    .filter(member => member.teamName && member.groupName)
}
