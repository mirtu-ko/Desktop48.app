/**
 * 房间语音条互斥：全局同时只允许一条语音在播。
 *
 * 状态必须留在模块作用域：<script setup> 顶层的 `let` 会被编译进 setup()，
 * 每个组件实例各一份，拿不到「上一条」，做不成单例（旧实现即栽在这里，注释写着互斥实则各播各的）。
 * 谁开始播放谁占位；占位者只在下一次有人开播、自己播完或卸载时让位。
 */

/** 当前在播语音的暂停器（由各实例把自己的 pause 交上来） */
let pauseCurrent: (() => void) | null = null

/** 占坑：先停掉正在播的那条，再把自己登记为当前 */
export function claimVoiceSlot(pause: () => void) {
  if (pauseCurrent && pauseCurrent !== pause)
    pauseCurrent()
  pauseCurrent = pause
}

/** 让坑：只有当前占位者能清，避免旧实例播完/卸载时误伤刚接手的那条 */
export function releaseVoiceSlot(pause: () => void) {
  if (pauseCurrent === pause)
    pauseCurrent = null
}
