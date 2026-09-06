import type {
  LiveDetail,
  LiveListContent,
  MusicAlbum,
  OpenLive,
  OpenLiveDetail,
  SyncInfoContent,
} from './api-types'
import { ElMessage } from 'element-plus'
import ApiUrls from './api-urls'
import Request from './request'

// 开放公演模型历史上从 apis.ts 导出（Shows.vue / ShowCard.vue 引用），
// 定义已迁移至 api-types.ts，这里保留 re-export 兼容既有导入路径
export type { OpenLive, OpenLiveTeam } from './api-types'

export default class Apis {
  /** 单例入口 */
  public static instance() {
    return this.apis
  }

  private static apis: Apis = new Apis()

  /**
   * 同步成员信息：拉取并落库（database.json 的 starInfo/teamInfo/groupInfo）
   */
  public async syncInfo(): Promise<SyncInfoContent> {
    console.log('[apis.ts]开始更新成员信息')
    // 更新数据到数据库
    const content = await this.request<SyncInfoContent>(ApiUrls.UPDATE_INFO_URL, {}, {})
    console.log('[apis.ts]更新成员信息', content)
    // ★ 跨进程：preload/index.ts → main/ipc/register-database-ipc.ts（写 database.json 并重建成员树）
    await window.mainAPI.saveMemberData(content)
    return content
  }

  /**
   * 直播列表
   * @param next
   */
  public lives(next: string = '0'): Promise<LiveListContent> {
    const data = {
      next,
      loadMore: 'true',
      userId: '0',
      teamId: '0',
      groupId: '0',
      record: 'false',
    }

    return this.list(data)
  }

  /**
   * 回放列表
   */
  public reviews({
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

    return this.list(data)
  }

  /** 直播列表通用请求：参数原样透传（next 游标翻页 + 筛选） */
  public list(data: object): Promise<LiveListContent> {
    return this.request<LiveListContent>(ApiUrls.LIVE_LIST_URL, data, {})
  }

  /**
   * 直播|回放详情
   * @param liveId 直播|回放id
   */
  public live(liveId: string): Promise<LiveDetail> {
    const data = {
      type: 1,
      userId: '0',
      liveId,
    }

    return this.request<LiveDetail>(ApiUrls.LIVE_ONE_URL, data, {})
  }

  /**
   * 开放公演详情
   * @param liveId 开放公演的 snowflake liveId（来自 getOpenLiveList）
   * @returns content，其中 roomId 是 live.48.cn 体系里的数字 id
   */
  public openLive(liveId: string): Promise<OpenLiveDetail> {
    const data = {
      liveId,
    }
    return this.request<OpenLiveDetail>(ApiUrls.OPEN_LIVE_URL, data, {})
  }

  /**
   * 下载弹幕：原文（LRC 格式文本），解析见 use-barrage-list / Tools.lyricsParse
   * @param barrageUrl 弹幕地址
   */
  public barrage(barrageUrl: string): Promise<string> {
    return Request.get(barrageUrl)
  }

  /**
   * 音乐专辑列表（CDN 静态 JSON，tag：ep=EP / zj=专辑 / sg=单曲）
   */
  public async musicAlbums(): Promise<MusicAlbum[]> {
    let data: unknown
    try {
      data = await Request.get(ApiUrls.MUSIC_LIST_URL)
    }
    catch (e: any) {
      Apis.toastApiError(`获取专辑列表失败：${e?.message || '网络错误'}`)
      throw e
    }
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      }
      catch (e) {
        console.warn('[apis.ts]musicAlbums 响应不是 JSON', e)
        Apis.toastApiError('专辑接口返回数据异常，请稍后重试')
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
  public openLives(groupId: number = 0, next: string = '0', record: boolean = false): Promise<LiveListContent<OpenLive>> {
    const data = {
      groupId,
      next,
      debug: false,
      record,
    }
    return this.request<LiveListContent<OpenLive>>(ApiUrls.OPEN_LIVE_LIST_URL, data, {})
  }

  /**
   * 统一错误提示（带 3 秒去重）：断流重试链路会连续失败多次，
   * 同文案短时间重复弹出只会刷屏；调用方无需各自补 ElMessage。
   */
  private static lastToastText = ''
  private static lastToastAt = 0

  private static toastApiError(message: string): void {
    const now = Date.now()
    if (message === Apis.lastToastText && now - Apis.lastToastAt < 3000)
      return
    Apis.lastToastText = message
    Apis.lastToastAt = now
    ElMessage.error(message)
  }

  /** 统一请求：解析 JSON 信封，成功返回 content，失败抛 message */
  private async request<T>(url: string, data: object, headers: Record<string, string>): Promise<T> {
    let responseBody: string
    try {
      responseBody = await Request.post(url, data, headers)
    }
    catch (e: any) {
      // 网络层失败（超时/断网/主进程拒绝），调用方大多只静默 console，这里统一兜底提示
      Apis.toastApiError(`网络请求失败：${e?.message || '未知错误'}`)
      throw e
    }
    if (typeof responseBody === 'string') {
      try {
        responseBody = JSON.parse(responseBody)
      }
      catch (e) {
        console.warn('[apis.ts]responseBody 不是 JSON', responseBody, e)
        Apis.toastApiError('接口返回数据异常，请稍后重试')
        throw new Error(`[apis.ts]接口返回非JSON：${responseBody}`)
      }
    }
    const envelope = responseBody as { success?: boolean, message?: string, content?: T }
    if (envelope && envelope.success) {
      return envelope.content as T
    }
    else {
      const message = envelope && envelope.message ? envelope.message : '接口无 success 字段'
      console.log('[apis.ts]reject', message, data)
      Apis.toastApiError(message)
      throw new Error(message)
    }
  }
}
