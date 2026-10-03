/**
 * 直播 / 回放详情加载：把 open 与 user 两个上游接口、live 与 vod 两条选流规则
 * 归一成一个扁平的 LiveDetailView，两条链路拿到模型之后各自决定怎么用。
 *
 * 无响应式状态、不依赖 Vue：调用方持有全部状态，本函数只负责取数与归一，
 * 因此可在 node 环境直接单测。
 *
 * ⚠️ 硬性约束：内层零 try/catch，异常必须原样穿透。
 * 上游的「直播已终结」是业务错误（Apis 抛 Error 带固定文案），
 * 调用方靠 isUnavailableLiveMessage 判别后关窗；在这里吞掉或改写，
 * 可恢复的临时故障会被当成永久下架，直播被反复重试。
 */
import type { OpenLiveDetail } from '@renderer/services/api-types'
import Apis from '@renderer/services/apis'
import { normalizeCarouselTime, pickPreferredStream, pickPreferredVodStream } from '@renderer/utils/live-stream'
import Tools from '@renderer/utils/tools'

/** 数据源：user=个人直播/回放，open=开放公演/公演回放 */
export type LiveDetailSource = 'user' | 'open'

/** 选流档位：live=优先高清(2)；vod=优先超清(3)，回落高清(2) */
export type StreamPreference = 'live' | 'vod'

/**
 * 归一后的详情：只描述「这场直播/回放是什么」，不含任何播放行为（转流 / 起播 / 弹幕）。
 */
export interface LiveDetailView {
  liveId: string
  /**
   * 远程源地址：直播为 rtmp（喂主进程 FFmpeg），回放为 VOD http(s)（浏览器直放）。
   * 选不到流时为空串，由调用方决定是报错还是降级。
   */
  playStreamPath: string
  /** 选中的清晰度档位；user 源恒为 undefined（接口只给单档地址） */
  streamType?: number
  /** 封面（已归一为可直接使用的 URL） */
  coverUrl: string
  /** 主播名 / 公演标题兜底 */
  realName: string
  /** 头像（已归一）；avatarUrl 优先于详情主播头像 */
  userAvatar: string
  /** 在线人数；上游未带时为 undefined（open 源恒不带） */
  onlineNum?: number
  /** 1=视频 2=电台；open 源与缺失时为 undefined */
  liveType?: number
  /** 电台轮播图（已逐个归一）；无则空数组。**不含封面回退**，回退由调用方按各自需要决定 */
  carouselImages: string[]
  /** 轮播间隔（毫秒）；缺省或非法回退 5000 */
  carouselTime: number
  /** 弹幕文件地址；直播源恒空串 */
  barrageUrl: string
  /** 回放是否已生成；open 源恒 true（该接口无此概念） */
  review: boolean
}

export interface LoadLiveDetailOptions {
  liveId: string
  source: LiveDetailSource
  /** 选流档位；user 源忽略（接口只给单档地址） */
  stream: StreamPreference
  /** open 模式下的顶部头像（公演封面，完整 URL），优先于详情主播头像 */
  avatarUrl?: string
  /** 开播时间（毫秒时间戳）：一直播 HLS 路径按此日期重写，仅 source=user 时生效 */
  startTime?: number
}

/** user 源：把 LiveDetail 归一到视图模型（单档地址 + 一直播路径重写 + 弹幕地址） */
function fromUserLive(
  liveId: string,
  raw: Awaited<ReturnType<typeof Apis.live>>,
  startTime: number | undefined,
): LiveDetailView {
  // 一直播的 HLS 路径按开播日期重写；非该域名时 streamPathHandle 原样返回
  const playStreamPath = startTime === undefined
    ? raw.playStreamPath
    : Tools.streamPathHandle(raw.playStreamPath, startTime)
  return {
    liveId: raw.liveId || liveId,
    playStreamPath,
    streamType: undefined,
    coverUrl: Tools.sourceUrl(raw.coverPath),
    realName: raw.user.userName,
    userAvatar: Tools.sourceUrl(raw.user.userAvatar),
    onlineNum: raw.onlineNum,
    liveType: raw.liveType,
    carouselImages: (raw.carousels?.carousels || []).map(url => Tools.sourceUrl(url)),
    carouselTime: normalizeCarouselTime(raw.carousels?.carouselTime),
    barrageUrl: raw.msgFilePath || '',
    review: Boolean(raw.review),
  }
}

/** open 源：公演详情是多档清晰度数组，按偏好选流；无主播与在线人数信息 */
function fromOpenLive(
  liveId: string,
  raw: OpenLiveDetail,
  avatarUrl: string | undefined,
  stream: StreamPreference,
): LiveDetailView {
  const picked = stream === 'vod' ? pickPreferredVodStream(raw.playStreams) : pickPreferredStream(raw.playStreams)
  return {
    liveId: raw.liveId || liveId,
    playStreamPath: picked?.streamPath || '',
    streamType: picked?.streamType,
    coverUrl: Tools.sourceUrl(raw.coverPath || ''),
    // 该接口没有主播信息，用副标题 / 标题兜底
    realName: raw.subTitle || raw.title || '开放公演',
    userAvatar: Tools.sourceUrl(avatarUrl || ''),
    onlineNum: undefined,
    liveType: undefined,
    carouselImages: [],
    carouselTime: normalizeCarouselTime(undefined),
    barrageUrl: raw.msgFilePath || '',
    // 公演接口无「回放是否生成」概念，一律视为可播（选流为空由调用方判）
    review: true,
  }
}

/**
 * 拉详情并归一。异常原样上抛（见文件头约束）。
 * 调用方各自负责打日志与错误提示，本函数不打任何日志。
 */
export async function loadLiveDetail({
  liveId,
  source,
  stream,
  avatarUrl,
  startTime,
}: LoadLiveDetailOptions): Promise<LiveDetailView> {
  if (source === 'open')
    return fromOpenLive(liveId, await Apis.openLive(liveId), avatarUrl, stream)
  return fromUserLive(liveId, await Apis.live(liveId), startTime)
}
