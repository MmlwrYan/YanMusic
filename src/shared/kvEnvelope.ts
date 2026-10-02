/**
 * KV 加密信封的**零依赖纯逻辑**（F-6，v1.3.0）。
 *
 * ## 为什么单独成模块
 *
 * 这些判定原先住在 `main/storage/kv.ts`。该文件 `import { safeStorage } from 'electron'`、
 * 还 `import log from '../logger'`，因此**无法在 `node --test` 下加载** ——
 * 于是守凭据加密的那批测试只能退化成**源码正则**：
 *
 * ```ts
 * const source = readFileSync('src/main/storage/kv.ts', 'utf8');
 * const block = source.match(/const ENCRYPTED_KV_KEYS[^=]*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
 * ```
 *
 * 这类断言**改动一个字符就可能失效或误报**（多一个空格、换个写法、注释里出现同名标识符都会影响），
 * 而它们守的恰恰是「凭据必须加密落盘」这条线。抽到本模块后（**零依赖、无 IO、无 Electron**），
 * 测试可 `import` 并做**真行为断言**。
 *
 * ## 边界（刻意不搬进来）
 *
 * 与 `safeStorage` 交互的部分**留在 `kv.ts`**：`encryptJson` / `decryptJsonIfNeeded`
 * 以及迁移时的实际写入。本模块只回答「**该不该加密 / 是不是信封 / 要不要迁移**」这三个纯问题。
 *
 * 本模块是**纯重构的产物**：逻辑与注释语义与迁移前完全一致。
 */

/**
 * 需要**加密落盘**的 KV 键。
 *
 * SECURITY（H-3，v1.2.4）：修复前所有 KV 值一律以明文 JSON 存进原生 SQLite
 * （`yan-storage` 的 `kv_set`），其中就包括登录态 —— `pinia:user` 里的
 * `token`（Kugou 登录票据）与用户资料。任何能读到磁盘文件的进程都可直接取得票据。
 *
 * 修复方式：以下键在写入前经 Electron `safeStorage`（Windows DPAPI / macOS
 * Keychain / Linux libsecret）加密，读取时透明解密；**其余键保持明文**，
 * 因为它们只是普通设置项，一律加密会平白放大解密失败面、且对性能无益。
 *
 * 值在磁盘上的形态为 `{"__yanEncrypted":"<base64 密文>"}`，
 * 与既有明文 JSON 对象在结构上不冲突，因此可平滑升级：
 * 旧数据按明文读入，下一次写出即自动转为密文。
 * **v1.2.9 补充**：仅靠「下次写出」对存量用户是**不够**的 —— `pinia:device`
 * 这类键几乎不再被写，旧明文会永久留在盘上。因此增加了**读时惰性迁移**
 * （见 `needsEncryptionMigration` / `migratePlaintextToEnvelope`）。
 */
export const ENCRYPTED_KV_KEYS: ReadonlySet<string> = new Set<string>([
  // 登录态：token（Kugou 票据）、userid、用户资料
  'pinia:user',
  // 设备指纹：dfid / mid / uuid / guid / mac（W-3，v1.2.9）
  // 它同时是 `ipc/sensitiveKv.ts` 的运行时敏感键；两处必须一致，由
  // `tests/kv-sensitive-keys.test.ts` 的守卫锁定。
  'pinia:device',
]);

/** 加密信封标记 */
export const ENVELOPE_KEY = '__yanEncrypted';

export type EncryptedEnvelope = { [ENVELOPE_KEY]: string };

export const isEncryptedEnvelope = (value: unknown): value is EncryptedEnvelope =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)[ENVELOPE_KEY] === 'string';

export const shouldEncryptKvKey = (key: string): boolean => ENCRYPTED_KV_KEYS.has(key);

/**
 * 判定某个落盘值是否属于「本应加密、但仍是明文」的存量数据（W-3 第二步）。
 *
 * 只加白名单（第一步）**对存量用户无效**：读路径遇到非信封会**原样直通**
 * （`decryptJsonIfNeeded` 的语义），而写路径只在**再次写入**时才加密 ——
 * 像 `pinia:device` 这种几乎不再被写的键，旧明文会永久留在磁盘上。
 *
 * 本函数是**纯函数**（无 IO、无 Electron），因此可直接单测。
 *
 * @returns `true` = 需要迁移为加密信封
 */
export const needsEncryptionMigration = (key: string, raw: string | null | undefined): boolean => {
  if (!raw) return false;
  if (!shouldEncryptKvKey(key)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非 JSON：属异常数据（KV 值一律由 JSON.stringify 产出）。
    // 读路径会原样返回，不迁移 —— 避免在损坏数据上写入无法预期的内容。
    return false;
  }
  return !isEncryptedEnvelope(parsed);
};
