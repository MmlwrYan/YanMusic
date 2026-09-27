import { safeStorage } from 'electron';
import log from '../logger';
import { getNativeStorage } from './native';

type KvBatchMutation =
  { key: string; value: unknown; delete?: never } | { key: string; delete: true; value?: never };

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
 */
const ENCRYPTED_KV_KEYS: ReadonlySet<string> = new Set<string>([
  // 登录态：token（Kugou 票据）、userid、用户资料
  'pinia:user',
]);

/** 加密信封标记 */
const ENVELOPE_KEY = '__yanEncrypted';

type EncryptedEnvelope = { [ENVELOPE_KEY]: string };

const isEncryptedEnvelope = (value: unknown): value is EncryptedEnvelope =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)[ENVELOPE_KEY] === 'string';

export const shouldEncryptKvKey = (key: string): boolean => ENCRYPTED_KV_KEYS.has(key);

/**
 * 把 JSON 字符串加密成信封 JSON 字符串。
 * 加密不可用时**抛出**（而不是静默降级为明文）—— 涉及凭据时不接受「悄悄地不加密」。
 */
const encryptJson = (key: string, valueJson: string): string => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`安全存储不可用，拒绝以明文写入敏感键：${key}`);
  }
  const cipher = safeStorage.encryptString(valueJson).toString('base64');
  return JSON.stringify({ [ENVELOPE_KEY]: cipher } satisfies EncryptedEnvelope);
};

/** 尝试解密信封；非信封原样返回。解密失败返回 null，让调用方按「无数据」处理。 */
const decryptJsonIfNeeded = (key: string, valueJson: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
  if (!isEncryptedEnvelope(parsed)) return valueJson;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('[KvStorage] 安全存储不可用，无法解密已加密键:', key);
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(parsed[ENVELOPE_KEY], 'base64'));
  } catch (error) {
    log.warn('[KvStorage] 解密失败，按无数据处理:', key, error);
    return null;
  }
};

/** 写入前的统一变换：敏感键加密，其余原样 */
const encodeForWrite = (key: string, valueJson: string): string =>
  shouldEncryptKvKey(key) ? encryptJson(key, valueJson) : valueJson;

/** 读取后的统一变换：敏感键解密（失败返回 null = 无数据） */
const decodeAfterRead = (key: string, raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null;
  if (!shouldEncryptKvKey(key)) return raw;
  return decryptJsonIfNeeded(key, raw);
};

export class KvStorage {
  get<T>(key: string): T | null {
    const decoded = decodeAfterRead(key, getNativeStorage().kvGet(key));
    if (!decoded) return null;
    try {
      return JSON.parse(decoded) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    getNativeStorage().kvSet(key, encodeForWrite(key, JSON.stringify(value)));
  }

  /**
   * 批量写入（YanMusic 适配实现：原生 yan-storage 仅提供单键 kvSet/kvDelete，
   * 此处以循环等价实现 EchoMusic 的 applyBatch 语义；非原子）。
   */
  applyBatch(mutations: KvBatchMutation[]): void {
    for (const mutation of mutations) {
      if (mutation.delete) {
        getNativeStorage().kvDelete(mutation.key);
      } else {
        const valueJson = JSON.stringify(mutation.value);
        if (valueJson === undefined)
          throw new Error(`KV value is not JSON serializable: ${mutation.key}`);
        getNativeStorage().kvSet(mutation.key, encodeForWrite(mutation.key, valueJson));
      }
    }
  }

  delete(key: string): void {
    getNativeStorage().kvDelete(key);
  }
}

let kvStorage: KvStorage | null = null;

export const getKvStorage = () => {
  if (!kvStorage) kvStorage = new KvStorage();
  return kvStorage;
};
