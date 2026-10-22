/**
 * 网络诊断：探测应用实际依赖的端点，区分网络不可达、服务端拒绝和服务端异常。
 * pocketapi / h5 的根路径会被网关或 WAF 误判，因此使用真实业务端点。pocketapi
 * 分别以站点身份、App 身份、App 身份 + 登录态探测，用 403 差异定位地区策略或身份限制。
 * 4xx/5xx 的响应体摘要用于区分边缘拦截页与业务响应；端点变更需与业务地址同步。
 */
import type { ClientRequest } from 'electron'
import { Buffer } from 'node:buffer'
import { ANDROID_DEVICE } from '@common/android-device'
import { LIVE_LIST_URL } from '@common/pocket-api-urls'
import { net } from 'electron'
import { log } from './logger'
import { getToken, pocketAppHeaders } from './pocket48/pocket-auth'

/** 单个探测结果（IPC 契约对端：preload/ipc-contract.d.ts）。 */
export interface NetDiagnoseItem {
  label: string
  url: string
  /** HTTP 状态码；null 表示未收到响应。 */
  status: number | null
  /** 从发起到收到响应头或失败的耗时（ms）。 */
  ms: number
  error?: string
  detail?: string
}

interface DiagnoseTarget {
  label: string
  url: string
  method: 'GET' | 'POST'
  body?: object
  headers?: Record<string, string>
}

type ProbeResult = Omit<NetDiagnoseItem, 'label' | 'url' | 'ms'>

/** 无需登录的直播列表请求，与业务列表接口保持一致。 */
const POCKET_LIVE_LIST: Omit<DiagnoseTarget, 'label'> = {
  url: LIVE_LIST_URL,
  method: 'POST',
  body: { groupId: 0, next: '0', debug: false, record: false },
}

/** 业务实际依赖的静态资源与媒体端点；镜像域名不重复探测。 */
const SERVICE_TARGETS: DiagnoseTarget[] = [
  { label: '头像/封面媒体', url: 'https://source.48.cn/', method: 'GET' },
  { label: '房间音视频', url: 'https://mp4.48.cn/', method: 'GET' },
  { label: '官网 / 媒体源', url: 'https://www.snh48.com/', method: 'GET' },
  { label: 'CGT48 曲库', url: 'https://www.cgt48.com/json/music_snh.json', method: 'GET' },
]

const MEMBERS_JSONP: DiagnoseTarget = {
  label: '成员名单 jsonp',
  url: 'https://h5.48.cn/resource/jsonp/allmembers.php?gid=10',
  method: 'GET',
}

const DIAGNOSE_TIMEOUT = 8 * 1000
const DETAIL_BYTES = 512
const DETAIL_CHARS = 160

/** 站点身份 UA，机型与 App 身份共用 common/android-device.ts。 */
const DIAGNOSE_UA = `Mozilla/5.0 (Linux; Android ${ANDROID_DEVICE.osVersion}; ${ANDROID_DEVICE.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`

/**
 * 组装站点对照、App 身份、成员名单与静态资源探测目标。
 * 身份头生成失败时只跳过 App 身份行，成员名单仍可回退到站点身份探测。
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

/** 去掉 HTML 标签和多余空白，避免把整页拦截内容塞进诊断结果。 */
function clipDetail(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_CHARS)
}

/**
 * 探测单个目标：状态码 < 400 时收到响应头即结束；4xx/5xx 读取少量正文用于区分
 * 边缘拦截页与业务响应。超时和网络错误统一折进结果，不向上抛异常。
 */
function probe(target: DiagnoseTarget): Promise<NetDiagnoseItem> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let request: ClientRequest | undefined
    let responseStatus: number | undefined

    const finish = (result: ProbeResult) => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      // 只回传展示字段，身份头（含 token）不能随结果通过 IPC。
      resolve({ ...result, label: target.label, url: target.url, ms: Date.now() - startedAt })
    }
    const fail = (error: string) => finish({ status: null, error })

    timer = setTimeout(() => {
      finish(responseStatus === undefined
        ? { status: null, error: `超时（${DIAGNOSE_TIMEOUT / 1000} 秒无响应）` }
        : { status: responseStatus, detail: '（响应体未在超时内结束）' })
      request?.abort()
    }, DIAGNOSE_TIMEOUT)

    try {
      request = net.request({ url: target.url, method: target.method })
      request.setHeader('User-Agent', DIAGNOSE_UA)
      if (target.method === 'POST')
        request.setHeader('Content-Type', 'application/json')
      for (const [key, value] of Object.entries(target.headers ?? {}))
        request.setHeader(key, value)

      request.on('response', (response) => {
        const status = response.statusCode
        responseStatus = status

        if (status < 400) {
          finish({ status })
          request?.abort()
          return
        }

        const chunks: Buffer[] = []
        let bytes = 0
        const settle = () => finish({ status, detail: clipDetail(Buffer.concat(chunks).toString('utf8')) })
        response.on('data', (chunk: Buffer) => {
          const remaining = DETAIL_BYTES - bytes
          if (remaining > 0)
            chunks.push(chunk.subarray(0, remaining))
          bytes += chunk.length
        })
        response.on('end', settle)
        response.on('aborted', settle)
        response.on('error', settle)
      })
      request.on('abort', () => fail('请求被中断'))
      request.on('error', error => fail(error.message))
      if (target.body)
        request.write(JSON.stringify(target.body))
      request.end()
    }
    catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })
}

/** 并发探测全部目标；单个目标失败不影响其余结果。 */
export async function diagnoseTargets(): Promise<NetDiagnoseItem[]> {
  const targets = await buildTargets()
  return Promise.all(targets.map(probe))
}
