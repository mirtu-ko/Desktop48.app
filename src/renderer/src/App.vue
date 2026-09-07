<script setup lang="ts">
import { ref } from 'vue'
import AppTitleBar from './components/app/AppTitleBar.vue'
import Initialize from './components/app/Initialize.vue'
import Index from './pages/Index.vue'

const isInitialized = ref(false)

function onInitialized() {
  isInitialized.value = true
}
</script>

<template>
  <div id="app">
    <AppTitleBar />
    <div class="app-body">
      <Initialize v-if="!isInitialized" @initialized="onInitialized" />
      <Index v-else />
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
</style>
