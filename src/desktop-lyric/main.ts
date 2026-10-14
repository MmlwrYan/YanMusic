import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import App from './App.vue';
import { installPluginRuntime } from '@/plugins/runtime';
import { sqlitePersistPlugin } from '@/stores/sqlitePersist';
import { installCspViolationReporter } from '@/utils/cspViolationReporter';
import { installE2eTestHook } from '../renderer/e2eHook';
import '../renderer/style.css';

// N-02 观测：与主窗口一致地收集 CSP 违规（仅报告，不阻断）。
installCspViolationReporter();

const app = createApp(App);
const pinia = createPinia();
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      name: 'desktop-lyric',
      component: App,
    },
  ],
});

pinia.use(sqlitePersistPlugin);
app.use(pinia);
app.use(router);
app.component('Icon', Icon);
installPluginRuntime({ app, router, pinia });
app.mount('#app');
// V4-07（v1.4.0）：桌面歌词窗口也需要 E2E 钩子 —— 游标就渲染在这个窗口里。
// 未设置 VITE_YANMUSIC_E2E 时整段被构建期静态消除，不进入正式产物。
installE2eTestHook();
