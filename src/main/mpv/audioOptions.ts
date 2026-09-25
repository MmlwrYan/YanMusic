import { getStorePersistenceKey } from '../../shared/storePersistence';
import {
  applyLegacyAudioOptionDefaultMigration,
  NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG,
  normalizeNativeAudioOptions,
  type MigratableAudioOptionKey,
  type NativeAudioOptions,
} from '../../shared/native-audio-options';
import log from '../logger';
import { getKvStorage } from '../storage/kv';
import { getPersistedRendererSettings } from '../storage/persistedStores';

const SETTING_STORE_ID = 'setting';

/** 受一次性迁移影响的四个字段（用于日志留痕）。 */
const MIGRATABLE_KEYS: readonly MigratableAudioOptionKey[] = [
  'demuxerReadaheadSecs',
  'cache',
  'cachePauseWaitSecs',
  'audioChannels',
];

const pickMigratable = (state: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(MIGRATABLE_KEYS.map((key) => [key, state[key] ?? null]));

/**
 * 读取渲染层持久化设置中的原生音频/缓存选项。
 *
 * 纯逻辑（默认值与归一化）在 `src/shared/native-audio-options.ts`，
 * 这里只负责从 KV 取数据 —— 与 `networkSettings.ts` 读取网络设置的方式一致。
 *
 * **为什么存量设置对齐要在主进程先做一次**：`app.ts` 在 `app.whenReady()` 里
 * `await initMpvPlayer()`，**之后**才 `await createWindow()`；也就是说引擎在窗口
 * 存在之前就已经用当前设置初始化完毕，而渲染层的迁移要等窗口挂载后才执行。
 * 若只依赖渲染层，升级后的**第一次**启动会用未对齐的旧默认值初始化 mpv
 * （与 1.1.1 的硬编码行为不一致），第二次启动才对齐 —— 迁移的意义被抵消。
 * 这里在读取设置的同时把补丁落盘，使第一次启动即对齐；渲染层的
 * `ensureNativeAudioOptionDefaults()` 仍是幂等的安全网（读到标记后直接跳过）。
 */
export const readNativeAudioOptions = (): NativeAudioOptions => {
  const persisted = getPersistedRendererSettings();
  const migrated = applyLegacyAudioOptionDefaultMigration(persisted);

  if (migrated) {
    getKvStorage().set(getStorePersistenceKey(SETTING_STORE_ID), migrated);
    log.info('[AudioOptions] 存量音频/缓存设置对齐：已在引擎初始化前完成并落盘', {
      before: pickMigratable(persisted),
      after: pickMigratable(migrated),
      [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: migrated[NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG],
    });
  } else {
    log.info('[AudioOptions] 存量音频/缓存设置对齐：无需执行（标记已为 true）', {
      ...pickMigratable(persisted),
      [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: persisted[NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG] ?? null,
    });
  }

  return normalizeNativeAudioOptions(migrated ?? persisted);
};

export {
  DEFAULT_NATIVE_AUDIO_OPTIONS,
  normalizeNativeAudioOptions,
  type NativeAudioOptions,
} from '../../shared/native-audio-options';
