<script setup lang="ts">
// 统一底部 Dock 导航：磨砂表层复用全局 .frosted-surface
export interface DockItem {
  /** 路由 path（Constants.Menu 值，如 '/lives'），同时作为激活态匹配标识；点击后原样 push */
  index: string
  label: string
  /** Element Plus 图标组件 */
  icon: any
  /** 主题色：悬浮/激活时图标渐变与光晕的颜色，缺省用品牌紫 */
  color?: string
  /** 角标数字：>0 时显示，超过 99 显示 99+ */
  badge?: number
}

defineProps<{
  items: DockItem[]
  active: string
}>()

const emit = defineEmits<{ change: [index: string] }>()

function change(index: string) {
  emit('change', index)
}
</script>

<template>
  <nav class="app-dock frosted-surface">
    <el-tooltip
      v-for="item in items"
      :key="item.index"
      :content="item.label"
      placement="top"
      :show-after="400"
      :offset="10"
    >
      <button
        type="button"
        class="dock-item"
        :class="{ 'is-active': active === item.index }"
        :style="{ '--item-color': item.color || 'var(--brand-primary)' }"
        @click="change(item.index)"
      >
        <span class="dock-icon">
          <el-icon><component :is="item.icon" /></el-icon>
          <!-- 角标：正在进行的任务数量，最多 2 位 -->
          <span
            v-if="item.badge"
            class="dock-badge"
          >{{ item.badge > 99 ? '99+' : item.badge }}</span>
        </span>
        <span class="dock-label">{{ item.label }}</span>
      </button>
    </el-tooltip>
  </nav>
</template>

<style scoped lang="scss">
/* 底部 Dock：玻璃基底由全局 .frosted-surface 提供，
 * 此处叠加渐变描边、深玻璃质感与逐项主题色 */
.app-dock {
  position: fixed;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 24px;
  user-select: none;
  /* 深玻璃：更透、更模糊，泛出品牌色氛围光 */
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.08) 55%),
    color-mix(in srgb, var(--el-bg-color) 58%, transparent);
  backdrop-filter: blur(28px) saturate(170%);
  /* 去掉 .frosted-surface 的 1px 边框，避免与 ::before 渐变描边形成双线 */
  border: none;
  box-shadow:
    var(--shadow-lg),
    0 18px 44px -14px rgba(109, 90, 224, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);

  /* 渐变描边：上亮下紫，替代纯色边框 */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(
      160deg,
      rgba(255, 255, 255, 0.95),
      rgba(255, 255, 255, 0.25) 38%,
      rgba(109, 90, 224, 0.35)
    );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }
}

.dock-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 64px;
  padding: 8px 0 11px;
  border: none;
  border-radius: 16px;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  /* 弹性回弹曲线，悬浮/按下更灵动 */
  transition:
    transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 0.2s ease,
    box-shadow 0.2s ease;
  animation: dock-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;

  /* 入场依次弹出的小动效 */
  @for $i from 1 through 6 {
    &:nth-child(#{$i}) {
      animation-delay: $i * 0.04s;
    }
  }

  /* 图标块：白色玻璃小磁贴，像一枚迷你 App 图标 */
  .dock-icon {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.55));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.9),
      0 2px 6px -2px rgba(var(--shadow-rgb), 0.14);
    color: var(--el-text-color-regular);
    transition:
      transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
      background 0.2s ease,
      color 0.2s ease,
      box-shadow 0.2s ease;

    .el-icon {
      font-size: 21px;
    }

    /* 角标：磁贴右上角的任务数胶囊，用该项主题色点亮 */
    .dock-badge {
      position: absolute;
      top: -5px;
      right: -7px;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-pill);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      color: #fff;
      background: linear-gradient(135deg, color-mix(in srgb, var(--item-color) 80%, #000), var(--item-color));
      box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.85),
        0 3px 8px -2px color-mix(in srgb, var(--item-color) 70%, transparent);
      animation: badge-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
  }

  .dock-label {
    font-size: 11px;
    line-height: 1.2;
    letter-spacing: 0.3px;
    color: var(--el-text-color-secondary);
    transition: color 0.2s ease;
  }

  &:hover {
    transform: translateY(-6px);

    .dock-icon {
      transform: scale(1.1);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--item-color) 22%, #fff),
        color-mix(in srgb, var(--item-color) 10%, #fff)
      );
      color: var(--item-color);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.6),
        0 10px 22px -8px color-mix(in srgb, var(--item-color) 60%, transparent);
    }

    .dock-label {
      color: var(--item-color);
    }
  }

  &.is-active {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--item-color) 14%, transparent),
      color-mix(in srgb, var(--item-color) 6%, transparent)
    );
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--item-color) 24%, transparent);

    /* 激活图标：主题色渐变磁贴，像点亮的应用图标 */
    .dock-icon {
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--item-color) 78%, #000) 0%,
        var(--item-color) 52%,
        color-mix(in srgb, var(--item-color) 55%, #fff) 100%
      );
      color: #fff;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.4),
        0 8px 18px -6px color-mix(in srgb, var(--item-color) 70%, transparent);
    }

    .dock-label {
      color: var(--item-color);
      font-weight: 600;
    }

    /* 底部呼吸光点 */
    &::after {
      content: '';
      position: absolute;
      left: 50%;
      bottom: 4px;
      width: 4px;
      height: 4px;
      border-radius: var(--radius-pill);
      transform: translateX(-50%);
      background: var(--item-color);
      box-shadow: 0 0 8px 2px color-mix(in srgb, var(--item-color) 60%, transparent);
      animation: dock-dot-pulse 2s ease-in-out infinite;
    }
  }
}

@keyframes dock-pop {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.9);
  }
}

@keyframes badge-pop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
}

@keyframes dock-dot-pulse {
  0%,
  100% {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
  50% {
    opacity: 0.55;
    transform: translateX(-50%) scale(0.8);
  }
}
</style>
