/**
 * 渲染层 dev-only 调试日志（与主进程 logger.debug / ipc/trace.ts 对称）。
 *
 * - `import.meta.env.DEV` 在 Vite 构建期确定为常量，生产包中被 tree-shake，零运行时开销
 * - 主动用 console.log 而非 console.debug：后者默认被 DevTools 的 Verbose 过滤器隐藏，
 *   新人排查时会「以为没日志」；[DBG] 前缀保证默认面板即可见、可一键过滤
 * - 埋点位置约定：只记「决策点与状态流转」（谁发起了什么、走了哪个分支、耗时多久），
 *   不记高频心跳（如任务 progress，逐帧输出会淹没真正有用的片段）
 *
 * ── scope 对照表（新人读代码目录）───────────────────────────────
 * | scope      | 链路               | 关键模块                                          |
 * |------------|--------------------|---------------------------------------------------|
 * | live       | 直播/公演播放链    | LivePlayer → use-live-session → use-live-player   |
 * |            |                    | （主进程侧：stream.ts → http-server → ffmpeg）    |
 * | show       | 公演选路入口       | Shows.vue → 按状态分流到直播链或录播链            |
 * | playback   | 录播 VOD 播放链    | ReviewPlayer → use-playback-engine (hls.js)       |
 * | tasks      | 下载/录制任务链    | use-tasks → task-base → ffmpeg 任务通道           |
 * | load-more  | 列表分页与自动补拉 | use-load-more → use-paged-live-list               |
 * | net        | 所有链路共用的网络 | request.ts → 主进程 netRequest                    |
 * ────────────────────────────────────────────────────────────────
 * 直播链跨进程时序：渲染层先 createLiveStream（只登记会话），
 * 播放器 GET 本地地址后主进程 http-server 才 spawn FFmpeg —— 对照 main.log 的 [ipc]/[http-server.ts]。
 */

const isDev = import.meta.env.DEV

/** 调用方可据此跳过昂贵的参数格式化（关闭时 debugLog 本身是 no-op） */
export function isDebugEnabled(): boolean {
  return isDev
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDev)
    return
  console.log(`[DBG][${scope}]`, ...args)
}

export default debugLog
