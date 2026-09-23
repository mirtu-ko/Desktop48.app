<script setup lang="ts">
import { StarFilled, VideoCameraFilled } from '@element-plus/icons-vue'
import Tools from '@renderer/utils/tools'
import { computed } from 'vue'

interface Member {
  teamName: string
  teamColor: string
}

interface UserInfo {
  /** 口袋 userId（列表接口给字符串）：点成员名开详情抽屉时按它反查 */
  userId: string
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

const props = defineProps<{
  item: Item
  /** 刷新版本号：变化时给封面 URL 追加 cache-busting 参数，强制失败图重试 */
  imageVersion?: number | string
  /** 是否被关注成员的直播：为 true 时整卡金色描边高亮，右上角标「已关注」胶囊 */
  followed?: boolean
}>()

/** 点击成员名：交给列表页打开成员详情抽屉（卡片点击是播放，故模板上 .stop） */
const emit = defineEmits<{ selectMember: [userId: string] }>()

const coverSrc = computed(() => {
  const source = props.item.cover?.[0]
  if (!source || !props.imageVersion)
    return source
  const separator = source.includes('?') ? '&' : '?'
  return `${source}${separator}_r=${encodeURIComponent(String(props.imageVersion))}`
})

// 直播类型角标：直播 / 录屏 / 电台
const liveBadge = computed(() => {
  if (props.item.liveType === 1) {
    return props.item.liveMode === 1
      ? { text: '录屏', type: 'Screen' }
      : { text: '直播', type: 'live' }
  }
  return { text: '电台', type: 'radio' }
})
</script>

<template>
  <div class="live-card lift-card clickable" :class="{ 'live-card--followed': followed }">
    <div class="cover-container">
      <el-image
        :key="coverSrc"
        class="cover"
        :src="coverSrc"
        fit="cover"
        lazy
      >
        <template #placeholder>
          <div class="media-ph" />
        </template>
        <template #error>
          <div class="media-ph">
            <el-icon :size="28">
              <VideoCameraFilled />
            </el-icon>
          </div>
        </template>
      </el-image>
      <span class="live-badge" :class="`live-badge--${liveBadge.type}`">{{ liveBadge.text }}</span>
      <!-- 关注标识：封面右上角「已关注」胶囊角标；卡片同时有金色描边与淡金底染（未关注无此标记） -->
      <span v-if="followed" class="follow-badge" title="已关注成员 · 优先展示">
        <el-icon :size="12"><StarFilled /></el-icon>
        <span>已关注</span>
      </span>
    </div>

    <div class="card-body">
      <p class="live-title ellipsis" :title="item.title">
        {{ item.title }}
      </p>
      <div class="member-info">
        <!-- 成员名可点开详情抽屉；点击不冒泡，否则连带触发卡片播放 -->
        <span
          class="nickname ellipsis"
          :title="`查看 ${item.userInfo.nickname} 的成员详情`"
          @click.stop="emit('selectMember', item.userInfo.userId)"
        >
          {{ item.userInfo.nickname }}
        </span>
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

  /* 关注卡高亮：整卡金色描边 + 轻发光 + 底部淡金底染（比角落单颗星更醒目） */
  &.live-card--followed {
    --fb-color: var(--color-follow);

    border-color: var(--fb-color);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--fb-color) 60%, transparent),
      0 3px 14px -6px color-mix(in srgb, var(--fb-color) 55%, transparent);

    .card-body {
      background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--fb-color) 6%, transparent));
    }

    &:hover {
      box-shadow:
        0 0 0 1px var(--fb-color),
        0 8px 18px -8px color-mix(in srgb, var(--fb-color) 60%, transparent);
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

  .live-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1;
    padding: 2px 8px;
    border-radius: var(--radius-xs);
    font-size: 12px;
    line-height: 18px;
    letter-spacing: 1px;
    color: #fff;

    &.live-badge--live {
      background: var(--color-lives);
    }

    &.live-badge--Screen {
      background: var(--color-shows);
    }

    &.live-badge--radio {
      background: var(--color-downloads);
    }
  }

  /* 关注标识：封面右上角「已关注」胶囊，配合整卡金色描边/底染，扫一眼即可认出关注成员 */
  .follow-badge {
    --fb-color: var(--color-follow);

    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: var(--radius-pill);
    color: #fff;
    font-size: 12px;
    line-height: 1;
    background: var(--fb-color);
    box-shadow: 0 3px 10px -3px color-mix(in srgb, var(--fb-color) 85%, transparent);
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
      /* 负外边距抵消内边距：悬浮片撑开但文字不位移 */
      margin: -2px -6px;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      font-size: 12px;
      color: var(--el-text-color-regular);
      cursor: pointer;
      transition:
        color 0.2s ease,
        background-color 0.2s ease,
        box-shadow 0.2s ease;

      /* 可点开成员详情抽屉：悬浮成品牌紫淡染片（与 tab 悬浮同款），
       * 与标题那套「只变字色」区分开 */
      &:hover {
        color: var(--brand-primary-dark);
        background: rgba(var(--brand-rgb), 0.12);
        box-shadow: 0 0 0 1px rgba(var(--brand-rgb), 0.3);
      }
    }
  }

  .live-date {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }
}
</style>
