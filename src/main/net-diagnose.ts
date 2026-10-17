/**
 * 网络诊断：对核心服务端点逐一发轻量请求，验证连通性（设置页「网络诊断」）。
 *
 * 定位是「用户自助排查」：接口报 HTTP 403 / 超时这类反馈无法远程定位时，
 * 让用户在设置页点一次「开始诊断」，把结果复制发给开发者即可区分
 * 网络不可达 / 服务端拒绝（地区策略、风控、客户端身份）/ 服务端异常三类问题。
 *
 * 探测口径（实测教训）：**必须打应用实际调用的端点，不能打域名根路径**——
 * pocketapi.48.cn 与 h5.48.cn 的根路径对 GET / 一律 403（网关无此路由/WAF 拦截），
 * 大陆网络也 403，会得出「被拒」的误导结论。因此 pocketapi 用渲染层直播列表
 * 同款 POST（无需登录），h5 用成员名单 jsonp，其余域名用各自的固定资源端点。
 *
 * **身份对照（2026-10-17 实测）**：同一个境外出口下，App 档身份头（PocketFans UA +
 * appInfo + pa，登录后再带 token）请求 pocketapi 返回 200，而站点档（浏览器 UA、
 * 无 appInfo/pa）返回 403。可见 403 未必是「IP 被封」，也可能是边缘按客户端身份判定。
 * 因此 pocketapi 固定探三行（站点身份对照 / App 身份 / App 身份 + 登录态），
 * 同一出口下三行的差异就是服务端实际用的判定维度。
 *
 * 业务链路已按此结论改为报 App 身份（见 `net-request-headers.ts`）：主进程 netRequest
 * 转发 pocketapi / h5 的业务接口时统一补 App 身份头。因此「App 身份」行与成员名单行
 * 就是应用实际发出的请求形态，「站点身份对照」行只用于确认服务端是否仍在按身份区分。
 *
 * 结果解读：
 * - 2xx/3xx：连通且服务端正常应答
 * - 4xx：连通但被拒；403 通常是 WAF 地区策略、风控，或客户端身份不符
 * - 5xx：服务端异常，与本机网络无关
 * - 无响应（连接失败/超时/中断）：网络不可达或被墙
 * - detail：4xx/5xx 的响应体摘要——WAF 的 HTML 拦截页与业务 JSON 信封在状态码上相同，
 *   只有正文能区分「边缘拦截」与「接口层拒绝」
 *
 * 端点与渲染层 services/api-urls.ts、common/pocket-api-urls.ts 保持一致，两边增删请同步。
 */
import type { ClientRequest } from 'electron'
import { Buffer } from 'node:buffer'
import { ANDROID_DEVICE } from '@common/android-device'
import { net } from 'electron'
import { log } from './logger'
import { getToken, pocketAppHeaders } from './pocket48/pocket-auth'

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
  /** 非 2xx 时的响应体摘要（截断），用于区分边缘拦截页与业务信封 */
  detail?: string
}

interface DiagnoseTarget {
  label: string
  url: string
  method: 'GET' | 'POST'
  /** POST 请求体（JSON 序列化后发送） */
  body?: object
  /**
   * 覆盖默认请求头（诊断默认带站点档 UA）。
   * App 身份对照行在此放 PocketFans UA / appInfo / pa / token——**这些头只用于发请求，
   * 不会随结果回传**（见 probe 的 finish）。
   */
  headers?: Record<string, string>
}

/** 口袋直播列表探测点：与渲染层 use-paged-live-list / services/apis.ts 同款，无需登录 */
const POCKET_LIVE_LIST: Omit<DiagnoseTarget, 'label'> = {
  url: 'https://pocketapi.48.cn/live/api/v1/live/getLiveList',
  method: 'POST',
  body: { groupId: 0, next: '0', debug: false, record: false },
}

/**
 * 其余探测目标：业务实际依赖的核心端点，覆盖成员名单 / 媒体 / 站点 / 曲库。
 * - source/mp4 两个媒体域是静态文件服务器（渲染层 <img>/video 直连，不经 netRequest），
 *   根路径即可安全探测（实测 200）；source1/2/3.48.cn 是 source 的同内容镜像，不重复探测
 * - live.48.cn 与 snh48.com 的媒体/回放地址由接口动态下发、无法固定，以根路径代表域名可达性
 * - 成员名单 jsonp 属业务接口，与 pocketapi 同档报 App 身份，见 buildTargets
 */
const SERVICE_TARGETS: DiagnoseTarget[] = [
  { label: '头像/封面媒体', url: 'https://source.48.cn/', method: 'GET' },
  { label: '房间音视频', url: 'https://mp4.48.cn/', method: 'GET' },
  { label: '站点直播', url: 'https://live.48.cn/', method: 'GET' },
  { label: '官网 / 媒体源', url: 'https://www.snh48.com/', method: 'GET' },
  { label: 'CGT48 曲库', url: 'https://www.cgt48.com/json/music_snh.json', method: 'GET' },
]

/** 成员名单 jsonp：业务接口，主进程 netRequest 对 h5.48.cn 同样报 App 身份 */
const MEMBERS_JSONP: DiagnoseTarget = {
  label: '成员名单 jsonp',
  url: 'https://h5.48.cn/resource/jsonp/allmembers.php?gid=10',
  method: 'GET',
}

const DIAGNOSE_TIMEOUT = 8 * 1000

/** 4xx/5xx 响应体最多收这么多字节，够覆盖 WAF 拦截页标题与业务信封的错误文案 */
const DETAIL_BYTES = 512
/** 摘要展示上限（字符） */
const DETAIL_CHARS = 160

/**
 * 站点档移动端 UA（与渲染层 services/request.ts 的 SITE_USER_AGENT 同源拼装）：
 * 诊断请求的形态应贴近真实链路，避免 WAF 对裸 Electron UA 给出与业务不同的回答。
 */
const DIAGNOSE_UA = `Mozilla/5.0 (Linux; Android ${ANDROID_DEVICE.osVersion}; ${ANDROID_DEVICE.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`

/**
 * 组装本轮探测目标。
 *
 * pocketapi 先探「站点身份对照」（改造前的口径，用于观察服务端是否仍按身份拒答），
 * 再探 App 身份两档——App 身份头由 pocket-auth 按当前档位生成（与业务请求同源，含 pa；
 * 已登录时再加 token）。h5 的成员名单 jsonp 与 pocketapi 同属业务接口，复用同一份 App 身份头，
 * 使诊断口径与 netRequest 实际发出的请求一致。
 *
 * 身份头组装失败（wasm / 凭证异常）只跳过对照行与 h5 的 App 身份，不影响探测本身：
 * 拿不到身份头时 h5 退回站点身份探测，仍然能判断域名可达性。
 */
async function buildTargets(): Promise<DiagnoseTarget[]> {
  const targets: DiagnoseTarget[] = [{ ...POCKET_LIVE_LIST, label: '口袋48 API（站点身份对照）' }]
  let appHeaders: Record<string, string> | undefined

  try {
    appHeaders = await pocketAppHeaders(false)
    targets.push({ ...POCKET_LIVE_LIST, label: '口袋48 API（App 身份）', headers: appHeaders })
    if (getToken()) {
      targets.push({
        ...POCKET_LIVE_LIST,
        label: '口袋48 API（App 身份 + 登录态）',
        headers: await pocketAppHeaders(true),
      })
    }
  }
  catch (error) {
    log('[net-diagnose] App 身份对照行组装失败，本轮只探站点身份', error)
  }

  targets.push({ ...MEMBERS_JSONP, headers: appHeaders })
  return [...targets, ...SERVICE_TARGETS]
}

/** 压掉 HTML 标签与空白，只留可读的一句，避免把整页拦截 HTML 塞进诊断结果 */
function clipDetail(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_CHARS)
}

/** 单目标探测：2xx/3xx 收到响应头即算完成（连通性判定不需要 body），4xx/5xx 多收一段正文，超时/错误折进结果而非 reject */
function probe(target: DiagnoseTarget): Promise<NetDiagnoseItem> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let request: ClientRequest | undefined
    /** 已收到响应头时的状态码：4xx/5xx 读正文期间超时，仍要按已拿到的状态收口 */
    let seenStatus: number | null = null
    // 只回传展示所需字段：target.headers 挂着 App 身份（含 token），不能随结果过 IPC
    const finish = (result: Omit<NetDiagnoseItem, 'label' | 'url' | 'ms'>) => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      resolve({ label: target.label, url: target.url, ...result, ms: Date.now() - startedAt })
    }

    // 先 settle 再 abort：abort 事件会以「请求被中断」再进一次 finish
    timer = setTimeout(() => {
      finish(seenStatus === null
        ? { status: null, error: `超时（${DIAGNOSE_TIMEOUT / 1000} 秒无响应）` }
        : { status: seenStatus, detail: '（响应体未在超时内结束）' })
      request?.abort()
    }, DIAGNOSE_TIMEOUT)

    request = net.request({ url: target.url, method: target.method })
    request.setHeader('User-Agent', DIAGNOSE_UA)
    if (target.method === 'POST')
      request.setHeader('Content-Type', 'application/json')
    for (const [key, value] of Object.entries(target.headers ?? {}))
      request.setHeader(key, value)

    request.on('response', (response) => {
      const status = response.statusCode ?? null
      seenStatus = status
      // 2xx/3xx：只看状态码，取到响应头即中止连接释放 socket
      if (status === null || status < 400) {
        finish({ status })
        request?.abort()
        return
      }
      // 4xx/5xx：收一小段正文再收口。边缘 WAF 的拦截页与业务 JSON 在状态码上完全一致，
      // 正文形态（HTML / JSON 信封）才是「地区策略 / 风控」与「接口层拒绝」的分水岭
      const chunks: Buffer[] = []
      let received = 0
      const settle = () => finish({ status, detail: clipDetail(Buffer.concat(chunks).toString('utf8')) })
      response.on('data', (chunk: Buffer) => {
        if (received < DETAIL_BYTES)
          chunks.push(chunk)
        received += chunk.length
      })
      response.on('end', settle)
      response.on('aborted', settle)
      response.on('error', settle)
    })
    request.on('abort', () => finish({ status: null, error: '请求被中断' }))
    request.on('error', err => finish({ status: null, error: err.message }))
    if (target.body)
      request.write(JSON.stringify(target.body))
    request.end()
  })
}

/** 并发探测全部目标；单目标失败不拖累其余结果，每个目标都必有返回 */
export async function diagnoseTargets(): Promise<NetDiagnoseItem[]> {
  const targets = await buildTargets()
  return Promise.all(targets.map(probe))
}
