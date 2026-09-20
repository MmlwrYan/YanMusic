#!/usr/bin/env node
/**
 * V5「存量设置迁移端到端」验证脚本（隔离 userData）。
 *
 * 步骤：
 *   1) 在一个全新的临时 userData 里预置一份设置（见 --profile）
 *   2) 用 --user-data-dir 启动真实 Electron 应用（清除会破坏 Electron 启动的环境变量）
 *   3) 轮询设置库，等待一次性迁移落盘
 *   4) 退出应用，读回并判定；同时打印应用日志中的迁移入口/出口记录
 *
 * 用法（仓库根目录）：
 *   node scripts/verify-legacy-migration.cjs                 # V5：全旧默认值 → 全部迁移
 *   node scripts/verify-legacy-migration.cjs --profile custom # V6：只迁移未改过的字段
 *   node scripts/verify-legacy-migration.cjs --profile fresh  # V7：新装对照（不迁移任何字段）
 *
 * 退出码：0 = 判定通过；1 = MISMATCH 或应用未能启动。
 *
 * ⚠️ 环境注意（这正是 20:31/20:42 两次误判为「迁移未生效」的原因）：
 *   DSH harness 的 `node` 垫片（%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd）
 *   会 `set ELECTRON_RUN_AS_NODE=1`，该变量被 Node 子进程继承后，Electron 会退化为
 *   「run as node」模式：`require('electron').app` 为 undefined，主进程在加载
 *   dist-electron/main/index.js 时抛 TypeError 并以 exit code 1 立即退出，
 *   窗口与渲染层（以及渲染层里的迁移）根本不会启动。
 *   本脚本在 spawn 前显式删除该变量，从而排除这一环境因素。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const storageAddon = path.join(repoRoot, 'native', 'yan-storage', 'yan-storage.node');

const profileArgIndex = process.argv.indexOf('--profile');
const profile = profileArgIndex >= 0 ? String(process.argv[profileArgIndex + 1] ?? 'legacy') : 'legacy';

const userData = path.join(os.tmpdir(), `yanmusic-migration-verify-${profile}`);
const dbPath = path.join(userData, 'YanMusic.sqlite');
const KEYS = [
  'demuxerReadaheadSecs',
  'cache',
  'cachePauseWaitSecs',
  'audioChannels',
  'nativeAudioOptionsMigrationDone',
];

/** 1.1.2 之前渲染层这四个字段的默认值（= 存量用户库里保存的值）。 */
const LEGACY_DEFAULTS = {
  demuxerReadaheadSecs: 1,
  cache: 'auto',
  cachePauseWaitSecs: 1,
  audioChannels: 'auto-safe',
};

/** 迁移后应有的值（= 引擎接线前的实际行为）。 */
const MIGRATED_DEFAULTS = {
  demuxerReadaheadSecs: 30,
  cache: 'yes',
  cachePauseWaitSecs: 5,
  audioChannels: 'stereo',
};

/** 用户显式改过的值（V6：迁移必须原样保留）。 */
const USER_TOUCHED = {
  cache: 'no',
  cachePauseWaitSecs: 2.5,
  audioChannels: 'mono',
};

const SHARED_SETTINGS = {
  theme: 'system',
  audioCacheSecs: 30,
  audioDemuxerMaxMB: 48,
  audioDemuxerBackMB: 12,
  audioBufferSecs: 0.5,
  cachePause: true,
  audioSamplerate: 'auto',
  audioFormat: 'auto',
  gaplessAudio: 'weak',
};

const PROFILES = {
  // V5：存量用户，四个字段都还是旧默认值 → 全部迁移
  legacy: {
    seed: { ...SHARED_SETTINGS, ...LEGACY_DEFAULTS },
    expected: { ...MIGRATED_DEFAULTS, nativeAudioOptionsMigrationDone: true },
    description: '存量用户（四项均为旧默认值）→ 四项全部对齐',
  },
  // V6：存量用户，其中三项被显式改过 → 只迁移未改过的那一项
  custom: {
    seed: { ...SHARED_SETTINGS, ...LEGACY_DEFAULTS, ...USER_TOUCHED },
    expected: {
      demuxerReadaheadSecs: MIGRATED_DEFAULTS.demuxerReadaheadSecs,
      cache: USER_TOUCHED.cache,
      cachePauseWaitSecs: USER_TOUCHED.cachePauseWaitSecs,
      audioChannels: USER_TOUCHED.audioChannels,
      nativeAudioOptionsMigrationDone: true,
    },
    description: '存量用户（三项被显式改过）→ 只对齐未改过的 demuxerReadaheadSecs',
  },
  // V7：新装对照 —— 库里没有这四个字段（store 默认值就是新默认值，只有状态变化时才会写盘）。
  // 判定标准不是「持久化对象里出现这四个字段」，而是「引擎实际拿到的配置与存量迁移后逐项相同」，
  // 该比较由本次运行打印的 [MpvController] Native audio options applied 与 legacy 档对照得出。
  fresh: {
    seed: { theme: 'system' },
    expected: { nativeAudioOptionsMigrationDone: true },
    description: '新装用户（库里无这四个字段）→ 引擎配置应与存量迁移后逐项相同',
  },
};

const active = PROFILES[profile];
if (!active) {
  console.error(`未知 profile：${profile}（可选：${Object.keys(PROFILES).join(' | ')}）`);
  process.exit(2);
}

const fail = (message) => {
  console.error(`FAILED: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(electronExe)) fail(`未找到 Electron：${electronExe}`);
if (!fs.existsSync(storageAddon)) fail(`未找到 yan-storage.node：${storageAddon}`);

const storage = require(storageAddon);

const readState = () => {
  const raw = storage.kvGet('pinia:setting');
  return raw ? JSON.parse(raw) : {};
};

const printState = (label) => {
  const state = readState();
  console.log(`[${label}] pinia:setting 中的相关字段：`);
  for (const key of KEYS) {
    console.log(`  ${key.padEnd(34)} = ${JSON.stringify(state[key] ?? null)}`);
  }
  return state;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const killTree = (pid) => {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
};

const readAppLogMigrationLines = () => {
  const lines = [];

  // 1) 应用日志文件（electron-log 的 file transport 是异步刷盘的，被强杀时可能为空）
  const logDir = path.join(userData, 'logs');
  if (fs.existsSync(logDir)) {
    const files = fs
      .readdirSync(logDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => path.join(logDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) {
      lines.push(...fs.readFileSync(files[0], 'utf8').split(/\r?\n/));
    }
  }

  // 2) 被捕获的 stdout（console transport 是同步的，强杀也拿得到）
  const stdoutPath = path.join(userData, 'verify-stdout.txt');
  if (fs.existsSync(stdoutPath)) {
    lines.push(...fs.readFileSync(stdoutPath, 'utf8').split(/\r?\n/));
  }

  const seen = new Set();
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const isHeader = /^\[[^\]]+\]/.test(line);
    const matched =
      line.includes('[AudioOptions]') || line.includes('[迁移]') || line.includes('[MpvController] Native audio options applied');
    if (isHeader) {
      if (current) blocks.push(current);
      current = matched ? [line] : null;
    } else if (current) {
      // 续行（多行 JSON 的 before/after）
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks
    .map((block) => block.join('\n'))
    .filter((block) => {
      const key = block.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

(async () => {
  console.log('=== V5/V6/V7 存量设置迁移端到端验证（隔离 userData）===');
  console.log(`profile：${profile} —— ${active.description}`);
  console.log(`userData：${userData}`);

  // 1) 预置设置
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  storage.initialize(dbPath);
  storage.kvSet('pinia:setting', JSON.stringify(active.seed));
  console.log('');
  printState('BEFORE 预置的设置');
  storage.close();

  // 2) 启动应用（清除 ELECTRON_RUN_AS_NODE）
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const stdoutPath = path.join(userData, 'verify-stdout.txt');
  const stderrPath = path.join(userData, 'verify-stderr.txt');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');

  console.log(
    `\n启动：${electronExe} . --user-data-dir=${userData}` +
      `（env.ELECTRON_RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null)} → 已清除）`,
  );

  const child = spawn(electronExe, ['.', `--user-data-dir=${userData}`], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', stdoutFd, stderrFd],
  });

  let exitedEarly = null;
  child.on('exit', (code, signal) => {
    exitedEarly = { code, signal };
  });

  // 3) 轮询等待迁移落盘
  storage.initialize(dbPath);
  let state = {};
  let migrated = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      state = readState();
      if (state.nativeAudioOptionsMigrationDone === true) {
        migrated = true;
        break;
      }
    } catch (error) {
      // 应用写入瞬间可能拿不到锁，重试即可
      void error;
    }
    if (exitedEarly) break;
    await sleep(500);
  }

  // 4) 退出应用并读回
  let killedByScript = false;
  if (!exitedEarly) {
    killedByScript = true;
    killTree(child.pid);
    await sleep(1500);
  }
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // 注意：Windows 上 `taskkill /F` 终止的进程会以 exit code 1 落定（且 signal 恒为 null），
  // 因此「status=1 signal=none」在本脚本里是**脚本自己强杀**的正常结果，
  // 不是应用故障；只有 killedByScript === false 时才代表应用自行退出。
  console.log(
    killedByScript
      ? `应用退出：由验证脚本 taskkill /T /F 终止（正常路径：应用会一直运行到用户关闭）` +
          (exitedEarly ? `，终止后落定为 status=${exitedEarly.code} signal=${exitedEarly.signal ?? 'none'}` : '')
      : `应用自行退出：status=${exitedEarly.code} signal=${exitedEarly.signal ?? 'none'}`,
  );
  if (!killedByScript && exitedEarly && exitedEarly.code !== 0) {
    console.log(`  应用 stderr 前 20 行：`);
    console.log(
      fs
        .readFileSync(stderrPath, 'utf8')
        .split(/\r?\n/)
        .slice(0, 20)
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  }

  console.log('');
  state = printState('AFTER 应用启动后');

  console.log('\n应用日志中的迁移入口/出口记录：');
  const logLines = readAppLogMigrationLines();
  if (logLines.length === 0) {
    console.log('  （未找到：应用可能未运行到迁移阶段）');
  } else {
    for (const line of logLines) console.log(`  ${line}`);
  }

  const mismatches = Object.entries(active.expected).filter(
    ([key, value]) => state[key] !== value && String(state[key]) !== String(value),
  );
  storage.close();

  console.log('');
  for (const [key, value] of Object.entries(active.expected)) {
    const ok = state[key] === value || String(state[key]) === String(value);
    console.log(
      `  ${key.padEnd(34)} 期望 ${JSON.stringify(value).padEnd(8)} 实际 ${JSON.stringify(state[key] ?? null).padEnd(8)} ${ok ? 'OK' : 'MISMATCH'}`,
    );
  }
  console.log(
    `\n迁移结果：${migrated && mismatches.length === 0 ? 'PASS —— 结果与预期逐项一致' : 'MISMATCH —— 迁移未生效'}`,
  );
  process.exit(migrated && mismatches.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
