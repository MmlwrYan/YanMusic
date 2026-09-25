#!/usr/bin/env node
/**
 * R2 人工验证脚本 / V4「真实引擎回读」。
 *
 * 链路与主进程 `MpvController.start()` 完全一致：
 *   真实 yan-storage.node 读 KV 键 pinia:setting
 *     == getPersistedRendererSettings()
 *   src/shared/native-audio-options.ts 的 normalizeNativeAudioOptions()
 *     == 主进程归一化（同一份纯逻辑）
 *   yan-mpv-player.initialize(...) → 回读 mpv 属性
 *     == 引擎实际拿到的值
 *
 * 用法（仓库根目录）：
 *   node scripts/verify-r2-audio-options.cjs
 *   node scripts/verify-r2-audio-options.cjs --user-data "D:\\some\\userData"
 *
 * 退出码：0 = 全部 OK；1 = 存在 MISMATCH 或环境不可用。
 *
 * 说明（P1 结论，勿改成「自动通过」）：`audio-format` 的期望值写死为 `no`，
 * 依据是 mpv v0.41.0 `options/m_option.c` 的 parse_afmt() 只接受 af_fmt_to_str()
 * 产出的具体采样格式名（不含 auto），而 print_afmt() 把「未设置」的内部值 0 打印为
 * "no" —— 即回读到的 `no` 是 mpv 的**默认值**，UI 的 auto 现在由「不下发该选项」表达。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..');

const argIndex = process.argv.indexOf('--user-data');
const userData =
  argIndex >= 0 && process.argv[argIndex + 1]
    ? process.argv[argIndex + 1]
    : path.join(os.homedir(), 'AppData', 'Roaming', 'YanMusic');

const storageAddon = path.join(repoRoot, 'native', 'yan-storage', 'yan-storage.node');
const mpvAddon = path.join(repoRoot, 'native', 'yan-mpv-player', 'yan-mpv-player.node');
const libmpvCandidates = [
  path.join(repoRoot, 'build', 'mpv', 'libmpv-2.dll'),
  '/usr/lib/x86_64-linux-gnu/libmpv.so.2',
  '/usr/lib/libmpv.so.2',
  '/opt/homebrew/lib/libmpv.dylib',
];

const fail = (message) => {
  console.error(`FAILED: ${message}`);
  process.exit(1);
};

for (const file of [storageAddon, mpvAddon]) {
  if (!fs.existsSync(file)) fail(`缺少原生模块：${file}（先执行 native/*/npm run build）`);
}
const libmpv = libmpvCandidates.find((candidate) => fs.existsSync(candidate));
if (!libmpv) fail(`未找到 libmpv：${libmpvCandidates.join(' | ')}`);

const dbPath = path.join(userData, 'YanMusic.sqlite');
if (!fs.existsSync(dbPath)) {
  fail(`未找到应用设置库：${dbPath}（先正常启动一次 YanMusic，或用 --user-data 指定）`);
}

const MIB = 1024 * 1024;

/**
 * 期望值 → mpv 属性读取值的映射。
 * 每项：{ option, property, expected(options), note }
 */
const CASES = [
  {
    option: 'audioCacheSecs',
    property: 'cache-secs',
    expected: (o) => o.cacheSecs,
    note: 'R2',
  },
  {
    option: 'audioDemuxerMaxMB',
    property: 'demuxer-max-bytes',
    expected: (o) => o.demuxerMaxMb * MIB,
    note: 'R2（主进程以 "<n>MiB" 下发，mpv 以字节回读）',
  },
  {
    option: 'audioDemuxerBackMB',
    property: 'demuxer-max-back-bytes',
    expected: (o) => o.demuxerBackMb * MIB,
    note: 'R2（同上）',
  },
  {
    option: 'audioBufferSecs',
    property: 'audio-buffer',
    expected: (o) => o.audioBufferSecs,
    note: 'R2',
  },
  {
    option: 'demuxerReadaheadSecs',
    property: 'demuxer-readahead-secs',
    expected: (o) => o.demuxerReadaheadSecs,
    note: '',
  },
  { option: 'cache', property: 'cache', expected: (o) => o.cache, note: '' },
  {
    option: 'cachePause',
    property: 'cache-pause',
    expected: (o) => (o.cachePause ? 'yes' : 'no'),
    note: '',
  },
  {
    option: 'cachePauseWaitSecs',
    property: 'cache-pause-wait',
    expected: (o) => o.cachePauseWaitSecs,
    note: '',
  },
  {
    option: 'audioSamplerate',
    property: 'audio-samplerate',
    expected: (o) => (o.audioSamplerate === 'auto' ? 0 : o.audioSamplerate),
    note: 'mpv 用整数表示，0 == auto',
  },
  {
    option: 'audioChannels',
    property: 'audio-channels',
    expected: (o) => o.audioChannels,
    note: '',
  },
  {
    option: 'audioFormat',
    property: 'audio-format',
    // P1：auto 时不下发该选项，mpv 保持默认值 0（回读为 no）；显式格式名则原样下发。
    expected: (o) => (o.audioFormat === 'auto' ? 'no' : o.audioFormat),
    note: 'P1：auto → mpv 默认值 no；显式格式名原样回读（见文件头注释）',
  },
  { option: 'gaplessAudio', property: 'gapless-audio', expected: (o) => o.gaplessAudio, note: '' },
];

const readProperty = (addon, name) => {
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

const matches = (actual, expected) => {
  const a = Number(actual);
  const e = Number(expected);
  if (Number.isFinite(a) && Number.isFinite(e)) return Math.abs(a - e) < 1e-6;
  return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
};

(async () => {
  console.log('=== R2 人工验证：用户持久化设置 → 归一化 → 真实 libmpv 回读 ===');
  console.log(`仓库：${repoRoot}`);
  console.log(`设置库：${dbPath}`);
  console.log(`libmpv：${libmpv}\n`);

  const storage = require(storageAddon);
  storage.initialize(dbPath);
  const raw = storage.kvGet('pinia:setting');
  if (!raw) fail('KV 键 pinia:setting 为空 —— 该 userData 下没有渲染层持久化设置');

  const persisted = JSON.parse(raw);
  console.log(`KV 键 pinia:setting 读取：${raw.length} 字节`);
  console.log('持久化对象中的相关字段：');
  for (const item of CASES) {
    console.log(`  ${item.option.padEnd(22)} = ${JSON.stringify(persisted[item.option])}`);
  }

  // 与主进程共用同一份纯逻辑（node 直接执行 .ts 需 Node >= 22.6 的类型剥离）
  const shared = await import(
    pathToFileURL(path.join(repoRoot, 'src', 'shared', 'native-audio-options.ts')).href
  );
  const options = shared.normalizeNativeAudioOptions(persisted);
  console.log(`\nnormalizeNativeAudioOptions() 结果：${JSON.stringify(options)}\n`);

  const addon = require(mpvAddon);
  addon.initialize(libmpv, {
    cacheSecs: options.cacheSecs,
    demuxerMaxMb: options.demuxerMaxMb,
    demuxerBackMb: options.demuxerBackMb,
    audioBufferSecs: options.audioBufferSecs,
    demuxerReadaheadSecs: options.demuxerReadaheadSecs,
    cache: options.cache,
    cachePause: options.cachePause,
    cachePauseWaitSecs: options.cachePauseWaitSecs,
    audioSamplerate: options.audioSamplerate,
    audioChannels: options.audioChannels,
    audioFormat: options.audioFormat,
    gaplessAudio: options.gaplessAudio,
  });

  console.log('libmpv 回读（证明设置真的到达引擎）：');
  console.log(`  ${'mpv 属性'.padEnd(24)} ${'期望'.padEnd(12)} ${'实际'.padEnd(12)} 判定`);

  let mismatch = 0;
  for (const item of CASES) {
    const expected = item.expected(options);
    const actual = readProperty(addon, item.property);
    const ok = actual !== null && matches(actual, expected);
    if (!ok) mismatch += 1;
    const suffix = item.note ? `   ← ${item.note}` : '';
    console.log(
      `  ${item.property.padEnd(24)} ${String(expected).padEnd(12)} ${String(actual).padEnd(12)} ${ok ? 'OK' : 'MISMATCH'}${suffix}`,
    );
  }

  try {
    addon.destroy();
  } catch {
    // destroy 失败不影响判定
  }
  storage.close();

  console.log(
    `\n判定：${mismatch === 0 ? 'PASS —— 12 项全部与用户持久化设置一致' : `FAIL —— ${mismatch} 项 MISMATCH`}`,
  );
  process.exit(mismatch === 0 ? 0 : 1);
})().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
