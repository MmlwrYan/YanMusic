export type ThemeMode = 'light' | 'dark' | 'system';

export type CloseBehavior = 'tray' | 'exit';

export type UpdateCheckStatus = 'available' | 'latest' | 'error';

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  downloadLabel?: string;
  manualDownload?: boolean;
  body?: string;
  message?: string;
  silent?: boolean;
};

export type UpdateDownloadProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type UpdateDownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error';

export type UpdateDownloadResult = {
  status: UpdateDownloadStatus;
  progress?: UpdateDownloadProgress;
  error?: string;
};

export type UpdateState = {
  checkResult: UpdateCheckResult | null;
  download: UpdateDownloadResult;
};

export type UpdateInstallResult = {
  ok: boolean;
  error?: string;
};

/**
 * v1.3.0（S-3）：启动期**降级/失败**的项。
 *
 * 定义放在 shared 而不是各自模块里，是为了让主进程（记录方）与渲染层（展示方）
 * **共用同一定义** —— 否则两处枚举值一旦漂移，会出现「主进程记了、渲染层不认识」
 * 的静默丢失（F-6 处理 kv 白名单时是同一类问题）。
 */
export type StartupDegradationKind =
  /** 音频引擎（mpv / libmpv）不可用 —— 可降级：界面可用，但无法播放。 */
  | 'mpv'
  /** 内置 API 服务未启动 —— 可降级。 */
  | 'api-server'
  /** 原生存储 addon（yan-storage）不可用 —— **不可降级**：存储是全应用根基。 */
  | 'native-storage';

export interface StartupDegradationInfo {
  kind: StartupDegradationKind;
  /** 面向用户的简短说明（不含堆栈；堆栈留在日志里）。 */
  message: string;
  /** `true` = 不可降级，调用方应明确提示后优雅退出。 */
  fatal: boolean;
}

export type AppInfoResult = {
  version: string;
  isPrerelease: boolean;
  isPackaged: boolean;
  /**
   * 启动期降级/失败的项；**空数组 = 一切正常**。
   *
   * 渲染层据此向用户明确提示「哪一部分不可用」，而不是让应用静默地半残运行。
   */
  startupDegradations?: StartupDegradationInfo[];
};
