<script setup lang="ts">
import type { ComponentInternalInstance, ComponentPublicInstance } from 'vue'
import { Download, Headset, Microphone, Setting, User, VideoCamera } from '@element-plus/icons-vue'
import AppDock from '@renderer/components/app/AppDock.vue'
import AppTitleBar from '@renderer/components/app/AppTitleBar.vue'
import BackTopButton from '@renderer/components/app/BackTopButton.vue'
import Initialize from '@renderer/components/app/Initialize.vue'
import FloatAudioBar from '@renderer/components/floats/FloatAudioBar.vue'
import { useMemberSync } from '@renderer/composables/use-member-sync'
import useTasksStore from '@renderer/stores/tasks'
import Constants from '@renderer/utils/constants'
import { computed, KeepAlive, onErrorCaptured, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 应用根组件：标题栏 + 初始化门 + 主界面骨架（Dock 导航 / 路由视图 / 全局浮层）。
 */

const router = useRouter()
const route = useRoute()

// 初始化门：Initialize 完成 ffmpeg 环境自检后 emit，之后才渲染主界面
const isInitialized = ref(false)

function onInitialized() {
  isInitialized.value = true
}

// 菜单值即路由 path，两者共用同一份定义（见 utils/constants.ts 的 Menu），
const MENU_PATHS: string[] = Object.values(Constants.Menu)

/** 未知 path（如重定向发生前的 '/'）一律回退到直播页，保证 Dock 始终有高亮项 */
function resolveActiveMenu(path: string): string {
  return MENU_PATHS.includes(path) ? path : Constants.Menu.LIVES
}

const activeIndex = ref(resolveActiveMenu(route.path))

// 任务状态由 useTasksStore 模块级单例持有，跨页面实时更新 Dock 角标
const { recordTasks, downloadTasks } = useTasksStore()

// Dock「下载」角标：正在下载中的任务数量
const runningTaskCount = computed(() => downloadTasks.value.filter(task => task.status === 'running').length + recordTasks.value.filter(task => task.status === 'running').length)

// 底部 Dock 菜单项（语义色引用 app.scss 的 --color-* 变量）。
// index 就是路由 path（Constants.Menu 的值），同时充当激活态匹配标识
const dockItems = computed(() => [
  { index: Constants.Menu.LIVES, label: '直播', icon: VideoCamera, color: 'var(--color-lives)' },
  { index: Constants.Menu.SHOWS, label: '公演', icon: Microphone, color: 'var(--color-shows)' },
  { index: Constants.Menu.ALBUMS, label: '专辑', icon: Headset, color: 'var(--color-albums)' },
  { index: Constants.Menu.MEMBERS, label: '成员', icon: User, color: 'var(--color-members)' },
  { index: Constants.Menu.DOWNLOADS, label: '下载', icon: Download, color: 'var(--color-downloads)', badge: runningTaskCount.value },
  { index: Constants.Menu.SETTING, label: '设置', icon: Setting, color: 'var(--color-setting)' },
])

/** 导航 path 必须带前导斜杠，确保 vue-router 按绝对路径解析 */
function changeMenu(path: string) {
  activeIndex.value = path
  router.push(path)
}

// 路由变化时自动同步菜单高亮
watch(
  () => route.path,
  (newPath) => {
    activeIndex.value = resolveActiveMenu(newPath)
  },
)

// 启动兜底：数据库没有成员信息时自动同步一次（逻辑见 use-member-sync.ts）
const { ensureMembers } = useMemberSync()

// ffmpeg 环境自检完成后再访问数据库，避免初始化阶段触发数据依赖
watch(isInitialized, async (ready) => {
  if (ready) {
    await ensureMembers()
  }
})

/**
 * 页面层渲染兜底：页面被 keep-alive 缓存后，一次渲染错误会让它永久卡在半更新的 DOM 上，
 * 而桌面端没有重载入口（用户只能重启应用）。这里捕获页面层的渲染错误，自动重挂整层
 * （key 变化 → keep-alive 重建、缓存清空），页面重新挂载即重新拉数据；
 * 浮动播放器在 keep-alive 之外，不受影响。
 */
const pageLayerKey = ref(0)
/** 已自动重挂过的路由 path：同一 path 只重挂一次，确定性错误（如脏数据）不至于反复重挂 */
let remountedPath: string | null = null

// 切页后允许新页面再享受一次自动恢复
watch(() => route.path, () => {
  remountedPath = null
})

/** 错误是否来自 keep-alive 包裹的页面层：标题栏 / Dock / 浮动播放器等全局浮层不算（公开实例要经 `$` 取内部实例） */
function isFromPageLayer(instance: ComponentPublicInstance | null): boolean {
  let cur: ComponentInternalInstance | null | undefined = instance?.$
  while (cur) {
    if (cur.vnode.type === KeepAlive)
      return true
    cur = cur.parent
  }
  return false
}

/** 只有渲染/更新期出错才重挂：事件回调里的普通报错不该把页面状态一起清掉 */
const RENDER_ERROR_INFO = ['render function', 'component update']

onErrorCaptured((error, instance, info) => {
  if (!isFromPageLayer(instance) || !RENDER_ERROR_INFO.includes(info))
    return
  if (remountedPath === route.path) {
    console.error(`[app] 页面渲染再次失败，停止自动恢复（${info}）:`, error)
    return false
  }
  remountedPath = route.path
  console.error(`[app] 页面渲染失败，自动重挂页面层（${info}）:`, error)
  pageLayerKey.value += 1
  return false
})
</script>

<template>
  <div id="app">
    <AppTitleBar />
    <div class="app-body">
      <Initialize v-if="!isInitialized" @initialized="onInitialized" />

      <div v-else class="app-layout">
        <div class="app-content">
          <router-view v-slot="{ Component }">
            <!-- key 只在页面渲染失败时递增，用来重建 keep-alive（清掉坏掉的缓存实例），平时恒为 0 -->
            <KeepAlive :key="pageLayerKey">
              <component :is="Component" />
            </KeepAlive>
          </router-view>
        </div>

        <!-- 底部 Dock 导航栏（玻璃配方复用全局 --glass-* token） -->
        <AppDock
          :items="dockItems"
          :active="activeIndex"
          @change="changeMenu"
        />

        <!-- 右下角全局回到顶部按钮：自动定位当前页面的主滚动容器 -->
        <BackTopButton />

        <!-- 全局音乐迷你播放条：跨页面持续播放专辑歌曲 -->
        <FloatAudioBar />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
#app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  /* 整窗唯一的画布背景：柔和渐变底 + 两角淡彩光晕。
   * 页面内容与底部 Dock、右上角浮层都透明地叠在这层之上，彼此之间不存在色差 */
  background:
    radial-gradient(1100px 480px at 90% -8%, rgba(var(--brand-rgb), 0.07), transparent 60%),
    radial-gradient(900px 420px at -8% 108%, rgba(255, 143, 184, 0.06), transparent 55%),
    linear-gradient(180deg, #f3f3fb, var(--el-bg-color-page));

  > * {
    flex: 1;
    min-height: 0;
  }
}

/* 内容区：撑满剩余空间 + 自身滚动 + 底部预留 Dock 空间。
 * 背景完全透明，直接透出 .app-body 的画布层 */
.app-content {
  flex: 1;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  padding: 0px;
  overflow: auto;
}
</style>
