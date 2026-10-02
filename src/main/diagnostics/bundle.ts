import { app } from 'electron';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getAppMemoryMetrics } from './memory';
import { getKvStorage } from '../storage/kv';
import { getStartupDegradations } from '../startupDiagnostics';
import { redactValue, type RedactContext } from './redact';
import { buildZipBuffer, type ZipEntryInput } from './zipWriter';
import log from '../logger';

/**
 * S-6（v1.3.0）：**一键导出诊断包**。
 *
 * ## 为什么需要
 *
 * 采集能力早就够了 —— `electron-log`（`app.getPath('logs')`）、诊断模式
 *（`logger.ts` 的 `isDiagnosticModeActive`）、`eventLoopMonitor`（卡顿探测）、
 * `diagnostics/memory.ts`（进程内存）都在。**缺的是一个统一出口**：
 * 用户遇到问题时没有「把该给的都给我」的按钮，只能截图或自己翻目录。
 *
 * ## 内容与安全
 *
 * 包内只有四类东西，且**设置一律脱敏**（见 `redact.ts`）：
 * 1. `README.txt` —— 说明每个文件是什么、以及「已脱敏但仍请自行过目」
 * 2. `diagnostics.json` —— 版本/平台/架构/运行环境 + 启动降级项 + 内存 + 卡顿摘要
 * 3. `settings-redacted.json` —— 脱敏后的设置
 * 4. `logs/*.log` —— 最近的日志文件（受总量上限约束）
 *
 * **刻意不收录**：`pinia:user` / `pinia:device`（登录票据与设备指纹）
 * —— 白名单式地只读 `pinia:setting`，其余 KV 键根本不读（fail-closed）。
 *
 * **不引入任何第三方上报**（规划 §5 的隐私红线）：本模块只**在用户主动点击时**
 * 生成一个本地文件，不联网、不自动上传。
 */

/** 日志收录的总量上限（防止把一个几 GB 的日志目录塞进包里）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** 最多收录的日志文件数。 */
const MAX_LOG_FILES = 10;

// 卡顿摘要的解析逻辑抽在零依赖的 `./stallSummary` 里 —— 本模块依赖 electron
//（app.getPath），无法在 node --test 下加载；而解析是纯函数，抽出来才能真行为单测。
import {
  mergeEventLoopStallSummaries,
  parseEventLoopStalls,
  type EventLoopStallSummary,
} from './stallSummary';

/** 收集最近的日志文件（按修改时间降序，受文件数与总量上限约束）。 */
const collectLogFiles = (logsDirectory: string): Array<{ name: string; content: string }> => {
  let candidates: Array<{ name: string; fullPath: string; mtimeMs: number; size: number }> = [];
  try {
    candidates = readdirSync(logsDirectory)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const fullPath = path.join(logsDirectory, name);
        const stats = statSync(fullPath);
        return { name, fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
      })
      .filter((item) => item.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }

  const collected: Array<{ name: string; content: string }> = [];
  let totalBytes = 0;
  for (const item of candidates) {
    if (collected.length >= MAX_LOG_FILES) break;
    if (totalBytes + item.size > MAX_LOG_BYTES) {
      // 超出上限时不再收录整份文件，但**在摘要里说明**，避免维护者误以为日志就这些
      break;
    }
    try {
      collected.push({ name: item.name, content: readFileSync(item.fullPath, 'utf8') });
      totalBytes += item.size;
    } catch {
      // 单个文件读失败（被占用/权限）不影响其余文件的收录
    }
  }
  return collected;
};

const buildReadme = (includedLogNames: string[]): string =>
  [
    'YanMusic 诊断包',
    '',
    '本包由应用在用户主动点击「导出诊断包」时于**本地**生成，不会自动上传。',
    '',
    '包含内容：',
    '  README.txt              本说明',
    '  diagnostics.json        版本 / 平台 / 架构 / 运行环境、启动降级项、内存与卡顿摘要',
    '  settings-redacted.json  设置（已脱敏：路径、URL 查询串、长密钥与敏感键名的值均已移除）',
    `  logs/                   最近 ${includedLogNames.length} 个日志文件`,
    '',
    '已做的脱敏：',
    '  · 用户目录路径 → <userData> / <home>',
    '  · URL → 仅保留 scheme://host（丢弃可能含 token 的 query）',
    '  · 键名含 token/secret/password/dfid/userid 等 → 值替换为 <redacted>',
    '  · 长且无空格的密钥样字符串 → <redacted-secret>',
    '',
    '刻意不包含：登录票据（pinia:user）与设备指纹（pinia:device）—— 这两项根本不读取。',
    '',
    '⚠️ 尽管已脱敏，发送前仍建议自行打开过目一遍。',
    includedLogNames.length > 0
      ? `\n日志文件：\n${includedLogNames.map((n) => `  logs/${n}`).join('\n')}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

/** 组装诊断包的**全部条目**（尚未压缩）。 */
export const collectDiagnosticsEntries = (): ZipEntryInput[] => {
  const userDataPath = app.getPath('userData');
  const homePath = app.getPath('home');
  const logsDirectory = app.getPath('logs');
  const redactContext: RedactContext = { userDataPath, homePath };

  const logFiles = collectLogFiles(logsDirectory);

  // 卡顿摘要：从（按时间排序后的）日志里解析
  const stallSummary: EventLoopStallSummary = mergeEventLoopStallSummaries(
    logFiles.map((file) => parseEventLoopStalls(file.content)),
  );

  let settingsRedacted: unknown = null;
  try {
    // **只读这一个键**（fail-closed）：pinia:user / pinia:device 根本不读。
    settingsRedacted = redactValue(getKvStorage().get<unknown>('pinia:setting'), redactContext);
  } catch (error) {
    settingsRedacted = { __error: '设置读取失败', detail: String((error as Error)?.message ?? '') };
  }

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      name: app.getName(),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      // 系统版本不含个人信息，但路径类环境变量一律不收录
      osRelease: process.getSystemVersion?.() ?? '',
    },
    // S-3：启动期降级项 —— 「应用能开但某功能不可用」是最高频的求助场景之一
    startupDegradations: redactValue(getStartupDegradations(), redactContext),
    memory: redactValue(getAppMemoryMetrics(), redactContext),
    eventLoopStalls: stallSummary,
    logFiles: logFiles.map((file) => ({
      name: file.name,
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
  };

  const entries: ZipEntryInput[] = [
    { name: 'README.txt', data: buildReadme(logFiles.map((file) => file.name)) },
    { name: 'diagnostics.json', data: JSON.stringify(diagnostics, null, 2) },
    { name: 'settings-redacted.json', data: JSON.stringify(settingsRedacted, null, 2) },
  ];

  for (const file of logFiles) {
    // 日志内容同样过一遍脱敏：日志里可能打印过含路径/URL 的消息
    entries.push({
      name: `logs/${file.name}`,
      data: redactStringForLogs(file.content, redactContext),
    });
  }

  return entries;
};

/**
 * 日志整文的脱敏。
 *
 * **不能**逐字符走 `redactString`（那会把每一行都当成一个「值」去判断，
 * 长日志行会被误判成密钥而被整行遮蔽 —— 诊断价值归零）。
 * 这里只做**定向替换**：路径前缀 + URL 的 query 段。
 */
const redactStringForLogs = (text: string, context: RedactContext): string => {
  let output = text;
  const { userDataPath, homePath } = context;
  for (const [needle, replacement] of [
    [userDataPath, '<userData>'],
    [homePath, '<home>'],
  ] as Array<[string | undefined, string]>) {
    if (!needle) continue;
    for (const variant of new Set([
      needle,
      needle.replace(/\\/g, '/'),
      needle.replace(/\//g, '\\'),
    ])) {
      output = output.split(variant).join(replacement);
    }
  }
  // URL 的 query 段（可能含 token）：只在此处做，避免误伤普通日志行
  output = output.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1');
  return output;
};

/** 生成诊断包并写入指定路径。 */
export const writeDiagnosticsBundle = (targetPath: string): { bytes: number; entries: number } => {
  const entries = collectDiagnosticsEntries();
  const buffer = buildZipBuffer(entries);
  // 用同步写：这是用户显式点击后的单次操作，且需要在其返回后立刻给出「已保存」反馈
  //（诊断包通常只有几百 KB —— 日志上限 5MB）。
  writeFileSync(targetPath, buffer);
  log.info('[Diagnostics] bundle exported', { entries: entries.length, bytes: buffer.length });
  return { bytes: buffer.length, entries: entries.length };
};
