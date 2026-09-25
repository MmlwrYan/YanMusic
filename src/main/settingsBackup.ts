import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import log from './logger';
import { getKvStorage } from './storage/kv';
import {
  getDesktopLyricPersistedSettings,
  patchDesktopLyricPersistedSettings,
  setMainAppSetting,
  setPersistedLogSettings,
  type MainAppSettings,
} from './storage/settings';
import { normalizeLogSettings, type AppLogLevel } from '../shared/logging';
import { getStorePersistenceKey } from '../shared/storePersistence';
import { isBlockedObjectKey } from '../shared/objectSafety';
import {
  SETTINGS_BACKUP_EXTENSION,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  sanitizePortableAppSettings,
  type SettingsBackupExportRequest,
  type SettingsBackupExportResult,
  type SettingsBackupImportRequest,
  type SettingsBackupImportResult,
  type SettingsBackupInspectResult,
  type SettingsBackupScope,
  type SettingsBackupSummary,
} from '../shared/settingsBackup';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 512 * 1024 * 1024;
const MAX_SETTINGS_JSON_BYTES = 2 * 1024 * 1024;
const INSPECTION_TTL_MS = 10 * 60 * 1000;

interface SettingsBackupArchive {
  format: typeof SETTINGS_BACKUP_FORMAT;
  version: typeof SETTINGS_BACKUP_VERSION;
  createdAt: string;
  appVersion: string;
  includes: SettingsBackupScope;
  settings?: Record<string, unknown>;
  desktopLyricSettings?: Record<string, unknown>;
}

interface InspectedBackup {
  filePath: string;
  archive: SettingsBackupArchive;
  expiresAt: number;
  digest: string;
}

const inspectedBackups = new Map<string, InspectedBackup>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeDesktopLyricSettings = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(cloned).filter(([key]) => key !== 'windowState' && !isBlockedObjectKey(key)),
    );
  } catch {
    return {};
  }
};

const validateArchive = (value: unknown): SettingsBackupArchive => {
  if (!isPlainObject(value)) throw new Error('不是有效的 YanMusic 备份文件');
  if (value.format !== SETTINGS_BACKUP_FORMAT) throw new Error('备份文件格式不受支持');
  if (value.version !== SETTINGS_BACKUP_VERSION) throw new Error('备份版本不受支持');
  if (!isPlainObject(value.includes)) throw new Error('备份范围信息无效');

  const includes = {
    settings: value.includes.settings === true,
    plugins: value.includes.plugins === true,
  };
  if (!includes.settings) throw new Error('备份中没有可恢复的内容');

  const settings = includes.settings ? sanitizePortableAppSettings(value.settings) : undefined;
  const desktopLyricSettings = includes.settings
    ? sanitizeDesktopLyricSettings(value.desktopLyricSettings)
    : undefined;
  if (
    settings &&
    Buffer.byteLength(JSON.stringify({ settings, desktopLyricSettings })) > MAX_SETTINGS_JSON_BYTES
  ) {
    throw new Error('应用设置数据过大');
  }

  return {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    createdAt: String(value.createdAt || ''),
    appVersion: String(value.appVersion || ''),
    includes,
    ...(settings ? { settings } : {}),
    ...(desktopLyricSettings ? { desktopLyricSettings } : {}),
  };
};

const readArchiveBuffer = async (
  compressed: Buffer,
): Promise<{ archive: SettingsBackupArchive; digest: string }> => {
  if (compressed.byteLength > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 256 MB');
  let json: Buffer;
  try {
    json = await gunzipAsync(compressed, { maxOutputLength: MAX_BACKUP_JSON_BYTES });
  } catch {
    throw new Error('备份文件已损坏或格式不正确');
  }
  if (json.byteLength > MAX_BACKUP_JSON_BYTES) throw new Error('备份解压后超过安全限制');
  try {
    return {
      archive: validateArchive(JSON.parse(json.toString('utf8'))),
      digest: createHash('sha256').update(compressed).digest('hex'),
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('备份文件内容无法解析');
    throw error;
  }
};

const readArchive = async (
  filePath: string,
): Promise<{ archive: SettingsBackupArchive; digest: string }> => {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('请选择有效的备份文件');
  if (stats.size > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 256 MB');
  return readArchiveBuffer(await fs.readFile(filePath));
};

const buildSummary = (archive: SettingsBackupArchive): SettingsBackupSummary => ({
  createdAt: archive.createdAt,
  appVersion: archive.appVersion,
  includes: archive.includes,
  settingCount:
    Object.keys(archive.settings ?? {}).length +
    Object.keys(archive.desktopLyricSettings ?? {}).length,
  pluginCount: 0,
  pluginNames: [],
});

const getDialogWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

const cleanupInspections = async () => {
  const now = Date.now();
  for (const [token, inspection] of inspectedBackups) {
    if (inspection.expiresAt > now) continue;
    inspectedBackups.delete(token);
  }
};

const createBackupArchive = async (
  request: SettingsBackupExportRequest,
): Promise<SettingsBackupArchive> => {
  if (!request?.settings) throw new Error('请至少选择一项备份内容');

  const archive: SettingsBackupArchive = {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    includes: { settings: true, plugins: false },
  };
  archive.settings = sanitizePortableAppSettings(request.settingsData);
  archive.desktopLyricSettings = sanitizeDesktopLyricSettings(getDesktopLyricPersistedSettings());
  if (Buffer.byteLength(JSON.stringify(archive.settings)) > MAX_SETTINGS_JSON_BYTES) {
    throw new Error('应用设置数据过大');
  }
  return archive;
};

const compressBackupArchive = async (archive: SettingsBackupArchive) => {
  const json = Buffer.from(JSON.stringify(archive));
  if (json.byteLength > MAX_BACKUP_JSON_BYTES) throw new Error('备份内容超过 512 MB');
  const compressed = await gzipAsync(json, { level: 9 });
  if (compressed.byteLength > MAX_BACKUP_FILE_BYTES) throw new Error('生成的备份文件超过 256 MB');
  return compressed;
};

export const exportSettingsBackup = async (
  request: SettingsBackupExportRequest,
): Promise<SettingsBackupExportResult> => {
  try {
    if (!request?.settings) {
      return { ok: false, canceled: false, error: '请至少选择一项备份内容' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const options = {
      title: '创建 YanMusic 备份',
      defaultPath: `YanMusic-backup-${date}.${SETTINGS_BACKUP_EXTENSION}`,
      buttonLabel: '创建备份',
      filters: [{ name: 'YanMusic 备份', extensions: [SETTINGS_BACKUP_EXTENSION] }],
    };
    const win = getDialogWindow();
    const picked = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

    const archive = await createBackupArchive(request);
    const compressed = await compressBackupArchive(archive);
    await fs.writeFile(picked.filePath, compressed);
    return {
      ok: true,
      canceled: false,
      filePath: picked.filePath,
      summary: buildSummary(archive),
    };
  } catch (error) {
    log.warn('[SettingsBackup] Export failed', error);
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : '创建备份失败',
    };
  }
};

export const inspectSettingsBackup = async (): Promise<SettingsBackupInspectResult> => {
  try {
    await cleanupInspections();
    const options: OpenDialogOptions = {
      title: '从备份恢复 YanMusic',
      buttonLabel: '选择备份',
      filters: [{ name: 'YanMusic 备份', extensions: [SETTINGS_BACKUP_EXTENSION] }],
      properties: ['openFile'],
    };
    const win = getDialogWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return { ok: false, canceled: true };
    const { archive, digest } = await readArchive(filePath);
    const token = randomUUID();
    inspectedBackups.set(token, {
      filePath,
      archive,
      digest,
      expiresAt: Date.now() + INSPECTION_TTL_MS,
    });
    return { ok: true, canceled: false, token, summary: buildSummary(archive) };
  } catch (error) {
    log.warn('[SettingsBackup] Inspect failed', error);
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : '无法读取备份文件',
    };
  }
};

/**
 * 把备份里的可移植设置写回主进程持久化设置。
 * 应用设置整体落在 kv 的 `setting` 命名空间；主进程侧另有独立存储的
 * closeBehavior / theme / 布尔开关 / dpiScale / 日志设置 / 桌面歌词设置，需要各自回写。
 */
const applyImportedSettings = (importedSettings: Record<string, unknown>) => {
  const key = getStorePersistenceKey('setting');
  const current = getKvStorage().get<Record<string, unknown>>(key);
  getKvStorage().set(key, {
    ...(isPlainObject(current) ? current : {}),
    ...importedSettings,
  });

  if (['tray', 'exit'].includes(String(importedSettings.closeBehavior))) {
    setMainAppSetting('closeBehavior', importedSettings.closeBehavior as 'tray' | 'exit');
  }
  if (['system', 'light', 'dark'].includes(String(importedSettings.theme))) {
    setMainAppSetting('theme', importedSettings.theme as 'system' | 'light' | 'dark');
  }
  const booleanMainSettingKeys: Array<
    Exclude<keyof MainAppSettings, 'closeBehavior' | 'theme' | 'dpiScale'>
  > = [
    'rememberWindowSize',
    'preventSleep',
    'disableGpuAcceleration',
    'autoLaunch',
    'startMinimized',
    'highDpiEnabled',
    'devToolsEnabled',
    'taskbarCoverPreview',
    'taskbarProgress',
  ];
  for (const settingKey of booleanMainSettingKeys) {
    if (typeof importedSettings[settingKey] !== 'boolean') continue;
    setMainAppSetting(settingKey, importedSettings[settingKey]);
  }
  if (typeof importedSettings.dpiScale === 'number' && Number.isFinite(importedSettings.dpiScale)) {
    setMainAppSetting('dpiScale', Math.min(2, Math.max(0.5, importedSettings.dpiScale)));
  }
  setPersistedLogSettings(
    normalizeLogSettings({
      level: importedSettings.logLevel as AppLogLevel,
      apiResponseBody: Boolean(importedSettings.logApiResponseBody),
      diagnosticUntil: 0,
    }),
  );
};

const importSettingsBackupForOwner = async (
  request: SettingsBackupImportRequest,
): Promise<SettingsBackupImportResult> => {
  await cleanupInspections();
  const inspection = inspectedBackups.get(String(request?.token || ''));
  if (!inspection) return { ok: false, error: '备份选择已失效，请重新选择文件' };
  inspectedBackups.delete(String(request.token));

  const archive = inspection.archive;
  const importSettings = Boolean(request.settings && archive.includes.settings);
  if (!importSettings) {
    return { ok: false, error: '请至少选择一项恢复内容' };
  }

  try {
    // Re-read the file so replacement or tampering between preview and import is detected.
    const fresh = await readArchive(inspection.filePath);
    const freshArchive = fresh.archive;
    if (fresh.digest !== inspection.digest) {
      throw new Error('备份文件在预览后发生变化，请重新选择');
    }

    applyImportedSettings(sanitizePortableAppSettings(freshArchive.settings));
    if (isPlainObject(freshArchive.desktopLyricSettings)) {
      patchDesktopLyricPersistedSettings(freshArchive.desktopLyricSettings);
    }

    return {
      ok: true,
      settingsImported: true,
      pluginsImported: 0,
      summary: buildSummary(freshArchive),
    };
  } catch (error) {
    log.warn('[SettingsBackup] Import failed', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : '从备份恢复失败',
      settingsImported: false,
      pluginsImported: 0,
    };
  }
};

export const importSettingsBackup = (
  request: SettingsBackupImportRequest,
): Promise<SettingsBackupImportResult> => importSettingsBackupForOwner(request);
