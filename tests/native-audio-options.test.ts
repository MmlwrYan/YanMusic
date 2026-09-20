import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLegacyAudioOptionDefaultMigration,
  DEFAULT_NATIVE_AUDIO_OPTIONS,
  LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS,
  NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG,
  normalizeNativeAudioOptions,
  resolveLegacyAudioOptionDefaultPatch,
} from '../src/shared/native-audio-options.ts';

/**
 * 这些断言把「接线前的实际行为」固化为回归基线：
 * 接线前 MpvController 直接把下列值硬编码给 mpv 的 set_option，
 * 因此默认值必须逐项相等，否则接线本身就会改变既有听感/缓冲行为。
 */
test('默认值与接线前硬编码到 mpv 的值逐项一致', () => {
  assert.deepEqual(DEFAULT_NATIVE_AUDIO_OPTIONS, {
    cacheSecs: 30,
    demuxerMaxMb: 48,
    demuxerBackMb: 12,
    audioBufferSecs: 0.5,
    demuxerReadaheadSecs: 30,
    cache: 'yes',
    cachePause: true,
    cachePauseWaitSecs: 5,
    audioSamplerate: 'auto',
    audioChannels: 'stereo',
    audioFormat: 'auto',
    gaplessAudio: 'weak',
  });
});

test('持久化对象为空时全部回落默认值', () => {
  assert.deepEqual(normalizeNativeAudioOptions({}), DEFAULT_NATIVE_AUDIO_OPTIONS);
  assert.deepEqual(normalizeNativeAudioOptions(null), DEFAULT_NATIVE_AUDIO_OPTIONS);
  assert.deepEqual(normalizeNativeAudioOptions(undefined), DEFAULT_NATIVE_AUDIO_OPTIONS);
});

/**
 * 回归：修复前主进程读的是裸 KV 键（audioCacheSecs 等），而渲染层把设置
 * 持久化在 pinia:setting 这一个整对象里，读取恒为 null → 用户改动永不生效。
 * 这里断言「持久化对象里的值会被读到」。
 */
test('回归：从 pinia:setting 形状的持久化对象中读到用户设置', () => {
  const persisted = {
    audioCacheSecs: 60,
    audioDemuxerMaxMB: 128,
    audioDemuxerBackMB: 32,
    audioBufferSecs: 1.5,
    demuxerReadaheadSecs: 8,
    cache: 'auto',
    cachePause: false,
    cachePauseWaitSecs: 2.5,
    audioSamplerate: '48000',
    audioChannels: 'auto-safe',
    audioFormat: 'float',
    gaplessAudio: 'yes',
    // 同一对象里混有其他设置项，不应影响解析
    theme: 'dark',
    defaultAudioQuality: 'high',
  };

  assert.deepEqual(normalizeNativeAudioOptions(persisted), {
    cacheSecs: 60,
    demuxerMaxMb: 128,
    demuxerBackMb: 32,
    audioBufferSecs: 1.5,
    demuxerReadaheadSecs: 8,
    cache: 'auto',
    cachePause: false,
    cachePauseWaitSecs: 2.5,
    audioSamplerate: '48000',
    audioChannels: 'auto-safe',
    audioFormat: 'float',
    gaplessAudio: 'yes',
  });
});

test('数值越界被夹取到合法区间', () => {
  const options = normalizeNativeAudioOptions({
    audioCacheSecs: -5,
    audioDemuxerMaxMB: 999999,
    audioBufferSecs: 999,
    demuxerReadaheadSecs: -1,
    cachePauseWaitSecs: -3,
  });

  assert.equal(options.cacheSecs, 0);
  assert.equal(options.demuxerMaxMb, 4096);
  assert.equal(options.audioBufferSecs, 10);
  assert.equal(options.demuxerReadaheadSecs, 0);
  assert.equal(options.cachePauseWaitSecs, 0);
});

test('非法取值回落到默认值（不把任意字符串注入 mpv 选项）', () => {
  const options = normalizeNativeAudioOptions({
    cache: 'yes; rm -rf /',
    audioChannels: 'surround-11.2',
    audioFormat: 'u8',
    gaplessAudio: 'maybe',
    audioSamplerate: 'not-a-rate',
  });

  assert.equal(options.cache, DEFAULT_NATIVE_AUDIO_OPTIONS.cache);
  assert.equal(options.audioChannels, DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels);
  assert.equal(options.audioFormat, DEFAULT_NATIVE_AUDIO_OPTIONS.audioFormat);
  assert.equal(options.gaplessAudio, DEFAULT_NATIVE_AUDIO_OPTIONS.gaplessAudio);
  assert.equal(options.audioSamplerate, 'auto');
});

test('audioSamplerate 的 auto / 数值映射', () => {
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: 'auto' }).audioSamplerate, 'auto');
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: 'AUTO' }).audioSamplerate, 'auto');
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: '44100' }).audioSamplerate, '44100');
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: '192000' }).audioSamplerate, '192000');
  // 超出 mpv 支持范围 → 回 auto，而不是把非法值透传
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: '1' }).audioSamplerate, 'auto');
  assert.equal(normalizeNativeAudioOptions({ audioSamplerate: '9999999' }).audioSamplerate, 'auto');
});

test('cachePause 只接受布尔值', () => {
  assert.equal(normalizeNativeAudioOptions({ cachePause: false }).cachePause, false);
  assert.equal(normalizeNativeAudioOptions({ cachePause: true }).cachePause, true);
  assert.equal(
    normalizeNativeAudioOptions({ cachePause: 'no' as unknown as boolean }).cachePause,
    DEFAULT_NATIVE_AUDIO_OPTIONS.cachePause,
  );
});

test('NaN / Infinity 不会污染结果（非有限值一律回落默认值）', () => {
  const options = normalizeNativeAudioOptions({
    audioCacheSecs: Number.NaN,
    audioBufferSecs: Number.POSITIVE_INFINITY,
    cachePauseWaitSecs: Number.NEGATIVE_INFINITY,
    demuxerReadaheadSecs: Number.NaN,
  });

  assert.equal(options.cacheSecs, DEFAULT_NATIVE_AUDIO_OPTIONS.cacheSecs);
  assert.equal(options.audioBufferSecs, DEFAULT_NATIVE_AUDIO_OPTIONS.audioBufferSecs);
  assert.equal(options.cachePauseWaitSecs, DEFAULT_NATIVE_AUDIO_OPTIONS.cachePauseWaitSecs);
  assert.equal(options.demuxerReadaheadSecs, DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs);
});

/**
 * 存量设置对齐（一次性迁移）。
 *
 * 渲染层会把整个 store 状态（含默认值）持久化，所以 1.1.2 之前用过应用的用户，
 * 其 `pinia:setting` 里保存的是旧默认值。若不对齐，接线生效后他们的
 * 缓冲时长 / 缓存模式 / 输出声道会静默变化 —— 这正是本迁移要避免的。
 */
test('存量旧默认值被对齐到引擎接线前的实际行为', () => {
  const patch = resolveLegacyAudioOptionDefaultPatch({
    demuxerReadaheadSecs: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.demuxerReadaheadSecs,
    cache: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.cache,
    cachePauseWaitSecs: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.cachePauseWaitSecs,
    audioChannels: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.audioChannels,
  });

  assert.deepEqual(patch, {
    demuxerReadaheadSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs,
    cache: DEFAULT_NATIVE_AUDIO_OPTIONS.cache,
    cachePauseWaitSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.cachePauseWaitSecs,
    audioChannels: DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels,
  });
});

test('用户显式改过的值不会被迁移覆盖', () => {
  const patch = resolveLegacyAudioOptionDefaultPatch({
    demuxerReadaheadSecs: 5,
    cache: 'no',
    cachePauseWaitSecs: 2.5,
    audioChannels: 'mono',
  });

  assert.deepEqual(patch, {});
});

test('部分字段改过时只迁移未改过的字段', () => {
  const patch = resolveLegacyAudioOptionDefaultPatch({
    demuxerReadaheadSecs: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.demuxerReadaheadSecs, // 未改过
    cache: 'no', // 用户改过
    cachePauseWaitSecs: 2.5, // 用户改过
    audioChannels: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.audioChannels, // 未改过
  });

  assert.deepEqual(patch, {
    demuxerReadaheadSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs,
    audioChannels: DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels,
  });
});

test('新装（已是新默认值）不需要迁移', () => {
  const patch = resolveLegacyAudioOptionDefaultPatch({
    demuxerReadaheadSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs,
    cache: DEFAULT_NATIVE_AUDIO_OPTIONS.cache,
    cachePauseWaitSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.cachePauseWaitSecs,
    audioChannels: DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels,
  });

  assert.deepEqual(patch, {});
});

/**
 * 迁移的最终目的：把「接线前的实际行为」变成新默认值，
 * 使「存量用户升级后」与「新装用户」拿到完全相同的引擎配置。
 */
test('迁移后存量用户与新装用户得到同一份引擎配置', () => {
  const legacyStored = {
    audioCacheSecs: 30,
    audioDemuxerMaxMB: 48,
    audioDemuxerBackMB: 12,
    audioBufferSecs: 0.5,
    ...LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS,
    audioSamplerate: 'auto',
    audioFormat: 'auto',
    gaplessAudio: 'weak',
    cachePause: true,
  };

  const migrated = {
    ...legacyStored,
    ...resolveLegacyAudioOptionDefaultPatch(legacyStored),
  };

  const freshState = {
    audioCacheSecs: 30,
    audioDemuxerMaxMB: 48,
    audioDemuxerBackMB: 12,
    audioBufferSecs: 0.5,
    demuxerReadaheadSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs,
    cache: DEFAULT_NATIVE_AUDIO_OPTIONS.cache,
    cachePause: true,
    cachePauseWaitSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.cachePauseWaitSecs,
    audioSamplerate: 'auto',
    audioChannels: DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels,
    audioFormat: 'auto',
    gaplessAudio: 'weak',
  };

  assert.deepEqual(
    normalizeNativeAudioOptions(migrated),
    normalizeNativeAudioOptions(freshState),
  );
});

/**
 * 主进程 / 渲染层共用的迁移入口 `applyLegacyAudioOptionDefaultMigration`。
 *
 * 它是 V5（隔离 userData 端到端）、V6（不覆盖存量用户已改过的值）、
 * V7（存量与新装得到同一份引擎配置）三项验收的可测试内核。
 */
test('applyLegacyAudioOptionDefaultMigration：迁移一次并写入标记，其他设置项不动', () => {
  const migrated = applyLegacyAudioOptionDefaultMigration({
    theme: 'dark',
    defaultAudioQuality: 'high',
    ...LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS,
  });

  assert.ok(migrated, '未迁移过时应返回迁移后的对象');
  assert.equal(migrated[NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG], true);
  // 与被迁移字段无关的设置项必须原样保留（迁移是整对象写回，不能丢键）
  assert.equal(migrated.theme, 'dark');
  assert.equal(migrated.defaultAudioQuality, 'high');
  assert.deepEqual(
    {
      demuxerReadaheadSecs: migrated.demuxerReadaheadSecs,
      cache: migrated.cache,
      cachePauseWaitSecs: migrated.cachePauseWaitSecs,
      audioChannels: migrated.audioChannels,
    },
    {
      demuxerReadaheadSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs,
      cache: DEFAULT_NATIVE_AUDIO_OPTIONS.cache,
      cachePauseWaitSecs: DEFAULT_NATIVE_AUDIO_OPTIONS.cachePauseWaitSecs,
      audioChannels: DEFAULT_NATIVE_AUDIO_OPTIONS.audioChannels,
    },
  );

  // 幂等：标记已为 true 时返回 null（调用方据此跳过写盘）
  assert.equal(applyLegacyAudioOptionDefaultMigration(migrated), null);
  assert.equal(
    applyLegacyAudioOptionDefaultMigration({ [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: true }),
    null,
  );
});

test('applyLegacyAudioOptionDefaultMigration：不覆盖存量用户显式改过的值（V6）', () => {
  const migrated = applyLegacyAudioOptionDefaultMigration({
    demuxerReadaheadSecs: LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS.demuxerReadaheadSecs, // 未改过
    cache: 'no', // 用户改过
    cachePauseWaitSecs: 2.5, // 用户改过
    audioChannels: 'mono', // 用户改过
  });

  assert.ok(migrated);
  assert.equal(migrated.demuxerReadaheadSecs, DEFAULT_NATIVE_AUDIO_OPTIONS.demuxerReadaheadSecs);
  assert.equal(migrated.cache, 'no');
  assert.equal(migrated.cachePauseWaitSecs, 2.5);
  assert.equal(migrated.audioChannels, 'mono');
});

test('applyLegacyAudioOptionDefaultMigration：新装（空对象）只写标记', () => {
  assert.deepEqual(applyLegacyAudioOptionDefaultMigration({}), {
    [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: true,
  });
  assert.deepEqual(applyLegacyAudioOptionDefaultMigration(null), {
    [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: true,
  });
});

test('applyLegacyAudioOptionDefaultMigration：迁移后存量与新装得到逐项相同的引擎配置（V7）', () => {
  const legacyPersisted = {
    audioCacheSecs: 30,
    audioDemuxerMaxMB: 48,
    audioDemuxerBackMB: 12,
    audioBufferSecs: 0.5,
    cachePause: true,
    audioSamplerate: 'auto',
    audioFormat: 'auto',
    gaplessAudio: 'weak',
    ...LEGACY_RENDERER_AUDIO_OPTION_DEFAULTS,
  };
  const migrated = applyLegacyAudioOptionDefaultMigration(legacyPersisted);
  assert.ok(migrated);

  // 新装用户：库里只有迁移标记，其余全是 store 新默认值
  const freshPersisted = { [NATIVE_AUDIO_OPTIONS_MIGRATION_FLAG]: true };

  assert.deepEqual(normalizeNativeAudioOptions(migrated), normalizeNativeAudioOptions(freshPersisted));
  assert.deepEqual(normalizeNativeAudioOptions(migrated), DEFAULT_NATIVE_AUDIO_OPTIONS);
});
