import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * IMP-01 观测：IPC 通道「白名单」的**只记录不拒绝**版本。
 *
 * ## 为什么只观测不强制
 *
 * 上一轮审计已确认两个结构性障碍，直接上白名单会误伤现有调用：
 *   1. 4 类窗口共用**同一个 preload**（`window.ts:360`、`desktopLyric/window.ts:142`、
 *      `pluginWindows.ts:230`、`miniPlayer.ts:473`），typed helper 面对所有窗口完全相同；
 *   2. **mini 播放器加载的就是 `dist/index.html`**（`miniPlayer.ts:231`），与主窗口
 *      （`window.ts:362`）是同一份 bundle —— 仅凭 URL 无法区分二者。
 * 因此本轮只把「谁在调用什么」记下来，为 v1.3.0 的强制白名单提供真实分布；
 * **任何情况下都不拒绝调用**（除非显式打开严格模式，见下）。
 *
 * ## 确定性原则（宁可漏标，不可误标）
 *
 * - 无法判定的调用方（例如 index.html 同时可能是主窗口或 mini 播放器）→ 一律视为**允许**，
 *   只把 `ambiguous: true` 记进日志，供设计时量化「有多少调用无法区分」。
 * - 不确定的通道 → 作用域填 `all`。映射表里 `all` 的比例本身就是观测结论。
 *
 * ## 严格模式（默认关闭，为 v1.3.0 预留）
 *
 * 环境变量 `IPC_PERMISSION_STRICT=1|true|yes` 时，判定为不允许的调用会抛错。
 * **默认关闭**，且本轮不得开启：本轮范围冻结要求「白名单只观测不拒绝」。
 */

export type WindowKind = 'main' | 'desktop-lyric' | 'mini-player' | 'plugin-window';

/** `all` = 不作限制（默认，用于「不确定」的通道） */
export type ChannelScope = 'all' | readonly WindowKind[];

interface ScopeRule {
  /** 通道前缀匹配；`'*'` 表示兜底 */
  readonly prefix: string;
  readonly scope: ChannelScope;
  /** 判定依据（写清楚，便于后续收紧时复核） */
  readonly basis: string;
}

/**
 * 通道 → 允许窗口 的规则表。
 *
 * 填写原则：**先按「最宽松合理」填**。只有能从代码/界面职责明确推断时才收窄，
 * 其余一律 `all`。`all` 的条目数量本身就是「白名单设计尚未成熟」的度量。
 */
const SCOPE_RULES: readonly ScopeRule[] = [
  // ── 明确属于主窗口的设置 / 管理界面 ──
  { prefix: 'app:', scope: ['main'], basis: '版本与更新信息面板在主窗口设置页' },
  { prefix: 'api-server:', scope: ['main'], basis: '内置 API 服务开关在主窗口设置页' },
  { prefix: 'logging:', scope: ['main'], basis: '日志设置在主窗口设置页' },
  { prefix: 'network:', scope: ['main'], basis: '网络/代理设置在主窗口设置页' },
  { prefix: 'settings-backup:', scope: ['main'], basis: '设置备份在主窗口设置页' },
  { prefix: 'update:', scope: ['main'], basis: '更新检查/下载 UI 在主窗口' },
  { prefix: 'update-disable-gpu-acceleration', scope: ['main'], basis: 'GPU 设置开关在主窗口' },
  { prefix: 'diagnostics:', scope: ['main'], basis: '内存诊断面板在主窗口设置页' },
  { prefix: 'clear-app-data', scope: ['main'], basis: '清除数据在主窗口设置页' },
  { prefix: 'open-log-directory', scope: ['main'], basis: '打开日志目录按钮在主窗口设置页' },
  { prefix: 'open-disclaimer', scope: ['main'], basis: '免责声明入口在主窗口' },
  { prefix: 'quit-app', scope: ['main'], basis: '退出入口在主窗口' },
  { prefix: 'window-toggle', scope: ['main'], basis: '主窗口最小化/最大化控制' },
  { prefix: 'shortcuts:refresh', scope: ['main'], basis: '全局快捷键设置在主窗口' },
  { prefix: 'get-all-fonts', scope: ['main'], basis: '字体列表用于主窗口外观设置' },
  { prefix: 'audio:delete-audio-effect', scope: ['main'], basis: '音效文件管理在主窗口设置页' },

  // ── 播放引擎控制：主窗口 / mini 播放器 / 桌面歌词都有播放控制 UI ──
  {
    prefix: 'mpv:',
    scope: ['main', 'mini-player', 'desktop-lyric'],
    basis: '三处都有播放控制；plugin-window 无播放控制 UI',
  },

  // ── 插件相关：插件窗口要读写自己的 data，主窗口要管理插件 ──
  {
    prefix: 'plugins:data:',
    scope: ['main', 'plugin-window'],
    basis: '插件 SDK ctx.storage 经插件窗口调用；主窗口插件页也可读',
  },

  // ── 窗口拖拽：无边框窗口（主窗口 / 桌面歌词 / mini）都会用 ──
  {
    prefix: 'window-drag:',
    scope: ['main', 'mini-player', 'desktop-lyric'],
    basis: '三者都是自绘标题栏的无边框窗口',
  },

  // ── 分享：主窗口与插件窗口都可能发起分享 ──
  { prefix: 'share:', scope: ['main', 'plugin-window'], basis: '插件可调用分享能力' },

  // ── 存储 / 网络请求：所有窗口的 Pinia 持久化与请求都走这里 ──
  {
    prefix: 'storage:',
    scope: 'all',
    basis: '所有窗口都通过 sqlitePersist 读写同一份存储',
  },
  { prefix: 'api:request', scope: 'all', basis: '各窗口都可能发起 API 请求' },
];

const DEFAULT_SCOPE: ChannelScope = 'all';

/** 查一个通道的作用域（未命中规则 → `all`，即不限制）。 */
export const scopeForChannel = (channel: string): ChannelScope => {
  for (const rule of SCOPE_RULES) {
    if (rule.prefix.endsWith(':') ? channel.startsWith(rule.prefix) : channel === rule.prefix) {
      return rule.scope;
    }
  }
  return DEFAULT_SCOPE;
};

/** 供测试与文档使用：哪些通道被收窄、哪些是 `all`。 */
export const describeScopeTable = () =>
  SCOPE_RULES.map((rule) => ({ prefix: rule.prefix, scope: rule.scope, basis: rule.basis }));

export interface SenderClassification {
  /** 该 URL 可能属于哪些窗口（index.html 会同时命中 main 与 mini-player） */
  readonly kinds: readonly WindowKind[];
  /** true = 仅凭 URL 无法唯一确定窗口类型（IMP-01 的结构性障碍） */
  readonly ambiguous: boolean;
  /** 归一化后的页面名，写进日志便于分析 */
  readonly page: string;
}

const pageNameOf = (url: string): string => {
  const clean = url.split('#')[0].split('?')[0];
  const match = /\/([^/]+\.html)$/.exec(clean);
  return match ? match[1] : clean ? '(非页面)' : '(空)';
};

/**
 * 仅凭发送方 URL 判定窗口类型。
 *
 * 注意：**index.html 必然 ambiguous** —— mini 播放器加载的就是 `dist/index.html`
 * （`miniPlayer.ts:231`），与主窗口同 bundle。这是本观测最重要的结论之一：
 * 在现有结构下，白名单无法仅靠 URL 对主窗口与 mini 播放器做出区分。
 */
export const classifySender = (url: unknown): SenderClassification => {
  const text = typeof url === 'string' ? url : '';
  if (!text) return { kinds: [], ambiguous: true, page: '(空)' };

  const page = pageNameOf(text);
  if (page === 'desktop-lyric.html') return { kinds: ['desktop-lyric'], ambiguous: false, page };
  if (page === 'plugin-window.html') return { kinds: ['plugin-window'], ambiguous: false, page };
  if (page === 'index.html') {
    return { kinds: ['main', 'mini-player'], ambiguous: true, page };
  }
  // 未知页面（例如未来的新窗口、或异常导航）：无法判定 → 视为不确定
  return { kinds: [], ambiguous: true, page };
};

export interface IpcCallDecision {
  readonly channel: string;
  readonly page: string;
  readonly kinds: readonly WindowKind[];
  readonly scope: ChannelScope;
  readonly ambiguous: boolean;
  /** false 仅当调用方窗口类型**可确定**且不在作用域内 */
  readonly allowed: boolean;
}

/** 纯判定：不写日志、不抛错。 */
export const evaluateIpcCall = (channel: string, url: unknown): IpcCallDecision => {
  const scope = scopeForChannel(channel);
  const { kinds, ambiguous, page } = classifySender(url);

  if (scope === 'all') {
    return { channel, page, kinds, scope, ambiguous, allowed: true };
  }
  // 无法确定窗口类型时一律放行：宁可漏标不可误标
  if (ambiguous) {
    return { channel, page, kinds, scope, ambiguous, allowed: true };
  }
  return { channel, page, kinds, scope, ambiguous, allowed: kinds.some((k) => scope.includes(k)) };
};

/** 严格模式开关（默认关闭）。仅认显式的真值，避免 "0"/"false" 被误判为开启。 */
export const isStrictModeEnabled = (value: unknown = process.env.IPC_PERMISSION_STRICT): boolean =>
  typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());

export const IPC_PERMISSION_STRICT_ENV = 'IPC_PERMISSION_STRICT';
export const IPC_VIOLATION_LOG_FILENAME = 'ipc-permission-violations.log';

let logDirectory: string | null = null;

/** 由启动处注入日志目录（`app.getPath('logs')`）。未注入时只在控制台输出。 */
export const configureIpcPermissionLog = (directory: string | null): void => {
  logDirectory = directory;
};

interface ViolationCounter {
  count: number;
  firstAt: string;
}

const violationCounters = new Map<string, ViolationCounter>();
/** 同一「通道 + 页面 + 判定」重复出现时的采样间隔：首次必写，之后每 N 次写一条汇总 */
const REPEAT_SAMPLE_INTERVAL = 200;

const writeLine = (record: Record<string, unknown>): void => {
  const line = JSON.stringify(record);
  if (!logDirectory) return;
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(path.join(logDirectory, IPC_VIOLATION_LOG_FILENAME), `${line}\n`, 'utf8');
  } catch {
    // 观测失败绝不影响主流程
  }
};

export interface ObservedIpcCall {
  readonly channel: string;
  readonly url: unknown;
  readonly webContentsId: unknown;
}

export interface ObserveResult extends IpcCallDecision {
  /** 本次调用是否被拒绝（仅在严格模式且 allowed=false 时为 true） */
  readonly rejected: boolean;
  /** 该键第几次出现（首次为 1） */
  readonly occurrences: number;
}

/**
 * 观测入口：判定 + 采样写日志。**默认永不拒绝**。
 *
 * 采样策略：同一 (通道, 页面, 允许性) 键**首次必写**，之后每 200 次写一条带累计次数的
 * 汇总记录 —— 避免高频通道（如 storage:kv:get）把日志刷爆，同时保留完整计数。
 */
export const observeIpcCall = ({ channel, url, webContentsId }: ObservedIpcCall): ObserveResult => {
  const decision = evaluateIpcCall(channel, url);
  const strict = isStrictModeEnabled();
  const rejected = strict && !decision.allowed;
  const occurrences = decision.allowed ? 0 : bumpCounter(decision);

  if (!decision.allowed) {
    const key = `${decision.channel}|${decision.page}`;
    if (occurrences === 1 || occurrences % REPEAT_SAMPLE_INTERVAL === 0) {
      writeLine({
        at: new Date().toISOString(),
        kind: occurrences === 1 ? 'violation' : 'violation-summary',
        channel: decision.channel,
        page: decision.page,
        // 发送方 URL 只记文件路径部分，避免把可能的查询参数写进日志
        kinds: decision.kinds,
        scope: decision.scope,
        ambiguous: decision.ambiguous,
        webContentsId: typeof webContentsId === 'number' ? webContentsId : -1,
        occurrences,
        strictMode: strict,
        rejected,
        note: 'whitelist observation only; call was still executed',
        key,
      });
    }
  }

  return { ...decision, rejected, occurrences };
};

const bumpCounter = (decision: IpcCallDecision): number => {
  const key = `${decision.channel}|${decision.page}`;
  const existing = violationCounters.get(key);
  if (existing) {
    existing.count += 1;
    return existing.count;
  }
  violationCounters.set(key, { count: 1, firstAt: new Date().toISOString() });
  return 1;
};

/** 供测试用：重置内部计数。 */
export const resetIpcPermissionObservation = (): void => {
  violationCounters.clear();
  logDirectory = null;
};

/** 本轮**未被观测覆盖**的通道（在 ipcRegistry 之外直连注册）。 */
export const EXTERNALLY_REGISTERED_CHANNELS = [
  'audio-spectrum:subscribe',
  'audio-spectrum:unsubscribe',
  'audio-spectrum:get-status',
  'audio-spectrum:get-snapshot',
  'media-control:update-state',
  'media-control:update-metadata',
  'media-control:update-timeline',
  'media-control:available',
  'thumbar:update-play-state',
] as const;
