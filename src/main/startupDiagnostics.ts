/**
 * S-3（v1.3.0）：启动关键路径的**降级记录**。
 *
 * ## 问题
 *
 * 修复前，启动期关键服务的失败处理是**不一致**的，且用户完全无感知：
 *
 * - `app.ts` 里 `initApiServer` / `initMpvPlayer` 失败**只写 `log.error`** ——
 *   应用照常启动，但音频引擎或内置 API 服务是坏的，界面不会告诉用户任何事；
 * - `storage/native.ts` 的 addon 加载失败**直接 `throw`** ——
 *   错误会一路冒泡，可能崩在窗口创建前（用户只看到应用打不开，没有任何解释）。
 *
 * 规划 §2.2 S-3 的要求：区分「**可降级**」与「**不可降级**」——
 * 音频引擎失败 → 主界面仍可打开并**明确提示**；
 * 本地库不可用 → **明确提示**而不是崩在窗口创建前。
 *
 * ## 本模块的职责
 *
 * 只做一件事：把「启动期哪一步降级/失败了」记录下来，供
 * ① 渲染层展示给用户、② 诊断包（S-6）导出。
 *
 * 判定边界（刻意不在本模块内做）：
 * - 「降级后能否继续」由**调用方**决定（见 `app.ts`）：`fatal` 为真时由调用方
 *   弹出明确错误并优雅退出；本模块**不自行退出**，以免隐藏控制流。
 * - 本模块**零依赖**（无 electron、无 IO），故可被 `node --test` 直接驱动，
 *   并可安全地被渲染层/诊断包复用（只读快照）。
 */

// 类型定义放在 `shared/app.ts`（**单一真源**）：主进程是记录方、渲染层是展示方，
// 共用一份定义可避免枚举值漂移导致「主进程记了、渲染层不认识」的静默丢失
//（F-6 处理 kv 白名单时是同一类问题）。此处只做**类型**导入/再导出，
// 不引入任何运行时依赖 —— 本模块仍保持零依赖，可在 node 下直接单测。
import type { StartupDegradationInfo, StartupDegradationKind } from '../shared/app';

export type { StartupDegradationKind };

export type StartupDegradation = StartupDegradationInfo;

const degradations: StartupDegradation[] = [];

/**
 * 记录一条启动降级。
 *
 * 同一 `kind` **只保留首次**：启动路径里可能存在重试（如 addon 的主/备路径），
 * 反复记录同一条会让界面上出现重复提示、也会让诊断包失真。
 */
export const recordStartupDegradation = (item: StartupDegradation): void => {
  if (degradations.some((existing) => existing.kind === item.kind)) return;
  degradations.push({
    kind: item.kind,
    message: String(item.message ?? '').trim() || '未知原因',
    fatal: Boolean(item.fatal),
  });
};

/** 只读快照（返回副本，调用方无法从外部改动内部状态）。 */
export const getStartupDegradations = (): StartupDegradation[] =>
  degradations.map((item) => ({ ...item }));

/** 是否存在不可降级的失败（调用方据此决定是否优雅退出）。 */
export const hasFatalStartupDegradation = (): boolean => degradations.some((item) => item.fatal);

/** 仅供测试：清空记录，避免用例间相互污染。 */
export const resetStartupDiagnosticsForTest = (): void => {
  degradations.length = 0;
};
