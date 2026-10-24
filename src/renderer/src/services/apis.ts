import type {
  AllMemberEnvelope,
  AllMemberItem,
  ApiEnvelope,
  LiveDetail,
  LiveListContent,
  MusicAlbum,
  OpenLive,
  OpenLiveDetail,
  SyncInfoContent,
} from './api-types'
import { debugLog } from '@renderer/utils/debug'
import { ElMessage } from 'element-plus'
import ApiUrls from './api-urls'
import EventBus from './event-bus'
import Request, { HttpError } from './request'

/**
 * 解析 h5.48.cn 的 jsonp 响应。真实接口返回形如 `callback({...})` 的包裹文本，
 * 需剥掉 `函数名(` 前缀与末尾 `;`、`)`；若首个非空白字符即 `{`/`[`（形如测试里的
 * 纯 JSON `{total, rows}`），则直接当 JSON 解析。调用方再按字段取 total/rows。
 */
function parseJsonpBody<T>(raw: string): T {
  const body = raw.trim()
  const head = body[0]
  // 纯 JSON（对象 `{` 或数组 `[`）→ 原样解析
  if (head === '{' || head === '[')
    return JSON.parse(body) as T
  // jsonp 包裹：跳过 `函数名(`，取其后到末尾的 JSON，再剥掉收尾 `;` / `)`
  const start = body.indexOf('(') + 1
  const json = body.slice(start).trim().replace(/\);?\s*$/, '')
  return JSON.parse(json) as T
}

/** 拉取 h5.48.cn 的 jsonp 成员名单，返回其 rows 数组（解析失败/网络失败都会抛，由调用方决定降级策略） */
async function fetchAllMembers<T>(url: string): Promise<T[]> {
  const raw = await Request.get(url)
  const payload = parseJsonpBody<AllMemberEnvelope<T>>(raw)
  return payload.rows ?? []
}

/**
 * 成员名单的来源，按优先级排列：静态快照优先，jsonp 接口兜底。
 *
 * 两者是同一份发布产物：回包同构（`函数名({total, rows})`）、字段一个不差。
 * 快照是 `resource/json/` 下的静态文件，接口 502 期间它照常可用（2026-10-22 实测：接口 502、快照 200 / 941KB / 761 行），
 * 所以拿它当主源；接口只在快照尚未随发布更新时兜底。
 */
const ALL_MEMBER_SOURCES = [ApiUrls.ALL_MEMBER_SNAPSHOT_URL, ApiUrls.ALL_MEMBER_URL]

/**
 * 补充源专用：按优先级逐个来源试，失败或拿到空名单就换下一个，全部失败返回 undefined（调用方据此不带该 key 上送）。
 * 空名单也算失败——接口正常时恒有 700+ 条，`[]` 只可能来自异常响应，
 * 而 saveMemberData 的 `if (content.allmembers)` 对 `[]` 判真，上送会清空已落库的名单。
 * 这条链路不走 pocketapi 的瞬时失败重试，被风控返回 HTML 时 JSON.parse 会抛，异常只能在这里收敛。
 */
async function fetchAllMembersOrSkip(): Promise<AllMemberItem[] | undefined> {
  for (const url of ALL_MEMBER_SOURCES) {
    try {
      const rows = await fetchAllMembers<AllMemberItem>(url)
      if (rows.length === 0) {
        console.error('[apis.ts]allmembers 返回空名单，换下一个来源:', url)
        continue
      }
      debugLog('net', 'allmembers 拉取完成', url, rows.length)
      return rows
    }
    catch (e: any) {
      console.error('[apis.ts]allmembers 来源失败，换下一个:', url, e?.message || e)
    }
  }
  console.error('[apis.ts]allmembers 全部来源失败，跳过本次补充源')
  return undefined
}

/**
 * 同步成员信息：拉取并落库（database.json 的 starInfo/teamInfo/groupInfo），
 * 同时从 h5.48.cn 拉取补充成员名单（静态快照为主、接口兜底，见 ALL_MEMBER_SOURCES）一并存库。
 * 落库成功后广播 members-updated（见 event-bus.ts），依赖成员树的页面据此作废缓存。
 *
 * allmembers 是**次要数据源**：它返回 undefined 时只跳过本次补充，9 个主分节照常落库
 * （缺 key → saveMemberData 保留旧值），它的抖动不该把主流程拖挂。
 */
async function syncInfo(): Promise<SyncInfoContent> {
  debugLog('net', '开始更新成员信息')
  // 更新数据到数据库（UPDATE_INFO_URL，9 个分节）
  const content = await request<SyncInfoContent>(ApiUrls.UPDATE_INFO_URL, {}, {})
  debugLog('net', '更新成员信息', content)
  // 补充数据源：h5.48.cn 全量成员名单（独立信封，不参与 UPDATE 分节）
  const allmembers = await fetchAllMembersOrSkip()
  // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts（写 database.json 并重建成员树）
  await window.mainAPI.saveMemberData(allmembers ? { ...content, allmembers } : content)
  // 广播紧贴数据变更点（而不是调用方 use-member-sync）：成员树 store 据此作废缓存重拉，
  // 任何调用方走到这里都会通知，不必依赖「记得在封装层补一句」的约定
  EventBus.emit('members-updated')
  return content
}

/**
 * 直播列表
 * @param next 翻页游标，首页传 '0'
 * @param options 空态轮询这类后台调用传 `{ silent: true }`，失败不弹全局提示
 */
function lives(next: string = '0', options?: RequestOptions): Promise<LiveListContent> {
  const data = {
    next,
    loadMore: 'true',
    userId: '0',
    teamId: '0',
    groupId: '0',
    record: 'false',
  }

  return list(data, options)
}

/**
 * 回放列表：requestOptions 传 `{ silent: true }` 时失败不弹全局提示（空态预告这类后台调用用）
 */
function playbackList({
  next = '0',
  userId = '0',
  teamId = '0',
  groupId = '0',
}: {
  next: string
  userId: string
  teamId: string
  groupId: string
}, requestOptions?: RequestOptions): Promise<LiveListContent> {
  const data = {
    next,
    loadMore: 'true',
    userId,
    teamId,
    groupId,
    record: 'true',
  }

  return list(data, requestOptions)
}

/** 直播列表通用请求：参数原样透传（next 游标翻页 + 筛选） */
function list(data: object, options?: RequestOptions): Promise<LiveListContent> {
  return request<LiveListContent>(ApiUrls.LIVE_LIST_URL, data, {}, options)
}

/**
 * 直播|回放详情
 * @param liveId 直播|回放id
 * @param options 见 RequestOptions：在线人数轮询这类后台调用传 `{ silent: true }`
 */
function live(liveId: string, options?: RequestOptions): Promise<LiveDetail> {
  const data = {
    type: 1,
    userId: '0',
    liveId,
  }

  return request<LiveDetail>(ApiUrls.LIVE_ONE_URL, data, {}, options)
}

/**
 * 开放公演详情
 * @param liveId 开放公演的 snowflake liveId（来自 getOpenLiveList）
 * @returns content，其中 roomId 是 live.48.cn 体系里的数字 id
 */
function openLive(liveId: string): Promise<OpenLiveDetail> {
  const data = {
    liveId,
  }
  return request<OpenLiveDetail>(ApiUrls.OPEN_LIVE_URL, data, {})
}

/**
 * 下载弹幕：原文（LRC 格式文本），解析见 use-playback-danmaku / Tools.lyricsParse
 */
function barrage(barrageUrl: string): Promise<string> {
  return Request.get(barrageUrl)
}

/**
 * 音乐专辑列表（CDN 静态 JSON，tag：ep=EP / zj=专辑 / sg=单曲）
 */
async function musicAlbums(): Promise<MusicAlbum[]> {
  let data: unknown
  try {
    data = await Request.get(ApiUrls.MUSIC_LIST_URL)
  }
  catch (e: any) {
    toastApiError(`获取专辑列表失败：${e?.message || '网络错误'}`)
    throw e
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    }
    catch (e) {
      console.error('[apis.ts]musicAlbums 响应不是 JSON', e)
      toastApiError('专辑接口返回数据异常，请稍后重试')
      throw new Error('[apis.ts]音乐专辑接口返回非JSON')
    }
  }
  const albumData = data as { all?: MusicAlbum[], ep?: MusicAlbum[], zj?: MusicAlbum[], sg?: MusicAlbum[] }
  return albumData?.all || [...(albumData?.ep || []), ...(albumData?.zj || []), ...(albumData?.sg || [])]
}

/**
 * 开放公演列表
 * @param groupId 团体 id，取值见 Constants.GroupTabs，0=全部
 * @param next 翻页游标，首页传 '0'
 * @param record true=可回放的已结束公演，false=排期/进行中
 * @param options 空态预告这类后台调用传 `{ silent: true }`，失败不弹全局提示
 */
function openLives(groupId: number = 0, next: string = '0', record: boolean = false, options?: RequestOptions): Promise<LiveListContent<OpenLive>> {
  const data = {
    groupId,
    next,
    debug: false,
    record,
  }
  return request<LiveListContent<OpenLive>>(ApiUrls.OPEN_LIVE_LIST_URL, data, {}, options)
}

/**
 * 统一错误提示（带 3 秒去重）：断流重试链路会连续失败多次，
 * 同文案短时间重复弹出只会刷屏；调用方无需各自补 ElMessage。
 *
 * 去重状态直接放模块作用域——ES 模块本身就是单例，不需要 class 静态字段。
 */
let lastToastText = ''
let lastToastAt = 0

function toastApiError(message: string): void {
  const now = Date.now()
  if (message === lastToastText && now - lastToastAt < 3000)
    return
  lastToastText = message
  lastToastAt = now
  ElMessage.error(message)
}

/** 请求选项（见 request 的重试与提示策略） */
export interface RequestOptions {
  /** 瞬时失败的重试次数（不含首次），默认 DEFAULT_RETRIES；0 = 不重试 */
  retries?: number
  /** true = 最终失败也不弹全局提示，只留日志（后台轮询失败不该打扰用户） */
  silent?: boolean
}

/**
 * 瞬时失败的重试：网络层异常（超时/断网/主进程拒绝）与 RETRYABLE_SERVER_STATUS 命中的业务状态码，
 * 退避 400ms → 800ms → 1200ms 再试。只重试**失败**的读接口，不会产生重复副作用。
 */
const DEFAULT_RETRIES = 3
const RETRY_BASE_DELAY = 400

/**
 * 值得重试的服务端业务状态码。
 *
 * `1017 参数错误` 是 pocketapi 的**瞬时**失败（实测与参数 / 频率 / 并发无关），重试即可恢复。
 * 其余状态码（如 `10049 该成员直播已被删除`）是确定性结论，重试没有意义，必须原样上抛。
 */
const RETRYABLE_SERVER_STATUS = new Set([1017])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 单次请求结果：失败时带上「是否值得重试」与原始异常（网络层错误保留原对象给调用方） */
type RequestAttempt<T>
  = | { ok: true, content: T }
    | { ok: false, message: string, retryable: boolean, cause?: unknown }

/** 统一请求：解析 JSON 信封，成功返回 content，失败抛 message（瞬时失败由 request 负责重试） */
async function requestOnce<T>(url: string, data: object, headers: Record<string, string>): Promise<RequestAttempt<T>> {
  let responseBody: string
  try {
    responseBody = await Request.post(url, data, headers)
  }
  catch (e: any) {
    if (e instanceof HttpError) {
      // 429 是「该停」而不是「该重试」：服务端限流窗口已生效，再打只会把窗口拖长。
      // 主进程已按 Retry-After 让整域冷却（main/net-rate-limit.ts）
      if (e.status === 429)
        return { ok: false, message: '请求过于频繁，请稍后再试', retryable: false, cause: e }
      // 5xx / 408 才是瞬时故障；其余 4xx 是请求本身的问题，重试没有意义
      return {
        ok: false,
        message: `网络请求失败：${e.message}`,
        retryable: e.status === 408 || e.status >= 500,
        cause: e,
      }
    }
    // 网络层失败（超时/断网/主进程拒绝），调用方大多只静默 console，这里统一兜底提示
    return { ok: false, message: `网络请求失败：${e?.message || '未知错误'}`, retryable: true, cause: e }
  }
  if (typeof responseBody === 'string') {
    try {
      responseBody = JSON.parse(responseBody)
    }
    catch (e) {
      console.error('[apis.ts]responseBody 不是 JSON', responseBody, e)
      return { ok: false, message: '接口返回数据异常，请稍后重试', retryable: true }
    }
  }
  const envelope = responseBody as ApiEnvelope<T>
  if (envelope && envelope.success)
    return { ok: true, content: envelope.content as T }

  const message = envelope && envelope.message ? envelope.message : '接口无 success 字段'
  console.error('[apis.ts]reject', message, data)
  const status = envelope?.status
  return { ok: false, message, retryable: status !== undefined && RETRYABLE_SERVER_STATUS.has(status) }
}

/** 统一请求：按 RequestOptions 重试瞬时失败，只在最终失败时提示并上抛 */
async function request<T>(url: string, data: object, headers: Record<string, string>, options: RequestOptions = {}): Promise<T> {
  const attempts = (options.retries ?? DEFAULT_RETRIES) + 1
  for (let attempt = 1; ; attempt++) {
    const result = await requestOnce<T>(url, data, headers)
    if (result.ok)
      return result.content
    // 确定性失败（业务结论）或重试预算用尽：提示一次并上抛，调用方按错误文案决定后续
    if (!result.retryable || attempt >= attempts) {
      if (!options.silent)
        toastApiError(result.message)
      throw result.cause ?? new Error(result.message)
    }
    const delay = RETRY_BASE_DELAY * attempt
    debugLog('net', `瞬时失败（第 ${attempt}/${attempts} 次尝试），${delay}ms 后重试`, result.message)
    await sleep(delay)
  }
}

/**
 * 渲染层接口层（全部无状态）。
 *
 * 接口函数全部为模块级封装，内部不依赖对象实例状态。
 */
const Apis = {
  syncInfo,
  lives,
  playbackList,
  live,
  openLive,
  barrage,
  musicAlbums,
  openLives,
}

export default Apis
