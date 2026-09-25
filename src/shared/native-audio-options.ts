/**
 * 原生播放引擎音频/缓存选项的**纯逻辑**（默认值 + 归一化）。
 *
 * 放在 `shared/` 而非 `main/` 的原因：这部分不依赖 Electron、不依赖存储层，
 * 可以被 `node:test` 直接覆盖；`main/mpv/audioOptions.ts` 只负责把
 * 渲染层持久化设置读出来再调用这里。
 *
 * 数据来源是**渲染层 setting store 的持久化对象**（KV 键 `pinia:setting`），
 * 与 `shared/network.ts` 的 `normalizeNetworkSettings` 同范式。
 *
 * 历史背景：这些字段此前被 `MpvController` 以「裸 KV 键」读取
 * （`storage.get('audioCacheSecs')` 等），而渲染层实际把它们持久化在
 * `pinia:setting` 这一个整对象里，导致读取恒为 null、设置永不生效；
 * 另有 8 个同类设置项（`audioSamplerate` / `audioChannels` / `audioFormat` /
 * `gaplessAudio` / `demuxerReadaheadSecs` / `cache` / `cachePause` /
 * `cachePauseWaitSecs`）完全没有消费方。
 *
 * **默认值约束**：`DEFAULT_NATIVE_AUDIO_OPTIONS` 必须与原生侧
 * `native/yan-mpv-player/src/player.rs` 的 `MpvPlayerConfig::default()` 逐项一致，
 * 且与接线前代码硬编码到 `set_option` 的值一致，保证接线本身不改变既有行为。
 */

export interface NativeAudioOptions {
  /** 对应 mpv `cache-secs`（秒） */
  cacheSecs: number;
  /** 对应 mpv `demuxer-max-bytes`（MiB） */
  demuxerMaxMb: number;
  /** 对应 mpv `demuxer-max-back-bytes`（MiB） */
  demuxerBackMb: number;
  /** 对应 mpv `audio-buffer`（秒） */
  audioBufferSecs: number;
  /** 对应 mpv `demuxer-readahead-secs`（秒） */
  demuxerReadaheadSecs: number;
  /** 对应 mpv `cache`：auto | yes | no */
  cache: 'auto' | 'yes' | 'no';
  /** 对应 mpv `cache-pause` */
  cachePause: boolean;
  /** 对应 mpv `cache-pause-wait`（秒） */
  cachePauseWaitSecs: number;
  /** 对应 mpv `audio-samplerate`：auto | 44100 | 48000 | 96000 | 192000 */
  audioSamplerate: string;
  /** 对应 mpv `audio-channels`：auto-safe | auto | stereo | mono */
  audioChannels: string;
  /** 对应 mpv `audio-format`：auto | float | s16 | s32 */
  audioFormat: string;
  /** 对应 mpv `gapless-audio`：weak | yes | no */
  gaplessAudio: string;
}

/**
 * 默认值。括号内注明「接线前的实际行为」，全部保持一致，
 * 因此未改过设置的用户在接线前后听到的完全一样。
 */
export const DEFAULT_NATIVE_AUDIO_OPTIONS: NativeAudioOptions = {
  cacheSecs: 30,
  demuxerMaxMb: 48,
  demuxerBackMb: 12,
  audioBufferSecs: 0.5,
  demuxerReadaheadSecs: 30, // 接线前：demuxer-readahead-secs 被赋值为 cache-secs（30）
  cache: 'yes', // 接线前：硬编码 "yes"
  cachePause: true, // 接线前：硬编码 "yes"
  cachePauseWaitSecs: 5, // 接线前：硬编码 "5"
  audioSamplerate: 'auto', // 接线前：硬编码 "0"（mpv 中 0 == auto）
  audioChannels: 'stereo', // 接线前：硬编码 "stereo"
  audioFormat: 'auto', // 接线前：未设置，mpv 默认 auto
  gaplessAudio: 'weak', // 接线前：未设置，mpv 默认 weak
};

export const MAX_CACHE_SECS = 3_600_000;
export const MAX_DEMUXER_MB = 4096;
export const MAX_AUDIO_BUFFER_SECS = 10;
export const MIN_SAMPLE_RATE = 8_000;
export const MAX_SAMPLE_RATE = 768_000;

/**
 * 1.1.2 之前**渲染层设置项**的默认值。
 *
 * 这些字段当时从未下发给引擎（引擎侧是被硬编码的），因此「设置里的值」与
 * 「引擎实际行为」在四个字段上不一致。由于渲染层会把整个 store 状态（含默认值）
 * 一起持久化，存量用户的 `pinia:setting` 里保存的就是这四个旧默认值 ——
 * 只改 `setting.ts` 的默认值无法影响他们，必须做一次性迁移。
 */
export const LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS = {
  demuxerReadaheadSecs: 1,
  cache: 'auto',
  cachePauseWaitSecs: 1,
  audioChannels: 'auto-safe',
} as const;

export type MigratableAudioOptionKey =
  'demuxerReadaheadSecs' | 'cache' | 'cachePauseWaitSecs' | 'audioChannels';

/**
 * 计算「存量设置对齐」补丁：把**仍然等于旧默认值**的字段改成引擎接线前的实际行为，
 * 从而让升级不产生静默的听感/缓冲变化。
 *
 * 已被用户显式改成其他值的字段一律不动。
 * 注意：若用户恰好把某字段设成了与旧默认值相同的值，无法与「从未改过」区分，
 * 会被一并迁移 —— 这是基于默认值迁移的固有限制（与 `impulseResponseSafetyMigrationDone`
 * 的既有做法一致）。
 */
export const resolveLegacyAudioOptionDefaultPatch = (state: {
  demuxerReadaheadSecs?: number | null;
  cache?: string | null;
  cachePauseWaitSecs?: number | null;
  audioChannels?: string | null;
}): Partial<Pick<NativeAudioOptions, MigratableAudioOptionKey>> => {
  const patch: Partial<Pick<NativeAudioOptions, MigratableAudioOptionKey>> = {};
  const legacy = LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS;
  const defaults = DEFAULT_NATIVE_AUDIO_OPTIONS;

  if (Number(state.demuxerReadaheadSecs) === legacy.demuxerReadaheadSecs) {
    patch.demuxerReadaheadSecs = defaults.demuxerReadaheadSecs;
  }
  if (state.cache === legacy.cache) {
    patch.cache = defaults.cache;
  }
  if (Number(state.cachePauseWaitSecs) === legacy.cachePauseWaitSecs) {
    patch.cachePauseWaitSecs = defaults.cachePauseWaitSecs;
  }
  if (state.audioChannels === legacy.audioChannels) {
    patch.audioChannels = defaults.audioChannels;
  }

  return patch;
};

/** 一次性存量设置对齐标记在持久化对象中的键名（渲染层 setting store 的同名 state 字段）。 */
export const NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG = 'nativeAudioOptionsMigrationDone';

/**
 * 计算一次性「存量设置对齐」后的**完整持久化对象**，供主进程与渲染层共用。
 *
 * 返回 `null` 表示无需改动（该用户已经迁移过，或标记已是 true）。
 *
 * 为什么主进程也要调用一次：主进程在创建窗口**之前**就调用 `addon.initialize(...)`
 * （`app.ts` 的 `initMpvPlayer()` 先于 `createWindow()`），而渲染层的迁移要等窗口
 * 挂载之后才执行。只靠渲染层会让「升级后的第一次启动」用未对齐的旧默认值初始化
 * 引擎，第二次启动才对齐 —— 这正是本迁移要避免的行为变化。
 */
export const applyLegacyAudioOptionDefaultMigration = (
  persisted: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  const state = persisted ?? {};
  if (state[NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG] === true) return null;

  const patch = resolveLegacyAudioOptionDefaultPatch({
    demuxerReadaheadSecs: state.demuxerReadaheadSecs as number | null | undefined,
    cache: state.cache as string | null | undefined,
    cachePauseWaitSecs: state.cachePauseWaitSecs as number | null | undefined,
    audioChannels: state.audioChannels as string | null | undefined,
  });

  return { ...state, ...patch, [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: true };
};

export const CACHE_MODES = ['auto', 'yes', 'no'] as const;
export const AUDIO_CHANNELS = ['auto-safe', 'auto', 'stereo', 'mono'] as const;
export const AUDIO_FORMATS = ['auto', 'float', 's16', 's32'] as const;
export const GAPLESS_MODES = ['weak', 'yes', 'no'] as const;

const readNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readChoice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
};

const readSamplerate = (value: unknown): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 'auto';
  const rate = Math.round(parsed);
  if (rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) return 'auto';
  return String(rate);
};

/**
 * 归一化渲染层持久化设置中的原生音频/缓存选项。
 *
 * 任一项缺失或非法时回落到 `DEFAULT_NATIVE_AUDIO_OPTIONS` 的同名值，
 * 因此「用户从未改过设置」与「持久化数据损坏」两种情况下行为都等于接线前。
 */
export const normalizeNativeAudioOptions = (
  persisted: Record<string, unknown> | null | undefined,
): NativeAudioOptions => {
  const source = persisted ?? {};
  const defaults = DEFAULT_NATIVE_AUDIO_OPTIONS;
  return {
    cacheSecs: readNumber(source.audioCacheSecs, defaults.cacheSecs, 0, MAX_CACHE_SECS),
    demuxerMaxMb: readNumber(source.audioDemuxerMaxMB, defaults.demuxerMaxMb, 0, MAX_DEMUXER_MB),
    demuxerBackMb: readNumber(source.audioDemuxerBackMB, defaults.demuxerBackMb, 0, MAX_DEMUXER_MB),
    audioBufferSecs: readNumber(
      source.audioBufferSecs,
      defaults.audioBufferSecs,
      0,
      MAX_AUDIO_BUFFER_SECS,
    ),
    demuxerReadaheadSecs: readNumber(
      source.demuxerReadaheadSecs,
      defaults.demuxerReadaheadSecs,
      0,
      MAX_CACHE_SECS,
    ),
    cache: readChoice(source.cache, CACHE_MODES, defaults.cache),
    cachePause: readBoolean(source.cachePause, defaults.cachePause),
    cachePauseWaitSecs: readNumber(
      source.cachePauseWaitSecs,
      defaults.cachePauseWaitSecs,
      0,
      MAX_CACHE_SECS,
    ),
    audioSamplerate: readSamplerate(source.audioSamplerate ?? defaults.audioSamplerate),
    audioChannels: readChoice(source.audioChannels, AUDIO_CHANNELS, defaults.audioChannels),
    audioFormat: readChoice(source.audioFormat, AUDIO_FORMATS, defaults.audioFormat),
    gaplessAudio: readChoice(source.gaplessAudio, GAPLESS_MODES, defaults.gaplessAudio),
  };
};
