import { Menu, Tray, app, dialog, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'path';
import { writeDiagnosticsBundle } from './diagnostics/bundle';
import { quitApplication } from './window';
import { DEFAULT_PLAYER_VOLUME, type PlayMode } from '../shared/playback';
import type { DesktopLyricSnapshot } from '../shared/desktop-lyric';
import type { TrayCommand, TrayPlaybackPayload } from '../shared/tray';
import log from './logger';
import { resolveTrayIconPath } from './appIcons';

interface TrayContext {
  getMainWindow: () => Electron.BrowserWindow | null;
  restoreWindow: () => void | Promise<void>;
  getDesktopLyricSnapshot: () => DesktopLyricSnapshot;
  toggleDesktopLyricLock: () => DesktopLyricSnapshot | Promise<DesktopLyricSnapshot>;
}

type TrayPlaybackState = Required<TrayPlaybackPayload>;

let appTray: Tray | null = null;
let trayContext: TrayContext | null = null;
let playbackState: TrayPlaybackState = {
  isPlaying: false,
  playMode: 'list',
  volume: DEFAULT_PLAYER_VOLUME,
};

const playModeLabelMap: Record<PlayMode, string> = {
  sequential: '顺序播放',
  list: '列表循环',
  random: '随机播放',
  single: '单曲循环',
};

const createTrayImage = () => {
  const iconPath = resolveTrayIconPath();
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      log.warn('[Tray] Icon image is empty:', iconPath);
      return nativeImage.createEmpty();
    }
    if (process.platform === 'darwin') {
      image.setTemplateImage(true);
    } else {
      // Win10/Win11/Linux：resize 到标准尺寸，避免兼容性问题
      return image.resize({ width: 20, height: 20 });
    }
    return image;
  } catch (e) {
    log.error('[Tray] Failed to create tray image:', e);
    return nativeImage.createEmpty();
  }
};

const forwardCommandToRenderer = (command: TrayCommand) => {
  const mainWindow = trayContext?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shortcut-trigger', command);
};

const setPlayModeFromTray = (playMode: PlayMode) => {
  const mainWindow = trayContext?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tray:set-play-mode', playMode);
};

const toggleDesktopLyricLockFromMenu = async () => {
  if (!trayContext) return;
  const snapshot = trayContext.getDesktopLyricSnapshot();
  if (!snapshot.settings.enabled) return;
  try {
    await trayContext.toggleDesktopLyricLock();
  } catch (err) {
    log.error('[Tray] Failed to toggle desktop lyric lock:', err);
  }
};

const createPlaybackMenuItems = (): MenuItemConstructorOptions[] => [
  {
    label: playbackState.isPlaying ? '暂停' : '播放',
    click: () => forwardCommandToRenderer('togglePlayback'),
  },
  {
    label: '上一首',
    click: () => forwardCommandToRenderer('previousTrack'),
  },
  {
    label: '下一首',
    click: () => forwardCommandToRenderer('nextTrack'),
  },
  {
    label: '播放模式',
    submenu: (
      Object.entries(playModeLabelMap) as Array<[PlayMode, string]>
    ).map<MenuItemConstructorOptions>(([mode, label]) => ({
      label,
      type: 'radio',
      checked: playbackState.playMode === mode,
      click: () => setPlayModeFromTray(mode),
    })),
  },
  { type: 'separator' },
  {
    label: `音量 ${Math.round(playbackState.volume * 100)}%`,
    enabled: false,
  },
  {
    label: '增大音量',
    click: () => forwardCommandToRenderer('volumeUp'),
  },
  {
    label: '减小音量',
    click: () => forwardCommandToRenderer('volumeDown'),
  },
  {
    label: '静音 / 取消静音',
    click: () => forwardCommandToRenderer('toggleMute'),
  },
];

const createDesktopLyricMenuItems = (): MenuItemConstructorOptions[] => {
  const snapshot = trayContext?.getDesktopLyricSnapshot();
  const opened = snapshot?.settings.enabled ?? false;
  const locked = opened && (snapshot?.settings.locked ?? false);

  return [
    {
      label: locked ? '解锁桌面歌词' : '锁定桌面歌词',
      enabled: opened,
      click: () => void toggleDesktopLyricLockFromMenu(),
    },
  ];
};

/**
 * S-6（v1.3.0）：从托盘菜单导出**诊断包**。
 *
 * 用户遇到问题时最需要的正是「一键把该给维护者的东西都收集起来」——
 * 此前没有这个出口，用户只能截图、或让维护者远程指导他翻目录。
 *
 * 用 `showSaveDialog` 让用户自己决定保存位置（而不是静默写到某个目录）：
 * 诊断包含运行环境与日志，用户应当知道它落在哪里，也便于发送前先自行过目。
 *
 * 导出完成后用 `showMessageBox` 给出**明确结果**（条目数、体积、路径）——
 * 「点了没反应」是这一功能最不该有的表现（原生保存对话框在某些窗口状态下会被遮挡）。
 */
const exportDiagnosticsBundleFromMenu = async () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `YanMusic-diagnostics-${timestamp}.zip`;

  let targetPath: string;
  try {
    const result = await dialog.showSaveDialog({
      title: '导出诊断包',
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return;
    targetPath = result.filePath;
  } catch (error) {
    log.warn('[Tray] diagnostics save dialog failed:', error);
    return;
  }

  try {
    const { bytes, entries } = writeDiagnosticsBundle(targetPath);
    await dialog.showMessageBox({
      type: 'info',
      title: '诊断包已导出',
      message: `已导出 ${entries} 个条目（${(bytes / 1024).toFixed(1)} KB）`,
      detail:
        `保存位置：\n${targetPath}\n\n` +
        '包内设置已脱敏（路径、URL 查询串、长密钥与敏感键名的值均已移除），' +
        '且不含登录票据与设备指纹。\n发送前建议自行打开过目。',
      buttons: ['确定'],
    });
  } catch (error) {
    log.error('[Tray] diagnostics bundle export failed:', error);
    await dialog.showMessageBox({
      type: 'error',
      title: '导出失败',
      message: '诊断包导出失败',
      detail: String((error as Error)?.message ?? error),
      buttons: ['确定'],
    });
  }
};

const createTrayMenu = () => {
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => void trayContext?.restoreWindow(),
    },
    { type: 'separator' },
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    ...createDesktopLyricMenuItems(),
    { type: 'separator' },
    {
      // S-6（v1.3.0）：诊断包出口。放在「退出」之前 ——
      // 它属于「出问题时才会用」的支持类操作，不应挤在常用项中间。
      label: '导出诊断包…',
      click: () => void exportDiagnosticsBundleFromMenu(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApplication(),
    },
  ]);
};

export const createDockMenu = () =>
  Menu.buildFromTemplate([
    ...createPlaybackMenuItems(),
    { type: 'separator' },
    ...createDesktopLyricMenuItems(),
  ]);

const rebuildTrayMenu = () => {
  if (appTray) {
    appTray.setImage(createTrayImage());
    appTray.setToolTip('YanMusic');
    if (process.platform === 'linux') {
      appTray.setContextMenu(createTrayMenu());
    }
  }

  if (process.platform === 'darwin') {
    app.dock?.setMenu(createDockMenu());
  }
};

export const refreshTrayMenus = () => {
  rebuildTrayMenu();
};

export const initTray = (context: TrayContext) => {
  trayContext = context;
  if (appTray) {
    rebuildTrayMenu();
    return appTray;
  }

  const trayImage = createTrayImage();
  appTray = new Tray(trayImage);
  appTray.setToolTip('YanMusic');

  appTray.on('click', () => {
    void trayContext?.restoreWindow();
  });

  if (process.platform === 'linux') {
    appTray.setContextMenu(createTrayMenu());
  } else {
    appTray.on('right-click', () => {
      appTray?.popUpContextMenu(createTrayMenu());
    });
  }

  return appTray;
};

export const refreshTray = () => {
  if (!trayContext) return null;
  if (appTray) {
    destroyTray();
  }
  return initTray(trayContext);
};

export const destroyTray = () => {
  if (!appTray) return;
  appTray.destroy();
  appTray = null;
};

export const updateTrayPlaybackState = (nextState: Partial<TrayPlaybackState>) => {
  playbackState = {
    ...playbackState,
    ...nextState,
  };
  rebuildTrayMenu();
};
