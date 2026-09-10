import type { RouteRecordRaw } from 'vue-router'
import Albums from './pages/Albums.vue'
import Downloads from './pages/Downloads.vue'
import Lives from './pages/Lives.vue'
import Members from './pages/Members.vue'
import Setting from './pages/Setting.vue'
import Shows from './pages/Shows.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/lives',
    component: Lives,
    // ?tab=playback&member=<userId>：成员详情抽屉「看 TA 的回放」的跳转参数，
    // Lives 页 onMounted 读取（keep-alive 下仅首次挂载生效，后续跳转走 watch）
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
    path: '/setting',
    component: Setting,
  },
  {
    path: '/downloads',
    component: Downloads,
  },
  {
    path: '/',
    redirect: '/lives',
  },
]
export default routes
