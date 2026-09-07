<script setup lang="ts">
import { VideoCameraFilled } from '@element-plus/icons-vue'
import { computed } from 'vue'
import Tools from '../../utils/tools'

interface Member {
  teamName: string
  teamColor: string
}

interface UserInfo {
  nickname: string
}

interface Item {
  title?: string
  liveMode?: number
  liveType?: number
  cover: string[]
  date: string
  userInfo: UserInfo
  member: Member | null
}

const props = defineProps<{ item: Item }>()

// 直播类型角标：直播 / 录屏 / 电台
const liveBadge = computed(() => {
  if (props.item.liveType === 1) {
    return props.item.liveMode === 1
      ? { text: '录屏', type: 'review' }
      : { text: '直播', type: 'live' }
  }
  return { text: '电台', type: 'radio' }
})
</script>

<template>
  <div class="live-card lift-card clickable">
    <div class="cover-container">
      <el-image class="cover" :src="item.cover?.[0]" fit="cover" lazy>
        <template #placeholder>
          <div class="cover-ph" />
        </template>
        <template #error>
          <div class="cover-ph">
            <el-icon :size="28">
              <VideoCameraFilled />
            </el-icon>
          </div>
        </template>
      </el-image>
      <span class="live-badge" :class="`live-badge--${liveBadge.type}`">{{ liveBadge.text }}</span>
    </div>

    <div class="card-body">
      <p class="live-title ellipsis" :title="item.title">
        {{ item.title }}
      </p>
      <div class="member-info">
        <span class="nickname ellipsis">{{ item.userInfo.nickname }}</span>
        <span
          v-if="item.member?.teamName"
          class="team-badge"
          :style="item.member.teamColor ? { '--tb-color': `#${item.member.teamColor}` } : undefined"
        >
          {{ Tools.shortTeamName(item.member.teamName) }}
        </span>
      </div>
      <p class="live-date">
        {{ item.date }}
      </p>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 卡片皮肤（实底白卡 + hover 上浮）见全局 .lift-card */
.live-card {
  position: relative;
  margin: 0;
  cursor: pointer;

  &:hover {
    .cover {
      transform: scale(1.05);
    }

    .live-title {
      color: var(--el-color-primary);
    }
  }

  .cover-container {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;

    .cover {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transition: transform 0.3s ease;
    }
  }

  .cover-ph {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--el-fill-color-light);
    color: var(--el-text-color-placeholder);
  }

  .live-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 18px;
    letter-spacing: 1px;
    color: #fff;

    &.live-badge--live {
      background: var(--el-color-danger);
    }

    &.live-badge--review {
      background: var(--el-color-success);
    }

    &.live-badge--radio {
      background: var(--el-color-warning);
    }
  }

  .card-body {
    padding: 10px 12px 12px;
    min-width: 0;
  }

  .live-title {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
    color: var(--el-text-color-primary);
    transition: color 0.25s ease;
  }

  .member-info {
    margin-top: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;

    .nickname {
      min-width: 0;
      font-size: 12px;
      color: var(--el-text-color-regular);
    }
  }

  .live-date {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }
}
</style>
