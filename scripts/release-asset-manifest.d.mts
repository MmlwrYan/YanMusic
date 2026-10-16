/**
 * `scripts/release-asset-manifest.mjs` 的类型声明。
 *
 * 与 `scripts/check-native-freshness.d.mts` 同一做法：仓库里的 `.mjs` 脚本
 * 若被 `.ts` 测试 import，就配一份 `.d.mts`，让 `vue-tsc --noEmit` 能通过，
 * 同时**不引入**「把脚本改写成 TypeScript」这种更大改动。
 */

/** electron-builder 生成的自动更新元数据文件名（逐个列出）。 */
export declare const EXPECTED_METADATA: readonly string[];

/** 非元数据产物的后缀；真实产物名为 `YanMusic-<版本>-<后缀>`。 */
export declare const EXPECTED_PAYLOAD_SUFFIXES: readonly string[];

/** 约定产物总数（平台产物 + 元数据）。 */
export declare const EXPECTED_TOTAL: number;

/** 清单比对结果。 */
export interface ManifestComparison {
  ok: boolean;
  expected: string[];
  actual: string[];
  /** 清单有、实际没有 */
  missing: string[];
  /** 实际有、清单没有（**多余文件**，v1.4.0/v1.4.2 两次事故都是这一类） */
  unexpected: string[];
}

/** 把一组真实文件名与清单做双向比对。 */
export declare function compareAgainstManifest(
  actualNames: readonly string[],
  version: string,
): ManifestComparison;
