import type { TaskKind } from '@renderer/composables/tasks/use-tasks'
import type { TaskPayload } from '@renderer/services/task-payload'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed } from 'vue'
import { useDownloadGuard } from './use-download-guard'
import useTasks from './use-tasks'

/**
 * 播放器媒体任务发起流程：LivePlayer（录制）与 PlaybackPlayer（回放下载）
 * 原本各自维护一套「目录校验 → 取源地址 → 组 TaskPayload → handleTask 下发」的同构代码，
 * 这里收敛为单一骨架；差异项通过参数表达：
 * - kind: 'download'（回放 HLS→MP4）/ 'record'（直播 RTMP→FLV）
 * - ext / separator: 任务文件名的扩展名与成员名分隔符（保持既有命名约定）
 * - getUrl: 源地址获取方式——回放用现成 playStreamPath，录制需先拉最新 RTMP 详情
 *
 * 状态查询与停止仍走 useTasks 的共享任务 store（handleTask/isTaskRunning/stopTask 一并返回）。
 * 须在组件 setup 内调用（useDownloadGuard 内部依赖 useRouter）。
 */
export function useMediaDownload(options: {
  kind: TaskKind
  liveId: () => string
  /** 成员/主播名：任务文件名前缀 */
  getRealName: () => string
  /** 任务开始时间：文件名时间戳来源 */
  startTime: () => number
  ext: () => string
  separator?: () => string
  /** 源地址解析：返回 null 表示失败（失败提示由调用链既有兜底负责，如 Apis 统一弹窗） */
  getUrl: () => Promise<string | null>
}) {
  const { checkDownloadDirectory } = useDownloadGuard()
  const { handleTask, isTaskRunning, stopTask } = useTasks()

  const running = computed(() => isTaskRunning(options.kind, options.liveId()))

  async function start() {
    const valid = await checkDownloadDirectory()
    if (!valid)
      return

    const url = await options.getUrl()
    if (!url)
      return

    const filename = Tools.taskFilename(
      options.getRealName(),
      options.startTime(),
      options.ext(),
      options.separator?.() ?? '',
    )
    const task: TaskPayload = {
      url,
      filename,
      liveId: options.liveId(),
    }
    // 任务由 useTasks 模块级单例直接接住并启动，状态在按钮上就地可见，
    // 不再跳转下载页——播放器本身也是浮窗，跳走反而打断浏览
    await handleTask(task, options.kind)
  }

  /** 按钮点击统一入口：未运行则发起，运行中则停止（含提示） */
  function onActionClick() {
    if (!running.value) {
      void start()
      return
    }
    stopTask(options.kind, options.liveId())
    ElMessage({ message: options.kind === 'record' ? '已结束录制' : '已停止下载', type: 'success' })
  }

  return { running, onActionClick, stopTask }
}

export default useMediaDownload
