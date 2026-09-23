export const SHARE_SCHEME = 'yanmusic';
/**
 * 分享落地页（自有 GitHub Pages，由仓库 `docs/` 目录发布）。
 *
 * 前置条件：Pages 必须配置为从 `docs/` 目录发布，否则该地址不可用
 * （仓库内已有 `docs/share/index.html` 与 `docs/.nojekyll`）。
 */
export const SHARE_WEB_BASE_URL = 'https://mmlwryan.github.io/YanMusic/share/';
/**
 * 历史分享链接指向的落地页地址。**仅用于解析兼容**，不再用于生成新链接，
 * 以保证已经分发出去的旧链接不会失效。
 */
export const LEGACY_SHARE_WEB_BASE_URLS = ['https://hoowhoami.github.io/yanmusic/share/'] as const;

export type ShareResourceType =
  | 'song'
  | 'playlist'
  | 'artist'
  | 'album'
  | 'plugin'
  | 'listen-together';
export type ShareTargetQuery = Record<string, string>;

export interface ShareTarget {
  type: ShareResourceType;
  id: string;
  title?: string;
  sharer?: string;
  query?: ShareTargetQuery;
}

export interface ShareCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SHARE_TYPE_LABELS: Record<ShareResourceType, string> = {
  song: '歌曲',
  playlist: '歌单',
  artist: '歌手',
  album: '专辑',
  plugin: '插件',
  'listen-together': '一起听',
};

interface ShareWebEndpoint {
  origin: string;
  path: string;
}

const toShareWebEndpoint = (baseUrl: string): ShareWebEndpoint => {
  const url = new URL(baseUrl);
  return { origin: url.origin, path: url.pathname.replace(/\/$/, '') };
};

/** 可接受的落地页端点：自有域名在前，历史域名随后（仅解析兼容）。 */
const SHARE_WEB_ENDPOINTS: ShareWebEndpoint[] = [
  SHARE_WEB_BASE_URL,
  ...LEGACY_SHARE_WEB_BASE_URLS,
].map(toShareWebEndpoint);

/** 匹配某个落地页端点；不匹配返回 null。 */
const matchShareWebEndpoint = (url: URL): ShareWebEndpoint | null => {
  const pathname = url.pathname.replace(/\/$/, '');
  return (
    SHARE_WEB_ENDPOINTS.find(
      (endpoint) =>
        endpoint.origin === url.origin &&
        (pathname === endpoint.path || pathname.startsWith(`${endpoint.path}/`)),
    ) ?? null
  );
};

const isShareResourceType = (value: string): value is ShareResourceType =>
  value === 'song' ||
  value === 'playlist' ||
  value === 'artist' ||
  value === 'album' ||
  value === 'plugin' ||
  value === 'listen-together';

const readText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export const isSongShareId = (value: unknown): boolean => /^[a-f0-9]{32}$/i.test(readText(value));

export const isPluginShareId = (value: unknown): boolean =>
  /^[a-zA-Z0-9._-]+$/.test(readText(value));

const stripTrailingUrlPunctuation = (value: string) =>
  value.trim().replace(/[)\]}>,，。！？；;]+$/g, '');

export const getShareResourceLabel = (type: ShareResourceType) => SHARE_TYPE_LABELS[type];

const normalizeShareQuery = (query: Record<string, unknown> | undefined): ShareTargetQuery => {
  const result: ShareTargetQuery = {};
  if (!query) return result;
  Object.entries(query).forEach(([key, value]) => {
    const name = readText(key);
    const text = readText(value);
    if (name && text) result[name] = text;
  });
  return result;
};

const readSearchParams = (searchParams: URLSearchParams, excludedKeys: string[] = []) => {
  const excluded = new Set(excludedKeys);
  const query: ShareTargetQuery = {};
  searchParams.forEach((value, key) => {
    if (excluded.has(key)) return;
    const name = readText(key);
    const text = readText(value);
    if (name && text) query[name] = text;
  });
  return query;
};

const withQuery = (target: ShareTarget, query: ShareTargetQuery): ShareTarget =>
  Object.keys(query).length > 0 ? { ...target, query } : target;

const parseCustomShareUrl = (value: string): ShareTarget | null => {
  const text = stripTrailingUrlPunctuation(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== `${SHARE_SCHEME}:`) return null;

  const segments = url.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment.trim()))
    .filter(Boolean);
  const typeText = url.hostname || segments.shift() || '';
  if (!isShareResourceType(typeText)) return null;

  const id = readText(segments.shift());
  if (!id) return null;
  if (typeText === 'song' && !isSongShareId(id)) return null;
  if (typeText === 'plugin' && !isPluginShareId(id)) return null;

  return withQuery({ type: typeText, id }, readSearchParams(url.searchParams));
};

const parseShareTargetParts = (
  type: string | null,
  id: string | null,
  query: ShareTargetQuery = {},
): ShareTarget | null => {
  const typeText = readText(type);
  if (!isShareResourceType(typeText)) return null;

  const targetId = readText(id);
  if (!targetId) return null;
  if (typeText === 'song' && !isSongShareId(targetId)) return null;
  if (typeText === 'plugin' && !isPluginShareId(targetId)) return null;

  return withQuery({ type: typeText, id: targetId }, query);
};

export const buildShareUrl = (target: ShareTarget): string => {
  const id = readText(target.id);
  if (!isShareResourceType(target.type) || !id) {
    throw new Error('Invalid share target');
  }
  if (target.type === 'song' && !isSongShareId(id)) {
    throw new Error('Invalid song share target');
  }
  if (target.type === 'plugin' && !isPluginShareId(id)) {
    throw new Error('Invalid plugin share target');
  }

  const url = new URL(`${SHARE_SCHEME}://${target.type}/${encodeURIComponent(id)}`);
  const query = normalizeShareQuery(target.query);
  Object.entries(query).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
};

export const buildShareWebUrl = (target: ShareTarget): string => {
  const id = readText(target.id);
  if (!isShareResourceType(target.type) || !id) {
    throw new Error('Invalid share target');
  }
  if (target.type === 'song' && !isSongShareId(id)) {
    throw new Error('Invalid song share target');
  }
  if (target.type === 'plugin' && !isPluginShareId(id)) {
    throw new Error('Invalid plugin share target');
  }

  const url = new URL(SHARE_WEB_BASE_URL);
  if (Object.keys(normalizeShareQuery(target.query)).length === 0) {
    url.searchParams.set('type', target.type);
    url.searchParams.set('id', id);
  } else {
    url.searchParams.set('target', buildShareUrl({ ...target, id }));
  }
  return url.toString();
};

export const parseShareWebUrl = (value: string): ShareTarget | null => {
  const text = stripTrailingUrlPunctuation(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const endpoint = matchShareWebEndpoint(url);
  if (!endpoint) return null;

  const pathname = url.pathname.replace(/\/$/, '');

  const targetParam = readText(url.searchParams.get('target'));
  if (targetParam) {
    const target = parseCustomShareUrl(targetParam);
    if (target) return target;
  }

  const queryTarget = parseShareTargetParts(
    url.searchParams.get('type'),
    url.searchParams.get('id'),
    readSearchParams(url.searchParams, ['type', 'id', 'target']),
  );
  if (queryTarget) return queryTarget;

  const pathRest = pathname.slice(endpoint.path.length).replace(/^\/+/, '');
  const [pathType, ...pathIdParts] = pathRest.split('/').filter(Boolean);
  if (!pathType || pathIdParts.length === 0) return null;

  return parseShareTargetParts(
    pathType,
    decodeURIComponent(pathIdParts.join('/')),
    readSearchParams(url.searchParams, ['target']),
  );
};

export const parseShareUrl = (value: string): ShareTarget | null =>
  parseCustomShareUrl(value) || parseShareWebUrl(value);

export const isShareUrl = (value: string): boolean => parseShareUrl(value) !== null;

export const extractShareTarget = (value: string): ShareTarget | null => {
  const text = readText(value);
  if (!text) return null;

  const directTarget = parseShareUrl(text);
  if (directTarget) return directTarget;

  const candidates = text.match(/yanmusic:\/\/[^\s<>"'`]+|https?:\/\/[^\s<>"'`]+/gi) ?? [];
  for (const candidate of candidates) {
    const target = parseShareUrl(candidate);
    if (target) return target;
  }

  return null;
};

export const buildShareText = (target: ShareTarget): string => {
  const title = readText(target.title);
  const sharer = readText(target.sharer) || 'yanmusic';
  const label = SHARE_TYPE_LABELS[target.type];
  const headline = `${sharer} 给你分享了${label}${title ? `「${title}」` : ''}，快去看看吧`;
  return `${headline}\n${buildShareWebUrl(target)}`;
};
