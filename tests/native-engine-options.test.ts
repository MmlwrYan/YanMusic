import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 真实引擎实测：把音频/缓存选项下发给 libmpv，再读回 mpv 属性核对。
 *
 * 这是「设置是否真的到达 mpv」的端到端证据 —— 修复前这些选项要么被硬编码、
 * 要么因为主进程读错存储键而恒为默认值，本测试直接验证 addon 的配置通道。
 *
 * 未构建原生模块 / 缺少 libmpv 时自动跳过（CI 的 typecheck 阶段尚未编译 addon）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonPath = path.join(repoRoot, 'native', 'yan-mpv-player', 'yan-mpv-player.node');
const libmpvCandidates = [
  path.join(repoRoot, 'build', 'mpv', 'libmpv-2.dll'),
  '/usr/lib/x86_64-linux-gnu/libmpv.so.2',
  '/usr/lib/libmpv.so.2',
  '/opt/homebrew/lib/libmpv.dylib',
];

const libmpvPath = libmpvCandidates.find((candidate) => existsSync(candidate));
const skip = !existsSync(addonPath) || !libmpvPath;
const skipReason = !existsSync(addonPath)
  ? `原生模块未构建：${addonPath}`
  : `未找到 libmpv：${libmpvCandidates.join(' | ')}`;

interface MpvAddon {
  initialize(libPath: string, config?: Record<string, unknown>): void;
  destroy(): void;
  getProperty(name: string): string;
}

const readOption = (addon: MpvAddon, name: string): string | null => {
  for (const property of [`options/${name}`, name]) {
    try {
      const value = addon.getProperty(property);
      if (value !== null && value !== undefined && value !== '') return String(value);
    } catch {
      // 该属性名不可读，尝试下一个
    }
  }
  return null;
};

/**
 * mpv 回读选项时的格式不统一：数值型选项会格式化成 `7.000000`，字符串型原样返回。
 * 因此数值可比时按数值比较，否则按去空白的小写字符串比较。
 */
const assertOptionEquals = (addon: MpvAddon, name: string, expected: string) => {
  const actual = readOption(addon, name);
  assert.ok(actual !== null, `mpv 属性 options/${name} 不可读`);

  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    assert.equal(
      actualNumber,
      expectedNumber,
      `mpv 属性 ${name} 期望 ${expected}，实际 ${actual}（说明配置未真正下发）`,
    );
    return;
  }

  assert.equal(
    actual.trim().toLowerCase(),
    expected.trim().toLowerCase(),
    `mpv 属性 ${name} 期望 ${expected}，实际 ${actual}（说明配置未真正下发）`,
  );
};

test('自定义音频/缓存选项真实到达 libmpv', { skip: skip ? skipReason : false }, () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as MpvAddon;

  try {
    addon.initialize(libmpvPath!, {
      cacheSecs: 45,
      demuxerMaxMb: 96,
      demuxerBackMb: 24,
      audioBufferSecs: 1.25,
      demuxerReadaheadSecs: 7,
      cache: 'auto',
      cachePause: false,
      cachePauseWaitSecs: 2.5,
      audioSamplerate: '48000',
      audioChannels: 'mono',
      audioFormat: 's16',
      gaplessAudio: 'no',
    });

    const expectations: Array<[string, string]> = [
      ['demuxer-readahead-secs', '7'],
      ['cache', 'auto'],
      ['cache-pause', 'no'],
      ['cache-pause-wait', '2.5'],
      ['cache-secs', '45'],
      ['audio-samplerate', '48000'],
      ['audio-channels', 'mono'],
      ['audio-format', 's16'],
      ['gapless-audio', 'no'],
    ];

    for (const [name, expected] of expectations) {
      assertOptionEquals(addon, name, expected);
    }
  } finally {
    try {
      addon.destroy();
    } catch {
      // destroy 失败不影响断言结果
    }
  }
});

test('选项默认值与接线前的硬编码行为一致（真实引擎回读）', { skip: skip ? skipReason : false }, () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as MpvAddon;

  try {
    // 不传任何配置 → 走 MpvPlayerConfig::default()
    addon.initialize(libmpvPath!);

    // 接线前这些值是被硬编码到 set_option 的，必须逐项一致
    assertOptionEquals(addon, 'cache', 'yes');
    assertOptionEquals(addon, 'cache-pause', 'yes');
    assertOptionEquals(addon, 'cache-pause-wait', '5');
    assertOptionEquals(addon, 'cache-secs', '30');
    assertOptionEquals(addon, 'demuxer-readahead-secs', '30');
    assertOptionEquals(addon, 'audio-samplerate', '0');
    assertOptionEquals(addon, 'audio-channels', 'stereo');
    assertOptionEquals(addon, 'gapless-audio', 'weak');
    // 接线前未设置 audio-format，mpv 默认 no；UI 的 auto 亦规范化为 no
    assertOptionEquals(addon, 'audio-format', 'no');
  } finally {
    try {
      addon.destroy();
    } catch {
      // ignore
    }
  }
});

test('非法取值被归一化，不会注入到 mpv', { skip: skip ? skipReason : false }, () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as MpvAddon;

  try {
    addon.initialize(libmpvPath!, {
      cache: 'yes; rm -rf /',
      audioChannels: 'surround-11.2',
      audioFormat: 'u8',
      gaplessAudio: 'maybe',
      audioSamplerate: 'not-a-rate',
      demuxerReadaheadSecs: Number.NaN,
    });

    // 全部应回落到 MpvPlayerConfig::default() 的白名单值
    assertOptionEquals(addon, 'cache', 'yes');
    assertOptionEquals(addon, 'audio-channels', 'stereo');
    // 实测：mpv 把 audio-format 的 auto 与 no 视为同一含义（不强制输出格式），
    // 回读一律为 no；未设置时也是 no —— 因此 UI 的 auto 与接线前「未设置」等价。
    assertOptionEquals(addon, 'audio-format', 'no');
    assertOptionEquals(addon, 'gapless-audio', 'weak');
    // mpv 的 audio-samplerate 用整数表示，0 == auto
    assertOptionEquals(addon, 'audio-samplerate', '0');
    assertOptionEquals(addon, 'demuxer-readahead-secs', '30');
  } finally {
    try {
      addon.destroy();
    } catch {
      // ignore
    }
  }
});
