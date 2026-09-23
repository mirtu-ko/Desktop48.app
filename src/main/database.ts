import type { AppConfig, ConfigKey } from '../common/app-config'
import type { MemberFlagKind } from '../common/member-flags'
import type {
  AllMemberItem,
  DomainInfoItem,
  GroupInfoItem,
  MemberDataContent,
  OfficialInfoItem,
  PeriodInfoItem,
  StarAdjunctItem,
  StarInfoItem,
  StarOfficialRelationItem,
  StarRepeatItem,
  TeamInfoItem,
} from './data'
import type { MemberTreeGroupNode } from './domain/member-tree'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { CONFIG_DEFAULTS } from '../common/app-config'
import { assertMemberFlagKind } from '../common/member-flags'
import data from './data'
import { addMemberFlagId, removeMemberFlagId, resolveMemberFlags } from './domain/member-flags'
import { buildMemberTree, teamColorOf } from './domain/member-tree'
import { log } from './logger'
import { SafeJSONFileSync } from './safe-json-file-sync'

/** 校验配置键。必须用 hasOwn：`in` 会沿原型链放行 `'toString'` 这类键 */
function assertConfigKey(key: ConfigKey) {
  if (!Object.hasOwn(CONFIG_DEFAULTS, key))
    throw new Error(`Invalid config key: ${key}`)
}

/**
 * database.json 的落库结构：成员相关原始数据（UPDATE_INFO_URL 的 9 个分节 + h5.48.cn 的 allmembers）+ 屏蔽名单 + 应用配置。
 * 分节字段定义见 ./data（依据 UPDATE_INFO_URL 真实返回逐字段建模）。
 */
export interface DatabaseShape {
  /** 官方账号 */
  officialInfo?: OfficialInfoItem[]
  /** 站点域名配置 */
  domainInfo?: DomainInfoItem[]
  /** 成员原始数据（建树与屏蔽名单解析的数据源） */
  starInfo?: StarInfoItem[]
  /** 兼职成员档案 */
  starAdjunctInfo?: StarAdjunctItem[]
  /** 成员重复档案 */
  starRepeatInfo?: StarRepeatItem[]
  /** 团体 */
  groupInfo?: GroupInfoItem[]
  /** 期数（生） */
  periodInfo?: PeriodInfoItem[]
  /** 队伍（提供排序权重、队伍色、徽章） */
  teamInfo?: TeamInfoItem[]
  /** 官方账号与成员的关联（接口当前返回空数组，字段待样本补充） */
  starOfficialRelationInfo?: StarOfficialRelationItem[]
  /** h5.48.cn 全量成员名单（allmembers.php） */
  allmembers?: AllMemberItem[]
  /**
   * 已屏蔽成员的 userId 列表（旧库可能残留 hiddenMemberIds，init() 时迁移）。
   * 宽容 number|string：旧库存过字符串形式的 id（member-flags 的纯函数按此设计）
   */
  blockedMemberIds?: Array<number | string>
  /** 已关注成员的 userId 列表（宽容 number|string，与 blockedMemberIds 同款设计） */
  followedMemberIds?: Array<number | string>
  config?: AppConfig
  /** 兼容旧库残留字段（init() 清理）：迁移来源 / 已废弃的持久化树 / 已停止拉取的精简名单 */
  hiddenMemberIds?: number[]
  memberTree?: unknown
  allmembersSimple?: unknown
}

/**
 * JSON 数据库门面：负责原子读写、config CRUD 与成员标记名单查询。
 *
 * 职责边界：
 * - 建树逻辑在 `domain/member-tree.ts`（纯函数）
 * - 屏蔽 / 关注名单的匹配与过滤在 `domain/member-flags.ts`（纯函数），本类只管落库
 * - IPC 注册在 `ipc/register-database-ipc.ts`
 *
 * 模块导入无副作用：单例懒创建（首次 instance() 时构造），init() 由 app.ts 显式调用。
 * dbPath 支持注入，便于脱离 Electron 做测试。
 */
class Database {
  /** 成员树：starInfo 的内存派生（不落盘），见 domain/member-tree.ts */
  public memberTree: MemberTreeGroupNode[] = []
  public db!: DatabaseShape
  public membersDB: StarInfoItem[] | undefined

  private static database: Database | null = null

  private storage: SafeJSONFileSync<DatabaseShape>
  private readonly dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(app.getPath('userData'), 'database.json')
    this.storage = new SafeJSONFileSync(this.dbPath)
  }

  public static instance() {
    this.database ??= new Database()
    return this.database
  }

  public init() {
    if (!existsSync(dirname(this.dbPath))) {
      mkdirSync(dirname(this.dbPath), { recursive: true })
    }
    // 没有可读主文件/备份时使用独立的默认数据，避免多个 Database 实例共享可变对象。
    this.db = this.storage.read() ?? structuredClone(data)
    this.membersDB = this.db.starInfo

    // 迁移旧存储字段：hiddenMemberIds → blockedMemberIds（一次性，读到旧键即搬运并删除）
    if (this.db.blockedMemberIds === undefined && this.db.hiddenMemberIds !== undefined) {
      this.db.blockedMemberIds = this.db.hiddenMemberIds
      delete this.db.hiddenMemberIds
    }

    // memberTree 是内存派生数据，清理旧库中的持久化副本
    delete this.db.memberTree

    // 清理已废弃的存储字段：allmembersSimple 是 allmembers 的字段子集，已停止拉取与落库
    delete this.db.allmembersSimple

    // 补齐未设置的配置并写盘：「未设置」= 缺失 / 空串 / 非字符串
    const stored = this.db.config as Partial<Record<ConfigKey, unknown>> | undefined
    const config: AppConfig = { ...CONFIG_DEFAULTS }
    for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[]) {
      const value = stored?.[key]
      if (typeof value === 'string' && value !== '')
        config[key] = value
    }
    this.db.config = config

    // 建树（纯内存派生，不写回原始数据）
    this.rebuildMemberTree()
    this.storage.write(this.db)
    log('[database.ts]数据库路径', this.dbPath)
  }

  /** 保存 API 同步来的成员相关原始数据（10 个分节全量落库）；清洗/派生只发生在内存里（建树），落盘的只有原始内容 */
  public saveMemberData(content: Partial<MemberDataContent>) {
    log('[database.ts] save-member-data 开始写入:', content.starInfo?.length, content.teamInfo?.length, content.groupInfo?.length)
    if (content.officialInfo)
      this.db.officialInfo = content.officialInfo
    if (content.domainInfo)
      this.db.domainInfo = content.domainInfo
    if (content.starInfo)
      this.db.starInfo = content.starInfo
    if (content.starAdjunctInfo)
      this.db.starAdjunctInfo = content.starAdjunctInfo
    if (content.starRepeatInfo)
      this.db.starRepeatInfo = content.starRepeatInfo
    if (content.groupInfo)
      this.db.groupInfo = content.groupInfo
    if (content.periodInfo)
      this.db.periodInfo = content.periodInfo
    if (content.teamInfo)
      this.db.teamInfo = content.teamInfo
    if (content.starOfficialRelationInfo)
      this.db.starOfficialRelationInfo = content.starOfficialRelationInfo
    if (content.allmembers)
      this.db.allmembers = content.allmembers
    log('[database.ts] save-member-data 原始数据写入成功:', {
      officialInfo: this.db.officialInfo?.length,
      domainInfo: this.db.domainInfo?.length,
      starInfo: this.db.starInfo?.length,
      starAdjunctInfo: this.db.starAdjunctInfo?.length,
      starRepeatInfo: this.db.starRepeatInfo?.length,
      groupInfo: this.db.groupInfo?.length,
      periodInfo: this.db.periodInfo?.length,
      teamInfo: this.db.teamInfo?.length,
      starOfficialRelationInfo: this.db.starOfficialRelationInfo?.length,
      allmembers: this.db.allmembers?.length,
    })
    // 同步缓存引用：starInfo 是整组替换，不刷新的话 hasMembers 等会读到旧数据直到重启
    this.membersDB = this.db.starInfo
    this.rebuildMemberTree()
    this.storage.write(this.db)
    return { ok: true }
  }

  public getMemberInfo(userId: number) {
    const member = this.db.starInfo?.find(m => Number(m.userId) === Number(userId))
    if (!member)
      return member
    // teamColor 纯派生：原始 starInfo 不带颜色（颜色只存在于 teamInfo），
    // 与成员树同款规则查 teamInfo 补上；浅拷贝返回，不改写原始数据
    return {
      ...member,
      teamColor: teamColorOf(this.db.teamInfo, member.teamId) || member.teamColor || '',
    }
  }

  public getAllMembers() {
    return {
      allmembers: this.db.allmembers ?? [],
      adjuncts: this.db.starAdjunctInfo ?? [],
    }
  }

  /** 屏蔽 / 关注共用的名单字段；持久化键保持旧格式，避免迁移已有 database.json */
  private memberFlagIds(kind: MemberFlagKind): Array<number | string> {
    assertMemberFlagKind(kind)
    const key = kind === 'blocked' ? 'blockedMemberIds' : 'followedMemberIds'
    if (!Array.isArray(this.db[key])) {
      this.db[key] = []
      this.storage.write(this.db)
    }
    return this.db[key] || []
  }

  public getMemberFlags(kind: MemberFlagKind) {
    const ids = this.memberFlagIds(kind)
    return resolveMemberFlags<StarInfoItem>(ids, this.db.starInfo ?? []).map(member => ({
      ...member,
      userId: Number(member.userId),
      realName: member.realName || '',
      teamColor: teamColorOf(this.db.teamInfo, member.teamId) || member.teamColor || '',
    }))
  }

  public setMemberFlags(kind: MemberFlagKind, ids: Array<number | string>) {
    assertMemberFlagKind(kind)
    const key = kind === 'blocked' ? 'blockedMemberIds' : 'followedMemberIds'
    this.db[key] = ids
    this.storage.write(this.db)
  }

  public addMemberFlag(kind: MemberFlagKind, userId: number) {
    assertMemberFlagKind(kind)
    const key = kind === 'blocked' ? 'blockedMemberIds' : 'followedMemberIds'
    const changed = addMemberFlagId(this.db[key], userId)
    if (changed) {
      this.db[key] = changed
      this.storage.write(this.db)
    }
  }

  public removeMemberFlag(kind: MemberFlagKind, userId: number) {
    assertMemberFlagKind(kind)
    const key = kind === 'blocked' ? 'blockedMemberIds' : 'followedMemberIds'
    this.db[key] = removeMemberFlagId(this.db[key], userId)
    this.storage.write(this.db)
  }

  public hasMembers() {
    return Array.isArray(this.membersDB) && this.membersDB.length > 0
  }

  /**
   * 读取配置：纯读操作，不写盘。init() 已补齐未设置的键，故恒返回生效值，
   * 调用方无需再传 defaultValue。末尾回退只作防御（空串同样算未设置）。
   */
  public getConfig<K extends ConfigKey>(key: K): AppConfig[K] {
    assertConfigKey(key)
    return this.db.config?.[key] || CONFIG_DEFAULTS[key]
  }

  public setConfig<K extends ConfigKey>(key: K, value: AppConfig[K]) {
    assertConfigKey(key)
    const config = this.db.config ?? { ...CONFIG_DEFAULTS }
    config[key] = value
    this.db.config = config
    this.storage.write(this.db)
  }

  /** 重建内存派生的成员树 */
  private rebuildMemberTree() {
    this.memberTree = buildMemberTree(this.db.starInfo, this.db.teamInfo, this.db.groupInfo)
  }
}

export { Database }
