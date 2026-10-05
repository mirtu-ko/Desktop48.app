import type { RouteRecordRaw } from 'vue-router'
import Albums from './pages/Albums.vue'
import Elections from './pages/Elections.vue'
import Lives from './pages/Lives.vue'
import Members from './pages/Members.vue'
import Playbacks from './pages/Playbacks.vue'
import Setting from './pages/Setting.vue'
import Shows from './pages/Shows.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/lives',
    component: Lives,
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
