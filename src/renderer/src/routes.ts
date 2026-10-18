import type { RouteRecordRaw } from 'vue-router'
import { defineAsyncComponent } from 'vue'

/**
 * 页面按需加载：此前全部静态 import，首屏必须下载所有页面的代码。
 * 改为异步组件后每个页面各自成 chunk（Electron 从本地 file:// 读取，切页开销可忽略）；
 * KeepAlive 与异步组件兼容——缓存的是解析后的页面实例，激活/停用行为不变。
 */
const Albums = defineAsyncComponent(() => import('./pages/Albums.vue'))
const Elections = defineAsyncComponent(() => import('./pages/Elections.vue'))
const Lives = defineAsyncComponent(() => import('./pages/Lives.vue'))
const Members = defineAsyncComponent(() => import('./pages/Members.vue'))
const Playbacks = defineAsyncComponent(() => import('./pages/Playbacks.vue'))
const Rooms = defineAsyncComponent(() => import('./pages/Rooms.vue'))
const Setting = defineAsyncComponent(() => import('./pages/Setting.vue'))
const Shows = defineAsyncComponent(() => import('./pages/Shows.vue'))

const routes: RouteRecordRaw[] = [
  {
    path: '/lives',
    component: Lives,
  },
  {
    path: '/rooms',
    component: Rooms,
  },
  {
    path: '/lives/playbacks',
    component: Playbacks,
    // query 预置成员筛选
    props: route => ({
      memberPreset: route.query.member
        ? { userId: String(route.query.member) }
        : null,
    }),
  },
  {
    path: '/shows',
    component: Shows,
  },
  {
    path: '/albums',
    component: Albums,
  },
  {
    path: '/members',
    component: Members,
  },
  {
    path: '/elections',
    component: Elections,
  },
  {
    path: '/setting',
    component: Setting,
  },
  {
    path: '/',
    redirect: '/lives',
  },
]
export default routes
