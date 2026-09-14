import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debug, debugLog, error, isVerboseEnabled, log, setVerboseEnabled, warn } from '../src/common/log'

/**
 * 日志核心的 verbose 门控：渲染层按 import.meta.env.DEV、主进程按 is.dev 在模块加载时注入，
 * 运行期不再切换。门控失效的后果是生产包里刷日志，或排查时"以为没日志"。
 */
let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  setVerboseEnabled(false)
})

afterEach(() => {
  // verboseEnabled 是模块级状态，别漏给后续用例
  setVerboseEnabled(false)
  vi.restoreAllMocks()
})

describe('common/log verbose 门控', () => {
  it('默认关闭：debugLog / debug 均为 no-op', () => {
    expect(isVerboseEnabled()).toBe(false)

    debugLog('list', '翻页')
    debug('启动')

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('打开后 debugLog 带 [DBG][scope] 前缀输出（默认控制台面板即可见）', () => {
    setVerboseEnabled(true)
    expect(isVerboseEnabled()).toBe(true)

    debugLog('list', '翻页', 3)

    expect(logSpy).toHaveBeenCalledWith('[DBG][list]', '翻页', 3)
  })

  it('打开后 debug 带 [DBG] 前缀输出', () => {
    setVerboseEnabled(true)

    debug('hello')

    expect(logSpy).toHaveBeenCalledWith('[DBG]', 'hello')
  })

  it('关掉后立即不再输出（运行期切换只影响开关本身）', () => {
    setVerboseEnabled(true)
    debugLog('list', 'a')
    setVerboseEnabled(false)
    debugLog('list', 'b')

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('[DBG][list]', 'a')
  })

  it('log / warn / error 恒输出，不受 verbose 影响', () => {
    log('普通')
    warn('警告')
    error('错误')

    expect(logSpy).toHaveBeenCalledWith('普通')
    expect(warnSpy).toHaveBeenCalledWith('警告')
    expect(errorSpy).toHaveBeenCalledWith('错误')
  })
})
