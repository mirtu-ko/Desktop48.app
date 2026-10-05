<script setup lang="ts">
import type { ElectionMember } from '@renderer/data/elections'
import { avatarUrl, formatVotes, groupColor, medalColor } from '@renderer/utils/election'
import { computed } from 'vue'

/**
 * 总选名次卡：复用成员卡的头像环与卡片皮肤（card-item / avatar-wrap，见 app.scss）。
 * 御三家在页顶领奖台单独展示，卡片从第四名起渲染；这里只补名次徽章与票数。
 */
const props = defineProps<{
  member: ElectionMember
  /** 网格内序号：驱动入场错峰（--i），封顶 20 */
  index: number
}>()

/** 前三名走奖牌色（名次徽章与头像环），其余走团色 */
const medal = computed(() => medalColor(props.member.rank))

/** 卡片内联变量：--avatar-accent 供头像环取色（前三名是奖牌色，其余是团色），--gc 供团体药丸 */
const cardStyle = computed(() => {
  const style: Record<string, string | number> = { '--i': Math.min(props.index, 20) }
  const color = groupColor(props.member.group)
  if (color)
    style['--gc'] = color
  if (medal.value) {
    style['--medal'] = medal.value
    style['--avatar-accent'] = medal.value
  }
  else if (color) {
    style['--avatar-accent'] = color
  }
  return style
})
</script>

<template>
  <div class="rank-card card-item" :style="cardStyle">
    <div class="avatar-slot">
      <div class="avatar-wrap">
        <span class="avatar-flow" />
        <el-image class="avatar" :src="avatarUrl(member.sid)" fit="cover" lazy>
          <template #error>
            <span class="avatar-fallback">{{ member.name.slice(0, 1) }}</span>
          </template>
        </el-image>

        <span class="rank-badge" :class="{ 'is-medal': !!medal }">{{ member.rank }}</span>
      </div>
    </div>

    <div class="rank-meta">
      <p class="rank-name ellipsis" :title="member.name">
        {{ member.name }}
      </p>
      <p class="rank-sub">
        <span class="group-chip">{{ member.group }}</span>
        <span v-if="member.votes" class="rank-votes">{{ formatVotes(member.votes) }} 票</span>
      </p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.rank-card {
  /* 名次徽章的默认色：前三名由内联 --medal 覆盖成金银铜 */
  --medal: var(--el-text-color-secondary);
  /* 团体色的可读文字版：浅色团色（GNZ48 黄绿、CKG48 琥珀）白字或本色都读不出来，压深一半才达标 */
  --gc-ink: color-mix(in srgb, var(--gc, var(--el-text-color-secondary)) 50%, #000);

  /* backwards 而非 both：both 会让动画收尾值常驻，压掉 hover 的 transform */
  animation: rank-in 0.34s ease backwards;
  animation-delay: calc(var(--i, 0) * 0.022s);
}

.rank-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  width: 100%;
  margin-top: 12px;
  padding: 0 4px;
  text-align: center;

  p {
    margin: 0;
  }
}

.rank-name {
  width: 100%;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.rank-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px 5px;
}

/* 团体药丸：同色淡底 + 压深文字，任意团色都保持可读（不用 .team-badge 的白字实底） */
.group-chip {
  flex: none;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.7;
  color: var(--gc-ink);
  background: color-mix(in srgb, var(--gc, var(--el-text-color-secondary)) 14%, transparent);
}

.rank-votes {
  font-size: 10px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

/* 名次徽章与头像兜底走共享样式（app.scss 的 .rank-badge / .avatar-fallback） */
.avatar-fallback {
  font-size: 30px;
}

@keyframes rank-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rank-card {
    animation: none;
  }
}
</style>
