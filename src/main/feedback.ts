/**
 * 问题反馈上报（主进程）：采集环境摘要，把用户输入 POST 到自建端点。
 *
 * 为什么放在主进程而不是渲染层直接 fetch：
 * - 上报地址由主进程持有，渲染层不传 URL，避免把 `netRequest` 的域名白名单为反馈而放宽
 * - 环境摘要（版本 / 平台 / 身份档）由主进程采集，渲染层无法伪造
 * - 网络异常与超时统一在这里收口，渲染层只需处理成功 / 失败两种结果
 *
 * 上报内容只含用户填写的问题描述、可选联系方式与本文件采集的摘要；
 * 账号凭据、手机号、聊天与房间消息一律不采集，日志中也不打印反馈正文。
 */

import type { FeedbackInput, FeedbackMeta, FeedbackPayload } from '@common/feedback'
import type { Buffer } from 'node:buffer'
import { FEEDBACK_ENDPOINT, validateFeedbackInput } from '@common/feedback'
import { app, net } from 'electron'
import { log } from './logger'
import { currentClientProfile, getAuthState } from './pocket48/pocket-auth'

const FEEDBACK_TIMEOUT = 15 * 1000
const FEEDBACK_RESPONSE_MAX_BYTES = 64 * 1024

/** 同一时刻只允许一次上报：渲染层按钮有 loading，但主窗口与独立播放窗可能同时发起 */
let inFlight = false

/** 采集运行环境摘要（只读，不含账号信息） */
export function collectFeedbackMeta(): FeedbackMeta {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? '',
    locale: app.getLocale(),
    clientProfile: currentClientProfile(),
    loggedIn: getAuthState().loggedIn,
  }
}

/** 上报通道是否可用：端点未配置时设置页据此禁用提交按钮 */
export function isFeedbackEndpointReady(): boolean {
  return FEEDBACK_ENDPOINT !== '' && /^https?:\/\//i.test(FEEDBACK_ENDPOINT)
}

/**
 * 提交反馈。失败一律抛错（渲染层展示 message），成功返回 void。
 *
 * 端点契约：接收 `FeedbackPayload` 的 JSON，返回 2xx 即视为成功，响应体不解析。
 */
export async function submitFeedback(input: FeedbackInput): Promise<void> {
  if (!isFeedbackEndpointReady())
    throw new Error('反馈上报地址未配置，暂无法提交')

  const validation = validateFeedbackInput(input)
  if (!validation.ok)
    throw new Error(validation.reason)

  if (inFlight)
    throw new Error('正在提交，请稍候')

  inFlight = true
  try {
    const payload: FeedbackPayload = {
      ...validation.value,
      meta: collectFeedbackMeta(),
    }
    await postJson(FEEDBACK_ENDPOINT, JSON.stringify(payload))
    // 只记长度不记正文：反馈内容可能含用户个人信息
    log(`[feedback] 已提交反馈（正文 ${payload.content.length} 字，${payload.contact ? '含' : '无'}联系方式）`)
  }
  finally {
    inFlight = false
  }
}

/** POST JSON 到固定端点；非 2xx 与超时都转为可读错误 */
function postJson(url: string, body: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = net.request({ url, method: 'POST' })
    request.setHeader('content-type', 'application/json; charset=utf-8')

    let settled = false
    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      request.abort()
      reject(new Error(`提交超时（${FEEDBACK_TIMEOUT}ms），请检查网络后重试`))
    }, FEEDBACK_TIMEOUT)

    const fail = (err: Error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    request.on('response', (response) => {
      // 必须把响应体读干净：不消费 data 时连接可能不被释放
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > FEEDBACK_RESPONSE_MAX_BYTES)
          request.abort()
      })
      response.on('end', () => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        const status = response.statusCode
        if (status >= 200 && status < 300)
          resolve()
        else
          reject(new Error(`提交失败（HTTP ${status}），请稍后重试或通过其它渠道反馈`))
      })
      response.on('error', (err: Error) => fail(err))
    })

    request.on('abort', () => fail(new Error('提交被中断，请重试')))
    request.on('error', fail)
    request.write(body)
    request.end()
  })
}
