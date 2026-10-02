<script setup lang="ts">
import { Film, VideoCamera } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FloatingTabBar from './FloatingTabBar.vue'

const emit = defineEmits<{ refresh: [] }>()

const route = useRoute()
const router = useRouter()

/** 当前路径映射为直播/回放页签 */
const activeTab = computed(() =>
  route.path === '/lives/playbacks' ? 'playback' : 'live',
)

const viewTabs = [
  { label: '直播', key: 'live', icon: VideoCamera },
  { label: '回放', key: 'playback', icon: Film },
]

function switchTab(tab: string) {
  if (tab === 'playback')
    router.push('/lives/playbacks')
  else if (route.path !== '/lives')
    router.push('/lives')
}
</script>

<template>
  <FloatingTabBar
    :tabs="viewTabs"
    :active="activeTab"
    @change="switchTab"
    @refresh="emit('refresh')"
  />
</template>
