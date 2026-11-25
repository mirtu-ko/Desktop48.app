<script setup lang="ts">
import { useAppConfig } from '@renderer/composables/use-app-config'
import { useFfmpegSetup } from '@renderer/composables/use-ffmpeg-setup'
import { usePocketFollowSync } from '@renderer/composables/use-pocket-follow'
import { ensureFloatTopmost } from '@renderer/stores/float-topmost'
import { useBlockedMembersStore } from '@renderer/stores/member-flags'
import { refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { useUpdater } from '@renderer/stores/use-updater'
import Constants from '@renderer/utils/constants'
import { countBucket, trackEvent } from '@renderer/utils/umami'
import { ElMessage } from 'element-plus'
import { nextTick, onActivated, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SettingAbout from '../components/setting/SettingAbout.vue'
import SettingAccount from '../components/setting/SettingAccount.vue'
import SettingApp from '../components/setting/SettingApp.vue'
import SettingContent from '../components/setting/SettingContent.vue'
import SettingMedia from '../components/setting/SettingMedia.vue'
import { usePocketAccount } from '../composables/use-pocket-account'
import { usePocketCheckIn } from '../composables/use-pocket-checkin'

/**
 * 设置页外壳：左侧分组导航 + 滚动联动，内容按 5 个分组拆成组件。
 *
 * 拆分口径（组件 → 数据来源）：
 * - SettingAccount  账号：use-pocket-account（登录态 / 登录 / 验证）
 * - SettingMedia    播放与文件：use-app-config、use-ffmpeg-setup、stores/float-topmost
 * - SettingContent  内容与可见性：stores/member-flags
 * - SettingApp      应用：use-updater（stores）、网络诊断、问题反馈、use-cache-cleanup（缓存占用）
 * - SettingAbout    关于：data/setting-links 的静态清单
 *
 * 页面只持有「跨分组共享」的东西：分组标题（导航滚动锚点必须由页面自己渲染）、
 * 签到与关注同步（跨账号卡与验证弹窗两个入口），以及挂载时的一次性初始化。
 * 分组标题保留 `data-setting-group`，所以滚动联动逻辑与拆分组件的数量无关。
 */

const router = useRouter()
const route = useRoute()

// ===== 跨分组共享的状态 =====

/** 下载目录（SettingMedia 使用） */
const appConfig = useAppConfig()
/** FFmpeg 环境（SettingMedia 使用；启动门禁 Initialize 用同一判定口径） */
const ffmpeg = useFfmpegSetup()
/** 屏蔽名单（SettingContent 使用） */
const { blockedMembers, refreshBlockedMembers, unblockMember, clearBlockedMembers } = useBlockedMembersStore()
/** 自动更新（SettingApp 使用） */
const updater = useUpdater()
/** 口袋关注同步：启动时静默拉取一次，验证弹窗里也能手动拉 */
const {
  syncing: followSyncing,
  syncPulled: followSyncPulled,
  syncError: followSyncError,
  sync: syncPocketFollow,
  syncIfStale: syncPocketFollowIfStale,
} = usePocketFollowSync()

/** 账号卡与登录弹窗（SettingAccount 使用）；登录成功后顺带同步口袋关注 */
const account = usePocketAccount(() => {
  void syncPocketFollow()
})
/** 签到（SettingAccount 的签到按钮使用） */
const checkIn = usePocketCheckIn()

/**
 * 手动拉取口袋关注：结果用消息提示。失败原因来自 syncError（如未登录 / 网络错误），
 * 与启动时的静默拉取不同——用户主动点了按钮，就应得到明确反馈。
 */
async function handleSyncFollow() {
  const ok = await syncPocketFollow()
  if (ok) {
    ElMessage({ message: `口袋关注已拉取（${followSyncPulled.value} 人）`, type: 'success' })
    return
  }
  ElMessage.error(followSyncError.value || '拉取关注失败，请稍后重试')
}

/** 签到按钮：防连点、奖励文案与错误转写都在 use-pocket-checkin 里，这里只负责弹提示 */
async function handleCheckIn() {
  const { ok, message } = await checkIn.checkIn()
  if (!message)
    return
  if (ok)
    ElMessage.success(message)
  else
    ElMessage.warning(message)
}

/** 屏蔽成员入口在成员页 */
function goMembers() {
  router.push('/members')
}

/**
 * 设置页的两个屏蔽名单出口（解除单个 / 清空）。
 *
 * 与卡片、详情抽屉共用 `member:block` 口径，`from: 'setting'` 标记入口：
 * 设置页是用户主动清理名单的唯一地方，「屏蔽了又清掉」的比例正是判断该功能是否有害的关键，
 * 而这条路径此前完全无数据。count 只报分桶（清空的绝对条数不是产品问题）。失败分支也要记，
 * 否则「点了没反应」会被当成「没人点」。
 */
async function handleUnblock(userId: number) {
  const ok = await unblockMember(userId)
  trackEvent('member:block', { action: 'unblock', from: 'setting', ...(ok ? {} : { result: 'fail' }) })
}

async function handleClearBlocked() {
  const count = blockedMembers.value.length
  await clearBlockedMembers()
  // clear() 不返回成败：以本地名单是否真的清空判定（成功即空，失败保持原样）
  const cleared = count > 0 && blockedMembers.value.length === 0
  trackEvent('member:block', {
    action: 'unblock_all',
    from: 'setting',
    count: countBucket(count),
    ...(cleared ? {} : { result: 'fail' }),
  })
}

/** SettingApp 的反馈入口依赖主进程环境摘要，挂载时拉一次 */
const appRef = ref<InstanceType<typeof SettingApp> | null>(null)

const settingScrollRef = ref<any>(null)
const settingRootRef = ref<HTMLElement | null>(null)

onMounted(async () => {
  await appConfig.loadAppConfig()
  await ensureFloatTopmost()
  // FFmpeg 就绪状态每次都重新判定：目录可能在应用之外被删除或移动
  await ffmpeg.refresh()
  await refreshBlockedMembers()
  await refreshPocketAuthState()
  // 已登录则静默拉取一次口袋关注（friends/id 一次性返回，无分页成本）
  syncPocketFollowIfStale(5 * 60 * 1000)
  await appRef.value?.loadFeedbackMeta()
  consumeUpdateFocus()
})

// ===== 左侧分组导航 =====

/**
 * 分组定义：id 对应内容区各组件的 `[data-setting-group]`，
 * label 需与组标题文案保持一致（标题由各组件渲染，这里只做导航）。
 */
const settingGroups = [
  { id: 'account', label: '账号' },
  { id: 'media', label: '播放与文件' },
  { id: 'content', label: '内容与可见性' },
  { id: 'app', label: '应用' },
  { id: 'about', label: '关于' },
]

const activeGroup = ref(settingGroups[0].id)

/** 平滑滚动期间锁住高亮，避免途经分组被依次点亮；用户中途打断由超时兜底解锁 */
let navTargetId: string | null = null
let navTargetTop = 0
let navLockUntil = 0

function groupElements(): HTMLElement[] {
  return Array.from(settingRootRef.value?.querySelectorAll<HTMLElement>('[data-setting-group]') ?? [])
}

/** 组标题相对滚动视口顶部的位置；不用 offsetTop，避免 offsetParent 差异 */
function groupTop(el: HTMLElement, wrap: HTMLElement): number {
  return el.getBoundingClientRect().top - wrap.getBoundingClientRect().top
}

function syncActiveGroup(wrap: HTMLElement) {
  if (navTargetId) {
    const arrived = Math.abs(wrap.scrollTop - navTargetTop) < 4
    if (arrived || Date.now() > navLockUntil)
      navTargetId = null
    else
      return
  }

  const items = groupElements()
  if (!items.length)
    return

  let current = items[0].dataset.settingGroup ?? settingGroups[0].id
  for (const el of items) {
    if (groupTop(el, wrap) > 40)
      break
    current = el.dataset.settingGroup ?? current
  }

  // 末尾分组内容较矮时永远到不了判定线，滚到底即视为最后一组；
  // 内容不足一屏时不做此判定，否则首屏就会被误标成「关于」
  const scrollable = wrap.scrollHeight - wrap.clientHeight > 40
  if (scrollable && wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4)
    current = items[items.length - 1].dataset.settingGroup ?? current

  activeGroup.value = current
}

function onSettingScroll() {
  const wrap = settingScrollRef.value?.wrapRef as HTMLElement | undefined
  if (wrap)
    syncActiveGroup(wrap)
}

/** 滚到指定元素并同步左侧导航高亮；平滑滚动期间用 navTargetId 锁住途经分组 */
function scrollToElement(target: HTMLElement, group: string) {
  const wrap = settingScrollRef.value?.wrapRef as HTMLElement | undefined
  if (!wrap)
    return

  navTargetTop = Math.max(0, wrap.scrollTop + groupTop(target, wrap) - 12)
  navTargetId = group
  navLockUntil = Date.now() + 1200
  activeGroup.value = group
  wrap.scrollTo({ top: navTargetTop, behavior: 'smooth' })
}

function scrollToGroup(id: string) {
  const target = settingRootRef.value?.querySelector<HTMLElement>(`[data-setting-group="${id}"]`)
  if (target)
    scrollToElement(target, id)
}

/**
 * 首页新版本 toast 的「去更新」会带 ?focus=update 进来：定位到「应用 → 版本」行，
 * 并立刻把参数从地址栏清掉，避免之后每次切回设置页都被重新滚到版本行。
 * 设置页首次挂载走 onMounted，已被 KeepAlive 缓存时走 onActivated。
 */
function consumeUpdateFocus() {
  if (route.query.focus !== 'update')
    return
  void router.replace({ path: Constants.Menu.SETTING })
  void nextTick(() => {
    const target = settingRootRef.value?.querySelector<HTMLElement>('#setting-update')
    if (target)
      scrollToElement(target, 'app')
  })
}

onActivated(consumeUpdateFocus)
</script>

<template>
  <el-scrollbar
    ref="settingScrollRef"
    class="scrollbar-wrapper"
    wrap-class="scrollbar-wrapper"
    @scroll="onSettingScroll"
  >
    <div
      ref="settingRootRef"
      class="setting-root"
    >
      <nav class="setting-nav" aria-label="设置分组导航">
        <span class="setting-nav-title">设置</span>
        <button
          v-for="group in settingGroups"
          :key="group.id"
          type="button"
          class="setting-nav-item"
          :class="{ 'is-active': activeGroup === group.id }"
          :aria-current="activeGroup === group.id ? 'location' : undefined"
          @click="scrollToGroup(group.id)"
        >
          {{ group.label }}
        </button>
      </nav>
      <div class="setting-content">
        <SettingAccount
          :account="account"
          :checking-in="checkIn.checkingIn.value"
          :follow-syncing="followSyncing"
          @check-in="handleCheckIn"
          @sync-follow="handleSyncFollow"
        />
        <SettingMedia :app-config="appConfig" :ffmpeg="ffmpeg" />
        <SettingContent
          :blocked-members="blockedMembers"
          @unblock="handleUnblock"
          @clear-all="handleClearBlocked"
          @go-members="goMembers"
        />
        <SettingApp ref="appRef" :updater="updater" />
        <SettingAbout />
      </div>
    </div>
  </el-scrollbar>
</template>

<style lang="scss">
/* 非 scoped：分组组件里的 .setting-row / .row-* 必须能被全局命中。
   规则本身包在 .setting-root 下，只对设置页生效。 */
@use '../components/setting/setting-shared';
</style>

<style scoped lang="scss">
@use '../assets/css/fluid' as *;

/* 页面外壳：导航 + 内容容器；分组卡片的样式分别在各分组组件里 */
.setting-root {
  /* 左 152px 导航 + 24px 间距 + 右侧内容，内容区仍以约 880px 为上限 */
  max-width: 1120px;
  margin: 0 auto;
  /* 底部留出悬浮 Dock 的高度（--dock-reserve），避免最后一张卡片被遮挡 */
  padding: fluid(14px, 20px) 24px var(--dock-reserve);
  display: flex;
  align-items: flex-start;
  gap: fluid(18px, 24px);
}

.setting-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: fluid(10px, 14px);
  min-width: 0;
}

/* 左侧分组导航：粘性停靠在滚动容器顶部；激活态竖条与内容区组标签同语言 */
.setting-nav {
  position: sticky;
  top: fluid(14px, 20px);
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 152px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--el-border-color) 55%, #ffffff);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--el-bg-color) 78%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  box-shadow: var(--shadow-sm);
}

.setting-nav-title {
  padding: 2px 10px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--el-text-color-secondary);
}

.setting-nav-item {
  position: relative;
  width: 100%;
  padding: fluid(8px, 9px) 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-regular);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    color 0.18s ease,
    background 0.18s ease;

  &:hover {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
  }

  &.is-active {
    color: var(--brand-primary);
    font-weight: 600;
    background: color-mix(in srgb, var(--brand-primary) 12%, transparent);

    &::before {
      content: '';
      position: absolute;
      top: 9px;
      bottom: 9px;
      left: 2px;
      width: 3px;
      border-radius: 2px;
      background: linear-gradient(180deg, var(--brand-primary-light), var(--brand-primary));
    }
  }
}

/* 窄窗收回单列，避免导航把卡片挤得过窄 */
@media (max-width: 1000px) {
  .setting-root {
    max-width: 880px;
  }

  .setting-nav {
    display: none;
  }
}
</style>
