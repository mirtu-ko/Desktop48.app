import ElementPlus from 'element-plus'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import routes from './routes'
import { installTasks } from './stores/tasks'

import 'element-plus/dist/index.css'
import './assets/css/app.scss'

const app = createApp(App)

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

app.use(router).use(ElementPlus)

// 显式安装任务系统（早于任何组件 setup 订阅事件并恢复一次任务快照）：
// 副作用集中在唯一入口，避免"import use-tasks 即触发"的隐式行为
installTasks()

app.mount('#app')
