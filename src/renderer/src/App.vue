<script setup lang="ts">
import { Download, Headset, Microphone, Setting, User, VideoCamera } from '@element-plus/icons-vue'
import AppDock from '@renderer/components/app/AppDock.vue'
import AppTitleBar from '@renderer/components/app/AppTitleBar.vue'
import BackTopButton from '@renderer/components/app/BackTopButton.vue'
import Initialize from '@renderer/components/app/Initialize.vue'
import FloatAudioBar from '@renderer/components/floats/FloatAudioBar.vue'
import FloatPlayerHost from '@renderer/components/floats/FloatPlayerHost.vue'
import { useMemberSync } from '@renderer/composables/use-member-sync'
import useTasksStore from '@renderer/stores/tasks'
import Constants from '@renderer/utils/constants'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 应用根组件：标题栏 + 初始化门 + 主界面骨架（Dock 导航 / 路由视图 / 全局浮层）。
 *
 * 主界面原先是 pages/Index.vue，但它并不在路由表里，本质是布局壳而非页面，
 * 故合并到此，不再两层套壳。
 */

const router = useRouter()
const route = useRoute()

// 初始化门：Initialize 完成 ffmpeg 环境自检后 emit，之后才渲染主界面
const isInitialized = ref(false)

function onInitialized() {
  isInitialized.value = true
}

// 菜单值即路由 path，两者共用同一份定义（见 utils/constants.ts 的 Menu），
// 此前这里手工维护的 pathToMenu 是与 Constants.Menu / routes.ts 重复的第三份副本
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

// 底部 Dock 菜单项（语义色统一取自 Constants.Theme；每项专属色用于激活/悬浮的图标渐变）。
// index 就是路由 path（Constants.Menu 的值），同时充当激活态匹配标识
const dockItems = computed(() => [
  { index: Constants.Menu.LIVES, label: '直播', icon: VideoCamera, color: Constants.Theme.LIVES },
  { index: Constants.Menu.SHOWS, label: '公演', icon: Microphone, color: Constants.Theme.SHOWS },
  { index: Constants.Menu.ALBUMS, label: '专辑', icon: Headset, color: Constants.Theme.ALBUMS },
  { index: Constants.Menu.MEMBERS, label: '成员', icon: User, color: Constants.Theme.MEMBERS },
  { index: Constants.Menu.DOWNLOADS, label: '下载', icon: Download, color: Constants.Theme.DOWNLOADS, badge: runningTaskCount.value },
  { index: Constants.Menu.SETTING, label: '设置', icon: Setting, color: Constants.Theme.SETTING },
])

/** path 带前导斜杠，是绝对路径——此前传的是 'lives' 这种相对路径，会被 vue-router 按"相对当前路径"解析 */
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

// 原 Index.vue 是挂在「初始化通过」分支上的，合并后要显式等这一时机，
// 否则会在 ffmpeg 环境就绪前就去访问数据库
watch(isInitialized, async (ready) => {
  if (ready) {
    await ensureMembers()
  }
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
            <keep-alive>
              <component :is="Component" />
            </keep-alive>
          </router-view>
        </div>

        <!-- 底部 Dock 导航栏（磨砂表层复用全局 .frosted-surface） -->
        <AppDock
          :items="dockItems"
          :active="activeIndex"
          @change="changeMenu"
        />

        <!-- 右下角全局回到顶部按钮：自动定位当前页面的主滚动容器 -->
        <BackTopButton />

        <!-- 全局画中画迷你窗：跨页面持续播放 -->
        <FloatPlayerHost />

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
    radial-gradient(1100px 480px at 90% -8%, rgba(109, 90, 224, 0.07), transparent 60%),
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
