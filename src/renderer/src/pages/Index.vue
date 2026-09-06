<script setup lang="ts">
import { Download, Headset, Microphone, Setting, User, VideoCamera } from '@element-plus/icons-vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppDock from '../components/app/AppDock.vue'
import BackTopButton from '../components/app/BackTopButton.vue'
import FloatAudioBar from '../components/floats/FloatAudioBar.vue'
import FloatPlayerHost from '../components/floats/FloatPlayerHost.vue'
import { useMemberSync } from '../composables/data/use-member-sync'
import useTasks from '../composables/tasks/use-tasks'
import EventBus from '../services/event-bus'
import Constants from '../utils/constants'

const router = useRouter()
const route = useRoute()

// 路由 path 与菜单 index 的映射
const pathToMenu = {
  '/lives': Constants.Menu.LIVES,
  '/shows': Constants.Menu.Shows,
  '/albums': Constants.Menu.Albums,
  '/members': Constants.Menu.Members,
  '/downloads': Constants.Menu.DOWNLOADS,
  '/setting': Constants.Menu.SETTING,
}

const activeIndex = ref(pathToMenu[route.path as keyof typeof pathToMenu] || Constants.Menu.LIVES)

// 任务状态由 useTasks 模块级单例持有，跨页面实时更新 Dock 角标
const { recordTasks, downloadTasks } = useTasks()

// Dock「下载」角标：正在下载中的任务数量
const runningTaskCount = computed(() => downloadTasks.value.filter(task => task.isRunning()).length + recordTasks.value.filter(task => task.isRunning()).length)

// 底部 Dock 菜单项（语义色统一取自 Constants.Theme；每项专属色用于激活/悬浮的图标渐变）
const dockItems = computed(() => [
  { index: Constants.Menu.LIVES, label: '直播', icon: VideoCamera, color: Constants.Theme.LIVES },
  { index: Constants.Menu.Shows, label: '公演', icon: Microphone, color: Constants.Theme.SHOWS },
  { index: Constants.Menu.Albums, label: '专辑', icon: Headset, color: Constants.Theme.ALBUMS },
  { index: Constants.Menu.Members, label: '成员', icon: User, color: Constants.Theme.MEMBERS },
  { index: Constants.Menu.DOWNLOADS, label: '下载', icon: Download, color: Constants.Theme.DOWNLOADS, badge: runningTaskCount.value },
  { index: Constants.Menu.SETTING, label: '设置', icon: Setting, color: Constants.Theme.SETTING },
])

function changeMenu(menu: string) {
  activeIndex.value = menu
  router.push(menu)
}

// 路由变化时自动同步菜单高亮
watch(
  () => route.path,
  (newPath) => {
    activeIndex.value = pathToMenu[newPath as keyof typeof pathToMenu] || Constants.Menu.LIVES
  },
)

/** EventBus 'change-selected-menu' 的处理器（menu 字符串，见 event-bus.ts Events 登记） */
const changeMenuHandler: (menu: string) => void = changeMenu

// 启动兜底：数据库没有成员信息时自动同步一次（逻辑见 use-member-sync.ts）
const { ensureMembers } = useMemberSync()

onMounted(async () => {
  EventBus.on('change-selected-menu', changeMenuHandler)
  await ensureMembers()
})

onUnmounted(() => {
  EventBus.off('change-selected-menu', changeMenuHandler)
})
</script>

<template>
  <div class="app-layout">
    <div class="app-content">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <Suspense>
            <template #default>
              <component :is="Component" />
            </template>
            <template #fallback>
              <div>Loading...</div>
            </template>
          </Suspense>
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
</template>

<style scoped lang="scss">
/* 内容区：撑满剩余空间 + 自身滚动 + 底部预留 Dock 空间。
 * 背景完全透明，直接透出 App.vue 的画布层 */
.app-content {
  flex: 1;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  padding: 0px;
  overflow: auto;
}
</style>
