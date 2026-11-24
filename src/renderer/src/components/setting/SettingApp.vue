<script setup lang="ts">
import type { useUpdater } from '@renderer/composables/use-updater'

import { FEEDBACK_CONTACT_MAX, FEEDBACK_CONTENT_MAX } from '@common/feedback'
import { ChatDotRound, Connection, Download, Refresh, Top } from '@element-plus/icons-vue'
import { previewReleaseNotes } from '@renderer/utils/update-notes'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'

/**
 * 应用组：版本 / 自动更新、网络诊断、问题反馈。
 *
 * 自动更新状态来自 use-updater（主进程持真相），本组件只把状态映射成文案与按钮；
 * 诊断结果与反馈表单只在本组内使用，状态留在这里，生命周期与设置页一致（页面被 KeepAlive 缓存）。
 * 两个弹窗外壳用 el-dialog + append-to-body，搬家不改变浮层层级。
 *
 * 与其它分组一致：composable 结果解构到 setup 顶层，模板里直接用 ref 名（自动解包）。
 */
const props = defineProps<{ updater: ReturnType<typeof useUpdater> }>()

// composable 返回值是普通对象，内部 ref 在模板里不会自动解包，因此解构到 setup 顶层
const { state, checking, version, check, download, install } = props.updater

// ===== 版本行 =====

/** 更新行的描述文案：一行说清当前处于什么状态、下一步该做什么 */
const updaterDesc = computed(() => {
  const s = state.value
  switch (s.phase) {
    case 'checking':
      return '正在检查更新，请稍候…'
    case 'up-to-date':
      return '当前已是最新版本，无需更新'
    case 'available':
      return `发现新版本 v${s.version}`
    case 'downloading':
      return `正在下载新版本 v${s.version}…`
    case 'ready':
      return `新版本 v${s.version} 已下载完成，重启后生效`
    case 'error':
      return `检查更新失败：${s.message}`
    case 'unsupported':
      return s.reason
    default:
      return '检查是否有可用的新版本'
  }
})

/** available 态的描述切强调样式，与其余状态的中性文案区分 */
const updaterDescClass = computed(() => state.value.phase === 'available' ? 'is-update' : '')

/** 新版本信息：仅 available 态非空 */
const availableUpdate = computed(() =>
  state.value.phase === 'available' ? state.value : null,
)
/** 下载中信息：仅 downloading 态非空，提示块内的进度展示取自此状态 */
const downloadingUpdate = computed(() =>
  state.value.phase === 'downloading' ? state.value : null,
)

/** 提示块标题：available / downloading 各一句；版本号在脚本侧拼接，模板不做类型收窄 */
const availableTitle = computed(() =>
  availableUpdate.value ? `发现新版本 v${availableUpdate.value.version}` : '')
const downloadingTitle = computed(() =>
  downloadingUpdate.value ? `正在下载新版本 v${downloadingUpdate.value.version}` : '')

/** 版本对比行：已知当前版本时给出「当前 vX → 最新 vY」，否则只报最新版本 */
const updateVersionLine = computed(() => {
  const next = availableUpdate.value
  if (!next)
    return ''
  return version.value
    ? `当前 v${version.value} → 最新 v${next.version}`
    : `最新版本 v${next.version}`
})

/** 更新说明预览：剥掉 markdown 标记后按纯文本行展示，并过滤 Full Changelog 汇总行；最多 4 行 */
const releaseNotesPreview = computed(() =>
  previewReleaseNotes(availableUpdate.value?.releaseNotes ?? ''),
)

/** 字节数格式化：下载进度的已传 / 总量与速率 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 1024 ** exp
  return `${exp === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`
}

/** 下载进度文字：总量已知时给出「已传 / 总量 · 速率」，否则只报已传与速率 */
const downloadSizeText = computed(() => {
  const d = downloadingUpdate.value
  if (!d)
    return ''
  const speed = `${formatBytes(d.bytesPerSecond)}/s`
  return d.total > 0
    ? `${formatBytes(d.transferred)} / ${formatBytes(d.total)} · ${speed}`
    : `${formatBytes(d.transferred)} · ${speed}`
})

/** available 态是否只能跳转手动下载（macOS 当前走该链路） */
const manualUpdateNotice = computed(() => availableUpdate.value?.manualUpdate ?? false)

/** 下载进度百分比（提示块内的进度条与百分比文字共用） */
const updaterPercent = computed(() =>
  state.value.phase === 'downloading'
    ? Math.min(100, state.value.percent)
    : 0,
)

/**
 * 打开手工下载页。
 *
 * 经 `window.open` 触发主进程的 `setWindowOpenHandler`，转交系统浏览器
 * （与 use-album-player.ts 同一路径；主进程只放行 http/https）。
 */
function openReleasePage(url: string) {
  window.open(url, '_blank', 'noopener')
}

/** 手动下载兜底地址：官方下载页。正常情况下主进程会在 available 态带上镜像安装包直链 */
const MANUAL_RELEASE_PAGE_URL = 'https://48.v2ing.com/'

/** 主操作按钮：状态决定文案与语义；自动更新 available 态是「更新版本」，macOS 是「去下载」 */
const updaterAction = computed<{ label: string, disabled: boolean, loading: boolean, handler: () => void }>(() => {
  const s = state.value
  if (s.phase === 'downloading')
    return { label: '下载中', disabled: true, loading: true, handler: () => {} }
  if (s.phase === 'ready')
    return { label: '立即重启', disabled: false, loading: false, handler: install }
  if (s.phase === 'available' && s.manualUpdate)
    return { label: '去下载', disabled: false, loading: false, handler: () => openReleasePage(availableUpdate.value?.url ?? MANUAL_RELEASE_PAGE_URL) }
  if (s.phase === 'available')
    return { label: '更新版本', disabled: false, loading: false, handler: download }
  // 免安装版等不支持自动更新的环境给出手工出路，别让用户对着禁用按钮无计可施
  if (s.phase === 'unsupported' && s.url)
    return { label: '去下载', disabled: false, loading: false, handler: () => openReleasePage(s.url!) }
  return { label: '检查更新', disabled: checking.value || s.phase === 'unsupported', loading: checking.value, handler: check }
})

// ===== 网络诊断 =====
// 对核心服务域名逐一探测连通性（主进程对端 main/net/net-diagnose.ts）。
// 用于接口报错（如 HTTP 403）时让用户自助定位：不可达 / 被拒 / 服务端异常一目了然。

const diagnosing = ref(false)
const diagnoseResults = ref<Array<{ label: string, url: string, status: number | null, ms: number, error?: string, detail?: string }>>([])
/** 诊断结果弹窗：点击即打开，先给等待态，出结果后原地替换 */
const diagnoseDialogVisible = ref(false)

/** 发起诊断：结果整体替换而非追加，重复点击看到的是最新一轮 */
async function handleDiagnose() {
  if (diagnosing.value)
    return
  diagnoseDialogVisible.value = true
  diagnosing.value = true
  try {
    diagnoseResults.value = await window.mainAPI.netDiagnose()
  }
  catch (e: any) {
    ElMessage.error(`网络诊断失败：${e?.message || '未知错误'}`)
  }
  finally {
    diagnosing.value = false
  }
}

/** 单条结果的结论徽标：按状态码分段给出结论与语义色 */
function diagnoseVerdict(item: typeof diagnoseResults.value[number]): { label: string, type: 'success' | 'warning' | 'danger' | 'info' } {
  if (item.status === null)
    return { label: '不可达', type: 'danger' }
  if (item.status < 400)
    return { label: '正常', type: 'success' }
  if (item.status === 403)
    return { label: '拒绝访问', type: 'danger' }
  if (item.status < 500)
    return { label: `HTTP ${item.status}`, type: 'warning' }
  return { label: `HTTP ${item.status}`, type: 'danger' }
}

/** 单条结果的补充说明：解释这个状态码对排查意味着什么 */
function diagnoseNote(item: typeof diagnoseResults.value[number]): string {
  if (item.status === null)
    return item.error || '连接失败'
  if (item.status === 403)
    return '服务端可达但拒绝访问：对比各身份行可区分地区策略与客户端身份限制'
  if (item.status >= 400 && item.status < 500)
    return '服务端可达（该状态码是探测路径的响应，不影响业务接口）'
  if (item.status >= 500)
    return '服务端异常，非本机网络问题'
  return ''
}

/** 复制诊断结果：随应用版本一起输出，方便用户直接粘贴反馈 */
async function handleCopyDiagnose() {
  const lines = diagnoseResults.value.map((item) => {
    const verdict = diagnoseVerdict(item)
    const status = item.status === null ? '无响应' : `HTTP ${item.status}`
    const note = diagnoseNote(item)
    // detail 可能是 4xx/5xx 的响应体摘要，也可能是多来源目标的主备说明，不额外加前缀
    return `${item.label}（${item.url}）: ${status} · ${item.ms}ms · ${verdict.label}${note ? ` · ${note}` : ''}${item.error ? ` · ${item.error}` : ''}${item.detail ? ` · ${item.detail}` : ''}`
  })
  const text = [
    `应用版本: ${version.value}`,
    `诊断时间: ${new Date().toLocaleString()}`,
    ...lines,
  ].join('\n')
  await navigator.clipboard.writeText(text)
  ElMessage({ message: '诊断结果已复制，可粘贴发给开发者', type: 'success' })
}

// ===== 问题反馈 =====
// 报文的采集与发送都在主进程（main/feedback.ts）：渲染层只提交用户输入，
// 环境摘要由主进程补齐，上报地址也不经过这里。

/** 环境摘要与上报通道可用性；端点未配置时 endpointReady=false，提交按钮禁用 */
const feedbackState = ref<Awaited<ReturnType<typeof window.mainAPI.feedbackMeta>> | null>(null)
/** 反馈弹窗：卡片只放入口，输入区在弹窗内，避免设置页被一块长表单撑开 */
const feedbackDialogVisible = ref(false)
const feedbackContent = ref('')
const feedbackContact = ref('')
const feedbackSubmitting = ref(false)

const feedbackReady = computed(() => feedbackState.value?.endpointReady ?? false)
/** 剩余可写字数：负数不展示（超长由主进程校验兜底并回报具体原因） */
const feedbackRemaining = computed(() => FEEDBACK_CONTENT_MAX - feedbackContent.value.length)

/** 反馈回复页：反馈提交后的答复都在这里公开可查，不需要登录 */
const FEEDBACK_REPLY_URL = 'https://48.v2ing.com/feedback'

/**
 * 打开回复页。
 *
 * 经 `window.open` 触发主进程的 `setWindowOpenHandler`，转交系统浏览器
 * （与 openReleasePage 同一路径；主进程只放行 http/https）。
 */
function openFeedbackReplies() {
  window.open(FEEDBACK_REPLY_URL, '_blank', 'noopener')
}

async function loadFeedbackMeta() {
  try {
    feedbackState.value = await window.mainAPI.feedbackMeta()
  }
  catch (error) {
    console.error('[feedback] 环境摘要读取失败:', error)
  }
}

async function handleSubmitFeedback() {
  if (!feedbackContent.value.trim()) {
    ElMessage.warning('请先填写问题描述')
    return
  }
  feedbackSubmitting.value = true
  try {
    await window.mainAPI.submitFeedback({
      content: feedbackContent.value,
      contact: feedbackContact.value,
    })
    ElMessage({ message: '反馈已提交，感谢你的反馈', type: 'success' })
    feedbackContent.value = ''
    feedbackContact.value = ''
    feedbackDialogVisible.value = false
  }
  catch (error) {
    // 主进程的报错已按用户可读口径组织（校验失败 / 超时 / HTTP 状态码）
    ElMessage.error(error instanceof Error ? error.message : '提交失败，请稍后重试')
  }
  finally {
    feedbackSubmitting.value = false
  }
}

/** 页面挂载时由父页调用：反馈入口的可用性依赖主进程的环境摘要 */
defineExpose({ loadFeedbackMeta })
</script>

<template>
  <h2 class="setting-group-label" data-setting-group="app">
    应用
  </h2>
  <section id="setting-update" class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-albums)' }"
      >
        <el-icon><Refresh /></el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          版本
          <span v-if="version" class="row-version">v{{ version }}</span>
          <span v-if="availableUpdate" class="row-update-badge">有新版本</span>
        </div>
        <div class="row-desc" :class="updaterDescClass">
          {{ updaterDesc }}
        </div>
      </div>
      <div class="row-actions">
        <el-button
          v-if="state.phase === 'available' || state.phase === 'ready'"
          :disabled="checking"
          @click="check"
        >
          重新检查
        </el-button>
        <el-button
          type="primary"
          :disabled="updaterAction.disabled"
          :loading="updaterAction.loading"
          @click="updaterAction.handler"
        >
          {{ updaterAction.label }}
        </el-button>
      </div>
    </div>

    <div v-if="availableUpdate || downloadingUpdate" class="row-body update-notice">
      <template v-if="availableUpdate">
        <div class="update-notice-head">
          <el-icon class="update-notice-icon">
            <Top />
          </el-icon>
          <span class="update-notice-title">{{ availableTitle }}</span>
          <span class="update-notice-versions">{{ updateVersionLine }}</span>
        </div>
        <ul v-if="releaseNotesPreview.lines.length" class="update-notes">
          <li
            v-for="(line, index) in releaseNotesPreview.lines"
            :key="index"
          >
            {{ line }}
          </li>
        </ul>
        <p v-if="releaseNotesPreview.truncated" class="update-notes-more">
          更多更新内容详见官网
        </p>
        <p class="update-notice-hint">
          {{ manualUpdateNotice
            ? 'macOS 暂不支持应用内更新，请点击「去下载」打开下载页，下载后手动安装。'
            : '点击「更新版本」开始下载，下载完成后重启应用即可完成升级。' }}
        </p>
      </template>
      <template v-else-if="downloadingUpdate">
        <div class="update-notice-head">
          <el-icon class="update-notice-icon">
            <Download />
          </el-icon>
          <span class="update-notice-title">{{ downloadingTitle }}</span>
          <span class="update-notice-versions">{{ updaterPercent.toFixed(0) }}%</span>
        </div>
        <el-progress
          class="update-progress"
          :percentage="updaterPercent"
          :stroke-width="8"
          :show-text="false"
        />
        <p class="update-notice-hint">
          {{ downloadSizeText }}，下载完成后需重启应用以完成更新。
        </p>
      </template>
    </div>
  </section>

  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-shows)' }"
      >
        <el-icon><Connection /></el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          网络诊断
        </div>
        <div class="row-desc">
          检测核心服务域名与口袋客户端身份的连通情况；接口报错（如 HTTP 403）时可能影响使用
        </div>
      </div>
      <div class="row-actions">
        <el-button
          v-if="diagnoseResults.length"
          :disabled="diagnosing"
          @click="diagnoseDialogVisible = true"
        >
          查看结果
        </el-button>
        <el-button
          type="primary"
          :loading="diagnosing"
          @click="handleDiagnose"
        >
          开始诊断
        </el-button>
      </div>
    </div>
  </section>

  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile"
        :style="{ '--tile-color': 'var(--color-setting)' }"
      >
        <el-icon><ChatDotRound /></el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          问题反馈
        </div>
        <div class="row-desc">
          描述使用中遇到的问题，提交时会附带版本与运行环境；不收集账号凭据、手机号与聊天内容
        </div>
      </div>
      <div class="row-actions">
        <el-button
          type="primary"
          @click="feedbackDialogVisible = true"
        >
          反馈一下
        </el-button>
      </div>
    </div>
  </section>

  <el-dialog
    v-model="feedbackDialogVisible"
    title="问题反馈"
    width="min(680px, calc(100vw - 32px))"
    align-center
    class="setting-dialog"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="!feedbackSubmitting"
  >
    <template #header>
      <div class="dialog-head">
        <span class="dialog-head-icon icon-tile" :style="{ '--tile-color': 'var(--color-setting)' }">
          <el-icon :size="18"><ChatDotRound /></el-icon>
        </span>
        <span class="dialog-head-title">问题反馈</span>
      </div>
    </template>
    <div class="feedback-form">
      <p class="feedback-intro">
        提交时会附带应用版本、运行平台，便于定位问题。请勿填写账号密码或他人隐私信息。
      </p>
      <div class="feedback-content-field">
        <el-input
          v-model="feedbackContent"
          type="textarea"
          :rows="8"
          :maxlength="FEEDBACK_CONTENT_MAX"
          resize="none"
          placeholder="说点什么吧，比心~"
        />
        <div class="feedback-hint">
          还可输入 {{ feedbackRemaining }} 字
        </div>
      </div>
      <el-input
        v-model="feedbackContact"
        :maxlength="FEEDBACK_CONTACT_MAX"
        placeholder="联系方式（可选）"
      />
      <p v-if="!feedbackReady" class="feedback-warn">
        上报服务尚未配置，暂无法提交；请通过其它渠道联系开发者。
      </p>
    </div>
    <template #footer>
      <div class="feedback-dialog-footer">
        <el-button @click="openFeedbackReplies">
          查看回复
        </el-button>
        <div class="feedback-dialog-actions">
          <el-button
            :disabled="feedbackSubmitting"
            @click="feedbackDialogVisible = false"
          >
            取消
          </el-button>
          <el-button
            type="primary"
            :disabled="!feedbackReady"
            :loading="feedbackSubmitting"
            @click="handleSubmitFeedback"
          >
            提交
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <el-dialog
    v-model="diagnoseDialogVisible"
    title="网络诊断结果"
    width="min(820px, calc(100vw - 32px))"
    align-center
    class="setting-dialog"
    append-to-body
  >
    <template #header>
      <div class="dialog-head">
        <span class="dialog-head-icon icon-tile" :style="{ '--tile-color': 'var(--color-shows)' }">
          <el-icon :size="18"><Connection /></el-icon>
        </span>
        <span class="dialog-head-title">网络诊断结果</span>
      </div>
    </template>
    <div v-if="diagnosing" class="verify-loading">
      <span class="verify-spinner" />
      <span>正在检测核心服务域名与口袋客户端身份…</span>
    </div>
    <template v-else-if="diagnoseResults.length">
      <p class="diagnose-summary">
        共检测 {{ diagnoseResults.length }} 个目标。结果仅供参考：HTTP 403 表示服务端可达但拒绝访问，需结合各身份行区分地区策略与客户端限制。
      </p>
      <div class="diagnose-grid">
        <div
          v-for="item in diagnoseResults"
          :key="`${item.label}|${item.url}`"
          class="diagnose-item"
        >
          <div class="diagnose-head">
            <span class="diagnose-label">{{ item.label }}</span>
            <el-tag
              size="small"
              :type="diagnoseVerdict(item).type"
            >
              {{ diagnoseVerdict(item).label }}
            </el-tag>
          </div>
          <div class="diagnose-detail">
            {{ item.status === null ? '无响应' : `HTTP ${item.status}` }} · {{ item.ms }}ms
            <span
              v-if="diagnoseNote(item)"
              class="diagnose-note"
            >{{ diagnoseNote(item) }}</span>
            <span
              v-if="item.detail"
              class="diagnose-note diagnose-note--body"
            >{{ item.detail }}</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty-hint">
      诊断未返回结果，请点击「重新诊断」重试
    </div>
    <template #footer>
      <div class="diagnose-dialog-footer">
        <el-button
          :disabled="!diagnoseResults.length || diagnosing"
          @click="handleCopyDiagnose"
        >
          复制结果
        </el-button>
        <div class="diagnose-dialog-actions">
          <el-button
            :disabled="diagnosing"
            @click="handleDiagnose"
          >
            重新诊断
          </el-button>
          <el-button
            type="primary"
            @click="diagnoseDialogVisible = false"
          >
            关闭
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.diagnose-summary {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.diagnose-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.diagnose-dialog-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 诊断结果网格：两列，单格 = 名称 + 徽标 / 状态摘要 + 说明；窄窗自动降为单列 */
.diagnose-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px 14px;
}

.diagnose-item {
  padding: 8px 12px;
  border: 1px dashed var(--el-border-color-lighter);
  border-radius: var(--radius-md);
}

.diagnose-item .diagnose-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.diagnose-item .diagnose-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.diagnose-item .diagnose-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.diagnose-item .diagnose-note {
  display: block;
}

/* 4xx/5xx 响应体摘要：比说明再低一档颜色，长串允许任意折行 */
.diagnose-item .diagnose-note--body {
  margin-top: 2px;
  color: var(--el-text-color-placeholder);
  word-break: break-all;
}

/* 弹窗头部：图标磁贴 + 标题（骨架同设置卡片的 row-icon，尺寸缩小以适配弹窗头；两个弹窗共用） */
.dialog-head {
  display: flex;
  gap: 10px;
  align-items: center;
  /* 留出右上角关闭按钮的位置，长标题不会被压住 */
  padding-right: 24px;
}

.dialog-head-icon {
  width: 30px;
  height: 30px;
}

.dialog-head-title {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

/* 问题反馈弹窗：说明、输入区、字数提示与页脚 */
.feedback-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 正文输入框：字数提示提到右下角，文本框底部留出内边距以免遮住末行文字 */
.feedback-content-field {
  position: relative;
}

.feedback-content-field :deep(.el-textarea__inner) {
  padding-bottom: 28px;
}

.feedback-intro {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.feedback-hint {
  /* 绝对定位到文本框右下角：不占布局，文字浮在输入区留白处 */
  position: absolute;
  right: 10px;
  bottom: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  /* 不拦截点击：浮层下方的区域仍可直接聚焦输入框 */
  pointer-events: none;
}

.feedback-warn {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-color-warning);
}

/* 页脚：查看回复靠左，取消与提交靠右 */
.feedback-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.feedback-dialog-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 新版本提示块：available 态展开版本对比与更新说明，downloading 态接棒显示进度 */
.update-notice {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--el-color-warning) 8%, transparent);
}

.update-notice-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.update-notice-icon {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--el-color-warning);
}

.update-notice-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.update-notice-versions {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* 更新说明：剥掉 markdown 标记后的纯文本行，告警色小圆点列表 */
.update-notes {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    padding-left: 12px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-regular);
    word-break: break-word;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0.72em;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--el-color-warning);
    }
  }
}

.update-notes-more {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.update-notice-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.update-progress {
  margin-top: 10px;
}
</style>
