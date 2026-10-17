/**
 * 网络诊断：对核心服务端点逐一发轻量请求，验证连通性（设置页「网络诊断」）。
 *
 * 定位是「用户自助排查」：接口报 HTTP 403 / 超时这类反馈无法远程定位时，
 * 让用户在设置页点一次「开始诊断」，把结果复制发给开发者即可区分
 * 网络不可达 / 服务端拒绝（地区限制、风控）/ 服务端异常三类问题。
 *
 * 探测口径（实测教训）：**必须打应用实际调用的端点，不能打域名根路径**——
 * pocketapi.48.cn 与 h5.48.cn 的根路径对 GET / 一律 403（网关无此路由/WAF 拦截），
 * 大陆网络也 403，会得出「被拒」的误导结论。因此 pocketapi 用渲染层直播列表
 * 同款 POST（无需登录），h5/cgt48 用各自的静态资源端点，请求头形态与
 * services/request.ts 一致（移动端浏览器 UA；机型事实取自 common/android-device.ts）。
 *
 * 结果解读：
 * - 2xx/3xx：连通且服务端正常应答
 * - 4xx：连通但被拒；403 通常是 WAF 地区限制或风控（大陆网络对真实端点不应出现）
 * - 5xx：服务端异常，与本机网络无关
 * - 无响应（连接失败/超时/中断）：网络不可达或被墙
 *
 * 端点与渲染层 services/api-urls.ts、common/pocket-api-urls.ts 保持一致，两边增删请同步。
 */
import type { ClientRequest } from 'electron'
import { ANDROID_DEVICE } from '@common/android-device'
import { net } from 'electron'

/** 单个探测结果（契约对端：preload/ipc-contract.d.ts 的 NetDiagnoseItem） */
export interface NetDiagnoseItem {
  /** 展示名称（诊断列表的行标题） */
  label: string
  url: string
  /** HTTP 状态码；null = 未收到响应（连接失败/超时/中断），原因见 error */
  status: number | null
  /** 从发起到收到响应头（或失败）的耗时（ms） */
  ms: number
  /** status 为 null 时的失败原因 */
  error?: string
}

interface DiagnoseTarget {
  label: string
  url: string
  method: 'GET' | 'POST'
  /** POST 请求体（JSON 序列化后发送） */
  body?: object
}

/**
 * 探测目标：业务实际依赖的核心端点，覆盖 API / 成员名单 / 媒体 / 站点 / 曲库七类。
 * - pocketapi 的 getLiveList 与渲染层直播页同款（无需登录），body 形态见 use-paged-live-list
 * - source/mp4 两个媒体域是静态文件服务器（渲染层 <img>/video 直连，不经 netRequest），
 *   根路径即可安全探测（实测 200）；source1/2/3.48.cn 是 source 的同内容镜像，不重复探测
 * - live.48.cn 与 snh48.com 的媒体/回放地址由接口动态下发、无法固定，以根路径代表域名可达性
 */
const DIAGNOSE_TARGETS: DiagnoseTarget[] = [
  {
    label: '口袋48 API',
    url: 'https://pocketapi.48.cn/live/api/v1/live/getLiveList',
    method: 'POST',
    body: { groupId: 0, next: '0', debug: false, record: false },
  },
  { label: '成员名单 jsonp', url: 'https://h5.48.cn/resource/jsonp/allmembers.php?gid=10', method: 'GET' },
  { label: '头像/封面媒体', url: 'https://source.48.cn/', method: 'GET' },
  { label: '房间音视频', url: 'https://mp4.48.cn/', method: 'GET' },
  { label: '站点直播', url: 'https://live.48.cn/', method: 'GET' },
  { label: '官网 / 媒体源', url: 'https://www.snh48.com/', method: 'GET' },
  { label: 'CGT48 曲库', url: 'https://www.cgt48.com/json/music_snh.json', method: 'GET' },
]

const DIAGNOSE_TIMEOUT = 8 * 1000

/**
 * 站点档移动端 UA（与渲染层 services/request.ts 的 SITE_USER_AGENT 同源拼装）：
 * 诊断请求的形态应贴近真实链路，避免 WAF 对裸 Electron UA 给出与业务不同的回答。
 */
const DIAGNOSE_UA = `Mozilla/5.0 (Linux; Android ${ANDROID_DEVICE.osVersion}; ${ANDROID_DEVICE.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`

/** 单目标探测：收到响应头即算完成（连通性判定不需要 body），超时/错误折进结果而非 reject */
function probe(target: DiagnoseTarget): Promise<NetDiagnoseItem> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let request: ClientRequest | undefined
    const finish = (item: Omit<NetDiagnoseItem, 'ms'>) => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      resolve({ ...item, ms: Date.now() - startedAt })
    }

    timer = setTimeout(() => {
      request?.abort()
      finish({ ...target, status: null, error: `超时（${DIAGNOSE_TIMEOUT / 1000} 秒无响应）` })
    }, DIAGNOSE_TIMEOUT)

    request = net.request({ url: target.url, method: target.method })
    request.setHeader('User-Agent', DIAGNOSE_UA)
    if (target.method === 'POST')
      request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      // 只看状态码；Electron 的 IncomingMessage 不是完整 Node 流（无 resume 可空消费 body），
      // 诊断不读 body，取到响应头即中止连接释放 socket。先 settle 再 abort，
      // 避免 abort 事件被当作失败覆盖结果
      finish({ ...target, status: response.statusCode ?? null })
      request.abort()
    })
    request.on('abort', () => finish({ ...target, status: null, error: '请求被中断' }))
    request.on('error', err => finish({ ...target, status: null, error: err.message }))
    if (target.body)
      request.write(JSON.stringify(target.body))
    request.end()
  })
}

/** 并发探测全部目标；单目标失败不拖累其余结果，每个目标都必有返回 */
export function diagnoseTargets(): Promise<NetDiagnoseItem[]> {
  return Promise.all(DIAGNOSE_TARGETS.map(probe))
}
