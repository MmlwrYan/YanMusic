/**
 * 插件源「提供方」抽象（纯函数，可在 node 下直接单测）。
 *
 * 背景：插件源最初只支持 GitHub，索引条目里的 `repo`、索引文件地址、插件包地址
 * 全部由 GitHub 专有的 URL 形态拼出（`raw.githubusercontent.com` / `archive/HEAD.zip`）。
 * 引入 Gitee 之后，这些形态必须按提供方分派，否则 Gitee 源会被拼成 GitHub 地址。
 *
 * 本模块是**这类 URL 的唯一事实源**；`src/main/plugins.ts` 只做转调，
 * 不再自己拼字符串（此前 GitHub 专用实现散落在该文件里）。
 *
 * 已实测的 URL 形态（2026-10-03）：
 * - GitHub raw    `https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>`
 * - GitHub 归档   `https://github.com/<o>/<r>/archive/<ref>.zip`
 * - Gitee  raw    `https://gitee.com/<o>/<r>/raw/<ref>/<path>`
 * - Gitee  归档   `https://gitee.com/<o>/<r>/repository/archive/<ref>.zip`
 * - Gitee  页面   `https://gitee.com/<o>/<r>/blob/<ref>/<path>`
 */

export type PluginSourceProvider = 'github' | 'gitee';

export type PluginRepository = {
  provider: PluginSourceProvider;
  owner: string;
  repo: string;
};

export const PLUGIN_SOURCE_PROVIDERS: readonly PluginSourceProvider[] = ['github', 'gitee'];

/** 未显式给出提供方时的默认值（`owner/repo` 简写按 GitHub 解释，保持向后兼容）。 */
export const DEFAULT_PLUGIN_SOURCE_PROVIDER: PluginSourceProvider = 'github';

/**
 * 各提供方的宿主域名后缀。
 * 判定规则是 `host === suffix || host.endsWith('.' + suffix)` ——
 * 注意必须带前导点，否则 `mygithub.com` 会被误判为 GitHub（历史实现用的是枚举全等，
 * 换成后缀匹配后这一点尤其要守住）。
 */
const PROVIDER_HOST_SUFFIXES: Record<PluginSourceProvider, readonly string[]> = {
  github: ['github.com', 'githubusercontent.com'],
  gitee: ['gitee.com', 'giteeusercontent.com'],
};

const PROVIDER_REPOSITORY_BASE: Record<PluginSourceProvider, string> = {
  github: 'https://github.com',
  gitee: 'https://gitee.com',
};

const PROVIDER_RAW_BASE: Record<PluginSourceProvider, string> = {
  // Gitee 无独立 raw 域名，走站内 /raw/ 路径
  github: 'https://raw.githubusercontent.com',
  gitee: 'https://gitee.com',
};

/** 仓库内文件路径规范化（去掉 `.`、反斜杠、首尾斜杠，空段）。 */
export const normalizeRepositoryFilePath = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

/**
 * 路径是否安全（不含 `..`、不是绝对路径）。
 * 这是**安全判定**，不要与上面的规范化混用：插件包路径来自远端索引，必须校验。
 */
export const isSafeRepositoryFilePath = (value: string): boolean =>
  value === '' ||
  (value !== '.' &&
    !value.split('/').includes('..') &&
    !value.startsWith('..') &&
    !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value));

/** 从 URL 或 `owner/repo` 简写解析出「提供方 + owner + repo」，解析失败返回 null。 */
export const parsePluginRepository = (value: unknown): PluginRepository | null => {
  const text = String(value ?? '')
    .trim()
    .replace(/\.git$/i, '');
  if (!text) return null;

  const shorthandMatch = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthandMatch) {
    return {
      provider: DEFAULT_PLUGIN_SOURCE_PROVIDER,
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const provider = PLUGIN_SOURCE_PROVIDERS.find((candidate) =>
    PROVIDER_HOST_SUFFIXES[candidate].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    ),
  );
  if (!provider) return null;

  const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return null;

  return { provider, owner, repo: repo.replace(/\.git$/i, '') };
};

export const toRepositoryUrl = (repo: PluginRepository): string =>
  `${PROVIDER_REPOSITORY_BASE[repo.provider]}/${repo.owner}/${repo.repo}`;

/** 源的稳定标识，形如 `github:owner/repo` / `gitee:owner/repo`。 */
export const toRepositorySourceId = (repo: PluginRepository): string =>
  `${repo.provider}:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;

/** 用于去重键的回落值（URL 解析失败时使用）。 */
export const toRepositoryKey = (value: unknown): string => {
  const parsed = parsePluginRepository(value);
  if (parsed) return toRepositorySourceId(parsed);
  return String(value ?? '')
    .trim()
    .toLowerCase();
};

/** 两个仓库是否指向同一个 `owner/repo`（大小写不敏感，**不比较提供方**）。 */
export const isSameRepository = (a: PluginRepository, b: PluginRepository): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/**
 * 决定「索引条目」应当从哪个仓库取文件（manifest / 图标 / 插件包）。
 *
 * 规则：条目自带 `repo` 时以它为准；**但若它与当前源指向同一个 `owner/repo`，
 * 则改用「源」的提供方**。
 *
 * ⚠️ 这条规则是必需的，不是优化。镜像源（Gitee）里的索引条目仍按本体仓库的
 * GitHub 形态书写（`https://github.com/<o>/<r>`），若直接照搬，用户把源换成
 * Gitee 后**只有索引 JSON 走 Gitee**，manifest、图标与插件包仍会回到 GitHub 取。
 * 后果恰好在最需要 Gitee 的场景（GitHub 不可达）下最严重：每个条目的 manifest
 * 都拉不到 → 条目被逐条丢弃 → 界面报「索引未提供可用插件」，而索引其实是能拉到的。
 * 实测证据（2026-10-03，自有镜像）：索引 200、manifest 的 GitHub 地址
 * `CURLE_SSL_CONNECT_ERROR(35)`、插件包 GitHub 地址 `CURLE_GOT_NOTHING(52)`；
 * 两者的 Gitee 等价地址分别为 200 与 200 application/zip。见
 * `docs/agent/v1.3.1/gitee-plugin-source-endpoints-2026-10-03.md`。
 *
 * 不同 `owner/repo` 的条目（未镜像的第三方）**不受影响**，仍按声明地址取。
 */
export const resolvePluginEntryRepository = (
  sourceRepo: PluginRepository,
  entryRepoValue: unknown,
): PluginRepository => {
  const entryRepo = parsePluginRepository(entryRepoValue);
  if (!entryRepo) return sourceRepo;
  if (!isSameRepository(entryRepo, sourceRepo)) return entryRepo;
  return {
    provider: sourceRepo.provider,
    owner: sourceRepo.owner,
    repo: sourceRepo.repo,
  };
};

export const toRepositoryRawFileUrl = (
  repo: PluginRepository,
  filePath: string,
  ref = 'HEAD',
): string => {
  const normalizedPath = normalizeRepositoryFilePath(filePath);
  const normalizedRef = String(ref || 'HEAD').trim() || 'HEAD';
  const encodedRef = encodeURIComponent(normalizedRef);
  if (repo.provider === 'gitee') {
    return `${PROVIDER_RAW_BASE.gitee}/${repo.owner}/${repo.repo}/raw/${encodedRef}/${normalizedPath}`;
  }
  return `${PROVIDER_RAW_BASE.github}/${repo.owner}/${repo.repo}/${encodedRef}/${normalizedPath}`;
};

export const toRepositoryBlobUrl = (
  repo: PluginRepository,
  filePath: string,
  ref = 'HEAD',
): string => {
  const normalizedPath = normalizeRepositoryFilePath(filePath);
  const normalizedRef = String(ref || 'HEAD').trim() || 'HEAD';
  return `${toRepositoryUrl(repo)}/blob/${encodeURIComponent(normalizedRef)}/${normalizedPath}`;
};

export const toRepositoryArchiveUrl = (repo: PluginRepository, ref = 'HEAD'): string => {
  const normalizedRef = String(ref || 'HEAD').trim() || 'HEAD';
  const encodedRef = encodeURIComponent(normalizedRef);
  if (repo.provider === 'gitee') {
    // 实测：Gitee 的归档端点不是 /archive/<ref>.zip，而是 /repository/archive/<ref>.zip
    return `${toRepositoryUrl(repo)}/repository/archive/${encodedRef}.zip`;
  }
  return `${toRepositoryUrl(repo)}/archive/${encodedRef}.zip`;
};

/** 某个 URL 是否由指定提供方托管。 */
export const isProviderHostedUrl = (value: string, provider: PluginSourceProvider): boolean => {
  let host: string;
  try {
    host = new URL(String(value ?? '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PROVIDER_HOST_SUFFIXES[provider].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
};

/** 某个 URL 是否由任一已知提供方托管。 */
export const isKnownPluginSourceHostedUrl = (value: string): boolean =>
  PLUGIN_SOURCE_PROVIDERS.some((provider) => isProviderHostedUrl(value, provider));

export const normalizePluginSourceProxyUrl = (value?: string): string =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '');

/**
 * 加速器闸门。
 *
 * 现有加速器（`gh-proxy` 一类）**只能反代 GitHub**，对 Gitee 无意义：
 * 把 Gitee 地址套上加速器会直接 404；而且 Gitee 本身在国内可直连，
 * 加速不会带来收益。因此这里**只对 GitHub 托管的地址放行加速器**，
 * 其余（含 Gitee）原样返回。
 */
export const applyPluginSourceProxy = (url: string, proxyUrl?: string): string => {
  const target = String(url ?? '').trim();
  const proxy = normalizePluginSourceProxyUrl(proxyUrl);
  if (!target || !proxy) return target;
  if (!/^https?:\/\//i.test(target)) return target;
  if (!isProviderHostedUrl(target, 'github')) return target;
  return `${proxy}/${target}`;
};

/**
 * 插件的下载 User-Agent。
 *
 * ⚠️ **Gitee 的归档端点有一个已实测的坑**：当 `User-Agent` 不被它识别为「下载工具」时，
 * `GET /<o>/<r>/repository/archive/<ref>.zip` **返回的是 HTML 落地页（200 + text/html）而不是 zip**，
 * 于是「下载成功、解压失败」——错误信息完全指不到真正的原因。
 *
 * 实测结论（2026-10-03，`oschina/git-osc` 与 `mirrors/git` 两个仓库复现一致）：
 *
 * | User-Agent | 返回 |
 * |---|---|
 * | `YanMusic-Plugin-Marketplace` | `text/html`（落地页，约 45 KB） |
 * | `Mozilla/5.0` | `text/html` |
 * | `python-requests/2.31.0` | `text/html` |
 * | `curl/8.0.1` / `curl/8.55.0` | **`application/zip`** |
 * | `YanMusic-Plugin-Marketplace (curl/8.4.0)` | **`application/zip`** |
 *
 * 也就是说：**UA 里带上 `curl/<版本>` 才会直接下发压缩包**。
 * 这里选择保留自己的标识再加后缀，而不是冒充 curl —— 出问题时抓包能看出是 YanMusic 发的。
 * 同时用 `isZipArchiveBuffer` 做二次校验，避免依赖这条未公开规则：
 * 一旦 Gitee 改行为，失败会**明确报「拿到的是网页不是压缩包」**，而不是含混的解压错误。
 */
export const PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT = 'YanMusic-Plugin-Marketplace';

/** Gitee 归档端点要求 UA 中含有的片段（实测所得）。 */
export const GITEE_ARCHIVE_UA_HINT = 'curl/8.4.0';

export const resolvePluginDownloadUserAgent = (url: string): string =>
  isProviderHostedUrl(url, 'gitee')
    ? `${PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT} (${GITEE_ARCHIVE_UA_HINT})`
    : PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT;

/** 是否为 ZIP 归档（本地文件头 / 空归档 / 分卷 三种魔数）。 */
export const isZipArchiveBuffer = (buffer: Uint8Array): boolean => {
  if (!buffer || buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false; // 'PK'
  const third = buffer[2];
  const fourth = buffer[3];
  return (
    (third === 0x03 && fourth === 0x04) || // 普通归档
    (third === 0x05 && fourth === 0x06) || // 空归档
    (third === 0x07 && fourth === 0x08) // 分卷归档
  );
};
