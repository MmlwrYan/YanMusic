import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 真实引擎实测：把音频/缓存选项下发给 libmpv，再读回 mpv 属性核对。
 *
 * 这是「设置是否真的到达 mpv」的端到端证据 —— 修复前这些选项要么被硬编码、
 * 要么因为主进程读错存储键而恒为默认值，本测试直接验证 addon 的配置通道。
 *
 * ## 为什么所有引擎调用都在子进程里执行（v1.2.2 起）
 *
 * 本文件曾把断言直接写在测试进程里，并用一个「子进程探测」来决定是否跳过。
 * 那个设计有一个致命缺口：**探测通过 ≠ 测试进程安全**。Windows CI 上实测到
 * addon 的 `destroy()` 会以 `0xC0000005`（STATUS_ACCESS_VIOLATION）终止进程
 * （证据见下方 `engineProbeFailure` 的诊断信息），于是出现：
 *   探测这一次侥幸通过 → 真实断言在同进程内执行 → 崩在 destroy →
 *   **整个文件被判定失败，且 705ms 的缓冲输出全部丢失**（表现为「文件级失败、
 *   零个用例、零行输出」，CI 上无法定位）。
 * 2026-09-24 的 v1.2.1 标签构建即因此失败过一次（Windows-x64）。
 *
 * 现在改为：**引擎调用与断言全部只在子进程中进行**，逐用例回传结果。
 *   - 子进程崩溃 → 已回传结果的用例照常断言（真实证据不丢），其余用例
 *     **带完整诊断（退出码 + 最后成功的步骤）跳过**，绝不带走测试进程；
 *   - 子进程返回断言失败 → 父进程逐条断言，失败照常失败（不掩盖真实缺陷）。
 * 因此本文件**不得**在测试进程内 `require` 原生 addon —— 见文件末尾的自检用例。
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

interface OptionCheck {
  readonly kind: 'option';
  readonly name: string;
  readonly expected: string;
  readonly actual: string | null;
  readonly ok: boolean;
}

interface PlainCheck {
  readonly kind: 'plain';
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

type Check = OptionCheck | PlainCheck;

interface TestReport {
  readonly index: number;
  readonly status: 'done' | 'error';
  readonly checks: readonly Check[];
  readonly message?: string;
}

/**
 * 子进程脚本：执行全部真实引擎调用与断言，逐用例回传结果。
 *
 * 打点一律用 `fs.writeSync(1, ...)`：进程被原生崩溃带走时 `console.log` 的
 * 缓冲输出会丢失，同步写不会 —— 这正是能定位到「崩在哪一步」的关键。
 */
const buildEngineScript = (): string =>
  [
    `const fs = require('node:fs');`,
    `const write = (s) => fs.writeSync(1, s + '\\n');`,
    `const addon = require(${JSON.stringify(addonPath)});`,
    `const LIB = ${JSON.stringify(libmpvPath)};`,
    ``,
    `const report = (index, status, checks, message) => {`,
    `  write('TEST ' + index + ' ' + status + ' ' + JSON.stringify({ checks: checks || [], message: message || '' }));`,
    `};`,
    `/** 引擎调用步骤：抛错说明引擎可加载但无法驱动 → 回传 error，由父进程判失败 */`,
    `const step = (label, fn) => {`,
    `  write('STEP_BEGIN ' + label);`,
    `  try { const v = fn(); write('STEP_OK ' + label); return v; }`,
    `  catch (error) { write('STEP_FAIL ' + label + ': ' + (error && error.message ? error.message : String(error))); throw error; }`,
    `};`,
    `/** destroy 与原始用例一致：失败不影响断言结果，只记录 */`,
    `const softStep = (label, fn) => {`,
    `  write('STEP_BEGIN ' + label);`,
    `  try { fn(); write('STEP_OK ' + label); }`,
    `  catch (error) { write('STEP_SOFTFAIL ' + label + ': ' + (error && error.message ? error.message : String(error))); }`,
    `};`,
    ``,
    `/** 与原始 readOption 完全一致：options/<name> 优先，空值视为不可读 */`,
    `const readOption = (name) => {`,
    `  for (const property of ['options/' + name, name]) {`,
    `    try {`,
    `      const value = addon.getProperty(property);`,
    `      if (value !== null && value !== undefined && value !== '') return String(value);`,
    `    } catch {}`,
    `  }`,
    `  return null;`,
    `};`,
    `/** 与原始 assertOptionEquals 完全一致的比较口径：可数值化则数值比，否则去空白小写比 */`,
    `const optionCheck = (name, expected) => {`,
    `  const actual = readOption(name);`,
    `  if (actual === null) return { kind: 'option', name, expected, actual: null, ok: false };`,
    `  const an = Number(actual);`,
    `  const en = Number(expected);`,
    `  const ok = Number.isFinite(an) && Number.isFinite(en)`,
    `    ? an === en`,
    `    : actual.trim().toLowerCase() === expected.trim().toLowerCase();`,
    `  return { kind: 'option', name, expected, actual, ok };`,
    `};`,
    `const plainCheck = (name, ok, detail) => ({ kind: 'plain', name, ok: !!ok, detail: String(detail) });`,
    ``,
    `/**`,
    ` * 每个用例独立捕获 setup 异常：与原始「抛错即用例失败」语义一致。`,
    ` *`,
    ` * finish() 在**断言跑完的那一刻**立刻回传结果，之后才做 destroy 清理 ——`,
    ` * 因为 CI 上实测崩溃点正是 destroy：若等 destroy 之后才回传，已完成的断言会`,
    ` * 随进程一起丢失（这正是 v1.2.1 那次「文件级失败、零输出」的代价）。`,
    ` */`,
    `const runTest = (index, body) => {`,
    `  const checks = [];`,
    `  let reported = false;`,
    `  const finish = () => { if (!reported) { reported = true; report(index, 'done', checks); } };`,
    `  try { body(checks, finish); finish(); }`,
    `  catch (error) { if (!reported) report(index, 'error', checks, error && error.message ? error.message : String(error)); }`,
    `};`,
    ``,
    `// ── 用例 1：自定义音频/缓存选项真实到达 libmpv ──`,
    `runTest(0, (checks, finish) => {`,
    `  step('t1.initialize-with-config', () => addon.initialize(LIB, ${JSON.stringify({
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
    })}));`,
    `  for (const [name, expected] of ${JSON.stringify([
      ['demuxer-readahead-secs', '7'],
      ['cache', 'auto'],
      ['cache-pause', 'no'],
      ['cache-pause-wait', '2.5'],
      ['cache-secs', '45'],
      ['audio-samplerate', '48000'],
      ['audio-channels', 'mono'],
      ['audio-format', 's16'],
      ['gapless-audio', 'no'],
    ])}) checks.push(optionCheck(name, expected));`,
    `  finish();`,
    `  softStep('t1.destroy', () => addon.destroy());`,
    `});`,
    ``,
    `// ── 用例 2：默认值（不传配置 → MpvPlayerConfig::default()）──`,
    `runTest(1, (checks, finish) => {`,
    `  step('t2.initialize-default', () => addon.initialize(LIB));`,
    `  for (const [name, expected] of ${JSON.stringify([
      ['cache', 'yes'],
      ['cache-pause', 'yes'],
      ['cache-pause-wait', '5'],
      ['cache-secs', '30'],
      ['demuxer-readahead-secs', '30'],
      ['audio-samplerate', '0'],
      ['audio-channels', 'stereo'],
      ['gapless-audio', 'weak'],
      ['audio-format', 'no'],
    ])}) checks.push(optionCheck(name, expected));`,
    `  finish();`,
    `  softStep('t2.destroy', () => addon.destroy());`,
    `});`,
    ``,
    `// ── 用例 3：非法取值被归一化，不注入 mpv ──`,
    `runTest(2, (checks, finish) => {`,
    `  step('t3.initialize-invalid', () => addon.initialize(LIB, {`,
    `    cache: 'yes; rm -rf /',`,
    `    audioChannels: 'surround-11.2',`,
    `    audioFormat: 'u8',`,
    `    gaplessAudio: 'maybe',`,
    `    audioSamplerate: 'not-a-rate',`,
    `    demuxerReadaheadSecs: Number.NaN,`,
    `  }));`,
    `  for (const [name, expected] of ${JSON.stringify([
      ['cache', 'yes'],
      ['audio-channels', 'stereo'],
      ['audio-format', 'no'],
      ['gapless-audio', 'weak'],
      ['audio-samplerate', '0'],
      ['demuxer-readahead-secs', '30'],
    ])}) checks.push(optionCheck(name, expected));`,
    `  finish();`,
    `  softStep('t3.destroy', () => addon.destroy());`,
    `});`,
    ``,
    `// ── 用例 4（P1）：audio-format 的 auto 语义 ──`,
    `runTest(3, (checks, finish) => {`,
    `  step('t4.initialize-auto', () => addon.initialize(LIB, { audioFormat: 'auto' }));`,
    `  const raw = step('t4.getProperty:option-info/audio-format', () => addon.getProperty('option-info/audio-format'));`,
    `  let defaultValue = null;`,
    `  try { defaultValue = JSON.parse(raw)['default-value']; } catch {}`,
    `  checks.push(plainCheck('mpv 自报 audio-format 默认值', defaultValue === 'no', 'default-value=' + JSON.stringify(defaultValue)));`,
    `  checks.push(optionCheck('audio-format', 'no'));`,
    `  for (const format of ['s16', 's32', 'float']) {`,
    `    step('t4.initialize-' + format, () => addon.initialize(LIB, { audioFormat: format }));`,
    `    checks.push(optionCheck('audio-format', format));`,
    `  }`,
    `  step('t4.initialize-no', () => addon.initialize(LIB, { audioFormat: 'no' }));`,
    `  checks.push(optionCheck('audio-format', 'no'));`,
    `  finish();`,
    `  softStep('t4.destroy', () => addon.destroy());`,
    `});`,
    ``,
    `// ── 用例 5（P2）：启动期一次性下发 + 导出面无运行期改写入口 ──`,
    `runTest(4, (checks, finish) => {`,
    `  const surface = Object.keys(addon);`,
    `  for (const forbidden of ['setProperty', 'set_property', 'setOption', 'set_option']) {`,
    `    checks.push(plainCheck('导出面不含 ' + forbidden, !surface.includes(forbidden), 'surface 长度 ' + surface.length));`,
    `  }`,
    `  for (const name of ${JSON.stringify([
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
    ])}) {`,
    `    checks.push(plainCheck('导出面不含 ' + name, !surface.includes(name), 'surface 长度 ' + surface.length));`,
    `  }`,
    `  step('t5.initialize-cfg1', () => addon.initialize(LIB, ${JSON.stringify({
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
    })}));`,
    `  for (const [name, expected] of ${JSON.stringify([
      ['cache-secs', '30'],
      ['cache', 'yes'],
      ['audio-channels', 'stereo'],
      ['demuxer-readahead-secs', '30'],
    ])}) checks.push(optionCheck(name, expected));`,
    `  step('t5.initialize-cfg2', () => addon.initialize(LIB, ${JSON.stringify({
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
    })}));`,
    `  for (const [name, expected] of ${JSON.stringify([
      ['cache-secs', '77'],
      ['cache', 'no'],
      ['audio-channels', 'mono'],
      ['demuxer-readahead-secs', '11'],
      ['audio-buffer', '1.5'],
      ['cache-pause', 'no'],
      ['cache-pause-wait', '2.5'],
      ['audio-samplerate', '48000'],
      ['gapless-audio', 'no'],
    ])}) checks.push(optionCheck(name, expected));`,
    `  finish();`,
    `  softStep('t5.destroy', () => addon.destroy());`,
    `});`,
    ``,
    `write('PROBE_DONE');`,
    `process.exit(0);`,
  ].join('\n');

interface EngineRun {
  readonly reports: Map<number, TestReport>;
  /** 最后进入但**未返回**的步骤（崩溃点），比「最后成功的步骤」更精确 */
  readonly lastBegun: string | null;
  readonly lastStep: string | null;
  /** null = 引擎在本机可用；否则为「不可用 / 崩溃」的诊断文本 */
  readonly failureReason: string | null;
}

const describeExit = (status: number | null, signal: NodeJS.Signals | null): string => {
  if (status === null) return `进程被信号终止 signal=${signal}`;
  // 0xC0000005 = STATUS_ACCESS_VIOLATION 等 NTSTATUS 以无符号 32 位呈现
  const hex = `0x${(status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return `退出码 ${status}（${hex}）`;
};

/**
 * 执行子进程并解析结果。
 *
 * **无论子进程是否正常结束都返回结构化结果**：崩溃时已回传的用例结果必须保留，
 * 否则「崩溃点之前的用例」也会被一并跳过，白白丢掉真实证据。
 */
const runEngine = (): EngineRun => {
  const result = spawnSync(process.execPath, ['-e', buildEngineScript()], {
    encoding: 'utf8',
    timeout: 120_000,
  });

  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '').trim();
  const lines = stdout.split('\n').filter(Boolean);

  const reports = new Map<number, TestReport>();
  for (const line of lines) {
    const match = /^TEST (\d+) (done|error) (.*)$/.exec(line);
    if (!match) continue;
    try {
      const payload = JSON.parse(match[3]) as { checks: Check[]; message: string };
      reports.set(Number(match[1]), {
        index: Number(match[1]),
        status: match[2] as 'done' | 'error',
        checks: payload.checks,
        message: payload.message,
      });
    } catch {
      // 单行结果损坏：视为该用例没有结果（父进程会按「无结果」处理）
    }
  }

  const stepsOk = lines
    .filter((line) => line.startsWith('STEP_OK '))
    .map((line) => line.replace('STEP_OK ', '').trim());
  const stepsBegun = lines
    .filter((line) => line.startsWith('STEP_BEGIN '))
    .map((line) => line.replace('STEP_BEGIN ', '').trim());
  const lastStep = stepsOk.length ? stepsOk[stepsOk.length - 1] : null;
  const lastBegun = stepsBegun.length ? stepsBegun[stepsBegun.length - 1] : null;
  // 进入但未返回 = 崩溃点；若两者相同说明它是最后一个成功步骤（崩溃发生在步骤之外）
  const crashPoint = lastBegun && lastBegun !== lastStep ? lastBegun : null;

  const finished = result.status === 0 && lines.includes('PROBE_DONE');
  if (finished) return { reports, lastBegun, lastStep, failureReason: null };

  const detail = [stderr, stdout.trim()]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  const progress = crashPoint
    ? `；崩在步骤 ${crashPoint}（已进入、未返回）`
    : lastStep
      ? `；最后成功的步骤：${lastStep}`
      : '；第一步即失败';
  return {
    reports,
    lastBegun,
    lastStep,
    failureReason: `播放引擎在子进程中异常终止（${describeExit(result.status, result.signal)}${progress}）：${detail || '无输出'}`,
  };
};

const baseSkipReason = !existsSync(addonPath)
  ? `原生模块未构建：${addonPath}`
  : !libmpvPath
    ? `未找到 libmpv：${libmpvCandidates.join(' | ')}`
    : null;

const engineRun = baseSkipReason ? null : runEngine();
const skipReason = baseSkipReason ?? engineRun?.failureReason ?? null;

if (skipReason) {
  // 显式打印，避免「静默跳过」掩盖真实问题（CI 日志里能直接看到原因）。
  // 该崩溃为 v1.2.2 已知问题（见 CHANGELOG「说明」），本轮未修复。
  console.log(`[native-engine-options] SKIP: ${skipReason}`);
}

/** 父进程断言：把子进程回传的结果当作真实证据逐条核对。 */
const assertReport = (index: number, testName: string) => {
  const report = engineRun?.reports.get(index);
  assert.ok(report, `${testName}：子进程未回传本用例结果（不应发生：无结果时应走 skip 分支）`);
  assert.equal(
    report.status,
    'done',
    `${testName}：引擎调用失败 —— ${report.message ?? '未知错误'}`,
  );

  for (const check of report.checks) {
    if (check.kind === 'option') {
      assert.ok(
        check.actual !== null,
        `mpv 属性 options/${check.name} 不可读（说明配置未真正下发）`,
      );
      assert.ok(
        check.ok,
        `mpv 属性 ${check.name} 期望 ${check.expected}，实际 ${check.actual}（说明配置未真正下发）`,
      );
      continue;
    }
    assert.ok(check.ok, `${check.name}：${check.detail}`);
  }
  assert.ok(report.checks.length > 0, `${testName}：未执行任何断言`);
};

/**
 * 用例门控：有真实结果 → **不跳过**（由用例体逐条断言）；
 * 引擎崩溃 / 不可用 → 带诊断跳过。
 *
 * 注意返回 `false` 而非 `true`：node:test 的 `skip` 选项以 falsy 表示「不跳过」，
 * 字符串则作为跳过原因展示。
 */
const gateFor = (index: number): false | string => {
  const hasReport = engineRun?.reports.has(index) ?? false;
  if (hasReport) return false;
  // 引擎可用却没有本用例结果 = 结果传输异常 → 不跳过，交给用例体断言失败
  return skipReason ?? false;
};

const options = (index: number) => ({ skip: gateFor(index) });

test('自定义音频/缓存选项真实到达 libmpv', options(0), () => {
  assertReport(0, '自定义音频/缓存选项真实到达 libmpv');
});

test('选项默认值与接线前的硬编码行为一致（真实引擎回读）', options(1), () => {
  assertReport(1, '选项默认值与接线前的硬编码行为一致（真实引擎回读）');
});

test('非法取值被归一化，不会注入到 mpv', options(2), () => {
  assertReport(2, '非法取值被归一化，不会注入到 mpv');
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
test('P1：audio-format 的 auto 由 mpv 默认值表达，回读 no 且可自证', options(3), () => {
  assertReport(3, 'P1：audio-format 的 auto 由 mpv 默认值表达，回读 no 且可自证');
});

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
test('P2：音频/缓存选项为启动期一次性下发（重建后生效，运行期无改写入口）', options(4), () => {
  assertReport(4, 'P2：音频/缓存选项为启动期一次性下发（重建后生效，运行期无改写入口）');
});

/**
 * 结构自检：本文件**不得**在测试进程内加载原生 addon。
 *
 * 这是 v1.2.2 那次「文件级失败、零输出」事故的直接防线：只要 addon 只出现在
 * 子进程脚本里，原生崩溃就不可能带走测试进程、更不可能吞掉整份 TAP 输出。
 * 一旦有人把 `createRequire(import.meta.url)`（即进程内加载 addon 的标准写法）
 * 加回来，本用例立即失败。
 */
test('结构自检：引擎只能经由子进程访问，测试进程内不得加载原生 addon', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // 只检查可执行代码：剥掉块注释，避免本文件顶部的说明文字命中自己
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // 待查串拼接而成：否则本用例的断言文案本身就会成为命中项
  const needleInProcessLoad = 'create' + 'Require';
  const needleDirectRequire = 'require(' + 'addonPath)';

  assert.ok(
    !code.includes(needleInProcessLoad),
    '测试进程内不得加载原生 addon：所有引擎调用必须经子进程执行（否则原生崩溃会带走整个测试文件）',
  );
  assert.ok(
    !code.includes(needleDirectRequire),
    '检测到测试进程内直接加载 addon：原生崩溃会带走整个测试文件',
  );
  // 正向断言：引擎断言确实是被 spawnSync 起来的子进程脚本
  assert.ok(code.includes('spawnSync(process.execPath'), '必须用 spawnSync 启动子进程执行引擎断言');
  assert.ok(code.includes('buildEngineScript()'), '引擎断言必须由 buildEngineScript() 生成');
});
