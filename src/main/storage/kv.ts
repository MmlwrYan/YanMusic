import { safeStorage } from 'electron';
import log from '../logger';
import { getNativeStorage } from './native';
// F-6（v1.3.0）：加密信封的纯逻辑已抽到零依赖模块，便于真行为单测。
// 本文件只保留需要 Electron / IO 的部分（safeStorage 加解密与落盘）。
import {
  ENVELOPE_KEY,
  isEncryptedEnvelope,
  needsEncryptionMigration,
  shouldEncryptKvKey,
  type EncryptedEnvelope,
} from '../../shared/kvEnvelope';

export { shouldEncryptKvKey, needsEncryptionMigration };

type KvBatchMutation =
  { key: string; value: unknown; delete?: never } | { key: string; delete: true; value?: never };

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

/**
 * 把一条存量明文**就地升级**为加密信封。
 *
 * 设计取舍：
 * - **幂等**：迁移后落盘值已是信封，下次读取不再触发；
 * - **不影响读取**：失败（如 `safeStorage` 不可用）只记日志，明文值照常返回，
 *   不把「迁移失败」升级成「读不到数据」；
 * - **通用**：做在 `get()` 而非针对某一个键，将来任何新增的 `ENCRYPTED_KV_KEYS`
 *   都自动获得同样的迁移能力。
 */
const migratePlaintextToEnvelope = (key: string, raw: string): void => {
  try {
    getNativeStorage().kvSet(key, encodeForWrite(key, raw));
    log.info('[KvStorage] 存量明文敏感键已升级为加密信封:', key);
  } catch (error) {
    log.warn('[KvStorage] 存量明文迁移失败（保留原值，不影响本次读取）:', key, error);
  }
};

/** 读取后的统一变换：敏感键解密（失败返回 null = 无数据） */
const decodeAfterRead = (key: string, raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null;
  if (!shouldEncryptKvKey(key)) return raw;
  return decryptJsonIfNeeded(key, raw);
};

export class KvStorage {
  get<T>(key: string): T | null {
    const raw = getNativeStorage().kvGet(key);
    // 存量明文迁移（W-3）：读一次即顺手升级为加密信封，失败不影响本次读取。
    if (needsEncryptionMigration(key, raw)) migratePlaintextToEnvelope(key, raw as string);
    const decoded = decodeAfterRead(key, raw);
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
