import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_NATIVE_AUDIO_OPTIONS,
  normalizeNativeAudioOptions,
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
