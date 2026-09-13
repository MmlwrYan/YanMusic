import { getNativeStorage } from './native';

type KvBatchMutation =
  | { key: string; value: unknown; delete?: never }
  | { key: string; delete: true; value?: never };

export class KvStorage {
  get<T>(key: string): T | null {
    const valueJson = getNativeStorage().kvGet(key);
    if (!valueJson) return null;
    try {
      return JSON.parse(valueJson) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    getNativeStorage().kvSet(key, JSON.stringify(value));
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
        getNativeStorage().kvSet(mutation.key, valueJson);
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
