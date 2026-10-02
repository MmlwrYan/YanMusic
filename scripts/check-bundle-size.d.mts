/**
 * `scripts/check-bundle-size.mjs` 的类型声明（S-5，v1.3.0）。
 *
 * **为什么需要**：`tsconfig.json` 的 `include` 覆盖 `tests/**\/*.ts`，而
 * `tests/bundle-size-guard.test.ts` 直接 import 这个 `.mjs`。在
 * `moduleResolution: "bundler"` 且未开 `allowJs` 时，TS 无法推导 `.mjs` 的类型 →
 * `TS7016` + 下游隐式 any。
 *
 * **这个坑已经踩过一次**（v1.2.9 的 `scan-dead-modules.d.mts`），后果很阴：
 * CI 构建是 `vue-tsc --noEmit && vite build`，`&&` 短路会让类型错误表现为
 * 「electron-builder 找不到 dist-electron/main/index.js」的打包失败。
 * 故新增任何被测试 import 的 `.mjs` 时，**顺手把同名 `.d.mts` 一起写上**。
 */

/** 首屏入口资源合计字节的基线 */
export declare const ENTRY_BASELINE_BYTES: number;

/** 容忍带比例（0.02 = +2%） */
export declare const ENTRY_TOLERANCE_RATIO: number;

export interface BundleSizeResult {
  /** 是否在预算内（`present === false` 时恒为 false） */
  ok: boolean;
  /** 产物是否存在（`dist/index.html`） */
  present: boolean;
  /** 入口资源合计字节 */
  totalBytes: number;
  /** 预算上限（基线 × (1 + 容忍带)） */
  budgetBytes: number;
  /** 入口引用的资源个数（去重后） */
  entryCount: number;
  /** 被引用但磁盘上不存在的资源（通常是构建异常） */
  missing: string[];
}

export declare function checkBundleSize(options?: {
  root?: string;
  baselineBytes?: number;
  tolerance?: number;
}): BundleSizeResult;
