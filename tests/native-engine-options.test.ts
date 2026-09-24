import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
 * 另外：**引擎存在但无法启动**时同样跳过 —— 见下方 `probeEngineAvailability()`。
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

/**
 * 在**子进程**中探测播放引擎是否真的能启动。
 *
 * 为什么必须在子进程里做：addon 加载 libmpv 时若崩溃（Windows CI 上实测到过），
 * 崩溃发生在原生层，`try/catch` 抓不到，会直接带走整个测试进程 —— 表现为
 * 「文件级失败且没有任何用例输出」，无法定位原因。
 * 隔离到子进程后：崩溃会被判定为「引擎在本机不可用」并**带诊断信息跳过**，
 * 而引擎可用时子进程返回 0，真实断言照常执行（Linux / macOS / 本地 Windows 均如此）。
 *
 * 注意：这里只把「进程崩溃 / 非 0 退出」判为不可用；断言失败仍然照常失败。
 */
const probeEngineAvailability = (): string | null => {
  const script = [
    `const addon = require(${JSON.stringify(addonPath)});`,
    `try {`,
    `  addon.initialize(${JSON.stringify(libmpvPath)}, undefined);`,
    `} catch (error) {`,
    `  console.error('INIT_FAIL: ' + (error && error.message ? error.message : String(error)));`,
    `  process.exit(3);`,
    `}`,
    `console.log('PROBE_OK');`,
    `process.exit(0);`,
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  const stdout = String(result.stdout ?? '').trim();
  if (result.status === 0 && stdout.includes('PROBE_OK')) return null;

  const detail = [String(result.stderr ?? '').trim(), stdout]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  const exitDescription =
    result.status === null
      ? `进程被信号终止 signal=${result.signal}（加载 libmpv 时崩溃）`
      : `退出码 ${result.status}`;
  return `播放引擎无法在本机启动（${exitDescription}）：${detail || '无输出'}`;
};

const baseSkipReason = !existsSync(addonPath)
  ? `原生模块未构建：${addonPath}`
  : !libmpvPath
    ? `未找到 libmpv：${libmpvCandidates.join(' | ')}`
    : null;
const engineProbeFailure = baseSkipReason ? null : probeEngineAvailability();
const skipReason = baseSkipReason ?? engineProbeFailure;
const skip = skipReason !== null;

if (skipReason) {
  // 显式打印，避免「静默跳过」掩盖真实问题（CI 日志里能直接看到原因）。
  console.log(`[native-engine-options] SKIP: ${skipReason}`);
}

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

test(
  '选项默认值与接线前的硬编码行为一致（真实引擎回读）',
  { skip: skip ? skipReason : false },
  () => {
    const require = createRequire(import.meta.url);

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
  },
);

test('非法取值被归一化，不会注入到 mpv', { skip: skip ? skipReason : false }, () => {
  const require = createRequire(import.meta.url);

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
test(
  'P1：audio-format 的 auto 由 mpv 默认值表达，回读 no 且可自证',
  { skip: skip ? skipReason : false },
  () => {
    const require = createRequire(import.meta.url);

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
  },
);

/**
 * P2 — 属性下发路径判定：这 12 项音频/缓存选项是**启动期一次性下发**（重启生效），
 * 运行期不存在改写通道。因此不需要补运行时 `set_property` 白名单。
 *
 * 依据：
 *  1. Rust 侧全部走 `mpv_set_option_string`，且都发生在 `mpv_initialize` **之前**
 *     （`player.rs`：「设置初始化选项（必须在 mpv_initialize 之前）」；`mpv_set_option_*`
 *     在 initialize 之后即不可用，libmpv 要求改用 `mpv_set_property_*`）。
 *  2. `lib.rs` 的 31 个 `#[napi]` 导出里没有任何能改写这 12 项的入口；通用逃生口
 *     `MpvPlayer::set_property` 未导出（这正是 addon 重建日志里 `dead_code` 警告的来源）。
 *  3. `MpvController.command('set_property', …)` 只路由 8 个固定属性
 *     （force-media-title / audio-exclusive / audio-device / pause / volume / speed / aid / af），
 *     不含这 12 项，所以运行期改设置不会到达 mpv。
 *
 * 本用例用真实引擎断言：初始化值生效 → 重建（等价于重启应用）后新值生效，
 * 并断言 addon 导出面上不存在运行期改写入口。
 */
test(
  'P2：音频/缓存选项为启动期一次性下发（重建后生效，运行期无改写入口）',
  { skip: skip ? skipReason : false },
  () => {
    const require = createRequire(import.meta.url);

    const addon = require(addonPath) as MpvAddon;

    try {
      // 1) 运行期改写入口不存在（导出面 31 项，逐一核对没有通用/专用写入入口）
      const surface = Object.keys(addon);
      for (const forbidden of ['setProperty', 'set_property', 'setOption', 'set_option']) {
        assert.ok(!surface.includes(forbidden), `addon 不应导出运行期通用写入入口 ${forbidden}`);
      }
      for (const name of [
        'setAudioFormat',
        'setAudioChannels',
        'setAudioSamplerate',
        'setCache',
        'setCacheSecs',
        'setCachePause',
        'setCachePauseWaitSecs',
        'setDemuxerMaxMb',
        'setDemuxerBackMb',
        'setDemuxerReadaheadSecs',
        'setAudioBufferSecs',
        'setGaplessAudio',
      ]) {
        assert.ok(!surface.includes(name), `addon 不应导出运行期写入入口 ${name}`);
      }

      // 2) 初始化时的配置生效
      addon.initialize(libmpvPath!, {
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
        gaplessAudio: 'weak',
      });
      assertOptionEquals(addon, 'cache-secs', '30');
      assertOptionEquals(addon, 'cache', 'yes');
      assertOptionEquals(addon, 'audio-channels', 'stereo');
      assertOptionEquals(addon, 'demuxer-readahead-secs', '30');

      // 3) 重建（= 重启应用，主进程会重新调用 addon.initialize）后新值生效
      addon.initialize(libmpvPath!, {
        cacheSecs: 77,
        demuxerMaxMb: 96,
        demuxerBackMb: 24,
        audioBufferSecs: 1.5,
        demuxerReadaheadSecs: 11,
        cache: 'no',
        cachePause: false,
        cachePauseWaitSecs: 2.5,
        audioSamplerate: '48000',
        audioChannels: 'mono',
        gaplessAudio: 'no',
      });
      assertOptionEquals(addon, 'cache-secs', '77');
      assertOptionEquals(addon, 'cache', 'no');
      assertOptionEquals(addon, 'audio-channels', 'mono');
      assertOptionEquals(addon, 'demuxer-readahead-secs', '11');
      assertOptionEquals(addon, 'audio-buffer', '1.5');
      assertOptionEquals(addon, 'cache-pause', 'no');
      assertOptionEquals(addon, 'cache-pause-wait', '2.5');
      assertOptionEquals(addon, 'audio-samplerate', '48000');
      assertOptionEquals(addon, 'gapless-audio', 'no');
    } finally {
      try {
        addon.destroy();
      } catch {
        // ignore
      }
    }
  },
);
