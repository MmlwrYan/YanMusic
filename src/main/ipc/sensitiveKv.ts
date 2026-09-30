// 注意：此处**显式带 `.ts` 扩展名**。
// `src/` 内的既有惯例是不带扩展名（由 vite/rolldown 解析），但本模块需要被
// `tests/sensitive-kv-access.test.ts` 用 `node --test` **直接加载**，
// 而 Node 的 ESM 解析器不做扩展名补全。
// `tsconfig.json` 已开启 `allowImportingTsExtensions`，故类型检查与打包均无影响。
// 取舍说明：这是本仓库 `src/` 内第一处带扩展名的导入，仅因**安全策略模块必须可单测**。
import { windowKindOf, type WindowKind } from './permissions.ts';

/**
 * S-2（v1.2.6）：敏感 KV 键的访问策略。
 *
 * ## 背景（H-2，一级）
 *
 * `src/main/ipc/storage.ts` 的 `storage:kv:*` handler 原本是**裸透传**：
 *
 * ```ts
 * // 修复前：_event 被丢弃，没有任何身份校验
 * ipcRegistry.registerHandler(channel, (_event, key) => getKvStorage().get(String(key)));
 * ```
 *
 * （注：上面刻意用 `channel` 变量而非字面量 ——
 * `tests/ipc-channel-contract.test.ts` 会用正则 `registerHandler\(\s*'([^']+)'`
 * 扫描 `src/main` 下的**全部** `.ts` 文件；注释里出现字面通道名会被误判为「重复注册」。）
 *
 * `_event` 被丢弃、**没有任何身份校验**，而 `KvStorage.get()` 会**透明解密**。
 * 因此任意窗口（含**插件窗口**）都能读走已解密的登录票据（在 `pinia:user` 的 `info.token`）。
 * 写入面同样无门禁 → 可覆写凭据（令牌替换 / 强制登出）。
 *
 * 更糟的是：**打开 `IPC_PERMISSION_STRICT` 也拦不住** ——
 * `permissions.ts` 里 `storage:` 前缀的 scope 是 `'all'`，
 * 而 `evaluateIpcCall` 在 `scope === 'all'` 时直接返回 `allowed: true`。
 * 所以本收口是**独立于白名单**的必要修复。
 *
 * ## 为什么「按键」收窄，而不是收窄 `storage:` 前缀
 *
 * `sqlitePersist`（`stores/sqlitePersist.ts:89`）在**所有装了持久化的窗口**里
 * 都会以 `pinia:<storeId>` 为键读写，因此**不能整体收窄前缀**，否则会打断
 * mini 播放器与桌面歌词的状态恢复。本模块只保护**具名的敏感键**。
 *
 * ## 为什么依赖 `windowKindOf`（登记表）而不是 URL
 *
 * 窗口是**主进程自己创建的**，创建时即调用 `registerWindowKind` 登记确切类型；
 * 而 URL 不可靠 —— mini 播放器与主窗口**加载同一份 `dist/index.html`**
 * （`miniPlayer.ts:232`），仅凭 URL 无法区分。
 * 因此这里**只信登记表**：未登记 → `null` → 拒绝（fail-closed）。
 */

/**
 * 需要按键级保护的敏感键。
 *
 * - `pinia:user`   —— 登录态，含 `info.token`（Kugou 票据）
 * - `pinia:device` —— 设备指纹（dfid / mac / mid / uuid）
 *
 * 两者都在 `storage/kv.ts` 的 `ENCRYPTED_KV_KEYS` 白名单内（静态加密），
 * 本模块补的是**运行时访问控制**这一面。
 */
export const SENSITIVE_KV_KEYS: ReadonlySet<string> = new Set<string>([
  'pinia:user',
  'pinia:device',
]);

/**
 * 允许通过 IPC 访问敏感键的窗口类型。
 *
 * 依据「谁真的需要」而非「谁可能想要」：
 *
 * | 窗口 | 需要 | 原因 |
 * |---|---|---|
 * | `main` | ✅ | 主窗口的 `useUserStore` / `useDeviceStore` |
 * | `mini-player` | ✅ | **加载同一份 `dist/index.html`**（`miniPlayer.ts:232`），共用 `main.ts` → 同样安装 `sqlitePersist` |
 * | `desktop-lyric` | ✅ | `desktop-lyric/main.ts:27` 安装了 `sqlitePersistPlugin` |
 * | `plugin-window` | ❌ | **不安装 pinia/sqlitePersist**，本就不该碰这些键 |
 *
 * 注意：插件代码运行在宿主渲染层的**同一 realm**（H-1），
 * 可直接读到宿主 Pinia 实例的内存态 —— 因此本收口是**缓解而非根治**，
 * 根治需 H-1（插件独立执行上下文）。
 */
export const SENSITIVE_KEY_ALLOWED_KINDS: ReadonlySet<WindowKind> = new Set<WindowKind>([
  'main',
  'mini-player',
  'desktop-lyric',
]);

/**
 * 取发送方窗口类型 —— **只信登记表**，未登记返回 `null`。
 *
 * 刻意不调用 `classifySender`：它会在登记表未命中时**回退到 URL 推断**，
 * 而 URL 对「主窗口 vs mini 播放器」是同一条 `index.html`，不可区分。
 * 安全判定必须 fail-closed，不能建立在推断之上。
 */
export const registeredSenderKind = (webContentsId: unknown): WindowKind | null =>
  windowKindOf(webContentsId);

export interface SensitiveKvDecision {
  /** 该键是否为敏感键 */
  readonly sensitive: boolean;
  /** 是否放行 */
  readonly allowed: boolean;
  /** 发送方窗口类型（未登记为 null） */
  readonly senderKind: WindowKind | null;
  /** 拒绝原因（放行时为 null），用于日志与错误信息 */
  readonly reason: string | null;
}

/**
 * 判定一次 KV 访问是否放行。**纯函数**（无 IO、无 Electron），可直接单测。
 *
 * 不敏感的键**一律放行** —— 保持既有行为，避免打断 `sqlitePersist`。
 */
export const evaluateSensitiveKvAccess = (
  key: unknown,
  webContentsId: unknown,
): SensitiveKvDecision => {
  const name = typeof key === 'string' ? key : String(key ?? '');

  if (!SENSITIVE_KV_KEYS.has(name)) {
    return { sensitive: false, allowed: true, senderKind: null, reason: null };
  }

  const senderKind = registeredSenderKind(webContentsId);

  if (senderKind === null) {
    return {
      sensitive: true,
      allowed: false,
      senderKind: null,
      reason: '发送方窗口未登记，无法确认身份',
    };
  }

  if (!SENSITIVE_KEY_ALLOWED_KINDS.has(senderKind)) {
    return {
      sensitive: true,
      allowed: false,
      senderKind,
      reason: `窗口类型 "${senderKind}" 无权访问敏感键`,
    };
  }

  return { sensitive: true, allowed: true, senderKind, reason: null };
};

/** 供测试用：判断某个键是否需要保护 */
export const isSensitiveKvKey = (key: unknown): boolean =>
  SENSITIVE_KV_KEYS.has(typeof key === 'string' ? key : String(key ?? ''));
