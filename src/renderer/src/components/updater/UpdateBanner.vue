<script setup lang="ts">
/**
 * 顶部更新横幅：只在主进程算出 notice 时出现（一版一次）。
 * 常驻状态在设置页版本行，这里只在需要用户动手时出现。
 */
import { Download } from '@element-plus/icons-vue'
import { useUpdater } from '@renderer/stores/use-updater'
import { trackEvent } from '@renderer/utils/umami'

const { state, banner, install, dismiss } = useUpdater()

function onPrimary(): void {
  if (!banner.value)
    return
  if (banner.value.kind === 'install') {
    install()
    return
  }
  trackEvent('update:open_page', { at: 'banner', version: state.value.notice?.version ?? '' })
  window.open(banner.value.url ?? '', '_blank', 'noopener')
}

function onDismiss(): void {
  void dismiss()
}
</script>

<template>
  <Transition name="update-banner">
    <div v-if="banner" class="update-banner">
      <el-icon class="update-banner-icon">
        <Download />
      </el-icon>
      <p class="update-banner-text">
        <span class="update-banner-title">{{ banner.title }}</span>
        <span class="update-banner-desc">{{ banner.description }}</span>
      </p>
      <div class="update-banner-actions">
        <el-button type="primary" size="small" @click="onPrimary">
          {{ banner.primaryLabel }}
        </el-button>
        <el-button text size="small" @click="onDismiss">
          稍后
        </el-button>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
/* 夹在标题栏与内容区之间的一条窄带：压的是内容高度，不遮挡任何东西 */
.update-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px 0 16px;
  background:
    radial-gradient(420px 60px at 6% -60%, rgba(var(--brand-rgb), 0.16), transparent 70%),
    linear-gradient(90deg, rgba(var(--brand-rgb), 0.1), rgba(var(--brand-rgb), 0.03));
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-shadow: 0 1px 2px rgba(var(--shadow-rgb), 0.04);
  overflow: hidden;
}

.update-banner-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--brand-primary);
}

.update-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
}

.update-banner-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.update-banner-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-banner-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 出现/消失都改 max-height：横幅在 flex 列里，直接切换 display 会让内容区跳一下 */
.update-banner-enter-active,
.update-banner-leave-active {
  transition:
    max-height 0.22s ease,
    opacity 0.18s ease,
    transform 0.18s ease;
  max-height: 40px;
}

.update-banner-enter-from,
.update-banner-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-6px);
}
</style>
