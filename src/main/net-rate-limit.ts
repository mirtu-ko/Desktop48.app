/**
 * 渲染层 `netRequest` 的出口闸门：按目标域名做令牌桶 + 在途上限。
 *
 * 白名单（allowed-hosts.ts）解决「能打谁」，这里解决「打多快」。没有这一层时，
 * 渲染层任一处写错（循环、watch 抖动、重复挂载）都能瞬间把请求打满，主进程会全盘接受，
 * 最终由对方服务端的风控替我们兜底。
 *
 * 超限不丢弃：进 FIFO 队列等令牌（调用方本来就在 await），队列满或等太久才拒绝。
 * 收到 429 且带 Retry-After 时整域进入冷却——服务端已明说等多久，继续撞只会更糟。
 */

/** 单域名每秒补多少个令牌，以及可攒的burst（允许短时并发探测，不允许持续高频） */
const HOST_RATE_PER_SEC = 5
const HOST_BURST = 5
/** 单域名同时在途上限：轮询并发是 3-4，超过说明调用方在堆积 */
const HOST_MAX_INFLIGHT = 4
/** 全局在途上限：多域名同时打时别把进程内的 socket 池撑爆 */
const GLOBAL_MAX_INFLIGHT = 8
/** 单域名等待队列上限与排队时长上限：超过就不再接受，避免请求越等越旧 */
const MAX_QUEUE = 24
const QUEUE_TIMEOUT_MS = 10_000
/** Retry-After 上限：服务端给得再长也不把整域锁死超过这个时间 */
const MAX_PENALTY_MS = 60_000

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface HostState {
  tokens: number
  refilledAt: number
  inflight: number
  /** 429 惩罚到期时刻：此前一律不发新请求 */
  blockedUntil: number
  queue: Waiter[]
  /** 等令牌的定时器：令牌按时间补充，队列有人时必须到点回来再看一眼 */
  pumpTimer: ReturnType<typeof setTimeout> | null
}

const hosts = new Map<string, HostState>()
let globalInflight = 0

// 条目按域名留驻：域名集合受白名单后缀约束（.48.cn / .yunxinsvr.com 等），规模有限，
// 不做回收——带着计数删除条目会让在途请求的 release 找不到自己的 state。
function hostState(host: string): HostState {
  let state = hosts.get(host)
  if (!state) {
    state = { tokens: HOST_BURST, refilledAt: Date.now(), inflight: 0, blockedUntil: 0, queue: [], pumpTimer: null }
    hosts.set(host, state)
  }
  return state
}

function refill(state: HostState): void {
  const now = Date.now()
  const elapsed = now - state.refilledAt
  if (elapsed <= 0)
    return
  state.tokens = Math.min(HOST_BURST, state.tokens + (elapsed * HOST_RATE_PER_SEC) / 1000)
  state.refilledAt = now
}

function canStart(state: HostState): boolean {
  return Date.now() >= state.blockedUntil
    && state.inflight < HOST_MAX_INFLIGHT
    && globalInflight < GLOBAL_MAX_INFLIGHT
    && state.tokens >= 1
}

/** 占一个名额，返回幂等的释放函数（调用方在 finally 里调，重复调用不会重复归还） */
function consume(host: string, state: HostState): () => void {
  state.tokens -= 1
  state.inflight += 1
  globalInflight += 1
  let released = false
  return () => {
    if (released)
      return
    released = true
    state.inflight -= 1
    globalInflight -= 1
    pump(host)
  }
}

/** 队列有人且条件满足就放行；否则安排一次「等令牌/等冷却到期」的唤醒 */
function pump(host: string): void {
  const state = hosts.get(host)
  if (!state)
    return
  refill(state)
  while (state.queue.length > 0 && canStart(state)) {
    const waiter = state.queue.shift()!
    clearTimeout(waiter.timer)
    waiter.resolve(consume(host, state))
  }
  if (state.queue.length === 0 || state.pumpTimer)
    return

  const now = Date.now()
  let wait = 0
  if (now < state.blockedUntil)
    wait = state.blockedUntil - now
  else if (state.tokens < 1)
    wait = Math.ceil(((1 - state.tokens) * 1000) / HOST_RATE_PER_SEC)
  else
    // 在途已满：release 一定会回来 pump，这里只防「释放丢了」时队列永久卡住
    wait = 1_000
  state.pumpTimer = setTimeout(() => {
    state.pumpTimer = null
    pump(host)
  }, Math.max(wait, 20))
}

/**
 * 申请一次对外请求的许可。返回的释放函数必须恰好调一次（主进程 handler 里用 finally）。
 * 队列满 / 排队超时都会被拒绝——让调用方尽早失败，而不是把过期请求继续排在后面。
 */
export function acquireNetSlot(host: string): Promise<() => void> {
  const state = hostState(host)
  refill(state)
  if (state.queue.length === 0 && canStart(state))
    return Promise.resolve(consume(host, state))
  if (state.queue.length >= MAX_QUEUE)
    return Promise.reject(new Error(`本地请求排队已满（${MAX_QUEUE}），请稍后再试`))

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = state.queue.indexOf(waiter)
        if (index >= 0)
          state.queue.splice(index, 1)
        reject(new Error(`本地请求排队超时（${QUEUE_TIMEOUT_MS}ms），请稍后再试`))
      }, QUEUE_TIMEOUT_MS),
    }
    state.queue.push(waiter)
    pump(host)
  })
}

/**
 * 429 后的整域冷却：只认服务端明确给出的 Retry-After（秒数或 HTTP 日期）。
 * 没有该头时返回 0——不猜时长，交给调用方「不重试」即可。
 */
export function parseRetryAfterMs(value: string | undefined): number {
  if (!value)
    return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, MAX_PENALTY_MS)
  const at = Date.parse(value)
  if (Number.isNaN(at))
    return 0
  return Math.min(Math.max(at - Date.now(), 0), MAX_PENALTY_MS)
}

/** 让某域名在给定时间内不再发新请求（排队者会被推到冷却结束之后） */
export function penalizeHost(host: string, penaltyMs: number): void {
  if (penaltyMs <= 0)
    return
  const state = hostState(host)
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + penaltyMs)
  pump(host)
}
