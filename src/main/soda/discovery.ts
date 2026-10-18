/**
 * 汽水音源的**本机客户端探测**（v2.0.0）。
 *
 * ## 为什么要有这个文件
 *
 * v1.5.0 的 Soda 音源要求用户手工设置三个环境变量
 * （`YANMUSIC_SODA_BDMS_PATH` / `DEVICE_ID` / `INSTALL_ID`）。
 * 实际门槛比看起来高得多：
 * - 得先知道签名模块叫 `bdms.node`；
 * - 得在安装目录里翻到 `app.asar.unpacked`；
 * - 设备指纹存在一个**gzip 压缩的二进制文件** `DeviceV1` 里，
 *   普通用户不可能打开它。
 *
 * 于是「装了汽水客户端」这个前提明明已经满足，音源却仍是关闭的。
 * 本模块把这三件事自动做完：找到安装目录、定位 `bdms.node`、
 * 解开 `DeviceV1` 取出 `did/iid/cdid`。
 *
 * ## 合规边界（与 `providers/SodaProvider.ts` 一致）
 *
 * - **只读**本机已安装客户端自己的文件，**不复制、不打包、不转存**；
 * - 设备指纹只在内存中用于请求，**不写日志、不入库**（见 `maskDeviceId`）；
 * - 不做任何解密或权益绕过。`bdms.node` 是签名模块，不是解密模块。
 *
 * ## 为什么不是 `.ts` 里直接 `import electron`
 *
 * 本文件零依赖（只用 `node:fs` / `node:path` / `node:os` / `node:zlib`），
 * 于是 `node --test` 可以直接驱动它的纯逻辑部分（`parseDeviceIdentity`），
 * 而不用 mock 整个 Electron。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** 客户端在磁盘上的名字（安装目录名）。 */
const APP_DIR_NAME = 'Soda Music';
const APP_DIR_NAME_ALT = 'SodaMusic';
/** 用户数据目录名（`%APPDATA%` 下）。 */
const USER_DATA_DIR_NAME = 'SodaMusic';

export interface SodaDeviceIdentity {
  /** 设备 id（请求里的 `device_id` / `fp`） */
  deviceId: string;
  /** 安装 id（请求里的 `iid` / `install_id`） */
  installId: string;
  /** 客户端 id（请求里的 `cdid`）—— v1.5.0 漏了这个字段 */
  cdid: string;
}

export interface SodaDiscoveryResult {
  /** `bdms.node` 绝对路径；未找到为 null */
  bdmsModulePath: string | null;
  identity: SodaDeviceIdentity | null;
  /** 探测过的候选路径（用于在 UI/日志里说清「为什么没找到」） */
  searched: string[];
}

/**
 * 把设备 id 脱敏成可安全记日志的形态。
 *
 * 只保留尾 4 位 —— 足够判断「是不是同一台设备」，又不足以复现。
 * 日志泄露设备指纹的后果被低估：它是请求里**唯一**的身份凭据。
 */
export const maskDeviceId = (value: string | undefined): string => {
  const text = String(value ?? '').trim();
  if (!text) return '(空)';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.min(text.length - 4, 8))}${text.slice(-4)}`;
};

/**
 * 解析 `DeviceV1` 的内容。
 *
 * ## 格式（实测）
 *
 * 文件头是 gzip 魔数 `1f 8b 08`，解开后是一段 JSON：
 * `{"did":"…","iid":"…","cdid":"…","serial":"…"}`
 *
 * 返回 null 而不是抛错：这是「探测」路径，任何一步不符合预期
 * （文件被更新成别的格式、被截断、不是 gzip）都只应导致
 * 「自动配置失败，请手动设置」，而不是让主进程抛异常。
 */
export const parseDeviceIdentity = (raw: Buffer | Uint8Array): SodaDeviceIdentity | null => {
  if (!raw || raw.length === 0) return null;

  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  let text: string;
  try {
    // 有的版本直接存明文 JSON（未压缩），故先前缀嗅探而不是无条件 gunzip。
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      text = gunzipSync(bytes).toString('utf8');
    } else {
      text = bytes.toString('utf8');
    }
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const pick = (key: string): string => {
    const value = parsed[key];
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  };

  const deviceId = pick('did') || pick('device_id');
  const installId = pick('iid') || pick('install_id');
  const cdid = pick('cdid');
  if (!deviceId || !installId) return null;

  return { deviceId, installId, cdid };
};

/** 候选安装根目录（按平台）。 */
export const sodaInstallRoots = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const roots: string[] = [];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    roots.push(path.join(localAppData, 'Programs', APP_DIR_NAME));
    roots.push(path.join(localAppData, 'Programs', APP_DIR_NAME_ALT));
  } else if (platform === 'darwin') {
    roots.push(path.join('/Applications', `${APP_DIR_NAME_ALT}.app`, 'Contents', 'Resources'));
  } else {
    roots.push(path.join('/opt', APP_DIR_NAME.toLowerCase()));
    roots.push(path.join(homedir(), '.local', 'share', APP_DIR_NAME_ALT));
  }
  return roots;
};

/** 候选用户数据目录。 */
export const sodaUserDataDirs = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return [path.join(appData, USER_DATA_DIR_NAME)];
  }
  if (platform === 'darwin') {
    return [path.join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME)];
  }
  return [path.join(homedir(), '.config', USER_DATA_DIR_NAME)];
};

/**
 * 在安装根目录里找 `bdms.node`。
 *
 * Windows 的目录结构是 `<root>\<version>\resources\app.asar.unpacked\bdms.node`，
 * macOS 是 `<root>/app.asar.unpacked/bdms.node`（`resources` 已在 root 里）。
 * 版本目录名形如 `3.7.0` / `3.8.0`，**按版本降序**取第一个可用的 ——
 * 用户可能装了多个版本，最新的那个最可能被真正使用。
 */
export const findBdmsModule = (roots: string[], searched: string[] = []): string | null => {
  const candidates: string[] = [];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;

    // ① 直接位于 root 下（macOS 形态）
    const direct = path.join(root, 'app.asar.unpacked', 'bdms.node');
    searched.push(direct);
    if (existsSync(direct)) candidates.push(direct);

    // ② 位于版本子目录下（Windows 形态）
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const versionDirs = entries
      .filter((name) => /^\d+\.\d+\.\d+/.test(name))
      .filter((name) => {
        try {
          return statSync(path.join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => compareVersion(b, a));

    for (const version of versionDirs) {
      const candidate = path.join(root, version, 'resources', 'app.asar.unpacked', 'bdms.node');
      searched.push(candidate);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }

  return candidates[0] ?? null;
};

/** 比较 `3.10.0` 与 `3.9.0`（按数字段，避免字符串比较把 3.10 排在 3.9 前面）。 */
export const compareVersion = (a: string, b: string): number => {
  const pa = a.split(/[.\s-]/).map((n) => Number.parseInt(n, 10));
  const pb = b.split(/[.\s-]/).map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};

/** 读用户数据目录下的 `DeviceV1`。 */
export const readDeviceIdentityFile = (
  dirs: string[],
  searched: string[] = [],
): SodaDeviceIdentity | null => {
  for (const dir of dirs) {
    const file = path.join(dir, 'DeviceV1');
    searched.push(file);
    if (!existsSync(file)) continue;
    try {
      const identity = parseDeviceIdentity(readFileSync(file));
      if (identity) return identity;
    } catch {
      // 读不了就继续下一个候选，不抛
    }
  }
  return null;
};

/**
 * 一次性完成探测。
 *
 * 任何一步失败都只返回 null 字段（不抛错）—— 探测失败应当导致
 * 「音源不可用，请手动配置」，而不是启动阶段崩溃。
 */
export const discoverSodaClient = (options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): SodaDiscoveryResult => {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const searched: string[] = [];

  const bdmsModulePath = findBdmsModule(sodaInstallRoots(env, platform), searched);
  const identity = readDeviceIdentityFile(sodaUserDataDirs(env, platform), searched);

  return { bdmsModulePath, identity, searched };
};
