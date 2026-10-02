/**
 * P-3（v1.3.0）：插件能力调用的**发送方身份绑定**（M-1）。
 *
 * ## 问题
 *
 * 修复前，所有 `plugins:` 能力通道都**按调用方自报的 `pluginId` 入参**做能力判定 ——
 * 注册点把入参 `pluginId` 原样交给能力实现：
 *
 * ```ts
 * // 修复前的能力实现（pluginId 完全来自调用方）
 * deletePluginSqlite(pluginId, name);
 * ```
 *
 * ⚠️ 此处刻意**不写出完整的注册调用**（不写「注册函数名 + 真实通道名」的形式）：
 * `tests/ipc-channel-contract.test.ts` 的「无重复注册」守卫会扫描源码里的注册调用，
 * 在文档注释中写出完整调用会被误判为「本文件也注册了该通道」而误报。
 * 同理，下文的通道白名单只列**通道名字符串**，不带注册函数名。
 *
 * 于是任何能触达 IPC 的代码都可以**冒充其他插件**：
 *
 * - `plugins:sqlite:delete(他人的 pluginId, name)` —— 删除**别人的**数据库；
 * - `plugins:fs:write-file(他人的 pluginId, path, data)` —— 以他人身份通过
 *   `hasPluginLocalFilesAccess` 判定并写文件；
 * - `plugins:net:request(他人的 pluginId, …)` —— 以他人身份发起网络请求（并计入他人配额）。
 *
 * **P-1（移除通用 `ipcRenderer` 桥）没有消除该路径**：插件与宿主在**同一 realm** 求值，
 * 插件代码可直接访问 `window.electron.plugins.*` 具名 API，照样能传任意 `pluginId`。
 * 因此 P-1 收窄了「入口」，P-3 才是「不信调用方自报的身份」。两者缺一不可。
 *
 * ## 方案：sender 反查 + 保守放行
 *
 * 新增 `webContentsId → pluginId` 注册表（由 `pluginWindows.ts` 在插件窗口
 * 创建/销毁时维护），校验时**以发送方反查结果为准**，忽略入参自报值。
 *
 * ### 为什么是「保守放行」而不是「一律拒绝」
 *
 * 插件在**宿主主世界同一 realm** 中求值，因此：
 *
 * - 在**插件窗口**里运行的插件：`event.sender` 是该插件窗口的 WebContents → **可反查**；
 * - 在**主窗口**里运行的插件：`event.sender` 就是主窗口，而主窗口**可同时承载多个插件**
 *   → **无法反查**（sender 区分不出是哪一个）。
 *
 * 规划 §7 对该项的风险评级是**概率中 / 影响高（插件大面积不可用）**，并给出回退策略：
 * 「先只对**已知窗口**启用反查，未知来源走旧的入参路径 + 打 warn 观测」。
 *
 * 本模块严格实现该策略 —— `resolvedPluginId === null`（未知来源）时**放行**：
 * 这不是偷懒，而是**避免误拒正品插件**。代价是主窗口内的冒充仍未被拦住，
 * 属**已知残余风险**，需在有真实插件环境后按观测数据收紧（见规划 §10.3）。
 *
 * ### 误拒风险分析（为何本方案不会误伤正品插件）
 *
 * 正品插件经 `runtime.ts` 的具名 API 调用时，传入的 `pluginId` **就是它自己的 id**，
 * 与 sender 反查结果必然一致 → 放行。只有「声明 A、实际来自 B」才被拒。
 *
 * ## 依赖
 *
 * 本模块**零依赖**（无 electron、无 IO），故 `tests/plugin-identity-binding.test.ts`
 * 可**直接 import 并驱动真行为**（与 F-6 的 `shared/kvEnvelope.ts` 同一思路）。
 */

/**
 * 需要做发送方身份校验的通道白名单。
 *
 * **只列入「首个参数是能力主体 `pluginId`」的通道。** 判定口径：
 * 该参数指向**谁的能力被使用**（文件、SQLite、网络、窗口、存储等）。
 *
 * 刻意**不列入**的通道及其理由：
 *
 * - `plugins:marketplace:*` / `plugins:install-local` —— 插件市场的 `pluginId` 是
 *   「安装目标」而非「能力主体」，且由主窗口设置页调用；
 * - `plugins:startup:mark` / `plugins:active-session:set` —— 首参是 `pluginIds: string[]`，
 *   语义是**宿主批量上报启动会话**，不是插件自证身份；
 * - `plugins:set-safe-mode` / `plugins:icons:*` / `plugins:dialog:*` / `plugins:list` 等 ——
 *   首个参数不是 pluginId（或没有该参数）。
 *
 * ⚠️ 新增 `plugins:` 通道时**必须**同步评估是否纳入本表 ——
 * `tests/plugin-identity-binding.test.ts` 守卫会扫描本仓库所有 `plugins:` 注册，
 * 若某通道首参形如 `pluginId` 却不在本表内，守卫变红。
 */
export const PLUGIN_IDENTITY_CHANNELS: ReadonlySet<string> = new Set<string>([
  // ── 文件系统（能力主体：谁能访问本地文件） ──
  'plugins:fs:list-image-files',
  'plugins:fs:list-files',
  'plugins:fs:get-file-url',
  'plugins:fs:read-text-file',
  'plugins:fs:read-file-bytes',
  'plugins:fs:read-audio-metadata',
  'plugins:fs:write-file',
  'plugins:fs:delete-file',
  // ── 进程 ──
  'plugins:process:launch',
  'plugins:process:terminate',
  // ── 网络（能力主体：配额与溯源归属谁） ──
  'plugins:net:request',
  'plugins:net:cancel',
  // ── 本地 Web 服务 ──
  'plugins:web-server:listen',
  'plugins:web-server:status',
  'plugins:web-server:respond',
  'plugins:web-server:close',
  // ── SQLite（危害最直观：删他人的库） ──
  'plugins:sqlite:open',
  'plugins:sqlite:exec',
  'plugins:sqlite:run',
  'plugins:sqlite:all',
  'plugins:sqlite:get',
  'plugins:sqlite:transaction',
  'plugins:sqlite:close',
  'plugins:sqlite:list',
  'plugins:sqlite:delete',
  // ── 插件生命周期（管理通道；主窗口来源因无法反查而放行） ──
  'plugins:set-enabled',
  'plugins:uninstall',
  'plugins:failure:clear',
  // ── 资源读取与插件私有存储 ──
  'plugins:read-asset',
  'plugins:window:read-asset',
  'plugins:data:get',
  'plugins:data:set',
  'plugins:data:delete',
  // ── 插件浮窗（在 pluginWindows.ts 注册） ──
  'plugins:window:start-drag',
  'plugins:window:drag-move',
  'plugins:window:end-drag',
  'plugins:window:cancel-drag',
  'plugins:window:start-resize',
  'plugins:window:resize',
  'plugins:window:end-resize',
  'plugins:window:cancel-resize',
  'plugins:window:show',
  'plugins:window:hide',
  'plugins:window:close',
  'plugins:window:move',
  'plugins:window:get-bounds',
  'plugins:window:set-ignore-mouse-events',
  'plugins:window:show-on-top',
  'plugins:window:get-context',
]);

/**
 * `webContentsId → pluginId` 注册表。
 *
 * 由 `pluginWindows.ts` 在插件窗口创建时登记、销毁时移除。
 * 用 `webContents.id` 而非窗口对象：它是跨销毁稳定的数值标识，
 * 且在 `IpcMainInvokeEvent.sender.id` 上可直接取到
 *（`storage.ts` 的 `registeredSenderKind` 用的是同一套做法）。
 */
const senderOwners = new Map<number, string>();

/** 登记某个 WebContents 归属的插件。非法入参（非正整数 id / 空 pluginId）静默忽略。 */
export const registerPluginSender = (webContentsId: number, pluginId: string): void => {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
  const normalized = String(pluginId ?? '').trim();
  if (!normalized) return;
  senderOwners.set(webContentsId, normalized);
};

/** 注销（插件窗口销毁时调用）。 */
export const unregisterPluginSender = (webContentsId: number): void => {
  senderOwners.delete(webContentsId);
};

/** 按发送方反查插件身份。**查不到返回 `null`**（= 未知来源，见模块头部说明）。 */
export const resolvePluginIdByWebContentsId = (
  webContentsId: number | undefined,
): string | null => {
  if (typeof webContentsId !== 'number') return null;
  return senderOwners.get(webContentsId) ?? null;
};

/** 仅供测试：清空注册表，避免用例间相互污染。 */
export const resetPluginSenderRegistryForTest = (): void => {
  senderOwners.clear();
};

export type PluginIdentityVerdict = 'allow' | 'mismatch';

/**
 * **纯判定**：是否允许本次调用（不读注册表、无副作用，故可直接单测）。
 *
 * 放行（`allow`）的三种情形：
 * 1. 声明的 `pluginId` 不是非空字符串 —— 本校验不适用（例如可选参数缺省、首参为数组等）；
 * 2. 反查结果为 `null` —— **未知来源**（主窗口内的插件无法反查），按规划 §7 走旧路径放行；
 * 3. 反查结果与声明值一致 —— 正品插件的正常路径。
 *
 * 仅当「反查成功且与声明值不同」时判 `mismatch`。
 */
export const evaluatePluginIdentity = (
  resolvedPluginId: string | null,
  claimedPluginId: unknown,
): PluginIdentityVerdict => {
  if (typeof claimedPluginId !== 'string' || claimedPluginId.length === 0) return 'allow';
  if (resolvedPluginId === null) return 'allow';
  return resolvedPluginId === claimedPluginId ? 'allow' : 'mismatch';
};

export interface IpcSenderGuardParams {
  channel: string;
  webContentsId: number | undefined;
  args: unknown[];
}

export type IpcSenderGuardResult = { ok: true } | { ok: false; error: string };

/**
 * 放行结果的**单例**。
 *
 * 守卫在**每一次 IPC 调用**上执行（含 `storage:kv:get` 这类高频通道），
 * 故放行路径不应分配对象 —— 每次都 `return { ok: true }` 会产生一个小对象，
 * 虽大概率被 V8 标量替换掉，但没有理由留下这笔可避免的热路径开销
 *（对应规划 DoD 第 4 条「热路径不留同步开销」）。
 *
 * 刻意在本模块内定义而非从 `ipc/registry.ts` 导入：registry 依赖 electron，
 * 而本模块必须保持**零依赖**（否则 `tests/plugin-identity-binding.test.ts`
 * 无法在纯 Node 下加载并做真行为断言）。
 */
const ALLOW: IpcSenderGuardResult = Object.freeze({ ok: true });

export type IpcSenderGuard = (params: IpcSenderGuardParams) => IpcSenderGuardResult;

export interface PluginIdentityMismatchInfo {
  channel: string;
  resolvedPluginId: string;
  claimedPluginId: string;
}

/**
 * 生成注册表用的守卫函数（依赖倒置：`registry.ts` 只认识这个函数签名，
 * **不认识**插件身份概念）。
 *
 * @param onMismatch 拒绝时的回调 —— 用于写审计日志。**只在校验失败时触发**，
 *   因此不会在热路径上制造噪声。
 */
export const createPluginSenderGuard = (
  onMismatch?: (info: PluginIdentityMismatchInfo) => void,
): IpcSenderGuard => {
  return (params: IpcSenderGuardParams): IpcSenderGuardResult => {
    // 放行路径零分配（单例常量）——本函数在每一次 IPC 调用上执行，
    // 见 registry.ts 中 IPC_SENDER_GUARD_ALLOW 的说明。
    if (!PLUGIN_IDENTITY_CHANNELS.has(params.channel)) return ALLOW;

    const resolvedPluginId = resolvePluginIdByWebContentsId(params.webContentsId);
    const claimed = params.args[0];
    if (evaluatePluginIdentity(resolvedPluginId, claimed) === 'allow') return ALLOW;

    const claimedPluginId = String(claimed);
    onMismatch?.({
      channel: params.channel,
      resolvedPluginId: resolvedPluginId as string,
      claimedPluginId,
    });

    return {
      ok: false,
      error:
        `插件身份不匹配：通道 "${params.channel}" 声明的 pluginId 为 "${claimedPluginId}"，` +
        `但发送方实际归属 "${String(resolvedPluginId)}"。` +
        '能力调用只允许操作自身资源（P-3 / M-1）。',
    };
  };
};
