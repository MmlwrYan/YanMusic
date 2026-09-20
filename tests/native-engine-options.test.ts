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
    // 接线前未设置 audio-format，mpv 默认 no；UI 的 auto 等价于「不强制输出格式」，
    // 现在也表达为「不下发该选项」，因此回读同样是 no（依据见文件末尾 P1 用例）。
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
    // P1：mpv 不认 auto 这个字面量，回读到的 no 是「未设置」的默认值，
    // 因此这里对 no 做显式断言（依据见文件末尾「audio-format 语义」用例）。
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

/**
 * P1 — `audio-format` 的 `auto → no` 究竟是什么语义。
 *
 * 结论：**既不是「libmpv 对 auto 的正常归一化回读」，也不是「映射层把非法值改写成 no」**，
 * 而是：`auto` 根本不是 mpv `--audio-format` 的合法取值，写入被 mpv 拒绝，选项保持
 * 「未设置」的内部值 0，回读时被打印成 `no`。因此回读到的 `no` 是**默认值**。
 *
 * 依据（三重且互相独立）：
 *  1. 官方手册（mpv `DOCS/man/options.rst`）：``--audio-format=<format>`` —
 *     "The values that ``<format>`` can adopt are listed below in the description of the
 *     ``format`` audio filter."，即只接受具体采样格式名，取值表里没有 `auto`。
 *  2. 引擎源码（与 `build/mpv/libmpv-2.dll` 同源；该 DLL 自报 `mpv v0.41.0-1012-ge8673660a`）
 *     `options/m_option.c`：
 *       parse_afmt(): for (i = 1; i < AF_FORMAT_COUNT; i++) if (bstr_equals0(param,
 *                      af_fmt_to_str(i))) fmt = i;
 *                     if (!fmt) { mp_err("unknown format name"); return M_OPT_INVALID; }
 *       print_afmt(): return fmt ? af_fmt_to_str(fmt) : "no";
 *     而 `audio/format.c` 的 `af_fmt_to_str()` 只产出 u8/s16/s32/s64/float/double/…p，
 *     既没有 `auto` 也没有 `no`。
 *  3. 本用例的真实引擎回读：写 auto → 读 no；写 s16/s32/float → 原样读回；
 *     `option-info/audio-format` 由 mpv 自己报告 `default-value: "no"`。
 *
 * 处理：UI 的 `auto`（= 不强制输出格式）改为由**不下发该选项**表达，语义与 mpv 默认完全
 * 一致，同时消除了原先那次被 `set_option` 静默吞掉的非法写入（见 player.rs）。
 */
test('P1：audio-format 的 auto 由 mpv 默认值表达，回读 no 且可自证', { skip: skip ? skipReason : false }, () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as MpvAddon;

  try {
    // 1) mpv 自己报告的默认值就是 no
    addon.initialize(libmpvPath!, { audioFormat: 'auto' });
    const info = JSON.parse(addon.getProperty('option-info/audio-format')) as {
      'default-value': string;
    };
    assert.equal(
      info['default-value'],
      'no',
      'mpv 自报 audio-format 默认值应为 no（说明回读的 no 是默认值而非 auto 的别名）',
    );
    assertOptionEquals(addon, 'audio-format', 'no');

    // 2) 具体格式名仍能真正下发 —— 映射层没有被削弱
    for (const format of ['s16', 's32', 'float']) {
      addon.initialize(libmpvPath!, { audioFormat: format });
      assertOptionEquals(addon, 'audio-format', format);
    }

    // 3) 非法值一律回落 auto（= 不下发），回读仍是默认 no
    addon.initialize(libmpvPath!, { audioFormat: 'no' });
    assertOptionEquals(addon, 'audio-format', 'no');
  } finally {
    try {
      addon.destroy();
    } catch {
      // ignore
    }
  }
});
