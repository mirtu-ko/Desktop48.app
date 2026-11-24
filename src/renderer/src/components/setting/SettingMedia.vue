<script setup lang="ts">
import type { useAppConfig } from '@renderer/composables/use-app-config'
import type { useFfmpegSetup } from '@renderer/composables/use-ffmpeg-setup'
import { Cpu, Folder, Position } from '@element-plus/icons-vue'
import { describeFfmpegProblem } from '@renderer/composables/use-ffmpeg-setup'
import { floatTopmost, setFloatTopmost } from '@renderer/stores/float-topmost'
import { ElMessage } from 'element-plus'
import { computed } from 'vue'

/**
 * 播放与文件组：默认下载目录、FFmpeg 目录、播放窗置顶策略。
 *
 * 状态来源都不在本组件：下载目录来自 use-app-config，FFmpeg 环境与修复动作来自
 * use-ffmpeg-setup（与启动门禁同一判定口径），置顶偏好是 stores/float-topmost 的模块级单例。
 * 本组件只做模板接线与操作结果的用户提示。
 *
 * ⚠️ 两个 composable 的返回值都是普通对象，内部 ref 在模板里不会自动解包，
 * 因此解构到 setup 顶层（顶层 ref 由模板自动解包）。
 */
const props = defineProps<{
  appConfig: ReturnType<typeof useAppConfig>
  ffmpeg: ReturnType<typeof useFfmpegSetup>
}>()

const { downloadDirectory, setDownloadDirectory, openDownloadDirectory } = props.appConfig
const {
  status,
  checking,
  downloading,
  busy,
  isSystem,
  directory,
  copy,
  downloadPercent,
  downloadLabel,
  download,
  choose,
  openDirectory,
} = props.ffmpeg

/** FFmpeg 行状态徽章：可用 / 未配置 / 目录不存在 / 缺少 ffmpeg */
const ffmpegStateLabel = computed(() => {
  if (!status.value)
    return checking.value ? '检测中…' : '状态未知'
  return copy.value.label
})

const ffmpegStateClass = computed(() => {
  if (!status.value)
    return 'is-checking'
  return status.value.ok ? 'is-ready' : 'is-broken'
})

/** 一键下载 FFmpeg：成功即已写入配置，无需再点保存 */
async function downloadFfmpeg() {
  if (await download()) {
    ElMessage({ message: 'FFmpeg 已就绪', type: 'success' })
    return
  }
  ElMessage.error('下载 FFmpeg 失败：请检查网络后重试，或手动选择已有目录')
}

/** 手动选择目录：校验通过才落盘，校验失败说明错在哪（目录不存在 / 目录内缺 ffmpeg） */
async function chooseFfmpegDir() {
  const result = await choose()
  if (result.outcome === 'ok') {
    ElMessage({ message: '设置成功', type: 'success' })
    return
  }
  if (result.outcome === 'invalid') {
    ElMessage.error(describeFfmpegProblem(result.status.problem, result.status.directory).title)
    return
  }
  if (result.outcome === 'failed')
    ElMessage.error('设置 FFmpeg 目录失败，请重试')
}

/** 单选组的事件是宽联合类型，这里收窄成三个合法取值再落盘，其余值忽略 */
function onPickFloatTopmost(value: string | number | boolean | undefined) {
  if (value === 'always' || value === 'playing' || value === 'never')
    void setFloatTopmost(value)
}
</script>

<template>
  <h2 class="setting-group-label" data-setting-group="media">
    播放与文件
  </h2>
  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-downloads)' }"
      >
        <el-icon><Folder /></el-icon>
      </span>
      <div class="row-text">
        <div class="row-title">
          默认下载目录
        </div>
        <div class="row-desc">
          回放与录制文件的保存位置
        </div>
      </div>
      <el-input
        :model-value="downloadDirectory"
        class="row-control"
        readonly
        placeholder="点击输入框选择目录"
        @click="setDownloadDirectory"
      />
      <div class="row-actions">
        <el-button
          :disabled="!downloadDirectory"
          @click="openDownloadDirectory"
        >
          打开目录
        </el-button>
        <el-button
          type="primary"
          @click="setDownloadDirectory"
        >
          选择
        </el-button>
      </div>
    </div>
  </section>

  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-lives)' }"
      >
        <el-icon><Cpu /></el-icon>
      </span>
      <div class="row-text">
        <div class="row-title">
          FFmpeg 目录
        </div>
        <div class="row-desc">
          播放直播与录制下载依赖的程序
        </div>
      </div>
      <el-input
        :model-value="directory"
        class="row-control"
        readonly
        placeholder="未配置，可一键下载或手动选择"
        @click="chooseFfmpegDir"
      />
      <div class="row-actions">
        <el-button
          :disabled="!directory"
          @click="openDirectory"
        >
          打开目录
        </el-button>
        <el-button
          :disabled="busy"
          @click="chooseFfmpegDir"
        >
          选择
        </el-button>
        <el-button
          type="primary"
          :disabled="busy || isSystem"
          :loading="downloading"
          @click="downloadFfmpeg"
        >
          {{ downloading ? '下载中' : '下载' }}
        </el-button>
      </div>
    </div>

    <div class="row-body">
      <div
        class="ffmpeg-state"
        :class="ffmpegStateClass"
      >
        <span class="state-dot" />
        <span class="state-label">{{ ffmpegStateLabel }}</span>
        <span
          v-if="status && (!status.ok || isSystem)"
          class="state-hint"
        >{{ copy.hint }}</span>
      </div>
      <el-progress
        v-if="downloading && downloadPercent !== null"
        class="ffmpeg-progress"
        :percentage="downloadPercent ?? 0"
        :stroke-width="8"
        :show-text="false"
      />
      <p
        v-if="downloading"
        class="ffmpeg-progress-label"
      >
        {{ downloadLabel }}
      </p>
      <p
        v-else-if="status && !status.ok"
        class="ffmpeg-fix-hint"
      >
        下一步：点击「下载」自动获取，或点击「选择」指定本机已有的 FFmpeg 目录。
      </p>
    </div>
  </section>

  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-shows)' }"
      >
        <el-icon><Position /></el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          播放窗置顶
        </div>
        <div class="row-desc">
          播放窗与其他窗口的前后层级；标题栏的图钉可单独调整当前窗
        </div>
      </div>
      <div class="topmost-actions">
        <el-radio-group
          :model-value="floatTopmost"
          @update:model-value="onPickFloatTopmost"
        >
          <el-radio-button value="always">
            始终置顶
          </el-radio-button>
          <el-radio-button value="playing">
            仅播放时
          </el-radio-button>
          <el-radio-button value="never">
            从不置顶
          </el-radio-button>
        </el-radio-group>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
/* FFmpeg 就绪状态：圆点 + 结论 + 原因说明，broken 态再补一条可直接照做的修复提示。
   行的横向骨架（.setting-row / .row-icon / .row-text / .row-control / .row-actions）
   由设置页引入的 setting-shared 提供，这里只有本组特有的状态块。 */
.ffmpeg-state {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.ffmpeg-state .state-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.ffmpeg-state.is-ready .state-dot {
  background: var(--el-color-success);
}

.ffmpeg-state.is-broken .state-dot {
  background: var(--el-color-danger);
}

.ffmpeg-state .state-hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.ffmpeg-progress {
  margin-top: 12px;
}

.ffmpeg-progress-label,
.ffmpeg-fix-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
</style>
