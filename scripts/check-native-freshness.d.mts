/**
 * `scripts/check-native-freshness.mjs` 的类型声明（V4-01，v1.4.0）。
 *
 * **为什么需要**：与 `check-bundle-size.d.mts` / `scan-dead-modules.d.mts` 同因 ——
 * `tests/native-freshness.test.ts` 直接 import 这个 `.mjs`，而 `moduleResolution: "bundler"`
 * 且未开 `allowJs` 时 TS 推导不出类型，会报 `TS7016`。
 *
 * ⚠️ **这个坑已经踩过两次**，后果很阴：CI 构建是 `vue-tsc --noEmit && vite build`，
 * `&&` 短路会让类型错误表现为「electron-builder 找不到 dist-electron/main/index.js」。
 * 新增任何被测试 import 的 `.mjs` 时，**顺手把同名 `.d.mts` 一起写上**。
 */

/** 四个原生 addon 的目录名 */
export declare const NATIVE_ADDON_DIRS: readonly string[];

export interface NativeAddonFreshness {
  name: string;
  binaryPath: string;
  binaryExists: boolean;
  binaryMtimeMs: number;
  newestSourcePath: string;
  newestSourceMtimeMs: number;
  /** 产物存在、且有源可依，但源比产物新 */
  stale: boolean;
  /** 产物不存在 */
  missing: boolean;
}

export interface NativeFreshnessResult {
  /** 是否**至少有一个**产物存在（全缺 = 干净检出，调用方应 skip 并标注未校验） */
  present: boolean;
  addons: NativeAddonFreshness[];
  staleAddons: NativeAddonFreshness[];
  missingAddons: NativeAddonFreshness[];
}

export declare function findNewestSource(
  crateDir: string,
): { path: string; mtimeMs: number } | null;

export declare function checkNativeFreshness(options?: {
  root?: string;
  addonDirs?: readonly string[];
}): NativeFreshnessResult;

export declare function parseCargoSourceReplacement(
  configText: string,
): { alias: string; registry: string } | null;

export declare function toProbeUrl(registry: string): string;

export declare function describeCargoMirrorDiagnosis(info: {
  alias: string;
  registry: string;
  probeUrl?: string;
  reason?: string;
}): string;
