/**
 * 渲染层事件总线：全局单例，只承载少量「跨组件广播」语义的事件。
 *
 * 为什么不直接用 mitt：mitt 的泛型约束是 `Emitter<Events extends Record<EventType, unknown>>`
 * （`EventType = string | symbol`），因此 `interface Events` 必须带 `[key: string]: unknown`
 * 兜底才能通过编译；而一旦带了兜底，事件名写错就不会报错——等于放弃了类型检查。
 * 本模块用 40 行自研实现替代，事件名与参数在编译期严格校验（见 test/event-bus.test.ts）。
 *
 * 使用约定：
 * - 新增事件必须在下方的 `Events` 里登记（含用途与收发两端的注释），便于全局检索；
 * - 无参数事件声明为 `void`，发射时不用传第二参；
 * - 订阅方记得在卸载时 `off`（或使用返回的取消函数），避免 KeepAlive 页面重复订阅；
 * - 回调抛出的异常会向上冒泡（与替换前的 mitt 行为一致），无法保证自己不出错的订阅方
 *   请自行 catch —— 总线不做静默吞错，否则会盖住真正的 bug。
 */

export interface Events {
  /** 浮窗放流失败（流不存在/直播下架），参数为 liveId；Lives 页若该直播在列表中则自动刷新 */
  'live-unavailable': string
  /**
   * 请求刷新直播列表（发射点：App.vue 双击底部 Dock 的直播项）。
   * 订阅方：pages/Lives.vue —— 刷新当前可见的那个列表（直播 / 回放），与双击左上角 tab 同效
   */
  'lives-refresh': void
  /**
   * 成员数据库已更新（发射点：services/apis.ts 的 syncInfo 落库之后）。
   * 订阅方：stores/member-tree.ts —— 作废成员树缓存并重拉，让 keep-alive 常驻的页面
   * （如回放页的成员筛选器）也能选到新增成员
   */
  'members-updated': void
}

type EventName = keyof Events

/** 事件回调：void 事件对应 `(payload: void) => void`，零参箭头函数可直接传入 */
type Handler<K extends EventName> = (payload: Events[K]) => void

/** 无参数事件发射时不允许再传第二参 */
type EmitArgs<K extends EventName> = Events[K] extends void ? [] : [payload: Events[K]]

/** 事件名 → 订阅者集合。用 Map 而不是对象字面量，避免 'constructor' 这类原型链键名 */
const handlers = new Map<EventName, Set<Handler<EventName>>>()

/** 订阅事件；返回取消订阅函数（等价于再调一次 off） */
function on<K extends EventName>(event: K, handler: Handler<K>): () => void {
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  set.add(handler as Handler<EventName>)
  return () => off(event, handler)
}

/** 取消订阅：只移除这一份回调，同一事件的其他订阅者不受影响 */
function off<K extends EventName>(event: K, handler: Handler<K>): void {
  const set = handlers.get(event)
  if (!set)
    return
  set.delete(handler as Handler<EventName>)
  // 没人订阅了就删掉整条记录，长时间运行的窗口不会攒下一堆空集合
  if (set.size === 0)
    handlers.delete(event)
}

/**
 * 发射事件。
 *
 * 遍历的是订阅者快照：回调里 `off` 自己或订阅新事件都不会打乱本次分发
 * （Set 在遍历中被修改会让后面的订阅者被跳过或重复收到）。
 */
function emit<K extends EventName>(event: K, ...args: EmitArgs<K>): void {
  const set = handlers.get(event)
  if (!set)
    return
  for (const handler of [...set])
    (handler as (...params: EmitArgs<K>) => void)(...args)
}

const eventBus = { emit, on, off }

export default eventBus
