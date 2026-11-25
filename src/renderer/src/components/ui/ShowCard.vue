<script setup lang="ts">
import type { OpenLive } from '@renderer/services/api-types'
import { isShowLive } from '@renderer/composables/use-show-actions'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import CoverImage from './CoverImage.vue'

defineProps<{
  show: OpenLive
  /** 不可点击原因：叠在封面底部，可点击时传空 */
  hint?: string
}>()

function formatTime(stime: string): string {
  return dayjs(Number.parseInt(stime)).format('MM月DD日 HH:mm')
}
</script>

<template>
  <div class="show-card">
    <div class="show-image">
      <CoverImage :src="show.coverPath" :alt="show.title" class="cover-image">
        <div class="image-placeholder">
          {{ show.title }}
        </div>
      </CoverImage>
      <div v-if="show.teamList?.length" class="team-badges">
        <span
          v-for="team in show.teamList"
          :key="team.teamId"
          class="team-badge"
          :style="Tools.colorVarStyle('--tb-color', team.teamColor)"
        >
          {{ Tools.shortTeamName(team.teamName) }}
        </span>
      </div>
      <el-tag v-if="isShowLive(show)" class="show-tag" type="danger" size="small">
        进行中
      </el-tag>
      <span v-if="hint && !isShowLive(show)" class="show-hint">{{ hint }}</span>
      <span class="show-time">{{ formatTime(show.stime) }}</span>
    </div>
    <div class="show-info">
      <h3 class="ellipsis">
        {{ show.title }}
      </h3>
      <el-text v-if="show.subTitle" size="small" type="info">
        {{ show.subTitle }}
      </el-text>
    </div>
  </div>
</template>

<style scoped>
.show-image {
  position: relative;
  width: 100%;
  padding-top: 48%;
  overflow: hidden;
}

.show-image .cover-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 16px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 15px;
  line-height: 1.4;
  background: linear-gradient(135deg, var(--el-fill-color-light) 0%, var(--el-fill-color) 100%);
  overflow: hidden;
  word-break: break-all;
}

.show-info {
  padding: 5px 10px;
}

.team-badges {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1;
  display: flex;
  gap: 4px;
}

.show-info h3 {
  margin: 10px 0 4px;
  font-size: 16px;
  color: var(--el-text-color-primary);
}

.show-tag {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 1;
}

.show-time {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 1;
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  background: rgba(0, 0, 0, 70%);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  backdrop-filter: blur(4px);
}

/* 不可点击原因：盖在封面下半部分，只在卡片处于禁用态时由父级给出文案 */
.show-hint {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 55%) 55%);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  /* 给角落的时间气泡让位，避免两段文字压在一起 */
  padding: 18px 112px 6px 10px;
  text-align: left;
  pointer-events: none;
}
</style>
