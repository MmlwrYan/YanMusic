import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type {
  EchoPluginDescriptor,
  PluginSqliteCloseResult,
  PluginSqliteDatabaseInfo,
  PluginSqliteDeleteResult,
  PluginSqliteExecResult,
  PluginSqliteListResult,
  PluginSqliteMigration,
  PluginSqliteOpenOptions,
  PluginSqliteOpenResult,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteQueryResult,
  PluginSqliteRunResult,
  PluginSqliteStatement,
} from '../shared/plugins';
import { getNativeStorage } from './storage/native';
import { findBlockedSqlKeyword } from '../shared/pluginSqlSafety';
import { isPathInsideRoot } from '../shared/pathBoundary';
import log from './logger';

const PLUGIN_SQLITE_ROOT = 'plugin-sqlite';
const DEFAULT_DATABASE_NAME = 'main';
const MAX_DATABASE_NAME_LENGTH = 64;
const MAX_SQL_LENGTH = 256 * 1024;
const DEFAULT_QUERY_LIMIT = 1000;
const MAX_QUERY_LIMIT = 5000;
const MAX_TRANSACTION_STATEMENTS = 500;
const MAX_RESULT_JSON_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_PARAM_BYTES = 8 * 1024 * 1024;
const DATABASE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// SQL 危险语句拦截已抽到 shared/pluginSqlSafety.ts（纯函数、可在 node --test 下单测）。
// 详见该文件头部的 M-6 修复说明。
const HEX_RE = /^[0-9a-fA-F]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ok = <T extends object>(value: T): T & { ok: true } => ({ ok: true, ...value });
const fail = (error: unknown, fallback: string) => ({
  ok: false as const,
  error: error instanceof Error ? error.message : fallback,
});

const normalizeDatabaseName = (name?: string) => {
  const normalized = String(name || DEFAULT_DATABASE_NAME).trim();
  if (!normalized) throw new Error('SQLite 数据库名不能为空');
  if (normalized.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error(`SQLite 数据库名不能超过 ${MAX_DATABASE_NAME_LENGTH} 个字符`);
  }
  if (!DATABASE_NAME_RE.test(normalized)) {
    throw new Error(
      'SQLite 数据库名只能包含字母、数字、点、下划线和短横线，且必须以字母或数字开头',
    );
  }
  // L-4（v1.2.4）：显式拒绝 `..`。原正则允许点号但未禁止连续点，
  // 虽因「首字符必须是字母数字」尚未构造出确定的越界输入，但纵深防御上应收紧：
  // 只要不出现 `..`，`join(root, name + '.sqlite')` 就绝无跳出根目录的可能。
  if (normalized.includes('..')) {
    throw new Error('SQLite 数据库名不得包含连续的 ".."');
  }
  return normalized;
};

const getPluginSqliteRoot = (pluginId: string) =>
  join(app.getPath('userData'), PLUGIN_SQLITE_ROOT, pluginId);

/**
 * M-5 修复（v1.2.4）：纵深防御 —— 打开的数据库路径必须**落在插件自己的根目录内**。
 *
 * 现状与风险（审计发现 M-5）：原生层 `plugin_sqlite_open(database_id, database_path, …)`
 * 直接 `Connection::open_with_flags(database_path, …)`，**不校验路径**；当前之所以安全，
 * 全靠本文件用已消毒的库名（`DATABASE_NAME_RE`）拼出 `join(root, name + '.sqlite')`。
 * 也就是说**越权防护 100% 在 JS 层**，一旦多出第二条调用路径、或该 addon 被别的
 * 项目复用，原生层会无条件打开任意路径的 SQLite 文件。
 *
 * 这里补一道**显式的边界断言**（纵深防御，不是替代原生层修复）：
 *   - 解析后的绝对路径必须仍以插件根目录为前缀；
 *   - 并且不得借符号链接跳出（对本目录内已存在的文件做 realpath 比对）。
 * 原生层的 `sqlite3_set_authorizer` 白名单授权是彻底方案，已记入报告 M-5 的后续事项
 *（需改 Rust 并重编 4 平台产物，不在本补丁版本范围内）。
 */
const assertDatabasePathInsideRoot = (pluginId: string, databasePath: string) => {
  const root = resolve(getPluginSqliteRoot(pluginId));
  if (!isPathInsideRoot(root, resolve(databasePath))) {
    throw new Error('SQLite 数据库路径超出插件目录');
  }

  // 对已存在的路径再做一次 realpath 比对，避免符号链接把落点引到根目录之外。
  const resolved = resolve(databasePath);
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    if (!isPathInsideRoot(realRoot, real)) {
      throw new Error('SQLite 数据库路径经链接指向插件目录之外');
    }
  }
};

const getDatabasePath = (pluginId: string, name: string) => {
  const databasePath = join(getPluginSqliteRoot(pluginId), `${name}.sqlite`);
  assertDatabasePathInsideRoot(pluginId, databasePath);
  return databasePath;
};

const getDatabaseId = (pluginId: string, name: string) => `${pluginId}:${name}`;

const getNameFromDatabaseId = (pluginId: string, databaseId: string) => {
  const prefix = `${pluginId}:`;
  if (!String(databaseId || '').startsWith(prefix)) {
    throw new Error('SQLite 数据库不属于当前插件');
  }
  return normalizeDatabaseName(databaseId.slice(prefix.length));
};

const validateSql = (sql: string) => {
  const value = String(sql || '');
  if (!value.trim()) throw new Error('SQLite SQL 不能为空');
  if (value.length > MAX_SQL_LENGTH) throw new Error('SQLite SQL 过长');

  // 归一化后再判定：注释与引号已被剥除，任何拆分写法都会还原成独立关键字。
  const blocked = findBlockedSqlKeyword(value);
  if (blocked) {
    throw new Error(`SQLite SQL 包含不允许的语句（${blocked.toUpperCase()}）`);
  }
  return value;
};

const normalizeParams = (params?: PluginSqliteParams) => {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new Error('SQLite 参数必须是数组');
  return params.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('SQLite 数字参数必须是有限数值');
      }
      return value;
    }
    if (value && typeof value === 'object') {
      const type = String((value as { type?: unknown }).type || '').toLowerCase();
      const data = (value as { data?: unknown }).data;
      if (typeof data !== 'string') {
        throw new Error('SQLite 二进制参数 data 必须是字符串');
      }
      if (type === 'hex') {
        if (data.length % 2 !== 0 || !HEX_RE.test(data)) {
          throw new Error('SQLite hex 二进制参数格式无效');
        }
        if (data.length / 2 > MAX_BLOB_PARAM_BYTES) {
          throw new Error(`SQLite 二进制参数不能超过 ${MAX_BLOB_PARAM_BYTES} 字节`);
        }
        return { type, data };
      }
      if (type === 'base64') {
        const normalized = data.trim();
        if (!BASE64_RE.test(normalized)) {
          throw new Error('SQLite base64 二进制参数格式无效');
        }
        const buffer = Buffer.from(normalized, 'base64');
        const byteLength = buffer.byteLength;
        if (byteLength > MAX_BLOB_PARAM_BYTES) {
          throw new Error(`SQLite 二进制参数不能超过 ${MAX_BLOB_PARAM_BYTES} 字节`);
        }
        return { type: 'hex', data: buffer.toString('hex') };
      }
    }
    throw new Error(
      'SQLite 参数仅支持 string、number、boolean、null、{ type: "hex", data } 和 { type: "base64", data }',
    );
  });
};

const normalizeQueryLimit = (options?: PluginSqliteQueryOptions) => {
  const limit = Number(options?.limit ?? DEFAULT_QUERY_LIMIT);
  if (!Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.trunc(Math.min(Math.max(limit, 1), MAX_QUERY_LIMIT));
};

const parseNativeJson = <T>(value: string, maxBytes = MAX_RESULT_JSON_BYTES): T => {
  if (value.length > maxBytes) throw new Error('SQLite 查询结果过大');
  return JSON.parse(value) as T;
};

const toParamsJson = (params?: PluginSqliteParams) => JSON.stringify(normalizeParams(params));

const normalizeMigrations = (migrations?: PluginSqliteMigration[]) => {
  if (migrations === undefined) return [];
  if (!Array.isArray(migrations)) throw new Error('SQLite migrations 必须是数组');
  return migrations
    .map((migration) => {
      const version = Number(migration?.version);
      if (!Number.isInteger(version) || version < 1 || version > 999999) {
        throw new Error('SQLite migration.version 必须是 1 到 999999 的整数');
      }
      const sqlList = Array.isArray(migration.sql) ? migration.sql : [migration.sql];
      const sql = sqlList.map((item) => validateSql(item)).join('\n');
      return { version, sql };
    })
    .sort((left, right) => left.version - right.version);
};

const getCurrentUserVersion = (databaseId: string) => {
  const raw = getNativeStorage().pluginSqliteAll(databaseId, 'PRAGMA user_version', null, 1);
  const result = parseNativeJson<{ rows?: Array<Record<string, unknown>> }>(raw);
  return Number(result.rows?.[0]?.user_version ?? 0) || 0;
};

const applyMigrations = (databaseId: string, migrations?: PluginSqliteMigration[]) => {
  const normalizedMigrations = normalizeMigrations(migrations);
  if (normalizedMigrations.length === 0) return getCurrentUserVersion(databaseId);

  let currentVersion = getCurrentUserVersion(databaseId);
  for (const migration of normalizedMigrations) {
    if (migration.version <= currentVersion) continue;
    const sql = `BEGIN IMMEDIATE;\n${migration.sql}\nPRAGMA user_version = ${migration.version};\nCOMMIT;`;
    try {
      getNativeStorage().pluginSqliteExec(databaseId, sql);
    } catch (error) {
      try {
        getNativeStorage().pluginSqliteExec(databaseId, 'ROLLBACK;');
      } catch {
        // ignore rollback failures; the original migration error is more useful
      }
      throw error;
    }
    currentVersion = migration.version;
  }
  return currentVersion;
};

export const openPluginSqliteDatabase = (
  plugin: EchoPluginDescriptor,
  options?: PluginSqliteOpenOptions,
): PluginSqliteOpenResult => {
  let databaseId = '';
  try {
    const name = normalizeDatabaseName(options?.name);
    databaseId = getDatabaseId(plugin.id, name);
    const root = getPluginSqliteRoot(plugin.id);
    mkdirSync(root, { recursive: true });
    getNativeStorage().pluginSqliteOpen(
      databaseId,
      getDatabasePath(plugin.id, name),
      JSON.stringify({
        readOnly: options?.readOnly === true,
        busyTimeoutMs: Number(options?.busyTimeoutMs) || 3000,
      }),
    );
    const version = options?.readOnly
      ? getCurrentUserVersion(databaseId)
      : applyMigrations(databaseId, options?.migrations);
    return ok({ pluginId: plugin.id, databaseId, name, version });
  } catch (error) {
    if (databaseId) {
      try {
        getNativeStorage().pluginSqliteClose(databaseId);
      } catch {
        // ignore cleanup failure after an open/migration error
      }
    }
    log.warn('[PluginSqlite] Open failed', { pluginId: plugin.id, error });
    return fail(error, '插件 SQLite 数据库打开失败');
  }
};

export const execPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
): PluginSqliteExecResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    getNativeStorage().pluginSqliteExec(databaseId, validateSql(sql));
    return { ok: true };
  } catch (error) {
    return fail(error, '插件 SQLite 执行失败');
  }
};

export const runPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteRunResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteRun(
      databaseId,
      validateSql(sql),
      toParamsJson(params),
    );
    return ok(parseNativeJson<{ changes: number; lastInsertRowid: number }>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 写入失败');
  }
};

export const allPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
  options?: PluginSqliteQueryOptions,
): PluginSqliteQueryResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteAll(
      databaseId,
      validateSql(sql),
      toParamsJson(params),
      normalizeQueryLimit(options),
    );
    return ok(parseNativeJson<Omit<Extract<PluginSqliteQueryResult, { ok: true }>, 'ok'>>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 查询失败');
  }
};

export const getPluginSqlite = (
  pluginId: string,
  databaseId: string,
  sql: string,
  params?: PluginSqliteParams,
): PluginSqliteQueryResult => {
  const result = allPluginSqlite(pluginId, databaseId, sql, params, { limit: 1 });
  if (!result.ok) return result;
  return { ...result, rows: result.rows.slice(0, 1), rowCount: result.rows.length > 0 ? 1 : 0 };
};

export const transactionPluginSqlite = (
  pluginId: string,
  databaseId: string,
  statements: PluginSqliteStatement[],
): PluginSqliteExecResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    if (!Array.isArray(statements)) throw new Error('SQLite transaction 参数必须是数组');
    if (statements.length > MAX_TRANSACTION_STATEMENTS) {
      throw new Error(`SQLite transaction 最多包含 ${MAX_TRANSACTION_STATEMENTS} 条语句`);
    }
    const normalizedStatements = statements.map((statement) => ({
      sql: validateSql(statement?.sql),
      params: normalizeParams(statement?.params),
    }));
    getNativeStorage().pluginSqliteTransaction(databaseId, JSON.stringify(normalizedStatements));
    return { ok: true };
  } catch (error) {
    return fail(error, '插件 SQLite 事务执行失败');
  }
};

export const closePluginSqliteDatabase = (
  pluginId: string,
  databaseId: string,
): PluginSqliteCloseResult => {
  try {
    getNameFromDatabaseId(pluginId, databaseId);
    const raw = getNativeStorage().pluginSqliteClose(databaseId);
    return ok(parseNativeJson<{ closed: boolean }>(raw));
  } catch (error) {
    return fail(error, '插件 SQLite 数据库关闭失败');
  }
};

export const closePluginSqliteDatabases = (pluginId?: string) => {
  try {
    getNativeStorage().pluginSqliteCloseByPrefix(pluginId ? `${pluginId}:` : '');
  } catch (error) {
    log.warn('[PluginSqlite] Close failed', { pluginId, error });
  }
};

export const listPluginSqliteDatabases = (pluginId: string): PluginSqliteListResult => {
  try {
    const root = getPluginSqliteRoot(pluginId);
    if (!existsSync(root)) return { ok: true, databases: [] };
    const databases = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
      .map<PluginSqliteDatabaseInfo>((entry) => {
        const name = entry.name.slice(0, -'.sqlite'.length);
        const stats = statSync(join(root, entry.name));
        return { name, size: stats.size, modifiedAt: stats.mtimeMs };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return { ok: true, databases };
  } catch (error) {
    return fail(error, '插件 SQLite 数据库列表读取失败');
  }
};

export const deletePluginSqliteDatabase = (
  pluginId: string,
  name: string | undefined,
): PluginSqliteDeleteResult => {
  try {
    const databaseName = normalizeDatabaseName(name);
    const databaseId = getDatabaseId(pluginId, databaseName);
    getNativeStorage().pluginSqliteClose(databaseId);
    const databasePath = getDatabasePath(pluginId, databaseName);
    const existed = existsSync(databasePath);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      rmSync(path, { force: true });
    }
    return { ok: true, deleted: existed };
  } catch (error) {
    return fail(error, '插件 SQLite 数据库删除失败');
  }
};

export const deletePluginSqliteDatabases = (pluginId: string) => {
  closePluginSqliteDatabases(pluginId);
  rmSync(getPluginSqliteRoot(pluginId), { recursive: true, force: true });
};

app.once('before-quit', () => closePluginSqliteDatabases());
