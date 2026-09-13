import {
  getImportTaskResult,
  getImportTaskStatuses,
  type NativeImportMissedTrack,
  type NativeImportTask,
  type NativeImportTaskResult,
} from '@/api/importPlaylist';

/** 截图上单次最多选择的图片数量 */
export const SCREENSHOT_IMPORT_MAX_FILES = 9;
/** 截图上单张图片大小上限（字节） */
export const SCREENSHOT_IMPORT_MAX_SIZE = 10 * 1024 * 1024;
/** 截图上允许的图片类型 */
export const SCREENSHOT_IMPORT_ACCEPT = 'image/jpeg,image/png';

interface NativeImportCallbacks {
  shouldStop?: () => boolean;
  onProgress?: (task: NativeImportTask) => void;
  intervalMs?: number;
}

export interface NativeImportResult {
  task: NativeImportTask;
  missed: NativeImportMissedTrack[];
}

export class NativeImportUnsupportedError extends Error {
  constructor() {
    super('酷狗云端暂不支持该歌单链接');
    this.name = 'NativeImportUnsupportedError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const responseData = <T>(response: unknown): T | null => {
  if (!response || typeof response !== 'object') return null;
  return ((response as { data?: T }).data ?? null) as T | null;
};

const fetchMissedTracks = async (task: NativeImportTask): Promise<NativeImportMissedTrack[]> => {
  if (!task.listid || !task.missed_num) return [];
  const pageSize = 100;
  const pageCount = Math.ceil(Number(task.missed_num) / pageSize);
  const missed: NativeImportMissedTrack[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const response = await getImportTaskResult(task.listid, page, pageSize);
    const result = responseData<NativeImportTaskResult>(response);
    if (!result?.missed?.length) break;
    missed.push(...result.missed);
    if (result.missed.length < pageSize) break;
  }
  return missed;
};

/**
 * 轮询云端导入任务直到完成或失败。
 * @param taskId 任务编号
 * @param callbacks 中止判定与进度回调
 * @returns 任务结果；被中止时返回 null
 */
export const waitForNativeImport = async (
  taskId: string | number,
  callbacks: NativeImportCallbacks = {},
): Promise<NativeImportResult | null> => {
  const intervalMs = Math.max(500, callbacks.intervalMs ?? 1500);

  while (!callbacks.shouldStop?.()) {
    const response = await getImportTaskStatuses([taskId]);
    const data = responseData<NativeImportTask[] | NativeImportTask>(response);
    const task = Array.isArray(data) ? data[0] : data;
    if (!task) throw new Error('未查询到导入任务');
    callbacks.onProgress?.(task);

    const status = Number(task.status);
    if (status === 3) {
      return { task, missed: await fetchMissedTracks(task) };
    }
    if (status >= 10) {
      const taskType = Number(task.task_type ?? task.type ?? 0);
      if (status === 10 && taskType === 0 && Number(task.songs_num || 0) === 0) {
        throw new NativeImportUnsupportedError();
      }
      throw new Error(task.msg || `导入任务失败（状态 ${status}）`);
    }
    await sleep(intervalMs);
  }

  return null;
};

/** 从创建任务的响应中取出任务编号 */
export const responseTaskId = (response: unknown): string | number => {
  if (!response || typeof response !== 'object') throw new Error('创建导入任务失败');
  const data = (response as { data?: { id?: string | number } }).data;
  if (!data?.id) throw new Error('创建导入任务未返回任务编号');
  return data.id;
};

/** 生成截图任务的 task_sn */
export const createScreenshotTaskSn = (userId: string | number) => `${userId}${Date.now()}`;

/** 读取图片为 data URL（base64） */
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`读取图片失败：${file.name}`));
    reader.readAsDataURL(file);
  });

export interface ScreenshotFileValidation {
  files: File[];
  error?: string;
}

/** 校验用户选择的截图（数量与单张大小） */
export const validateScreenshotFiles = (input: File[]): ScreenshotFileValidation => {
  if (input.length > SCREENSHOT_IMPORT_MAX_FILES) {
    return {
      files: input.slice(0, SCREENSHOT_IMPORT_MAX_FILES),
      error: `一次最多选择 ${SCREENSHOT_IMPORT_MAX_FILES} 张截图`,
    };
  }
  const oversized = input.find((file) => file.size > SCREENSHOT_IMPORT_MAX_SIZE);
  if (oversized) {
    return { files: [], error: `${oversized.name} 超过 10 MB` };
  }
  return { files: input };
};
