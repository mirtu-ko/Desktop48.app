<script setup lang="ts">
import type { ElScrollbar } from 'element-plus'
import { computed, nextTick, ref, watch } from 'vue'

export interface BarrageListItem {
  id: number
  seconds: number
  time: string
  username: string
  content: string
}

const props = defineProps<{
  items: BarrageListItem[]
  // 搜索关键词，用于结果高亮；有值时视为搜索模式，不再自动跟随底部
  keyword?: string
  emptyText?: string
}>()

const emit = defineEmits<{ seek: [seconds: number] }>()

const scrollbarRef = ref<InstanceType<typeof ElScrollbar> | null>(null)
// 用户往上翻看历史时暂停自动跟随，重新滚到底部后恢复
const following = ref(true)
const timeRegex = /\.\d*/

const isSearching = computed(() => !!props.keyword?.trim())

function displayTime(time: string) {
  return (time || '').replace(timeRegex, '')
}

// 把命中的关键词切成片段，交给模板逐段渲染，避免使用 v-html
function segments(text: string) {
  const raw = text || ''
  const kw = props.keyword?.trim()
  if (!kw)
    return [{ text: raw, hit: false }]

  const result: { text: string, hit: boolean }[] = []
  const lower = raw.toLowerCase()
  const target = kw.toLowerCase()
  let start = 0
  let index = lower.indexOf(target, start)
  while (index !== -1) {
    if (index > start)
      result.push({ text: raw.slice(start, index), hit: false })
    result.push({ text: raw.slice(index, index + target.length), hit: true })
    start = index + target.length
    index = lower.indexOf(target, start)
  }
  if (start < raw.length)
    result.push({ text: raw.slice(start), hit: false })
  return result
}

function scrollToBottom() {
  const wrap = scrollbarRef.value?.wrapRef
  if (wrap)
    wrap.scrollTop = wrap.scrollHeight
}

function onScroll() {
  const wrap = scrollbarRef.value?.wrapRef
  if (!wrap)
    return
  // 留 20px 容差，否则滚动动画的小数误差会误判为“用户已离开底部”
  following.value = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 20
}

watch(
  () => props.items,
  async () => {
    if (isSearching.value || !following.value)
      return
    await nextTick()
    scrollToBottom()
  },
)

// 搜索态切换时列表内容整体替换，回到顶部
watch(isSearching, async (searching) => {
  await nextTick()
  const wrap = scrollbarRef.value?.wrapRef
  if (!wrap)
    return
  if (searching) {
    wrap.scrollTop = 0
  }
  else {
    following.value = true
    scrollToBottom()
  }
})

function resumeFollowing() {
  following.value = true
  scrollToBottom()
}
</script>

<template>
  <div class="barrage-root">
    <el-scrollbar ref="scrollbarRef" class="barrage-scroll" @scroll="onScroll">
      <ul class="barrage-list">
        <li
          v-for="item in items"
          :key="item.id"
          class="barrage-item"
          :title="`跳转到 ${displayTime(item.time)}`"
          @click="emit('seek', item.seconds)"
        >
          <span class="barrage-time">{{ displayTime(item.time) }}</span>
          <span class="barrage-username ellipsis">{{ item.username }}：</span>
          <span class="barrage-content"><template
            v-for="(segment, segmentIndex) in segments(item.content)"
            :key="segmentIndex"
          ><mark v-if="segment.hit" class="barrage-hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span>
        </li>
      </ul>
      <div v-if="items.length === 0" class="barrage-empty empty-hint">
        {{ emptyText || '暂无弹幕' }}
      </div>
    </el-scrollbar>

    <el-button
      v-if="!following && !isSearching"
      class="resume-follow"
      size="small"
      type="primary"
      round
      @click="resumeFollowing"
    >
      回到最新
    </el-button>
  </div>
</template>

<style scoped lang="scss">
.barrage-root {
  position: relative;
  height: 100%;
  min-height: 0;
}

.barrage-scroll {
  height: 100%;
}

.barrage-list {
  margin: 0;
  padding: 0;
}

.barrage-item {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-radius: var(--radius-xs);
  list-style: none;
  text-align: left;
  font-size: 12px;
  line-height: 1.6;
  font-family: 'Microsoft YaHei', serif;
  cursor: pointer;

  &:hover {
    background: var(--el-color-primary-light-9);
  }

  .barrage-username {
    flex-shrink: 0;
    max-width: 96px;
    color: var(--el-color-primary);
  }

  .barrage-time {
    flex-shrink: 0;
    color: var(--el-text-color-placeholder);
    font-variant-numeric: tabular-nums;
  }

  .barrage-content {
    min-width: 0;
    word-break: break-word;
  }
}

.barrage-hit {
  background: #ffe58f;
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
}

/* 文案颜色/字号见全局 .empty-hint；此处仅定面板内的留白 */
.barrage-empty {
  padding: 24px 0;
  text-align: center;
}

.resume-follow {
  position: absolute;
  right: 12px;
  bottom: 12px;
}
</style>
