/**
 * `scripts/scan-dead-modules.mjs` 的类型声明。
 *
 * **为什么需要这个文件**：`tsconfig.json` 的 `include` 覆盖 `tests/**\/*.ts`，
 * 而 `tests/source-level-guards.test.ts` 直接 `import` 了这个 `.mjs`。
 * 在 `moduleResolution: "bundler"` 且未开 `allowJs` 的配置下，TypeScript 无法
 * 为 `.mjs` 推导类型：
 *
 *   1. `TS7016` —— 找不到模块声明文件；
 *   2. 返回值退化为 `any` → 下游回调参数触发 `TS7006`（隐式 any）。
 *
 * **为什么这件事必须当真**：CI 的构建步骤是
 * `pnpm exec vue-tsc --noEmit && pnpm exec vite build`（`&&` 短路）。
 * 类型检查一旦非 0 退出，`vite build` **根本不会执行** —— 于是
 * `dist-electron/main/index.js` 不存在，而 `electron-builder` 要到
 * `sanityCheckPackage` 才报错，症状是「打包失败」而非「类型错误」，
 * 排查时极易被误导到产物/打包配置上去。
 *
 * v1.2.9 首轮干跑六条腿全红即栽在此处（本机最后一次 `vue-tsc` 跑在新增测试
 * 文件之前，漏检）。故补此声明，并在流程上要求：**新增任何测试文件后必须重跑
 * `vue-tsc`**，不能只跑 `node --test`。
 */

/** 单个零引用模块的记录（路径为仓库相对路径，POSIX 分隔） */
export interface DeadModuleEntry {
  /** 相对仓库根的路径 */
  file: string;
  /** 文件行数 */
  lines: number;
}

/** 一次完整扫描的结果 */
export interface DeadModuleScanResult {
  /** 扫描到的 `src/` 源文件总数 */
  scanned: number;
  /** 由 5 个应用入口 BFS 可达的文件数 */
  reachable: number;
  /** 不可达（零引用）文件数 */
  unreachable: number;
  /** 配置里声明了但磁盘上不存在的入口（通常是路径写错） */
  missingEntries: string[];
  /** A 类：真零引用 —— 可删，删除前仍须人工确认 */
  A: DeadModuleEntry[];
  /** B 类：被 `import.meta.glob` 覆盖（插件 API 面）—— 不可删 */
  B: DeadModuleEntry[];
  /** T 类：仅被 tests 引用（契约锚点）—— 应改为生产代码引用，而非让测试吊着 */
  T: DeadModuleEntry[];
}

/** 执行一次扫描，返回 A/B/T 三类清单 */
export function scanDeadModules(): DeadModuleScanResult;
