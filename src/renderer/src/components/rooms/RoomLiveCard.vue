<script setup lang="ts">
import { ArrowRight, VideoCamera } from '@element-plus/icons-vue'

/**
 * 直播 / 回放分享卡：竖版封面（3:4）+ 类型角标 + 标题 + 时间与动作提示。
 *
 * 角标与动作文案由「是否在播」决定（直播 / 录屏 / 电台 / 回放），这个判断依赖页面里
 * 的在线状态缓存，所以在页面算好后以 badge 传入；组件只按 type 换样式与文案。
 */
defineProps<{
  /** 封面图；空则显示占位图标 */
  cover: string
  /** liveId 存在才能点开独立播放窗 */
  clickable: boolean
  badge: { text: string, type: 'live' | 'screen' | 'radio' | 'playback' }
  /** hover 说明：直播 / 回放分别打开哪个窗口 */
  hint: string
  title: string
  /** 开播时间文案；空则不展示 */
  startTimeText: string
}>()

const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <button
    type="button"
    class="msg-live"
    :class="{ 'is-clickable': clickable }"
    :disabled="!clickable"
    :title="hint"
    :aria-label="`${badge.text}：${title || '快来看看吧'}`"
    @click="emit('open')"
  >
    <span class="msg-live-cover">
      <el-image
        v-if="cover"
        class="msg-live-cover-img"
        :src="cover"
        fit="cover"
        lazy
      >
        <template #error>
          <span class="msg-live-cover-ph">
            <el-icon :size="22">
              <VideoCamera />
            </el-icon>
          </span>
        </template>
      </el-image>
      <span v-else class="msg-live-cover-ph">
        <el-icon :size="22">
          <VideoCamera />
        </el-icon>
      </span>
      <!-- 封面蒙层与播放入口：强化分享卡的视频语义，同时保持角标在最上层 -->
      <span class="msg-live-cover-mask" aria-hidden="true">
        <span class="msg-live-play">
          <el-icon :size="24">
            <VideoCamera />
          </el-icon>
        </span>
      </span>
      <span
        class="msg-live-badge"
        :class="`msg-live-badge--${badge.type}`"
      >{{ badge.text }}</span>
    </span>
    <span class="msg-live-text">
      <span class="msg-live-title">{{ title || '快来看看吧' }}</span>
      <span class="msg-live-meta">
        <span v-if="startTimeText">{{ startTimeText }}</span>
        <span v-if="clickable" class="msg-live-action">
          {{ badge.type === 'playback' ? '观看回放' : '进入直播' }}
          <el-icon :size="12">
            <ArrowRight />
          </el-icon>
        </span>
      </span>
    </span>
  </button>
</template>

<style scoped lang="scss">
.msg-live {
  display: flex;
  flex-direction: column;
  width: 272px;
  min-width: 0;
  padding: 0;
  border: none;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  /* 与气泡内壁同心：外角取同心内角，收角一侧与气泡收角对齐 */
  border-radius: var(--radius-xs) var(--msg-radius-inner) var(--msg-radius-inner) var(--msg-radius-inner);

  &.is-clickable {
    cursor: pointer;

    &:hover {
      .msg-live-cover-img {
        transform: scale(1.04);
      }

      .msg-live-action {
        color: var(--color-lives);
      }

      .msg-live-play {
        transform: translateY(-1px) scale(1.08);
        background: color-mix(in srgb, var(--color-lives) 82%, #000);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--color-lives) 42%, transparent);
      }
    }
  }
}

.msg-live-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  /* 与卡片同角（卡片 padding 为 0，内角不再递减），左上咬合气泡收角 */
  border-radius: var(--radius-xs) var(--msg-radius-inner) var(--msg-radius-inner) var(--msg-radius-inner);
  background: var(--el-fill-color);
}

.msg-live-cover-img {
  display: block;
  width: 100%;
  height: 100%;
  transition: transform 0.3s ease;
}

/* 直播封面蒙层：底部稍深，保证中央播放入口与页面底色之间总有足够对比 */
.msg-live-cover-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, 18%), rgba(0, 0, 0, 46%));
}

.msg-live-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border: 1px solid rgba(255, 255, 255, 50%);
  border-radius: 50%;
  color: #fff;
  background: rgba(0, 0, 0, 42%);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 28%);
  backdrop-filter: blur(8px);
  transition:
    transform 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

/* 封面兜底：解析不到封面或加载失败时回退类型图标（直播色渐变块，与 LiveItem error 槽同思路） */
.msg-live-cover-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-lives) 70%, #fff), var(--color-lives));
}

/* 类型角标叠封面左上角（LiveItem 同位）；配色对齐 LiveItem（直播玫红 / 电台绿 / 录屏琥珀），回放中性灰 */
.msg-live-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  padding: 1px 7px;
  border-radius: var(--msg-radius-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
  color: #fff;

  &.msg-live-badge--live {
    background: var(--color-lives);
  }

  &.msg-live-badge--radio {
    background: var(--color-downloads);
  }

  &.msg-live-badge--screen {
    background: var(--color-shows);
  }

  &.msg-live-badge--playback {
    background: var(--el-color-info);
  }
}

.msg-live-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 10px 6px 5px;
}

.msg-live-title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  color: var(--el-text-color-primary);
}

.msg-live-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}

/* 动作提示：可点时才渲染，文案按回放/直播区分（观看回放 / 进入直播） */
.msg-live-action {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  color: var(--el-text-color-secondary);
  transition: color 0.18s ease;
}
</style>
