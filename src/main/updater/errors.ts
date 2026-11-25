/**
 * 更新链路的错误处理：分类、中文化、重试。
 * electron-updater 的报错形态很杂（statusCode / code / 纯网络错误），这里只回答两件事：
 * 重试有意吗、该给用户看什么中文。
 */
import { log } from '../logger'

/** 单次检查最多尝试次数（不含镜像失败后切 GitHub 的那次）。 */
export const CHECK_MAX_ATTEMPTS = 3

/** 指数退避基数：800ms、2400ms。 */
export const RETRY_BACKOFF_BASE_MS = 800

/** electron-updater / Node 错误里我们关心的字段。 */
interface CodedError {
  code?: unknown
  statusCode?: unknown
  message?: unknown
}

function asCodedError(error: unknown): CodedError {
  return (typeof error === 'object' && error !== null) ? error as CodedError : {}
}

function errorMessage(error: unknown): string {
  const message = asCodedError(error).message
  return typeof message === 'string' ? message : ''
}

/**
 * 确定性失败：包不存在、版本号非法、清单格式不对。立刻放弃，否则只会把十几秒耗在重试上。
 */
const NON_RETRYABLE_CODES = [
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_INVALID_VERSION',
]

const TRANSIENT_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]

const TRANSIENT_MESSAGE = /timed out|timeout|socket hang up|network|ECONN|ENOTFOUND|EAI_AGAIN/i

/** 这次失败还值得再试一次吗。 */
export function isRetryableError(error: unknown): boolean {
  const { code, statusCode } = asCodedError(error)

  if (typeof code === 'string') {
    if (NON_RETRYABLE_CODES.includes(code) || code.startsWith('ERR_UPDATER_INVALID_'))
      return false
    if (TRANSIENT_CODES.includes(code))
      return true
  }

  // 5xx 与 408/429 是服务端/限流，重试有意义
  if (typeof statusCode === 'number') {
    if (statusCode >= 500 || statusCode === 408 || statusCode === 429)
      return true
  }

  return TRANSIENT_MESSAGE.test(errorMessage(error))
}

/**
 * 把错误翻成一句用户能懂的话。`fallback` 区分检查与下载（共用错误源，主语不同）。
 */
export function humanizeError(error: unknown, fallback = '检查更新失败'): string {
  const { code, statusCode } = asCodedError(error)
  const message = errorMessage(error)

  if (typeof code === 'string') {
    if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
      return '未找到可用的更新包，请稍后重试或前往官网下载'
    if (code === 'ERR_UPDATER_INVALID_VERSION' || code.startsWith('ERR_UPDATER_INVALID_'))
      return '更新信息格式异常，请稍后重试或前往官网下载'
  }

  if (statusCode === 403)
    return '更新源访问受限或请求过于频繁；如仍失败可前往官网手动下载'
  if (typeof statusCode === 'number' && statusCode >= 500)
    return '更新服务器暂时不可用，请稍后重试'

  if (/timeout|timed out/i.test(message))
    return '网络连接超时，请检查网络后重试'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(message))
    return '无法连接到更新服务器，请检查网络后重试'

  return message || fallback
}

/** 退避等待；外部中止时立刻退出，不干等计时器。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new Error('操作已取消'))
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('操作已取消'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带指数退避的重试；只试瞬时错误，确定性失败或已取消立刻抛。
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: { attempts?: number, label?: string, signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? CHECK_MAX_ATTEMPTS
  const label = options.label ?? '更新检查'
  const signal = options.signal

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted)
      throw new Error(`${label}已取消`)
    try {
      return await task()
    }
    catch (error) {
      if (signal?.aborted || attempt >= attempts || !isRetryableError(error))
        throw error
      const wait = RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1)
      log(`[updater] ${label}第 ${attempt} 次失败，${wait}ms 后重试：`, errorMessage(error) || error)
      await delay(wait, signal)
    }
  }
}

/** 给 Promise 套超时，防止网络半死时 UI 永久停在「检查中」。 */
export function withTimeout<T>(task: Promise<T>, ms: number, message = '更新检查超时'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
