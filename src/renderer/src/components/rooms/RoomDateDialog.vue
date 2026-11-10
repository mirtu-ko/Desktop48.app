<script setup lang="ts">
// 房间消息「按日期查看」：独立只读弹层，用 nextTime 远端时间戳一次跳到历史某天。
// 自带数据与翻页，不进主消息流，不碰已读水位、贴底状态与 5s 轮询。
import type { PocketRoomMessageView } from '@renderer/utils/pocket-room-message'
import { OFFICIAL_POCKET_USER_ID } from '@common/pocket-rooms'
import { Calendar, Close } from '@element-plus/icons-vue'
import PreviewImage from '@renderer/components/ui/PreviewImage.vue'
import { isPlaceholderText, normalizePocketRoomMessage } from '@renderer/utils/pocket-room-message'
import { classifyRoomDateError, dateToNextTime, hasMessageOnDay, isRoomDateQueryable, mergeRoomMessagePages, nextRoomPageCursor, ROOM_ARCHIVE_START } from '@renderer/utils/room-date-jump'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  /** 与当前消息流同频道；null = 尚未解析，不发起请求 */
  channel: { serverId: string, channelId: string } | null
  scope: 'member' | 'all'
  roomName: string
  /** 本房间可查起点（yyyy-MM-dd）：入团日与归档起点取较晚者 */
  archiveStart?: string
}>(), {
  archiveStart: ROOM_ARCHIVE_START,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const selectedDate = ref<Date>(new Date())
/** 列表恒为 msgTime 正序：旧在上、新在下，与聊天流同向 */
const messages = ref<PocketRoomMessageView[]>([])
const listRef = ref<HTMLElement | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const errorText = ref('')
const cursor = ref(0)
const exhausted = ref(false)
const hasQueried = ref(false)
/** 目标日无消息、回落到更早一页时置位 */
const missedDay = ref(false)
/** 请求序号：日期 / 房间 / 口径变更后，在途回包一律作废 */
let requestSeq = 0

const scopeLabel = computed(() => props.scope === 'member' ? '只看房主' : '全部消息')
/** 起点来源：入团日晚于归档日时按入团日，否则说明更早已归档 */
const fromJoin = computed(() => props.archiveStart !== ROOM_ARCHIVE_START)
const archiveHint = computed(() => `可查 ${props.archiveStart} 起`)
const archiveReason = computed(() => fromJoin.value ? '入团日' : '更早已归档')
/** 空态把起点原因展开成一句，日期条上已标出日期与来源 */
const emptyHint = computed(() => fromJoin.value
  ? '入团前没有房间消息，更早的日期不可选'
  : '更早的消息已归档，不可查询')
const fallbackDate = computed(() => {
  const nearest = messages.value[messages.value.length - 1]
  return nearest ? dayjs(nearest.msgTime).format('YYYY-MM-DD') : ''
})
const imageUrls = computed(() => messages.value.filter(item => item.imageUrl).map(item => item.imageUrl))

/** 本房间起点之前与未来都禁用：前者没有房间消息，后者服务端会回空页 */
function disableDate(date: Date): boolean {
  return !isRoomDateQueryable(date, Date.now(), props.archiveStart)
}

function avatarUrl(avatar: string): string {
  return avatar ? Tools.sourceUrl(avatar) : ''
}

/** 跨年回看要带年份，不能只用 MM-DD HH:mm */
function fullTime(msgTime: number): string {
  return msgTime ? dayjs(msgTime).format('YYYY-MM-DD HH:mm') : ''
}

/** 接口原始消息 → 视图；只看房主时与消息流同口径剔除官方系统账号 */
function normalizeViews(raw: unknown[]): PocketRoomMessageView[] {
  const views = raw
    .map(normalizePocketRoomMessage)
    .filter((item): item is PocketRoomMessageView => item !== null)
  return props.scope === 'member'
    ? views.filter(item => item.userId !== OFFICIAL_POCKET_USER_ID)
    : views
}

/** 按指定日期重新跳一页（整页替换）；date 显式传入，不依赖 v-model 的更新时序 */
async function jump(date: Date = selectedDate.value): Promise<void> {
  if (!isRoomDateQueryable(date, Date.now(), props.archiveStart))
    return
  const channel = props.channel
  const nextTime = dateToNextTime(date)
  if (!channel?.channelId || !channel.serverId || !nextTime)
    return
  const seq = ++requestSeq
  loading.value = true
  loadingMore.value = false
  errorText.value = ''
  messages.value = []
  cursor.value = 0
  exhausted.value = false
  missedDay.value = false
  hasQueried.value = false
  try {
    const result = await window.mainAPI.pocketGetRoomMessages(
      channel.channelId,
      channel.serverId,
      nextTime,
      props.scope,
    )
    if (seq !== requestSeq)
      return
    const views = normalizeViews(result.messages)
    messages.value = mergeRoomMessagePages([], views)
    cursor.value = nextRoomPageCursor(nextTime, result.nextTime)
    exhausted.value = views.length === 0 || cursor.value === 0
    missedDay.value = views.length > 0 && !hasMessageOnDay(views, date)
    await nextTick()
    // 正序后最靠近所选日期的消息在底部，落点贴底才看得到目标日
    const el = listRef.value
    if (el)
      el.scrollTop = el.scrollHeight
  }
  catch (error) {
    if (seq === requestSeq) {
      const failure = classifyRoomDateError(error)
      // 服务端把「查不到」回成业务失败：按空页收口，不画错误条
      if (failure.empty)
        exhausted.value = true
      else
        errorText.value = failure.message
    }
  }
  finally {
    if (seq === requestSeq) {
      loading.value = false
      hasQueried.value = true
    }
  }
}

/** 从落点继续往更早翻一页（追加，不重置日期） */
async function loadMore(): Promise<void> {
  const channel = props.channel
  if (!channel?.channelId || !channel.serverId || loading.value || loadingMore.value || exhausted.value || !cursor.value)
    return
  const seq = requestSeq
  const requested = cursor.value
  const prevHeight = listRef.value?.scrollHeight ?? 0
  const prevTop = listRef.value?.scrollTop ?? 0
  loadingMore.value = true
  errorText.value = ''
  try {
    const result = await window.mainAPI.pocketGetRoomMessages(
      channel.channelId,
      channel.serverId,
      requested,
      props.scope,
    )
    if (seq !== requestSeq)
      return
    messages.value = mergeRoomMessagePages(messages.value, normalizeViews(result.messages))
    cursor.value = nextRoomPageCursor(requested, result.nextTime)
    exhausted.value = cursor.value === 0
    await nextTick()
    // 更早一页插在头部，视口按增量下移，肉眼位置不变
    const el = listRef.value
    if (el && prevHeight)
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  }
  catch (error) {
    if (seq === requestSeq) {
      const failure = classifyRoomDateError(error)
      // 翻到归档边界时保留已读到的页，只标记到头
      if (failure.empty) {
        cursor.value = 0
        exhausted.value = true
      }
      else {
        errorText.value = failure.message
      }
    }
  }
  finally {
    if (seq === requestSeq)
      loadingMore.value = false
  }
}

function onDateChange(value: Date | null): void {
  void jump(value ?? selectedDate.value)
}

function retry(): void {
  void jump()
}

/** 换房 / 换口径 / 换频道 / 换起点后清空旧结果，在途回包随之作废 */
function reset(): void {
  requestSeq += 1
  // 起点可能随房间变晚：把选中日期钳到起点，否则旧日期会被守卫挡掉、弹层停在空态
  const floor = dayjs(props.archiveStart).startOf('day').valueOf()
  if (selectedDate.value.getTime() < floor)
    selectedDate.value = new Date(floor)
  messages.value = []
  cursor.value = 0
  exhausted.value = false
  errorText.value = ''
  missedDay.value = false
  hasQueried.value = false
  loading.value = false
  loadingMore.value = false
}

watch(visible, (open) => {
  if (open && !hasQueried.value)
    void jump()
})

/** 房间身份：只看频道，口径 / 起点变化仍属同一房间 */
const roomKey = computed(() => `${props.channel?.serverId ?? ''}:${props.channel?.channelId ?? ''}`)
let lastRoomKey = roomKey.value

/** 换房后不沿用上个房间的日期，回到今天；口径 / 起点变化保留当前日期 */
watch(
  () => `${roomKey.value}:${props.scope}:${props.archiveStart}`,
  () => {
    if (roomKey.value !== lastRoomKey) {
      lastRoomKey = roomKey.value
      selectedDate.value = new Date()
    }
    reset()
    if (visible.value)
      void jump()
  },
)
</script>

<template>
  <el-dialog
    v-model="visible"
    class="detail-card-dialog room-date-dialog"
    modal-class="detail-card-overlay"
    :show-close="false"
    align-center
    append-to-body
  >
    <div class="detail-card date-card">
      <div class="detail-pane">
        <div class="detail-pane-head">
          <span class="detail-pane-title">按日期查看</span>
          <span class="detail-pane-sub">{{ roomName }}</span>
          <span class="date-hint">只读 · 时间正序 · 不影响已读</span>
        </div>

        <div class="date-bar">
          <el-date-picker
            v-model="selectedDate"
            type="date"
            size="small"
            :clearable="false"
            :disabled-date="disableDate"
            placeholder="选择日期"
            @change="onDateChange"
          />
          <span class="date-range">{{ archiveHint }}</span>
          <span class="date-reason" :title="emptyHint">{{ archiveReason }}</span>
          <span class="date-scope">{{ scopeLabel }}</span>
          <span class="date-count">{{ messages.length }} 条</span>
        </div>

        <div v-if="missedDay" class="date-notice">
          这一天没有消息，以下是之前最近的一页（{{ fallbackDate }}）
        </div>
        <div v-if="errorText" class="date-notice is-error">
          <span>{{ errorText }}</span>
          <el-button size="small" text @click="retry">
            重试
          </el-button>
        </div>

        <div v-if="messages.length" ref="listRef" class="date-list detail-scroll">
          <div class="date-more">
            <el-button v-if="!exhausted" size="small" :loading="loadingMore" @click="loadMore">
              加载更早
            </el-button>
            <span v-else class="date-end">没有更早了</span>
          </div>

          <article
            v-for="(item, index) in messages"
            :key="item.id"
            class="date-item detail-pane-row"
            :style="{ '--i': index }"
          >
            <img
              v-if="item.avatar"
              class="date-avatar"
              :src="avatarUrl(item.avatar)"
              :alt="item.nick"
              referrerpolicy="no-referrer"
            >
            <span v-else class="date-avatar date-avatar--fallback">{{ item.nick.slice(0, 1) }}</span>

            <div class="date-body">
              <div class="date-meta">
                <span class="date-nick" :class="{ 'is-member': item.isMember }">{{ item.nick }}</span>
                <span v-if="item.isMember" class="date-owner">房主</span>
                <span class="date-time">{{ fullTime(item.msgTime) }}</span>
              </div>
              <p v-if="item.quote" class="date-quote">
                {{ item.quote.nick }}：{{ item.quote.text }}
              </p>
              <p v-if="item.text" class="date-text" :class="{ 'is-placeholder': isPlaceholderText(item.text) }">
                {{ item.text }}
              </p>
              <PreviewImage
                v-if="item.imageUrl"
                class="date-image"
                :src="item.imageUrl"
                :image-width="item.imageWidth"
                :image-height="item.imageHeight"
                :preview-list="imageUrls"
                :initial-index="imageUrls.indexOf(item.imageUrl)"
                :max-width="260"
              />
            </div>
          </article>
        </div>

        <div v-else class="date-empty">
          <el-icon :size="26">
            <Calendar />
          </el-icon>
          <p>{{ loading ? '正在加载该日期附近的消息…' : hasQueried ? '这一天前后没有消息' : '选择日期查看历史消息' }}</p>
          <p class="date-empty-hint">
            {{ emptyHint }}
          </p>
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
/* 卡片主题青与关闭钮沿用精华弹层口径 */
.date-card {
  --accent: var(--color-rooms);
  --detail-close-bg: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
  --detail-close-ink: var(--el-text-color-secondary);
}

.date-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* 日期条：选择器在左，口径与条数靠右，固定在标题头与列表之间 */
.date-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.date-range,
.date-scope,
.date-count {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.date-range {
  white-space: nowrap;
}

/* 起点来源做成小标签：让「为什么只能查到这里」在日期条上一眼可见 */
.date-reason {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  color: color-mix(in srgb, var(--color-rooms) 72%, #000);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
}

.date-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

/* 回落 / 错误提示：同一条浅底横幅，错误态换语义色 */
.date-notice {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  font-size: 11px;
  color: color-mix(in srgb, var(--color-rooms) 72%, #000);
  background: color-mix(in srgb, var(--color-rooms) 10%, transparent);

  &.is-error {
    color: var(--el-color-danger);
    background: var(--el-color-danger-light-9);
  }
}

.date-list {
  flex: 1;
  padding: 4px 10px 12px;
}

.date-item {
  display: flex;
  gap: 10px;
  padding: 10px;
  border-radius: var(--radius-md);
  transition: background-color 0.18s ease;

  &:hover {
    background: color-mix(in srgb, var(--color-rooms) 6%, transparent);
  }

  & + .date-item {
    border-top: 1px solid var(--el-border-color-extra-light);
  }
}

.date-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--el-fill-color-light);
  box-shadow: 0 0 0 1px var(--el-border-color-extra-light);
}

.date-avatar--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-rooms) 72%, #fff), var(--color-rooms));
}

.date-body {
  flex: 1;
  min-width: 0;
}

.date-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.date-nick {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &.is-member {
    color: color-mix(in srgb, var(--color-rooms) 78%, #000);
  }
}

.date-owner {
  flex: none;
  height: 17px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  color: color-mix(in srgb, var(--color-rooms) 72%, #000);
  background: color-mix(in srgb, var(--color-rooms) 14%, transparent);
}

.date-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.date-quote {
  margin: 0 0 4px;
  padding: 4px 7px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  word-break: break-word;
}

.date-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;

  &.is-placeholder {
    color: var(--el-text-color-placeholder);
  }
}

.date-image {
  display: block;
  max-width: min(260px, 100%);
  max-height: 220px;
  margin-top: 6px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--el-fill-color-light);
  cursor: zoom-in;
}

.date-empty {
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
    color: color-mix(in srgb, var(--color-rooms) 62%, var(--el-text-color-secondary));
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

/* 次级提示行特异度要压过上面的 p */
.date-empty .date-empty-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}

/* 上翻入口随消息流一起滚：滚到顶部才看得见，不占固定栏 */
.date-more {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0 10px;
}

.date-end {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
