<script setup lang="ts">
import type { BirthdayEntry } from '@renderer/utils/member-birthday'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { ArrowLeft, ArrowRight, Close, DocumentCopy, Download, MagicStick, RefreshRight, View } from '@element-plus/icons-vue'
import {
  BIRTHDAY_PALETTES,
  loadPosterAvatar,
  nextBirthdayWish,
  posterFileName,
  randomBirthdayWish,
  renderBirthdayPoster,
} from '@renderer/utils/birthday-poster'
import { saveBlobImage } from '@renderer/utils/image-download'
import { trackEvent } from '@renderer/utils/umami'
import { useEventListener } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'

/**
 * 生日贺卡浮层：成员页生日墙条幅的「生日贺卡」按钮打开。
 * 三层结构：半透明蒙层 → 居中弹出卡片 → 覆盖蒙层的 Canvas 撒花。
 * 卡面直接显示 renderBirthdayPoster 产出的 PNG，预览 / 复制 / 保存共用同一份，所见即所得。
 * 只承载今日寿星（入参已由页面过滤），多人时才提供左右切换；祝福语打开时随机取、按钮按词库轮换。
 * 视觉：CSS 3D 倾斜 + 镜面高光跟随鼠标；prefers-reduced-motion 下退化为静态卡面。
 */
const props = defineProps<{
  /** 今日寿星（todayBirthdays 的输出）；同一天多人时按姓名定序 */
  entries: BirthdayEntry[]
  /** 页面持有的「今天」，跨零点重新激活页面时会刷新 */
  today: Date
  /** v-model:open —— 页面据此屏蔽自己的快捷键 */
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'select': [member: MemberDetail]
}>()

// ===== 撒花粒子状态 =====
// ⚠️ 必须声明在 immediate watcher 之前：后者在 setup 期间同步读写 frame / ribbons，命中 let 暂时性死区会整页白屏。

interface Dust {
  x: number
  y: number
  r: number
  speed: number
  phase: number
  color: string
}

interface Ribbon {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  angle: number
  spin: number
  alpha: number
  fade: number
  color: string
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const RIBBON_COLORS = ['#ffd166', '#ff8fb8', '#a89df6', '#ffffff', '#ffb45e', '#9ee7ff']
let dust: Dust[] = []
let ribbons: Ribbon[] = []
let frame = 0

// ===== 卡面状态 =====

const activeIndex = ref(0)
const active = computed<BirthdayEntry | null>(() => props.entries[activeIndex.value] ?? null)
/** 每次打开（含切换寿星）随机抽一句；关闭后保留上一句，用来避免下一次打开撞同一句 */
const wish = ref('')
const decorVariant = ref(0)
const decorName = computed(() => BIRTHDAY_PALETTES[decorVariant.value % BIRTHDAY_PALETTES.length].name)
/** 只有同日多位寿星时才提示左右切换，避免单人时给出无效操作说明 */
const cardTip = computed(() =>
  `1080 × 1440 PNG${props.entries.length > 1 ? ' · ← → 切换寿星' : ''} · Esc 关闭`,
)

const tiltX = ref(0)
const tiltY = ref(0)
const glowX = ref(50)
const glowY = ref(50)
const cardStyle = computed(() => ({
  '--tilt-x': `${tiltX.value}deg`,
  '--tilt-y': `${tiltY.value}deg`,
  '--glow-x': `${glowX.value}%`,
  '--glow-y': `${glowY.value}%`,
}))

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function close(): void {
  emit('update:open', false)
}

function resetTilt(): void {
  tiltX.value = 0
  tiltY.value = 0
  glowX.value = 50
  glowY.value = 50
}

function onCardMove(event: MouseEvent): void {
  if (reducedMotion)
    return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const px = (event.clientX - rect.left) / rect.width
  const py = (event.clientY - rect.top) / rect.height
  tiltY.value = (px - 0.5) * 15
  tiltX.value = (0.5 - py) * 11
  glowX.value = px * 100
  glowY.value = py * 100
}

function selectMember(index: number): void {
  if (index === activeIndex.value)
    return
  activeIndex.value = index
  wish.value = randomBirthdayWish(wish.value)
  resetTilt()
  burst()
  trackEvent('birthday:customize', { action: 'member' })
}

function stepMember(delta: number): void {
  if (props.entries.length < 2)
    return
  selectMember((activeIndex.value + delta + props.entries.length) % props.entries.length)
}

function nextWish(): void {
  wish.value = nextBirthdayWish(wish.value)
  trackEvent('birthday:customize', { action: 'wish' })
}

function nextDecor(): void {
  decorVariant.value += 1
  burst()
  trackEvent('birthday:customize', { action: 'decor' })
}

function viewProfile(): void {
  if (!active.value)
    return
  emit('select', active.value.member)
  close()
}

// ===== 头像：只在绘制卡面时取，按 URL 缓存 =====

const avatarCache = new Map<string, HTMLImageElement | null>()
const avatarPending = new Map<string, Promise<HTMLImageElement | null>>()
const avatarEl = ref<HTMLImageElement | null>(null)

async function ensureAvatar(entry: BirthdayEntry | null): Promise<void> {
  const url = entry?.member.avatar || ''
  if (!url) {
    avatarEl.value = null
    return
  }
  if (avatarCache.has(url)) {
    avatarEl.value = avatarCache.get(url) ?? null
    return
  }
  // 打开贺卡与切人可能同时请求同一张头像，用 in-flight 合并掉重复请求
  let pending = avatarPending.get(url)
  if (!pending) {
    pending = loadPosterAvatar(url)
    avatarPending.set(url, pending)
  }
  const image = await pending
  avatarPending.delete(url)
  avatarCache.set(url, image)
  // 取图期间用户可能已经翻到下一位，别把旧头像贴到新卡上
  if (active.value?.member.avatar === url)
    avatarEl.value = image
}

// ===== 卡面预览：预览 / 复制 / 保存共用同一张 PNG =====

const posterDataUrl = ref('')
const posterBlob = ref<Blob | null>(null)
const rendering = ref(false)
const busy = ref(false)
let renderToken = 0
let renderScheduled = false

async function renderPreview(): Promise<void> {
  const entry = active.value
  const token = ++renderToken
  if (!entry) {
    posterDataUrl.value = ''
    posterBlob.value = null
    return
  }
  rendering.value = true
  try {
    await ensureAvatar(entry)
    const poster = renderBirthdayPoster({
      entry,
      today: props.today,
      wish: wish.value,
      avatar: avatarEl.value,
      decor: decorVariant.value,
    })
    // 切人 / 换装扮比绘制快，旧结果一律丢弃，避免卡面显示上一位寿星
    if (token !== renderToken)
      return
    posterDataUrl.value = poster.dataUrl
    posterBlob.value = poster.blob
  }
  catch (error) {
    console.error('绘制生日贺卡失败:', error)
    if (token !== renderToken)
      return
    posterDataUrl.value = ''
    posterBlob.value = null
    ElMessage.error('贺卡绘制失败，请重试')
  }
  finally {
    if (token === renderToken)
      rendering.value = false
  }
}

/** 同一 tick 内 open / 切人 / 换祝福 / 换装扮可能连着改，合并成一次绘制 */
function scheduleRender(): void {
  if (renderScheduled)
    return
  renderScheduled = true
  void Promise.resolve().then(() => {
    renderScheduled = false
    if (props.open)
      void renderPreview()
  })
}

// immediate：组件被以 open=true 直接挂载（恢复浮层状态）时也要出图，不能只等下一次变化
watch([() => props.open, active, wish, decorVariant], ([open]) => {
  if (open) {
    scheduleRender()
  }
  else {
    renderToken += 1
    stopParticles()
    posterDataUrl.value = ''
    posterBlob.value = null
  }
}, { immediate: true })

watch(() => props.entries, (entries) => {
  if (activeIndex.value >= entries.length)
    activeIndex.value = 0
})

// ===== 撒花粒子：绘制与动画（覆盖半透明蒙层，不吃指针事件） =====

function canvasSize(): { w: number, h: number } {
  const canvas = canvasRef.value
  return { w: canvas?.clientWidth || 1200, h: canvas?.clientHeight || 800 }
}

function resizeCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas)
    return
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(canvas.clientWidth * ratio)
  canvas.height = Math.round(canvas.clientHeight * ratio)
  canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function seedDust(): void {
  const { w, h } = canvasSize()
  dust = Array.from({ length: 62 }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: 0.6 + Math.random() * 1.8,
    speed: 0.15 + Math.random() * 0.45,
    phase: Math.random() * Math.PI * 2,
    color: Math.random() > 0.7 ? '#ffd88a' : '#ffffff',
  }))
}

function paintDust(ctx: CanvasRenderingContext2D): void {
  for (const item of dust) {
    ctx.globalAlpha = 0.2 + Math.sin(item.phase) * 0.16
    ctx.fillStyle = item.color
    ctx.beginPath()
    ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function tick(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) {
    frame = 0
    return
  }
  const { w, h } = canvasSize()
  ctx.clearRect(0, 0, w, h)
  for (const item of dust) {
    item.y -= item.speed
    item.phase += 0.02
    if (item.y < -8) {
      item.y = h + 8
      item.x = Math.random() * w
    }
  }
  paintDust(ctx)

  for (let i = ribbons.length - 1; i >= 0; i--) {
    const item = ribbons[i]
    item.vy += 0.13
    item.x += item.vx
    item.y += item.vy
    item.angle += item.spin
    item.alpha -= item.fade
    if (item.y > h + 40 || item.alpha <= 0) {
      ribbons.splice(i, 1)
      continue
    }
    ctx.save()
    ctx.translate(item.x, item.y)
    ctx.rotate(item.angle)
    ctx.globalAlpha = Math.max(0, item.alpha)
    ctx.fillStyle = item.color
    ctx.fillRect(-item.w / 2, -item.h / 2, item.w, item.h)
    ctx.restore()
  }
  ctx.globalAlpha = 1
  // 彩带落完即停帧：不留下一个永不结束的 rAF 去和原生保存对话框抢重绘
  frame = ribbons.length ? requestAnimationFrame(tick) : 0
}

function pushRibbon(overrides: Partial<Ribbon>): void {
  ribbons.push({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    w: 8,
    h: 18,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.22,
    alpha: 1,
    fade: 0.004,
    color: RIBBON_COLORS[Math.floor(Math.random() * RIBBON_COLORS.length)],
    ...overrides,
  })
}

/** 弹卡背后喷一次彩带 + 顶部天降撒花 */
function burst(): void {
  if (reducedMotion || !canvasRef.value)
    return
  const { w, h } = canvasSize()
  const rect = popRef.value?.getBoundingClientRect()
  const cx = rect ? rect.left + rect.width / 2 : w / 2
  const cy = rect ? rect.top + rect.height * 0.42 : h * 0.46
  for (let i = 0; i < 130; i++) {
    pushRibbon({
      x: cx + (Math.random() - 0.5) * 200,
      y: cy + (Math.random() - 0.5) * 80,
      vx: (Math.random() - 0.5) * 9,
      vy: -5 - Math.random() * 9,
      w: 6 + Math.random() * 10,
      h: 12 + Math.random() * 22,
      alpha: 0.85 + Math.random() * 0.15,
    })
  }
  for (let i = 0; i < 60; i++) {
    pushRibbon({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.45,
      vx: (Math.random() - 0.5) * 1.8,
      vy: 1.2 + Math.random() * 2.2,
      w: 5 + Math.random() * 8,
      h: 10 + Math.random() * 16,
      spin: (Math.random() - 0.5) * 0.12,
      alpha: 0.65 + Math.random() * 0.3,
      fade: 0.0012,
    })
  }
  if (!frame)
    frame = requestAnimationFrame(tick)
}

function startParticles(): void {
  resizeCanvas()
  seedDust()
  if (reducedMotion) {
    const ctx = canvasRef.value?.getContext('2d')
    if (ctx)
      paintDust(ctx)
    return
  }
  if (!frame)
    frame = requestAnimationFrame(tick)
}

/** 保存对话框打开期间挂起动画，但不丢弃彩带（关闭后继续落） */
function suspendParticles(): void {
  if (frame)
    cancelAnimationFrame(frame)
  frame = 0
}

function stopParticles(): void {
  suspendParticles()
  ribbons = []
}

watch(() => props.open, async (open) => {
  if (!open)
    return
  trackEvent('birthday:card_open')
  activeIndex.value = 0
  // 同步赋值（在 await nextTick 之前）：绘制 watcher 的微任务读 wish 时必须已经抽好
  wish.value = randomBirthdayWish(wish.value)
  decorVariant.value = 0
  resetTilt()
  // immediate 时组件还没挂上，nextTick 之后 canvas 才在 DOM 里
  await nextTick()
  startParticles()
  burst()
}, { immediate: true })

function onKeydown(event: KeyboardEvent): void {
  if (!props.open)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
  else if (event.key === 'ArrowLeft') {
    stepMember(-1)
  }
  else if (event.key === 'ArrowRight') {
    stepMember(1)
  }
}

// 弹层打开时才挂全局监听：keep-alive 失活的页面不该留着窗口级回调
const listenerTarget = computed(() => props.open ? window : null)
useEventListener(listenerTarget, 'resize', resizeCanvas)
useEventListener(listenerTarget, 'keydown', onKeydown)

/** 卸载与页面失活共用一份清理：粒子帧、头像缓存、当前头像 */
function disposeCard(): void {
  stopParticles()
  avatarCache.clear()
  avatarPending.clear()
  avatarEl.value = null
}
onUnmounted(disposeCard)
onDeactivated(disposeCard)

// ===== 分享：全部复用卡面那份预览，不重新绘制 =====

async function copyImage(): Promise<void> {
  const dataUrl = posterDataUrl.value
  const blob = posterBlob.value
  if (!dataUrl || !blob)
    return
  busy.value = true
  let result: 'ok' | 'fail' = 'fail'
  try {
    // 主进程 clipboard.write 会写入系统原生位图格式，粘贴到聊天窗口兼容性最好
    await window.mainAPI.copyImageToClipboard(dataUrl)
    result = 'ok'
    ElMessage.success('贺卡图片已复制，粘贴即可分享')
  }
  catch (mainError) {
    console.error('主进程写剪贴板失败，改用渲染层 clipboard:', mainError)
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
        throw new Error('渲染层剪贴板不可用')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      result = 'ok'
      ElMessage.success('贺卡图片已复制，粘贴即可分享')
    }
    catch (error) {
      console.error('复制贺卡图片失败:', error)
      ElMessage.error('复制失败，可改用「保存图片」')
    }
  }
  finally {
    busy.value = false
    trackEvent('birthday:copy', { result })
  }
}

async function saveImage(): Promise<void> {
  const entry = active.value
  const dataUrl = posterDataUrl.value
  const blob = posterBlob.value
  if (!entry || !dataUrl || !blob)
    return
  busy.value = true
  suspendParticles()
  let result: 'ok' | 'cancel' | 'fail' = 'fail'
  try {
    const saved = await window.mainAPI.saveImageFile(dataUrl, posterFileName(entry, props.today))
    if (saved) {
      result = 'ok'
      ElMessage.success('贺卡图片已保存')
    }
    else {
      result = 'cancel'
    }
  }
  catch (error) {
    console.error('保存贺卡图片失败:', error)
    try {
      // 原生保存对话框异常时，退回渲染层下载，仍保证用户拿到图
      saveBlobImage(blob, posterFileName(entry, props.today))
      result = 'ok'
      ElMessage.success('已保存到默认下载目录')
    }
    catch {
      ElMessage.error('保存失败，请稍后重试')
    }
  }
  finally {
    busy.value = false
    if (props.open)
      startParticles()
    trackEvent('birthday:save', { result })
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- 半透明蒙层：页面内容仍可见，点空白处关闭 -->
    <div
      v-if="open && entries.length"
      class="bday-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="生日贺卡"
      @click.self="close"
    >
      <canvas ref="canvasRef" class="bday-overlay__canvas" />
      <div class="bday-overlay__glow" />

      <div ref="popRef" class="bday-pop">
        <span class="bday-pop__spark bday-pop__spark--a" />
        <span class="bday-pop__spark bday-pop__spark--b" />
        <span class="bday-pop__spark bday-pop__spark--c" />

        <header class="bday-pop__head">
          <div class="bday-pop__heading">
            <span class="bday-pop__eyebrow">BIRTHDAY CARD · Desktop48</span>
            <h3 class="bday-pop__title">
              今日寿星 · 生日贺卡
            </h3>
          </div>
          <button class="bday-pop__close" type="button" title="关闭（Esc）" @click="close">
            <el-icon :size="17">
              <Close />
            </el-icon>
          </button>
        </header>

        <div class="bday-pop__stage">
          <button
            v-if="entries.length > 1"
            class="bday-nav bday-nav--prev"
            type="button"
            title="上一位（←）"
            @click="stepMember(-1)"
          >
            <el-icon :size="16">
              <ArrowLeft />
            </el-icon>
          </button>

          <div class="bday-scene" @mousemove="onCardMove" @mouseleave="resetTilt">
            <div class="bday-3d" :style="cardStyle">
              <div class="bday-card">
                <img
                  v-if="posterDataUrl"
                  class="bday-card__img"
                  :src="posterDataUrl"
                  :alt="active ? `${active.member.realName} 的生日贺卡：${wish}` : '生日贺卡'"
                  :draggable="false"
                >
                <div v-else class="bday-card__loading">
                  <span class="bday-card__loading-star" />
                  正在绘制贺卡…
                </div>
                <span class="bday-card__shine" />
              </div>
            </div>
          </div>

          <button
            v-if="entries.length > 1"
            class="bday-nav bday-nav--next"
            type="button"
            title="下一位（→）"
            @click="stepMember(1)"
          >
            <el-icon :size="16">
              <ArrowRight />
            </el-icon>
          </button>
        </div>

        <div class="bday-pop__tools">
          <span class="bday-pop__hint">卡面即分享图，所见即所得</span>
          <button type="button" @click="nextWish">
            <el-icon :size="13">
              <RefreshRight />
            </el-icon>
            换一句
          </button>
          <button type="button" @click="nextDecor">
            <el-icon :size="13">
              <MagicStick />
            </el-icon>
            {{ decorName }}装扮
          </button>
        </div>

        <div v-if="entries.length > 1" class="bday-dots">
          <button
            v-for="(entry, index) in entries"
            :key="`${index}-${entry.member.sid}-${entry.day}`"
            class="bday-dots__item"
            :class="{ 'is-active': index === activeIndex }"
            type="button"
            :title="`${entry.member.realName} · 今天生日`"
            @click="selectMember(index)"
          />
        </div>

        <footer class="bday-pop__actions">
          <button class="bday-actions__item is-primary" type="button" :disabled="busy || rendering || !posterDataUrl" @click="copyImage">
            <el-icon :size="15">
              <DocumentCopy />
            </el-icon>
            复制图片
          </button>
          <button class="bday-actions__item" type="button" :disabled="busy || rendering || !posterDataUrl" @click="saveImage">
            <el-icon :size="15">
              <Download />
            </el-icon>
            保存图片
          </button>
          <button class="bday-actions__item" type="button" @click="viewProfile">
            <el-icon :size="15">
              <View />
            </el-icon>
            查看资料
          </button>
        </footer>
        <p class="bday-pop__tip">
          {{ cardTip }}
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
/* 贺卡是独立暖金主题：圆角 / 药丸用全局 token，其余配色集中在此便于整套调整 */
$bday-white: #fff;
$bday-ink: #fff3dc;
$bday-gold: #ffd166;

/* ===== 半透明蒙层：不是全屏接管，透出后面的成员页 ===== */
.bday-overlay {
  position: fixed;
  inset: 0;
  /* 低于 Element Plus 弹层（2000+），否则复制/保存的成功提示会被盖住 */
  z-index: 1900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(14, 9, 30, 0.66);
  animation: bday-overlay-in 0.24s ease both;
}

@keyframes bday-overlay-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.bday-overlay__canvas,
.bday-overlay__glow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.bday-overlay__glow {
  background: radial-gradient(560px 460px at 50% 46%, rgba(255, 190, 110, 0.12), transparent 72%);
}

/* ===== 弹出卡片 ===== */
.bday-pop {
  position: relative;
  width: min(452px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px 14px;
  border-radius: var(--radius-card);
  /* 圆角容器用 inset 描边：overflow 裁圆角时 border 会在四角留下缺口 */
  overflow: auto;
  background: linear-gradient(165deg, rgba(46, 27, 76, 0.96), rgba(28, 17, 50, 0.97));
  box-shadow:
    0 34px 90px -28px rgba(6, 3, 18, 0.9),
    inset 0 0 0 1px rgba(255, 214, 148, 0.32);
  animation: bday-pop-in 0.24s ease both;
}

/* 整卡只淡入，内容元素各自错峰上浮；带 key 的内容重放不会晃整张卡 */
@keyframes bday-pop-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes bday-content-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.bday-pop__head,
.bday-pop__stage,
.bday-pop__tools,
.bday-dots,
.bday-pop__actions,
.bday-pop__tip {
  animation: bday-content-in 0.42s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}

.bday-pop__head {
  animation-delay: 0.06s;
}

.bday-pop__stage {
  animation-delay: 0.12s;
}

.bday-pop__tools {
  animation-delay: 0.18s;
}

.bday-dots {
  animation-delay: 0.22s;
}

.bday-pop__actions {
  animation-delay: 0.26s;
}

.bday-pop__tip {
  animation-delay: 0.3s;
}

.bday-pop__spark {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #ffe0a0;
  box-shadow: 0 0 12px 3px rgba(255, 208, 130, 0.6);
  pointer-events: none;
  animation: bday-twinkle 2.4s ease-in-out infinite;

  &--a {
    top: 20px;
    right: 74px;
  }

  &--b {
    bottom: 96px;
    left: 14px;
    animation-delay: 0.8s;
  }

  &--c {
    bottom: 42px;
    right: 20px;
    animation-delay: 1.6s;
  }
}

@keyframes bday-twinkle {
  0%,
  100% {
    opacity: 0.18;
    transform: scale(0.7);
  }

  50% {
    opacity: 1;
    transform: scale(1.3);
  }
}

.bday-pop__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.bday-pop__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bday-pop__eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: rgba(255, 214, 148, 0.7);
}

.bday-pop__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #fff4d9;
}

.bday-pop__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba($bday-white, 0.18);
  border-radius: 50%;
  color: $bday-white;
  background: rgba($bday-white, 0.08);
  cursor: pointer;
  transition: background-color 0.18s ease;

  &:hover {
    background: rgba($bday-white, 0.2);
  }
}

/* ===== 3D 卡面 ===== */
.bday-pop__stage {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 34px;
}

.bday-scene {
  flex: none;
  width: min(300px, 40vh);
  aspect-ratio: 3 / 4;
  perspective: 1000px;
}

.bday-3d {
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transform: rotateX(var(--tilt-x)) rotateY(var(--tilt-y));
  transition: transform 0.16s ease-out;
}

.bday-card {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: linear-gradient(158deg, #3a2065, #8a3559);
  box-shadow:
    0 26px 56px -20px rgba(8, 4, 22, 0.9),
    0 0 0 1px rgba(255, 220, 160, 0.55),
    inset 0 0 0 1px rgba($bday-white, 0.12);
}

.bday-card__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}

.bday-card__loading {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 12px;
  color: rgba(255, 240, 214, 0.82);
  background: linear-gradient(
    110deg,
    rgba($bday-white, 0.04) 30%,
    rgba($bday-white, 0.14) 50%,
    rgba($bday-white, 0.04) 70%
  );
  background-size: 220% 100%;
  animation: bday-loading 1.6s linear infinite;
}

.bday-card__loading-star {
  width: 26px;
  height: 26px;
  border: 2px dashed rgba(255, 220, 150, 0.7);
  border-radius: 50%;
  animation: bday-spin 2.6s linear infinite;
}

@keyframes bday-loading {
  to {
    background-position: -220% 0;
  }
}

@keyframes bday-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 镜面高光跟着鼠标走，是「卡」的质感，不属于导出内容 */
.bday-card__shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    118deg,
    transparent 24%,
    rgba($bday-white, 0.16) 44%,
    rgba($bday-white, 0.02) 56%,
    transparent 72%
  );
  background-position: var(--glow-x) var(--glow-y);
  pointer-events: none;
}

.bday-nav {
  position: absolute;
  top: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba($bday-white, 0.16);
  border-radius: 50%;
  color: rgba(255, 244, 224, 0.88);
  background: rgba($bday-white, 0.07);
  cursor: pointer;
  transform: translateY(-50%);
  transition: background-color 0.18s ease;

  &:hover {
    background: rgba($bday-white, 0.2);
  }

  &--prev {
    left: 0;
  }

  &--next {
    right: 0;
  }
}

/* ===== 小工具 / 指示点 ===== */
.bday-pop__tools {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
}

.bday-pop__hint {
  margin-right: auto;
  font-size: 11px;
  color: rgba(255, 240, 220, 0.5);
}

.bday-pop__tools button {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 5px 11px;
  border: 1px solid rgba($bday-white, 0.2);
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 11px;
  color: $bday-ink;
  background: rgba($bday-white, 0.08);
  cursor: pointer;
  transition: background-color 0.18s ease;

  &:hover {
    background: rgba($bday-white, 0.2);
  }
}

.bday-dots {
  flex: none;
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
}

.bday-dots__item {
  width: 7px;
  height: 7px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba($bday-white, 0.28);
  cursor: pointer;
  transition:
    transform 0.18s ease,
    background-color 0.18s ease;

  &.is-active {
    transform: scale(1.7);
    background: $bday-gold;
  }
}

/* ===== 动作栏 ===== */
.bday-pop__actions {
  flex: none;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.bday-actions__item {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 8px 13px;
  border: 1px solid rgba($bday-white, 0.2);
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: $bday-ink;
  background: rgba($bday-white, 0.09);
  cursor: pointer;
  transition:
    transform 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover:not(:disabled) {
    transform: translateY(-2px);
    background: rgba($bday-white, 0.18);
  }

  &:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  &.is-primary {
    border-color: transparent;
    font-weight: 700;
    color: #3d2450;
    background: linear-gradient(135deg, #fff1c9, #ffc53d 70%, #ff9ec4);
    box-shadow: 0 8px 20px -8px rgba(255, 197, 61, 0.9);

    &:hover:not(:disabled) {
      background: linear-gradient(135deg, #fff8e4, $bday-gold 70%, #ffb1cd);
    }
  }
}

.bday-pop__tip {
  flex: none;
  margin: 0;
  text-align: center;
  font-size: 10px;
  color: rgba(255, 240, 220, 0.42);
}

@media (prefers-reduced-motion: reduce) {
  .bday-overlay,
  .bday-pop,
  .bday-pop__head,
  .bday-pop__stage,
  .bday-pop__tools,
  .bday-dots,
  .bday-pop__actions,
  .bday-pop__tip,
  .bday-card__loading,
  .bday-card__loading-star,
  .bday-pop__spark {
    animation: none;
  }

  .bday-3d,
  .bday-pop__close,
  .bday-pop__tools button,
  .bday-nav,
  .bday-actions__item,
  .bday-dots__item {
    transition: none;
  }

  .bday-actions__item:hover:not(:disabled) {
    transform: none;
  }
}
</style>
