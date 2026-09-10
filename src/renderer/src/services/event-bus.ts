import type { Emitter } from 'mitt'
import mitt from 'mitt'

// 定义所有事件及其参数类型。
// 新增事件必须在这里登记（含用途注释），便于全局检索事件的收发两端；
// index signature 仅为兼容 mitt 泛型约束保留，未登记的事件收不到类型提示
interface Events {
  /** 浮窗放流失败（流不存在/直播下架），参数为 liveId；Lives 页若该直播在列表中则自动刷新 */
  'live-unavailable': string
  [key: string]: unknown
  [key: symbol]: unknown
}

const emitter: Emitter<Events> = mitt<Events>()

export default emitter
