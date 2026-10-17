<script setup lang="ts">
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { Close, StarFilled } from '@element-plus/icons-vue'
// 房间精华消息弹层：房间置顶消息的完整列表（msgTime 倒序，父级 use-pocket-rooms 持有数据与翻页）。
// 外壳 / 标题头 / 滚动列 / 关闭钮复用 app.scss 的「详情卡片共用」（单栏列表）；
// 图片全屏预览与下载走 PreviewImage，与消息流同一套工具条。本组件只做展示与「加载更早」的上抛。
import PreviewImage from '@renderer/components/ui/PreviewImage.vue'
import { isPlaceholderText } from '@renderer/utils/pocket-room-message'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed } from 'vue'

const props = defineProps<{
  modelValue: boolean
  messages: PocketRoomMessageView[]
  loading: boolean
  /** 翻页到底：true 时底部按钮换成「没有更多了」 */
  exhausted: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'loadMore': []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 头像 URL：口袋扩展给的是相对/完整路径混杂，统一过 sourceUrl */
function avatarUrl(avatar: string) {
  return avatar ? Tools.sourceUrl(avatar) : ''
}

/** 条目时刻（MM-DD HH:mm） */
function shortTime(msgTime: number) {
  return msgTime ? dayjs(msgTime).format('MM-DD HH:mm') : ''
}

/** 精华图片列表（保持列表序）：点开任一张后可在精华图片范围内左右切换 */
const essenceImageUrls = computed(() =>
  props.messages
    .filter(item => item.imageUrl)
    .map(item => item.imageUrl as string),
)
</script>

<template>
  <!-- 外壳 / 标题头 / 滚动列复用 app.scss 的「详情卡片共用」，单栏列表 -->
  <el-dialog
    v-model="visible"
    class="detail-card-dialog essence-dialog"
    modal-class="detail-card-overlay"
    :show-close="false"
    align-center
    append-to-body
  >
    <div class="detail-card essence-card">
      <div class="detail-pane">
        <div class="detail-pane-head">
          <span class="detail-pane-title">精华消息</span>
          <span class="detail-pane-sub">{{ messages.length }} 条</span>
          <span class="essence-hint">房间置顶 · 按时间倒序</span>
        </div>

        <div v-if="messages.length" class="essence-list detail-scroll">
          <article
            v-for="(item, index) in messages"
            :key="item.id"
            class="essence-item detail-pane-row"
            :style="{ '--i': index }"
          >
            <img
              v-if="item.avatar"
              class="essence-avatar"
              :src="avatarUrl(item.avatar)"
              :alt="item.nick"
              referrerpolicy="no-referrer"
            >
            <span v-else class="essence-avatar essence-avatar--fallback">{{ item.nick.slice(0, 1) }}</span>

            <div class="essence-body">
              <div class="essence-meta">
                <span class="essence-nick" :class="{ 'is-member': item.isMember }">{{ item.nick }}</span>
                <span v-if="item.isMember" class="essence-owner">房主</span>
                <span class="essence-time">
                  {{ shortTime(item.msgTime) }}
                </span>
              </div>

              <!-- 媒体消息的正文只是「[图片消息]」这类占位，有图时不再重复一行 -->
              <p v-if="!isPlaceholderText(item.text)" class="essence-text">
                {{ item.text }}
              </p>

              <PreviewImage
                v-if="item.imageUrl"
                class="essence-image"
                :src="item.imageUrl"
                :image-width="item.imageWidth"
                :image-height="item.imageHeight"
                :preview-list="essenceImageUrls"
                :initial-index="essenceImageUrls.indexOf(item.imageUrl)"
                :max-width="300"
              />
            </div>
          </article>
        </div>

        <div v-else class="essence-empty">
          <el-icon :size="26">
            <StarFilled />
          </el-icon>
          <p>{{ loading ? '正在加载精华消息…' : '这个房间还没有精华消息' }}</p>
          <p class="essence-empty-hint">
            房主或管理员设为精华的消息会出现在这里
          </p>
        </div>

        <div v-if="messages.length" class="essence-foot">
          <el-button
            v-if="!exhausted"
            size="small"
            :loading="loading"
            @click="emit('loadMore')"
          >
            加载更早的精华
          </el-button>
          <span v-else class="essence-end">没有更多了</span>
        </div>
      </div>

      <button class="detail-close" title="关闭" @click="visible = false">
        <el-icon :size="15">
          <Close />
        </el-icon>
      </button>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
/* 关闭钮落在浅色标题头上：按专辑卡的口径给深色图标（几何与悬停态在全局）。
 * 卡片投影跟房间主题青走（--accent），与页面语义色一致 */
.essence-card {
  --accent: var(--color-rooms);
  --detail-close-bg: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
  --detail-close-ink: var(--el-text-color-secondary);
}

/* 标题头右侧提示：左推靠关闭钮，与曲目卡的「↑ ↓ 切换专辑」同一位置 */
.essence-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* 列表自持滚动，撑满标题头与底部翻页条之间的空间 */
.essence-list {
  flex: 1;
  padding: 6px 10px 14px;
}

.essence-item {
  display: flex;
  gap: 10px;
  padding: 12px 10px;
  border-radius: var(--radius-md);
  transition: background-color 0.18s ease;

  &:hover {
    background: color-mix(in srgb, var(--color-rooms) 6%, transparent);
  }

  & + .essence-item {
    border-top: 1px solid var(--el-border-color-extra-light);
  }
}

.essence-avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--el-fill-color-light);
  box-shadow: 0 0 0 1px var(--el-border-color-extra-light);
}

/* 头像兜底：房间主题青渐变圆（与 Rooms 页头像兜底同配方，仅此一处使用故直接内联） */
.essence-avatar--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-rooms) 72%, #fff), var(--color-rooms));
}

.essence-body {
  flex: 1;
  min-width: 0;
}

.essence-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.essence-nick {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &.is-member {
    color: color-mix(in srgb, var(--color-rooms) 78%, #000);
  }
}

/* 房主标：与消息流的「房主」小标同义，靠房间青区分 */
.essence-owner {
  flex: none;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
  color: color-mix(in srgb, var(--color-rooms) 72%, #000);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
}

.essence-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.essence-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 图片可点开全屏预览（PreviewImage 内置 viewer），与消息流一样给 zoom-in 光标 */
.essence-image {
  display: block;
  max-width: min(300px, 100%);
  max-height: 260px;
  margin-top: 8px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--el-fill-color-light);
  cursor: zoom-in;
}

/* 底部翻页条：固定在栏底，列表再长也不用来回滚到底找按钮 */
.essence-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.essence-end {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* 空态：占满标题头以下的整块区域，与消息区的空态同一套语言 */
.essence-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);

  .el-icon {
    color: color-mix(in srgb, var(--color-follow) 62%, var(--el-text-color-secondary));
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

/* 次级提示行：与 Rooms 页三处空态 hint 同规格（11px），压过本块 p 的 13px */
.essence-empty .essence-empty-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}
</style>
