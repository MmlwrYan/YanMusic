const MAX_STATS_BATCH = 200;

// ── M7-AUTH：写入端点最小鉴权 + 限流 ──
// 写入端点不再公开：需 `X-YanMusic-Key` 命中 secret `PLUGIN_STATS_WRITE_KEY`。
// 策略为 fail closed——未配置 secret 时一律拒绝写入（否则「忘记配置」= 写入口重新敞开）。
// 纯函数口径与 src/shared/pluginStatsAuth.ts 保持一致，由 tests/plugin-stats-auth.test.ts 守护。
const STATS_KEY_HEADER = 'x-yanmusic-key';
const WRITE_WINDOW_MS = 60000;
const WRITE_MAX_PER_WINDOW = 60;

/** 常时比较，避免响应时间侧信道。 */
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const isWriteAuthorized = (provided, expected) => {
  const want = String(expected ?? '');
  if (!want) return false;
  const got = String(provided ?? '').trim();
  if (!got) return false;
  return safeEqual(got, want);
};

// 固定窗口限流。Workers 实例间不共享内存，故这是「单实例尽力而为」的限流，
// 用于抬高脚本刷量的成本；强一致限流需改用 Durable Object / KV，属后续可选强化。
const rateBuckets = new Map();
const checkRateLimit = (ip, now) => {
  const entry = rateBuckets.get(ip);
  if (!entry || now - entry.windowStart >= WRITE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= WRITE_MAX_PER_WINDOW;
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
      ...(init.headers || {}),
    },
  });

const corsHeaders = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,user-agent,x-yanmusic-key',
});

const normalizePluginId = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');

const normalizeSourceId = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._/-]/g, '');

const normalizePackagePath = (value) =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const normalizeDownloadUrl = (value) => {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
};

const dayKey = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const normalizeStats = (value) => {
  const installCount = Math.max(0, Math.floor(Number(value?.installCount) || 0));
  const updateCount = Math.max(0, Math.floor(Number(value?.updateCount) || 0));
  return {
    installCount,
    updateCount,
    failureCount: Math.max(0, Math.floor(Number(value?.failureCount) || 0)),
    score: Math.max(0, Number(value?.score) || 0),
    lastInstalledAt: String(value?.lastInstalledAt || ''),
    lastUpdatedAt: String(value?.lastUpdatedAt || ''),
  };
};

const computeScore = (stats, daily) => {
  const installs = stats.installCount + stats.updateCount;
  const failures = stats.failureCount;
  const todayInstalls =
    Math.max(0, Number(daily?.installCount) || 0) + Math.max(0, Number(daily?.updateCount) || 0);
  return Math.max(0, Math.round((installs * 3 + todayInstalls * 5 - failures * 2) * 10) / 10);
};

const readStats = async (env, sourceId, pluginId) => {
  const normalizedSourceId = normalizeSourceId(sourceId);
  const normalizedPluginId = normalizePluginId(pluginId);
  const [statsRow, dailyRow] = await Promise.all([
    env.PLUGIN_STATS_DB.prepare(
      `SELECT install_count AS installCount,
              update_count AS updateCount,
              failure_count AS failureCount,
              last_installed_at AS lastInstalledAt,
              last_updated_at AS lastUpdatedAt
         FROM plugin_stats
        WHERE source_id = ? AND plugin_id = ?`,
    )
      .bind(normalizedSourceId, normalizedPluginId)
      .first(),
    env.PLUGIN_STATS_DB.prepare(
      `SELECT install_count AS installCount,
              update_count AS updateCount,
              failure_count AS failureCount
         FROM plugin_daily_stats
        WHERE source_id = ? AND plugin_id = ? AND day = ?`,
    )
      .bind(normalizedSourceId, normalizedPluginId, dayKey())
      .first(),
  ]);
  const normalized = normalizeStats(statsRow);
  normalized.score = computeScore(normalized, dailyRow);
  return normalized;
};

const getIncrementStatements = (env, plugin, field, timeField, now) => {
  const sourceId = normalizeSourceId(plugin.sourceId);
  const pluginId = normalizePluginId(plugin.pluginId);
  const version = String(plugin.version || '').trim();
  const sourceUrl = String(plugin.sourceUrl || '').trim();
  const sourceName = String(plugin.sourceName || '').trim();
  const repo = String(plugin.repo || '').trim();
  const packagePath = normalizePackagePath(plugin.packagePath);
  const downloadUrl = normalizeDownloadUrl(plugin.downloadUrl);
  const checksum = String(plugin.checksum || '').trim();
  const dailyKey = dayKey();

  const metadataParams = [
    sourceId,
    pluginId,
    version,
    sourceUrl,
    sourceName,
    repo,
    packagePath,
    downloadUrl,
    checksum,
  ];

  if (field === 'installCount') {
    return [
      env.PLUGIN_STATS_DB.prepare(
        `INSERT INTO plugin_stats
           (source_id, plugin_id, version, source_url, source_name, repo, package_path, download_url, checksum,
            install_count, update_count, failure_count, last_installed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)
         ON CONFLICT(source_id, plugin_id) DO UPDATE SET
           version = excluded.version,
           source_url = excluded.source_url,
           source_name = excluded.source_name,
           repo = excluded.repo,
           package_path = excluded.package_path,
           download_url = excluded.download_url,
           checksum = excluded.checksum,
           install_count = install_count + 1,
           last_installed_at = excluded.last_installed_at,
           updated_at = excluded.updated_at`,
      ).bind(...metadataParams, now, now, now),
      env.PLUGIN_STATS_DB.prepare(
        `INSERT INTO plugin_daily_stats
           (source_id, plugin_id, day, install_count, update_count, failure_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 0, ?, ?)
         ON CONFLICT(source_id, plugin_id, day) DO UPDATE SET
           install_count = install_count + 1,
           updated_at = excluded.updated_at`,
      ).bind(sourceId, pluginId, dailyKey, now, now),
    ];
  }

  if (field === 'updateCount') {
    return [
      env.PLUGIN_STATS_DB.prepare(
        `INSERT INTO plugin_stats
           (source_id, plugin_id, version, source_url, source_name, repo, package_path, download_url, checksum,
            install_count, update_count, failure_count, last_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?)
         ON CONFLICT(source_id, plugin_id) DO UPDATE SET
           version = excluded.version,
           source_url = excluded.source_url,
           source_name = excluded.source_name,
           repo = excluded.repo,
           package_path = excluded.package_path,
           download_url = excluded.download_url,
           checksum = excluded.checksum,
           update_count = update_count + 1,
           last_updated_at = excluded.last_updated_at,
           updated_at = excluded.updated_at`,
      ).bind(...metadataParams, now, now, now),
      env.PLUGIN_STATS_DB.prepare(
        `INSERT INTO plugin_daily_stats
           (source_id, plugin_id, day, install_count, update_count, failure_count, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 0, ?, ?)
         ON CONFLICT(source_id, plugin_id, day) DO UPDATE SET
           update_count = update_count + 1,
           updated_at = excluded.updated_at`,
      ).bind(sourceId, pluginId, dailyKey, now, now),
    ];
  }

  return [
    env.PLUGIN_STATS_DB.prepare(
      `INSERT INTO plugin_stats
         (source_id, plugin_id, version, source_url, source_name, repo, package_path, download_url, checksum,
          install_count, update_count, failure_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
       ON CONFLICT(source_id, plugin_id) DO UPDATE SET
         version = excluded.version,
         source_url = excluded.source_url,
         source_name = excluded.source_name,
         repo = excluded.repo,
         package_path = excluded.package_path,
         download_url = excluded.download_url,
         checksum = excluded.checksum,
         failure_count = failure_count + 1,
         updated_at = excluded.updated_at`,
    ).bind(...metadataParams, now, now),
    env.PLUGIN_STATS_DB.prepare(
      `INSERT INTO plugin_daily_stats
         (source_id, plugin_id, day, install_count, update_count, failure_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 1, ?, ?)
       ON CONFLICT(source_id, plugin_id, day) DO UPDATE SET
         failure_count = failure_count + 1,
         updated_at = excluded.updated_at`,
    ).bind(sourceId, pluginId, dailyKey, now, now),
  ];
};

const incrementStats = async (env, plugin, field, timeField) => {
  const sourceId = normalizeSourceId(plugin.sourceId);
  const pluginId = normalizePluginId(plugin.pluginId);
  if (!sourceId || !pluginId) throw new Error('missing plugin identity');

  const now = new Date().toISOString();
  const statements = getIncrementStatements(env, plugin, field, timeField, now);
  await env.PLUGIN_STATS_DB.batch(statements);
  return readStats(env, sourceId, pluginId);
};

const readJsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const handleStats = async (request, env) => {
  const body = await readJsonBody(request);
  const plugins = Array.isArray(body?.plugins) ? body.plugins.slice(0, MAX_STATS_BATCH) : [];
  const rows = await Promise.all(
    plugins.map(async (item) => {
      const sourceId = normalizeSourceId(item?.sourceId);
      const pluginId = normalizePluginId(item?.pluginId);
      if (!sourceId || !pluginId) return null;
      return {
        sourceId,
        pluginId,
        stats: await readStats(env, sourceId, pluginId),
      };
    }),
  );
  return json({ ok: true, plugins: rows.filter(Boolean) });
};

const handleEvents = async (request, env) => {
  // M7-AUTH：先鉴权（fail closed），再限流，最后才读 body 与写库。
  const providedKey = request.headers.get(STATS_KEY_HEADER) || '';
  if (!isWriteAuthorized(providedKey, env.PLUGIN_STATS_WRITE_KEY)) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!checkRateLimit(clientIp, Date.now())) {
    return json({ ok: false, error: 'rate limited' }, { status: 429 });
  }

  const body = await readJsonBody(request);
  const event = String(body?.event || '').trim();
  const plugin = body?.plugin || {};
  if (!['install', 'update', 'failure'].includes(event)) {
    return json({ ok: false, error: 'invalid event' }, { status: 400 });
  }
  const field =
    event === 'install' ? 'installCount' : event === 'update' ? 'updateCount' : 'failureCount';
  const timeField =
    event === 'install' ? 'lastInstalledAt' : event === 'update' ? 'lastUpdatedAt' : '';
  const stats = await incrementStats(env, plugin, field, timeField);
  return json({ ok: true, stats });
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    if (!env.PLUGIN_STATS_DB) {
      return json({ ok: false, error: 'PLUGIN_STATS_DB D1 binding is missing' }, { status: 500 });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/v1/plugins/stats') {
        return handleStats(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/v1/plugins/events') {
        return handleEvents(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true });
      }
      return json({ ok: false, error: 'not found' }, { status: 404 });
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'worker error' },
        { status: 500 },
      );
    }
  },
};
