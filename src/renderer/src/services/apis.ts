import type {
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
import Request from './request'

/**
 * 同步成员信息：拉取并落库（database.json 的 starInfo/teamInfo/groupInfo）
 */
async function syncInfo(): Promise<SyncInfoContent> {
  debugLog('net', '开始更新成员信息')
  // 更新数据到数据库
  const content = await request<SyncInfoContent>(ApiUrls.UPDATE_INFO_URL, {}, {})
  debugLog('net', '更新成员信息', content)
  // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts（写 database.json 并重建成员树）
  await window.mainAPI.saveMemberData(content)
  return content
}

/**
 * 直播列表
 * @param next
 */
function lives(next: string = '0'): Promise<LiveListContent> {
  const data = {
    next,
    loadMore: 'true',
    userId: '0',
    teamId: '0',
    groupId: '0',
    record: 'false',
  }

  return list(data)
}

/**
 * 回放列表
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
}): Promise<LiveListContent> {
  const data = {
    next,
    loadMore: 'true',
    userId,
    teamId,
    groupId,
    record: 'true',
  }

  return list(data)
}

/** 直播列表通用请求：参数原样透传（next 游标翻页 + 筛选） */
function list(data: object): Promise<LiveListContent> {
  return request<LiveListContent>(ApiUrls.LIVE_LIST_URL, data, {})
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
 * 下载弹幕：原文（LRC 格式文本），解析见 use-barrage-list / Tools.lyricsParse
 * @param barrageUrl 弹幕地址
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
 */
function openLives(groupId: number = 0, next: string = '0', record: boolean = false): Promise<LiveListContent<OpenLive>> {
  const data = {
    groupId,
    next,
    debug: false,
    record,
  }
  return request<LiveListContent<OpenLive>>(ApiUrls.OPEN_LIVE_LIST_URL, data, {})
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
 * 取 3 次是因为 1017 单次失败率约 1/3，4 次尝试后残留失败率已 <2%（再往上收益很小）。
 */
const DEFAULT_RETRIES = 3
const RETRY_BASE_DELAY = 400

/**
 * 值得重试的服务端业务状态码。
 *
 * `1017 参数错误` 是 pocketapi 的**瞬时**失败：同一份 body 连续请求 40 次约 1/3 命中，
 * 与请求参数、频率、并发都无关（2026-09-13 实测），重试即可恢复。
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
 * 说明：不用 `class + static` + `instance()` —— ES 模块本身就是单例，`Apis.instance()`
 * 只是给一个"没有任何实例字段的类"套上无意义的间接层。
 * 内部互相调用一律走模块级函数，而不是对象字面量里的 `this`（后者一被解构就断），
 * 所以下面这些函数里搜不到 `this`；只有导出时才组装成命名空间对象，
 * 于是 12 处调用点只需去掉 `.instance()`。
 */
const Apis = {
  syncInfo,
  lives,
  playbackList,
  list,
  live,
  openLive,
  barrage,
  musicAlbums,
  openLives,
}

export default Apis
