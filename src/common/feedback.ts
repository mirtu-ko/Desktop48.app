/**
 * 问题反馈的共享定义：上报地址、报文结构、输入校验（主进程与渲染层同构）。
 *
 * 边界：
 * - 本文件只描述「提交什么」与「怎么算合法」，不做任何 IO；发送在 `main/feedback.ts`
 * - 环境摘要由主进程生成（版本 / 平台 / 身份档），渲染层不能改写，避免上报内容失真
 * - 刻意不收集：账号凭据、手机号、聊天与房间消息、任何本地文件内容
 */

/**
 * 上报服务地址（POST JSON）：产品主页 Worker 的反馈路由（见 desktop48-site 仓库的 /api/feedback）。
 *
 * 保持为常量而非配置项：地址变动属于发版动作，不应由用户在设置里改写。
 * 置空串可关闭提交入口（设置页按钮禁用、复制环境信息仍可用），用于端点未就绪或临时下线。
 *
 * 显式标注 string：否则字面量类型会让「是否为空」的判断被 TS 判成恒真比较。
 */
export const FEEDBACK_ENDPOINT: string = 'https://48.v2ing.com/api/feedback'

/** 反馈正文长度上限（按字符计，超出拒绝而不是静默截断，用户能看到自己写了多少） */
export const FEEDBACK_CONTENT_MAX = 2000

/** 联系方式长度上限（邮箱 / 社交账号等，可选填） */
export const FEEDBACK_CONTACT_MAX = 100

/** 运行环境摘要：由主进程采集，不含任何账号或内容信息 */
export interface FeedbackMeta {
  /** 应用版本（package.json version） */
  appVersion: string
  /** 运行平台，如 win32 / darwin / linux */
  platform: string
  /** CPU 架构，如 x64 / arm64 */
  arch: string
  /** Electron 运行时版本 */
  electron: string
  /** 系统语言标记 */
  locale: string
  /** 口袋客户端身份档 id（仅档位名，不含账号信息） */
  clientProfile: string
  /** 是否已登录（布尔值，便于判断问题是否与登录态相关） */
  loggedIn: boolean
}

/** 提交给上报端点的完整报文 */
export interface FeedbackPayload {
  content: string
  /** 未填写时省略该字段，避免上报空串 */
  contact?: string
  meta: FeedbackMeta
}

/** 设置页初始化所需：环境摘要 + 上报通道是否可用（端点未配置时禁用提交） */
export interface FeedbackMetaResponse {
  meta: FeedbackMeta
  endpointReady: boolean
}

/** 渲染层提交的原始输入（环境摘要由主进程补齐） */
export interface FeedbackInput {
  content: string
  contact?: string
}

/** 校验结果：成功时给出规范化后的输入（已 trim、空联系方式归一为 undefined） */
export type FeedbackValidation
  = | { ok: true, value: FeedbackInput }
    | { ok: false, reason: string }

/**
 * 校验并规范化用户输入。
 *
 * 超长选择拒绝而非截断：反馈往往靠上下文才能定位，静默切掉尾部会让提交内容
 * 与用户看到的输入框不一致，事后无法解释。
 */
export function validateFeedbackInput(input: FeedbackInput): FeedbackValidation {
  const content = input.content.trim()
  if (!content)
    return { ok: false, reason: '请填写问题描述' }
  if (content.length > FEEDBACK_CONTENT_MAX)
    return { ok: false, reason: `问题描述不能超过 ${FEEDBACK_CONTENT_MAX} 字` }

  const contact = input.contact?.trim() ?? ''
  if (contact.length > FEEDBACK_CONTACT_MAX)
    return { ok: false, reason: `联系方式不能超过 ${FEEDBACK_CONTACT_MAX} 字` }

  return { ok: true, value: contact ? { content, contact } : { content } }
}

/** 环境摘要的纯文本形式（设置页「复制环境信息」用，便于粘贴到任意渠道） */
export function formatFeedbackMeta(meta: FeedbackMeta, capturedAt = new Date()): string {
  return [
    `应用版本: v${meta.appVersion}`,
    `运行环境: ${meta.platform} ${meta.arch} · Electron ${meta.electron}`,
    `系统语言: ${meta.locale}`,
    `客户端身份: ${meta.clientProfile}`,
    `登录状态: ${meta.loggedIn ? '已登录' : '未登录'}`,
    `采集时间: ${capturedAt.toLocaleString()}`,
  ].join('\n')
}
