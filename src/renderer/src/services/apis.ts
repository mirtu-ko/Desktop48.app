import type {
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
 */
function live(liveId: string): Promise<LiveDetail> {
  const data = {
    type: 1,
    userId: '0',
    liveId,
  }

  return request<LiveDetail>(ApiUrls.LIVE_ONE_URL, data, {})
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

/** 统一请求：解析 JSON 信封，成功返回 content，失败抛 message */
async function request<T>(url: string, data: object, headers: Record<string, string>): Promise<T> {
  let responseBody: string
  try {
    responseBody = await Request.post(url, data, headers)
  }
  catch (e: any) {
    // 网络层失败（超时/断网/主进程拒绝），调用方大多只静默 console，这里统一兜底提示
    toastApiError(`网络请求失败：${e?.message || '未知错误'}`)
    throw e
  }
  if (typeof responseBody === 'string') {
    try {
      responseBody = JSON.parse(responseBody)
    }
    catch (e) {
      console.error('[apis.ts]responseBody 不是 JSON', responseBody, e)
      toastApiError('接口返回数据异常，请稍后重试')
      throw new Error(`[apis.ts]接口返回非JSON：${responseBody}`)
    }
  }
  const envelope = responseBody as { success?: boolean, message?: string, content?: T }
  if (envelope && envelope.success) {
    return envelope.content as T
  }
  else {
    const message = envelope && envelope.message ? envelope.message : '接口无 success 字段'
    console.error('[apis.ts]reject', message, data)
    toastApiError(message)
    throw new Error(message)
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
