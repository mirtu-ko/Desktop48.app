import ElementPlus from 'element-plus'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { FLOAT_WINDOW_HASH_PATH } from '../../common/float-window'
import App from './App.vue'
import FloatWindowApp from './components/floats/FloatWindowApp.vue'
import routes from './routes'
import { installFloatPlayers } from './stores/float-players'
import { installTasks } from './stores/tasks'

import 'element-plus/dist/index.css'
import './assets/css/app.scss'

// 独立播放窗与主窗口复用同一份 index.html，靠 hash 分流：命中 FLOAT_WINDOW_HASH_PATH 即播放窗。
// 该常量与主进程拼 loadFile hash 时用的是同一个（src/common/float-window.ts），
// 避免两侧各写一份 '/float' 字面量而悄悄漂移。
// 播放窗刻意不挂 App.vue、不装 router，因此不会触发 Initialize 的 ffmpeg 初始化门、
// useMemberSync、useTasksStore 等主界面副作用，打开即播。
if (window.location.hash.slice(1).startsWith(FLOAT_WINDOW_HASH_PATH)) {
  // 播放窗也要安装任务系统：任务列表是主进程注册表的镜像（不跨进程共享），
  // 不装就既看不到别处发起的录制 / 下载（播放器按钮状态错），
  // 也不会把本窗发起的任务同步给主窗口的下载页。
  // silent：播放窗只静默镜像，完成提示留给发起窗口弹，避免两个窗口各弹一次。
  installTasks({ silent: true })
  createApp(FloatWindowApp).use(ElementPlus).mount('#app')
}
else {
  const app = createApp(App)

  const router = createRouter({
    history: createWebHashHistory(),
    routes,
  })

  app.use(router).use(ElementPlus)

  // 显式安装任务系统（早于任何组件 setup 订阅事件并恢复一次任务快照）：
  // 副作用集中在唯一入口，避免"import use-tasks 即触发"的隐式行为
  installTasks()

  // 主窗口侧的独立播放窗桥接：把主进程转发来的 live-unavailable 重新注入本地 EventBus
  installFloatPlayers()

  app.mount('#app')
}
