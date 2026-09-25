export type NetworkProxyMode = 'system' | 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers';

export interface NetworkSettings {
  /** 全局网络代理模式（系统/直连/WPAD/PAC/手动代理，EchoMusic 网络策略体系） */
  proxyMode: NetworkProxyMode;
  /** PAC 脚本地址 */
  proxyPacScript: string;
  /** 手动代理规则 */
  proxyRules: string;
  /** 代理用户名 */
  proxyUsername: string;
  /** 代理绕过规则 */
  proxyBypassRules: string;
  /** 酷狗 API 请求超时（秒，0 = 不限制） */
  kugouApiTimeoutSecs: number;
  /** 播放器网络超时（秒） */
  playerNetworkTimeoutSecs: number;
  /** 酷狗 API 专用代理（YanMusic 保留字段） */
  kugouApiProxyUrl: string;
  /** mpv 播放引擎 HTTP 代理（YanMusic 保留字段） */
  mpvHttpProxyUrl: string;
  /** mpv 网络超时（秒，YanMusic 保留字段） */
  mpvNetworkTimeoutSecs: number;
}

export interface NetworkSettingsUpdateRequest {
  settings: Partial<NetworkSettings>;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
}

export interface NetworkSettingsState {
  settings: NetworkSettings;
  hasProxyPassword: boolean;
}

export interface NetworkProxyCredentials {
  username: string;
  password: string;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyMode: 'system',
  proxyPacScript: '',
  proxyRules: '',
  proxyUsername: '',
  proxyBypassRules: '<local>',
  kugouApiTimeoutSecs: 0,
  playerNetworkTimeoutSecs: 60,
  kugouApiProxyUrl: '',
  mpvHttpProxyUrl: '',
  mpvNetworkTimeoutSecs: 60,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/** 代理 URL 归一化（http/https；YanMusic 保留函数，用于 kugouApiProxyUrl 与 mpvHttpProxyUrl） */
export const normalizeProxyUrl = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const normalizeProxyPacScript = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return '';
    if (url.protocol !== 'file:' && !url.hostname) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const normalizeProxyRules = (value: unknown): string => {
  const rules = String(value ?? '').trim();
  if (!rules || rules.length > 4096 || /[\u0000-\u001f\u007f]/.test(rules)) return '';
  const validSchemes = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
  const isValidProxy = (value: string) => {
    const candidate = value.trim();
    if (!candidate || /\s/.test(candidate)) return false;
    if (candidate.toLowerCase() === 'direct://') return true;
    try {
      const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
      return (
        validSchemes.has(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        (!url.pathname || url.pathname === '/') &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  };
  const validMappings = new Set(['http', 'https', 'ftp', 'socks']);
  const isValidGroup = (group: string) => {
    const separator = group.indexOf('=');
    const mapping = separator >= 0 ? group.slice(0, separator).trim().toLowerCase() : '';
    const proxyList = separator >= 0 ? group.slice(separator + 1) : group;
    if (separator >= 0 && !validMappings.has(mapping)) return false;
    const proxies = proxyList.split(',');
    return proxies.length > 0 && proxies.every(isValidProxy);
  };
  return rules.split(';').every(isValidGroup) ? rules : '';
};

export const addProxyCredentialsToUrl = (
  proxyUrl: string,
  credentials: NetworkProxyCredentials | undefined,
): string => {
  if (!credentials) return proxyUrl;
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl;
  }
  // Chromium only authenticates HTTP(S) proxies. reqwest additionally supports
  // username/password authentication for SOCKS5; SOCKS4 credentials are not
  // supported by either transport used by the app.
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return proxyUrl;
  url.username = credentials.username;
  url.password = credentials.password;
  return url.toString();
};

const normalizeProxyMode = (value: unknown): NetworkProxyMode => {
  if (
    value === 'system' ||
    value === 'direct' ||
    value === 'auto_detect' ||
    value === 'pac_script' ||
    value === 'fixed_servers'
  ) {
    return value;
  }
  return 'system';
};

const normalizeProxyBypassRules = (value: unknown): string => {
  const rules = String(value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
  return rules.join(',') || DEFAULT_NETWORK_SETTINGS.proxyBypassRules;
};

export const normalizeNetworkSettings = (
  value: Partial<NetworkSettings> | Record<string, unknown> | null | undefined,
): NetworkSettings => {
  const source = value ?? {};

  return {
    proxyMode: normalizeProxyMode(Reflect.get(source, 'proxyMode')),
    proxyPacScript: normalizeProxyPacScript(Reflect.get(source, 'proxyPacScript')),
    proxyRules: normalizeProxyRules(Reflect.get(source, 'proxyRules')),
    proxyUsername: String(Reflect.get(source, 'proxyUsername') ?? '').trim(),
    proxyBypassRules: normalizeProxyBypassRules(Reflect.get(source, 'proxyBypassRules')),
    kugouApiTimeoutSecs: clampNumber(
      Reflect.get(source, 'kugouApiTimeoutSecs'),
      DEFAULT_NETWORK_SETTINGS.kugouApiTimeoutSecs,
      0,
      300,
    ),
    playerNetworkTimeoutSecs: clampNumber(
      Reflect.get(source, 'playerNetworkTimeoutSecs'),
      DEFAULT_NETWORK_SETTINGS.playerNetworkTimeoutSecs,
      1,
      300,
    ),
    kugouApiProxyUrl: normalizeProxyUrl(Reflect.get(source, 'kugouApiProxyUrl')),
    mpvHttpProxyUrl: normalizeProxyUrl(Reflect.get(source, 'mpvHttpProxyUrl')),
    mpvNetworkTimeoutSecs: clampNumber(
      Reflect.get(source, 'mpvNetworkTimeoutSecs'),
      DEFAULT_NETWORK_SETTINGS.mpvNetworkTimeoutSecs,
      1,
      300,
    ),
  };
};

export const getNetworkSettingsValidationError = (settings: NetworkSettings): string | null => {
  if (settings.proxyMode === 'pac_script' && !settings.proxyPacScript) {
    return 'PAC 脚本地址无效';
  }
  if (settings.proxyMode === 'fixed_servers' && !settings.proxyRules) {
    return '手动代理规则无效';
  }
  return null;
};

export const parseElectronResolvedProxy = (value: string): string[] => {
  const candidates: string[] = [];
  for (const rawEntry of value.split(';')) {
    const [rawKind, endpoint] = rawEntry.trim().split(/\s+/, 2);
    const kind = rawKind.toUpperCase();
    let candidate: string | undefined;
    if (kind === 'DIRECT') candidate = '';
    else if (kind === 'PROXY' && endpoint) candidate = `http://${endpoint}`;
    else if (kind === 'HTTPS' && endpoint) candidate = `https://${endpoint}`;
    else if ((kind === 'SOCKS' || kind === 'SOCKS4') && endpoint) {
      candidate = `socks4://${endpoint}`;
    } else if (kind === 'SOCKS5' && endpoint) {
      candidate = `socks5h://${endpoint}`;
    }
    if (candidate !== undefined && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
};
