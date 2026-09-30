import { ipcRegistry } from './registry';
import type {
  StorageAppendQueueItemsPayload,
  StorageHistoryGetEntriesPayload,
  StorageHistoryRecordPlayPayload,
  StorageHistoryRemoveEntriesPayload,
  StorageQueueIdPayload,
  StorageReplaceQueuePayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '../../shared/storage';
import { getPlaybackQueueStorage } from '../storage/playbackQueues';
import { getHistoryStorage } from '../storage/history';
import { getKvStorage } from '../storage/kv';
import log from '../logger';
import { evaluateSensitiveKvAccess, registeredSenderKind } from './sensitiveKv';
import type { WindowKind } from './permissions';

/**
 * 允许执行 `storage:reset-all` 的窗口类型。
 *
 * 只允许**主窗口**：该操作会清空 `app_kv`（含登录票据）+ 播放历史 + 队列 + 歌曲，
 * 是「一键清空全部本地数据」。设置页的入口在 `stores/setting.ts:290`，
 * 而设置页只在主窗口 —— 其余窗口（mini / 桌面歌词 / 插件窗口）没有任何入口需要它。
 */
const RESET_ALL_ALLOWED_KINDS: ReadonlySet<WindowKind> = new Set<WindowKind>(['main']);

export const registerStorageHandlers = () => {
  ipcRegistry.registerHandler('storage:playback:get-snapshot', () =>
    getPlaybackQueueStorage().getSnapshot(),
  );

  ipcRegistry.registerHandler(
    'storage:playback:get-queue',
    (_event, payload: StorageQueueIdPayload) => getPlaybackQueueStorage().getQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:replace-queue',
    (_event, payload: StorageReplaceQueuePayload) =>
      getPlaybackQueueStorage().replaceQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:append-items',
    (_event, payload: StorageAppendQueueItemsPayload) =>
      getPlaybackQueueStorage().appendQueueItems(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:update-queue-meta',
    (_event, payload: StorageUpdateQueueMetaPayload) =>
      getPlaybackQueueStorage().updateQueueMeta(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:clear-queue',
    (_event, payload: StorageUpdateQueueMetaPayload) =>
      getPlaybackQueueStorage().clearQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:remove-queue',
    (_event, payload: StorageQueueIdPayload) => getPlaybackQueueStorage().removeQueue(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:remove-item',
    (_event, payload: StorageRemoveQueueItemPayload) =>
      getPlaybackQueueStorage().removeQueueItem(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:reorder-items',
    (_event, payload: StorageReorderQueueItemsPayload) =>
      getPlaybackQueueStorage().reorderQueueItems(payload),
  );

  ipcRegistry.registerHandler(
    'storage:playback:set-current-track',
    (_event, payload: StorageSetQueueCurrentTrackPayload) =>
      getPlaybackQueueStorage().setQueueCurrentTrack(payload),
  );

  ipcRegistry.registerHandler('storage:playback:set-active-queue', (_event, queueId: string) =>
    getPlaybackQueueStorage().setActiveQueue(queueId),
  );

  ipcRegistry.registerHandler(
    'storage:history:get-entries',
    (_event, payload: StorageHistoryGetEntriesPayload) =>
      getHistoryStorage().getEntries(payload ?? {}),
  );

  ipcRegistry.registerHandler(
    'storage:history:record-play',
    (_event, payload: StorageHistoryRecordPlayPayload) => getHistoryStorage().recordPlay(payload),
  );

  ipcRegistry.registerHandler(
    'storage:history:remove-entries',
    (_event, payload: StorageHistoryRemoveEntriesPayload) =>
      getHistoryStorage().removeEntries(payload),
  );

  ipcRegistry.registerHandler('storage:history:clear', () => getHistoryStorage().clear());

  // ── S-2（v1.2.6）：敏感键按键级收口 ──────────────────────────────────────
  //
  // 背景见 ipc/sensitiveKv.ts 的文件头。要点：
  //   · 收口**按 `key`**，不收窄 `storage:` 前缀（否则打断所有窗口的 sqlitePersist）；
  //   · 只信 `registerWindowKind` 登记表，未登记 → 拒绝（fail-closed）；
  //   · 不敏感的键一律放行 —— 保持既有行为。
  //
  // 观测策略：**仅当键敏感时才写日志**（无论放行与否）。
  // 不敏感键不记，避免高频的 `pinia:setting` 之类把日志刷爆。

  ipcRegistry.registerHandler('storage:kv:get', (event, key: string) => {
    const decision = evaluateSensitiveKvAccess(key, event.sender.id);
    if (decision.sensitive) {
      log.info('[storage.kv.get]', {
        key: String(key),
        senderKind: decision.senderKind,
        webContentsId: event.sender.id,
        allowed: decision.allowed,
      });
    }
    if (!decision.allowed) {
      throw new Error(`拒绝访问敏感键 "${String(key)}"：${decision.reason}`);
    }
    return getKvStorage().get(String(key));
  });

  ipcRegistry.registerHandler('storage:kv:set', (event, key: string, value: unknown) => {
    const decision = evaluateSensitiveKvAccess(key, event.sender.id);
    if (decision.sensitive) {
      log.info('[storage.kv.set]', {
        key: String(key),
        senderKind: decision.senderKind,
        webContentsId: event.sender.id,
        allowed: decision.allowed,
      });
    }
    if (!decision.allowed) {
      throw new Error(`拒绝写入敏感键 "${String(key)}"：${decision.reason}`);
    }
    getKvStorage().set(String(key), value);
    return { ok: true };
  });

  ipcRegistry.registerHandler('storage:kv:delete', (event, key: string) => {
    const decision = evaluateSensitiveKvAccess(key, event.sender.id);
    if (decision.sensitive) {
      log.info('[storage.kv.delete]', {
        key: String(key),
        senderKind: decision.senderKind,
        webContentsId: event.sender.id,
        allowed: decision.allowed,
      });
    }
    if (!decision.allowed) {
      throw new Error(`拒绝删除敏感键 "${String(key)}"：${decision.reason}`);
    }
    getKvStorage().delete(String(key));
    return { ok: true };
  });

  // 注意：`storage:reset-all` 走的是 `getPlaybackQueueStorage().resetAll()`
  // → `playbackQueues.ts:82` → `getNativeStorage().resetAll()`，
  // 而原生实现**同时 `DELETE FROM app_kv`**（即清掉 `pinia:user` / `pinia:device`）
  // 以及 play_history / queue_items / playback_queues / songs。
  // 因此它**必须一并收口**：它是「一键清空全部本地数据」，危害高于单纯的读。
  ipcRegistry.registerHandler('storage:reset-all', (event) => {
    const senderKind = registeredSenderKind(event.sender.id);
    log.info('[storage.reset-all]', {
      senderKind,
      webContentsId: event.sender.id,
      allowed: senderKind !== null && RESET_ALL_ALLOWED_KINDS.has(senderKind),
    });
    if (senderKind === null) {
      throw new Error('拒绝重置本地数据：发送方窗口未登记，无法确认身份');
    }
    if (!RESET_ALL_ALLOWED_KINDS.has(senderKind)) {
      throw new Error(`拒绝重置本地数据：窗口类型 "${senderKind}" 无权执行`);
    }
    getPlaybackQueueStorage().resetAll();
    return { ok: true };
  });
};
