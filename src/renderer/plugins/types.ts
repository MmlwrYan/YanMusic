import type { App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import type { pluginRuntimeState } from './runtime';

/**
 * 插件全局运行时对象。
 *
 * 历史名称为 `EchoGlobalRuntime`（沿用上游 EchoMusic 命名），现保留为 deprecated alias，
 * 新代码请使用 `YanGlobalRuntime`。两者结构完全相同，可互换使用。
 */
export interface YanGlobalRuntime {
  app: VueApp;
  router: Router;
  pinia: Pinia;
  plugins: typeof pluginRuntimeState;
  executeCommand: (id: string, ...args: unknown[]) => unknown;
}

/** @deprecated 使用 `YanGlobalRuntime`。保留仅为兼容既有引用。 */
export type EchoGlobalRuntime = YanGlobalRuntime;

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    /** @deprecated 使用 `$yanmusic`。保留仅为兼容既有插件。 */
    $echo: YanGlobalRuntime;
    /** 与 `$echo` 指向同一对象；新插件建议使用该名称。 */
    $yanmusic: YanGlobalRuntime;
  }
}
