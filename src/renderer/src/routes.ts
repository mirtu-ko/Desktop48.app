import type { RouteRecordRaw } from 'vue-router'

/**
 * 页面按需加载：每个页面各自成 chunk，导航进入时才加载（file:// 本地读取，切页开销可忽略）。
 * vue-router 原生支持懒加载，无需再用 defineAsyncComponent 包一层。
 * KeepAlive 缓存的是解析后的页面实例，激活/停用行为不变。
 */
const Albums = () => import('./pages/Albums.vue')
const Elections = () => import('./pages/Elections.vue')
const Lives = () => import('./pages/Lives.vue')
const Members = () => import('./pages/Members.vue')
const Playbacks = () => import('./pages/Playbacks.vue')
const Rooms = () => import('./pages/Rooms.vue')
const Setting = () => import('./pages/Setting.vue')
const Shows = () => import('./pages/Shows.vue')

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
