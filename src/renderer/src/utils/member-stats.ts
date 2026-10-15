/**
 * 成员数据看板的统计口径（纯函数：无状态、无 IO，可脱离 Electron 直接单测）。
 * 页面只负责把结果铺成图表，分组 / 归一化 / 排序的规则全部收在这里。
 *
 * 所有统计函数都要求传入「一人一条」的规范列表 —— 先过 canonicalMembers，
 * 否则兼任记录会把同一个人算两遍（成员库 tab 的原始列表含兼任镜像卡）。
 */
import type { MemberDetail } from '@renderer/utils/member-merge'
import Constants from '@renderer/utils/constants'
import { parseBirthday } from '@renderer/utils/member-birthday'
import { joinTimeKey } from '@renderer/utils/member-sort'
import Tools from '@renderer/utils/tools'

/** 图表的一行：标签 + 计数 */
export interface StatItem {
  label: string
  count: number
}

export interface HeightEntry {
  member: MemberDetail
  height: number
}

export interface HeightRanking {
  tallest: HeightEntry[]
  shortest: HeightEntry[]
  /** 平均身高（cm，四舍五入）；无人有有效身高时为 0 */
  average: number
  /** 参与统计的人数（身高字段有效者） */
  counted: number
}

export interface StatsOverview {
  total: number
  /** 现役在团人数：status = 1 且非荣誉毕业生 / 明星殿堂 */
  active: number
  hiatus: number
  left: number
  /**
   * 荣誉毕业生 / 明星殿堂人数（均为 status = 1）。
   * 与 `active` 成对：`active + honorary` 恒等于「status 为在团」的原始人数。
   */
  honorary: number
  /** 在团（现役）成员覆盖到的队伍数 */
  teams: number
  averageHeight: number
  /** 有总选排名的成员数（含历届上榜、现已退团的） */
  ranked: number
}

/*
 * 两张纯数据表写成「空白分隔的字符串 + split」而不是数组字面量：
 * 本项目启用 antfu/consistent-list-newline，跨行数组会被强制一项一行，
 * 40 多个单字条目排成 40 多行会把文件的正文挤没；这里用空白分隔既过 lint 又能按地域/顺序分组。
 */

/** 12 星座的规范名（去「座」后缀）：用来过滤接口里混进来的脏值，保证星座图恒为 12 项之内 */
const CONSTELLATIONS = '白羊 金牛 双子 巨蟹 狮子 处女 天秤 天蝎 射手 摩羯 水瓶 双鱼'.split(' ')

/**
 * 星座别名 → 规范名。
 * 上游**同时下发「摩羯座」与「魔羯座」两种写法**（实测 20 人 / 44 人），其实是同一个星座 ——
 * 「摩羯」是 Capricornus 的中文正名，「魔羯」是常见笔误。不归一的话「魔羯」会被当脏值丢掉，
 * 摩羯座凭空少掉一大半（64 → 20），在图上变成倒数第二稀有的星座。
 */
const CONSTELLATION_ALIASES: Record<string, string> = { 魔羯: '摩羯' }

/**
 * 省级行政区（含直辖市与特别行政区）。命中方式是在归一化后的字符串里找首个匹配项，
 * 所以「湖南 长沙」「湖南省长沙市」都会归到「湖南」，而「内蒙古」不会被更短的规则切碎。
 * 顺序按地域分组，也顺带保证多字项排在前面（includes 兜底时先命中更具体的名字）。
 */
const PROVINCES = `
内蒙古 黑龙江 香港 澳门
北京 天津 上海 重庆
河北 山西 辽宁 吉林 江苏 浙江 安徽 福建 江西 山东
河南 湖北 湖南 广东 广西 海南
四川 贵州 云南 西藏 陕西 甘肃 青海 宁夏 新疆
台湾
`.trim().split(/\s+/)

/**
 * 一人一条的规范列表：剔除兼任镜像卡，再按 userId 去重。
 * 兼任记录与本人共用 userId（只有 adjunctId 不同），不剔掉会让所有计数偏大。
 * 官网独有的补充成员没有 userId，无从去重，原样保留。
 */
export function canonicalMembers(members: MemberDetail[]): MemberDetail[] {
  const seen = new Set<number>()
  const result: MemberDetail[] = []
  for (const member of members) {
    if (member.adjunctId !== undefined)
      continue
    if (member.userId !== undefined) {
      if (seen.has(member.userId))
        continue
      seen.add(member.userId)
    }
    result.push(member)
  }
  return result
}

/** 数据看板的范围选项：key 一律是 groupId 字符串，与左上角 tab / 公演页共用同一套命名 */
export interface StatsScope {
  label: string
  key: string
  /** 分团色（CSS 颜色值）；全库范围为空 */
  color?: string
}

/**
 * 「全部」范围的 key：直接沿用 Constants.GroupTabs 第一项的 key('0')。
 * groupId 是自增主键、从 1 起，'0' 不会与任何真实分团撞车，所以能安全地当哨兵值。
 */
export const STATS_ALL_SCOPE = '0'

/**
 * 按范围筛成员：'0' / 空串表示全库，其余按 groupId 精确匹配。
 * 传进来的列表应已过 canonicalMembers —— 兼任镜像卡会被并进本人所属的分团，
 * 先筛后去重会让「本人算 A 团、兼任卡算 B 团」这类重复计数漏网。
 */
export function scopeMembers(members: MemberDetail[], scope: string): MemberDetail[] {
  if (!scope || scope === STATS_ALL_SCOPE)
    return members
  return members.filter(member => String(member.groupId) === scope)
}

/**
 * 状态口径：`all` 含在团 / 暂休 / 退团，`active` 只看现役在团（口径见 statusMembers）。
 * 与「范围」是两个正交维度，可任意组合（「GNZ48 在团成员的血型分布」）。
 */
export type StatsStatus = 'all' | 'active'

export const STATS_STATUS_ALL: StatsStatus = 'all'

export const STATS_STATUS_OPTIONS: Array<{ key: StatsStatus, label: string, title: string }> = [
  { key: 'all', label: '全部', title: '含在团 / 暂休 / 退团' },
  { key: 'active', label: '在团', title: '只看现役在团成员（不含荣誉毕业生 / 明星殿堂）' },
]

/**
 * 荣誉毕业生 / 明星殿堂：已毕业、升堂的成员，上游仍以 `status = 1`（在团）挂在名册上。
 *
 * 实测 42 人（SNH48 荣誉毕业生 27 + 明星殿堂 4、GNZ48 荣誉毕业生 11），**全部 status = 1**，
 * 于是「在团」口径会把她们一并算进去 —— 而她们早已不参加公演与总选。
 *
 * ⚠️ **判据只能落在 `teamName`**：成员树把 groupId 19（明星殿堂）别名归并进 SNH48，
 * 合并结果里没有任何成员的 `groupName` 是「明星殿堂」（实测 0 条），按团体名判一条都拦不住；
 * `MemberDetail` 也没有 teamId 字段，做不了「id + 名称」双判据（对比 member-exclude 的团体排除）。
 */
const HONORARY_TEAM_NAMES = ['荣誉毕业生', '明星殿堂']

/** 是否为荣誉毕业生 / 明星殿堂成员（队伍名比较前去空白） */
export function isHonoraryMember(member: MemberDetail): boolean {
  return HONORARY_TEAM_NAMES.includes((member.teamName || '').trim())
}

/**
 * 按状态口径筛成员。
 *
 * **「在团」= 现役在团**：除 `status === 1` 外还要排掉荣誉毕业生 / 明星殿堂 ——
 * 她们在上游同样是 status = 1，但已不参加公演与总选，算进来会让在团人数虚高 42 人。
 *
 * **与 scopeMembers 一样，必须排在 canonicalMembers 之后**：
 * 兼任镜像卡的状态跟着本人走，先去重再筛才不会把同一个人数两遍。
 */
export function statusMembers(members: MemberDetail[], status: StatsStatus): MemberDetail[] {
  if (status === STATS_STATUS_ALL)
    return members
  return members.filter(member =>
    member.status === Constants.MemberStatus.Active && !isHonoraryMember(member),
  )
}

/** 字符串数组 → 计数表（空串与空白串不计入） */
function countBy(values: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const raw of values) {
    const key = raw.trim()
    if (!key)
      continue
    map.set(key, (map.get(key) || 0) + 1)
  }
  return map
}

function toItems(map: Map<string, number>): StatItem[] {
  return [...map].map(([label, count]) => ({ label, count }))
}

/** 计数降序；同数时按标签的拼音序，避免每次渲染顺序抖动 */
function byCountDesc(a: StatItem, b: StatItem): number {
  return b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN')
}

/** 星座分布：去掉「座」后缀、归一别名后按人数降序。非星座的脏值一律丢弃 */
export function constellationStats(members: MemberDetail[]): StatItem[] {
  const names = members
    .map((member) => {
      const raw = (member.constellation || '').trim().replace(/座$/, '')
      return CONSTELLATION_ALIASES[raw] ?? raw
    })
    .filter(name => CONSTELLATIONS.includes(name))
  return toItems(countBy(names)).sort(byCountDesc)
}

/**
 * 入团年份分布：按年份升序（时间轴读法，不按人数排）。
 * 复用 member-sort 的 joinTimeKey 拿到 YYYYMMDD，取其万位以上即年份；
 * 缺失或只有脏值时该成员不计入。
 */
export function joinYearStats(members: MemberDetail[]): StatItem[] {
  const years: string[] = []
  for (const member of members) {
    const key = joinTimeKey(member.joinTime)
    if (key === Number.MAX_SAFE_INTEGER)
      continue
    years.push(String(Math.floor(key / 10000)))
  }
  return toItems(countBy(years)).sort((a, b) => Number(a.label) - Number(b.label))
}

/** 期数文本拆解结果：接口下发的是「SNH48 一期生」这种「团体 + 期数」的组合 */
export interface PeriodInfo {
  /** 团体名（「SNH48 一期生」→ SNH48）；文本里没有团体前缀时为空串 */
  group: string
  /** 期数名（「SNH48 一期生」→ 一期生） */
  name: string
  /** 期数序号（一期生 → 1）；认不出时排到末尾 */
  order: number
}

/** 中文数字：期数只用到个位与十位组合（一~九 / 十 / 十一~十九 / 二十~九十九） */
const CN_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/** 期数名 → 序号：'一期生' → 1、'十二期生' → 12、'1期生' → 1。认不出返回 MAX_SAFE_INTEGER（排到末尾） */
export function periodOrder(name: string): number {
  const arabic = name.match(/\d+/)
  if (arabic)
    return Number(arabic[0])

  const chinese = name.match(/[一二三四五六七八九十]+/)
  if (!chinese)
    return Number.MAX_SAFE_INTEGER

  const text = chinese[0]
  if (text === '十')
    return 10
  const tenIndex = text.indexOf('十')
  // 不含「十」：一~九
  if (tenIndex === -1)
    return CN_NUMERALS[text] ?? Number.MAX_SAFE_INTEGER

  const tens = tenIndex === 0 ? 1 : (CN_NUMERALS[text[0]] ?? 0)
  const ones = tenIndex === text.length - 1 ? 0 : (CN_NUMERALS[text[tenIndex + 1]] ?? 0)
  return tens * 10 + ones
}

/**
 * 「团体 + 期数」按首个空白拆成两段；没有空白（如「四期生」）则整串当名称。
 * 用 search + slice 而不是 /^(\S+)\s+(.+)$/：那个正则的两个量词能吃同一批字符，
 * 会被 lint 的 regexp/no-super-linear-backtracking 判为可被恶意输入拖慢（成员库文本来自接口，不可信）。
 */
export function parsePeriod(value: string | undefined): PeriodInfo {
  const raw = (value || '').trim()
  if (!raw)
    return { group: '', name: '', order: Number.MAX_SAFE_INTEGER }

  const gap = raw.search(/\s/)
  const group = gap === -1 ? '' : raw.slice(0, gap)
  const name = gap === -1 ? raw : raw.slice(gap).trim()
  return { group, name, order: periodOrder(name) }
}

/**
 * 期数分布。三个要点：
 *
 * - **跨团范围保留团体前缀**（「SNH48 一期生」），单团范围内剥掉前缀只留「一期生」——
 *   各团的「一期生」是不同年代的不同批人，糊成一条会误导；但单团范围里前缀纯属重复信息。
 * - **按期数序号升序**（先按团体聚拢）：期数是时间轴，按人数排会把一期生和十六期生插在一起。
 * - **团体之间按人数降序**（人数相同时按团名）：跨团时十几二十条柱子，把主团排在最前面
 *   比按团名字母序排更符合阅读预期 —— 字母序会把 SNH48 沉到最底下。
 */
export function periodStats(members: MemberDetail[]): StatItem[] {
  const parsed = members.map(member => parsePeriod(member.periodName))
  const withGroup = new Set(parsed.map(item => item.group).filter(Boolean)).size > 1

  const merged = new Map<string, { label: string, group: string, order: number, count: number }>()
  const groupSize = new Map<string, number>()
  for (const item of parsed) {
    if (!item.name)
      continue
    if (item.group)
      groupSize.set(item.group, (groupSize.get(item.group) ?? 0) + 1)

    const label = withGroup && item.group ? `${item.group} ${item.name}` : item.name
    const existing = merged.get(label)
    if (existing) {
      existing.count += 1
      continue
    }
    merged.set(label, { label, group: item.group, order: item.order, count: 1 })
  }

  // 团名 → 名次。没有团体前缀的条目拿不到名次（-1），排在最前，与单团范围的旧行为一致。
  const groupRank = new Map<string, number>()
  ;[...groupSize.keys()]
    .sort((a, b) => (groupSize.get(b) ?? 0) - (groupSize.get(a) ?? 0) || a.localeCompare(b))
    .forEach((key, index) => groupRank.set(key, index))

  return [...merged.values()]
    .sort((a, b) =>
      (groupRank.get(a.group) ?? -1) - (groupRank.get(b.group) ?? -1)
      || a.order - b.order
      || a.label.localeCompare(b.label, 'zh-Hans-CN'),
    )
    .map(item => ({ label: item.label, count: item.count }))
}

/** 分团分布：只在「全部」范围下有意义（单团范围只有一根柱子） */
export function groupStats(members: MemberDetail[]): StatItem[] {
  return toItems(countBy(members.map(member => member.groupName || ''))).sort(byCountDesc)
}

/** 队伍分布：跨团时带团体前缀，否则 SII / G 这类队名会与别团重名 */
export function teamStats(members: MemberDetail[]): StatItem[] {
  const withGroup = new Set(members.map(member => member.groupName).filter(Boolean)).size > 1
  const labels = members.map((member) => {
    const team = Tools.shortTeamName(member.teamName).trim()
    if (!team)
      return ''
    // 队伍名与团体名相同时不再补前缀：IDFT / 海外练习生 / 明星殿堂 这类单人团体，
    // 其「队伍」就是它自己，补前缀会拼出「IDFT IDFT」这种读起来像 bug 的标签
    if (!withGroup || !member.groupName || team === member.groupName)
      return team
    return `${member.groupName} ${team}`
  })
  return toItems(countBy(labels)).sort(byCountDesc)
}

/** 血型分布：接口偶有「O型」「o」这类写法，统一取开头的字母串 */
export function bloodTypeStats(members: MemberDetail[]): StatItem[] {
  const types = members
    .map(member => (member.bloodType || '').trim().toUpperCase().match(/^[ABO]+/)?.[0] ?? '')
    .filter(Boolean)
  return toItems(countBy(types)).sort(byCountDesc)
}

/**
 * 生日月份分布：1-12 月全列，无人过生日的月份也留一条空条 ——
 * 日历读法要的正是「哪个月空着」。单团范围常有空月，跨团基本填满。
 */
export function birthMonthStats(members: MemberDetail[]): StatItem[] {
  const months = countBy(
    members
      .map(member => parseBirthday(member.birthday)?.month ?? 0)
      .filter(Boolean)
      .map(String),
  )
  return Array.from({ length: 12 }, (_, index) => ({
    label: `${index + 1} 月`,
    count: months.get(String(index + 1)) ?? 0,
  }))
}

/**
 * 出生地 → 省级行政区。三步：
 *
 * 1. **归一**：去掉空白与分隔符，并剥掉开头的「中国」/「中华人民共和国」——
 *    上游大量使用「中国 四川」这种写法（实测占多数），还有「中国成都」。
 * 2. **匹配省份表**（先 startsWith 再 includes），命中即归到该省。
 * 3. **认不出时只在它像地名时才保留原文**（2-4 个纯汉字，如「成都」「温州」），否则判为无效。
 *    上游用 `-` 当占位符（实测 37 人），还有「滢112」这种脏值 ——
 *    放行它们会在图表里长出一根叫「-」的柱子。
 */
export function birthplaceRegion(value: string | undefined): string {
  const raw = (value || '')
    .replace(/[\s,，、/·]+/g, '')
    .replace(/^中华人民共和国/, '')
    .replace(/^中国/, '')
  if (!raw)
    return ''
  const exact = PROVINCES.find(province => raw.startsWith(province))
  if (exact)
    return exact
  const loose = PROVINCES.find(province => raw.includes(province))
  if (loose)
    return loose
  return /^[\u4E00-\u9FA5]{2,4}$/.test(raw) ? raw : ''
}

/**
 * 出生地分布：按人数降序，可选截断到前 limit 个省级行政区。
 *
 * **默认不截断**。早先固定取 TOP8，但条形图的「合计」只能加总传进来的条目 ——
 * 榜内 8 条加起来是 480 人，而实际有籍贯的是 862 人，等于把 862 显示成 480；
 * 百分比也跟着按榜内算（四川 23% 而非真实的 13%）。要看榜单就由调用方显式传 limit，
 * 并把「合计」理解为榜内之和。
 */
export function birthplaceStats(members: MemberDetail[], limit?: number): StatItem[] {
  const regions = members.map(member => birthplaceRegion(member.birthplace)).filter(Boolean)
  const items = toItems(countBy(regions)).sort(byCountDesc)
  return limit === undefined ? items : items.slice(0, limit)
}

/** 身高文本 → 厘米数：只认 100-250 区间内的 2-3 位整数，其余（缺失 / 「168cm」外的脏值）判为 0 */
export function parseHeight(value: string | undefined): number {
  const matched = (value || '').match(/(\d{2,3})/)
  if (!matched)
    return 0
  const height = Number(matched[1])
  return height >= 100 && height <= 250 ? height : 0
}

/** 身高之最：最高 / 最矮各 limit 名 + 平均身高 */
export function heightRanking(members: MemberDetail[], limit = 5): HeightRanking {
  const entries = members
    .map(member => ({ member, height: parseHeight(member.height) }))
    .filter(entry => entry.height > 0)

  const tallest = [...entries].sort((a, b) => b.height - a.height || a.member.realName.localeCompare(b.member.realName, 'zh-Hans-CN')).slice(0, limit)
  const shortest = [...entries].sort((a, b) => a.height - b.height || a.member.realName.localeCompare(b.member.realName, 'zh-Hans-CN')).slice(0, limit)
  const average = entries.length
    ? Math.round(entries.reduce((sum, entry) => sum + entry.height, 0) / entries.length)
    : 0

  return { tallest, shortest, average, counted: entries.length }
}

/** 身高分档（厘米，闭区间）：档位从矮到高，覆盖 150-176 的真实分布 */
const HEIGHT_BUCKETS: Array<{ label: string, min: number, max: number }> = [
  { label: '155 以下', min: 0, max: 154 },
  { label: '155-159', min: 155, max: 159 },
  { label: '160-164', min: 160, max: 164 },
  { label: '165-169', min: 165, max: 169 },
  { label: '170-174', min: 170, max: 174 },
  { label: '175-179', min: 175, max: 179 },
  { label: '180 以上', min: 180, max: Number.MAX_SAFE_INTEGER },
]

/**
 * 身高分布：按 5cm 分档，档位从矮到高（身体数据的读法是数轴，不按人数排）。
 *
 * **空档不渲染** —— 与生日月份刻意保留 0 人月份不同：月份是固定 12 格的日历，
 * 「哪个月空着」本身是信息；身高档位是连续量的任意切分，尾部的空档只说明数据范围到此为止，
 * 摆一根 0 人的柱子在图上只是噪音（实测最高 176，`180 以上` 恒为空）。
 */
export function heightBucketStats(members: MemberDetail[]): StatItem[] {
  const heights = members.map(member => parseHeight(member.height)).filter(height => height > 0)
  return HEIGHT_BUCKETS
    .map(bucket => ({
      label: bucket.label,
      count: heights.filter(height => height >= bucket.min && height <= bucket.max).length,
    }))
    .filter(item => item.count > 0)
}

/**
 * 概览数字：总数 / 三态人数 + 荣誉毕业 / 在团队伍数 / 平均身高。
 *
 * ⚠️ **`active` 与 `honorary` 必须成对看**：二者都取自 `status === 1` 的人，
 * `active` 排掉荣誉毕业生 / 明星殿堂后，把它们**单列**进 `honorary` —— 于是
 * `total = active + hiatus + left + honorary` 仍然成立，磁贴相加不会凭空少掉一块。
 * 若只是把 42 人从 `active` 里抹掉而不单列，它们在四个桶里就哪都不算了。
 */
export function statsOverview(members: MemberDetail[]): StatsOverview {
  const countStatus = (status: number) => members.filter(member => member.status === status).length
  const activeMembers = members.filter(
    member => member.status === Constants.MemberStatus.Active && !isHonoraryMember(member),
  )
  const activeTeams = new Set(
    activeMembers
      .map(member => `${member.groupName}/${member.teamName}`)
      .filter(key => key !== '/'),
  )

  // 平均身高与 heightRanking 同口径：只认 100-250 区间内的有效值
  const heights = members.map(member => parseHeight(member.height)).filter(height => height > 0)

  // 荣誉毕业 = 「status 为在团」减去「现役在团」。写成减法而不是再 filter 一遍，
  // 是为了让 total = active + hiatus + left + honorary 这条恒等式由构造方式保证，不靠两处口径对齐。
  const activeByStatus = countStatus(Constants.MemberStatus.Active)

  return {
    total: members.length,
    active: activeMembers.length,
    hiatus: countStatus(Constants.MemberStatus.Hiatus),
    left: countStatus(Constants.MemberStatus.Left),
    honorary: activeByStatus - activeMembers.length,
    teams: activeTeams.size,
    averageHeight: heights.length
      ? Math.round(heights.reduce((sum, height) => sum + height, 0) / heights.length)
      : 0,
    ranked: members.filter(member => Number(member.ranking) > 0).length,
  }
}
