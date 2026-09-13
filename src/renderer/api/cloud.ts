import request from '@/utils/request';

const normalizeCloudSongId = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) return null;
  return text;
};

export interface DeleteCloudSongTarget {
  cloudFileId?: string | number;
  hash?: string;
  albumAudioId?: string | number;
}

const requestDeleteCloudSongs = async (params: Record<string, unknown>) => {
  try {
    return await request.get('/user/cloud/del', { params });
  } catch (error: any) {
    const msg = error?.response?.body?.msg;
    if (msg) throw new Error(String(msg));
    throw error;
  }
};

/**
 * 删除用户云盘歌曲。
 * 优先传云盘文件 ID（列表接口 kv_id），缺失时回退到 hash。
 */
export async function deleteCloudSongs(targets: DeleteCloudSongTarget[]) {
  const normalizedTargets = targets
    .map((target) => ({
      cloudFileId: normalizeCloudSongId(target.cloudFileId),
      hash: String(target.hash ?? '').trim(),
      albumAudioId: normalizeCloudSongId(target.albumAudioId),
    }))
    .filter((target) => target.cloudFileId || target.hash);

  if (normalizedTargets.length === 0) {
    throw new Error('缺少可删除的云盘文件标识');
  }

  const fileTargets = normalizedTargets.filter((target) => target.cloudFileId);
  const hashTargets = normalizedTargets.filter((target) => !target.cloudFileId && target.hash);

  const responses: unknown[] = [];
  if (fileTargets.length > 0) {
    responses.push(
      await requestDeleteCloudSongs({
        fileids: fileTargets.map((target) => target.cloudFileId),
        album_audio_ids: fileTargets.map((target) => target.albumAudioId ?? 0),
      }),
    );
  }
  if (hashTargets.length > 0) {
    responses.push(
      await requestDeleteCloudSongs({
        hashes: hashTargets.map((target) => target.hash),
      }),
    );
  }

  const failed = responses.find((res) => {
    const body = res && typeof res === 'object' ? (res as Record<string, unknown>) : null;
    const status = Number(body?.status ?? 1);
    const errorCode = Number(body?.error_code ?? 0);
    return Boolean(body && (status === 0 || errorCode !== 0));
  });
  const body = failed && typeof failed === 'object' ? (failed as Record<string, unknown>) : null;
  const status = Number(body?.status ?? 1);
  const errorCode = Number(body?.error_code ?? 0);
  if (body && (status === 0 || errorCode !== 0)) {
    throw new Error(String(body.msg || `删除失败（error_code=${errorCode}）`));
  }
  return responses[responses.length - 1];
}

const normalizeCloudUploadSongId = (value: unknown): string | number => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return 0;
  return /^0+$/.test(text) ? 0 : text;
};

/**
 * 上传音乐文件到用户云盘（二进制 body，支持分片上传与秒传）
 * @param data 文件二进制内容（Uint8Array / ArrayBuffer）
 * @param options 文件信息
 */
export async function uploadToCloud(
  data: Uint8Array | ArrayBuffer,
  options: {
    name: string;
    extendname?: string;
    authorName?: string;
    audioId?: string | number;
    albumAudioId?: string | number;
  },
) {
  const extendname = options.extendname || options.name.split('.').pop()?.toLowerCase() || 'mp3';
  const baseName = options.name.replace(/\.[^.]+$/, '');
  const audioId = normalizeCloudUploadSongId(options.audioId);
  const albumAudioId = normalizeCloudUploadSongId(options.albumAudioId);
  try {
    const res = await request.post('/user/cloud/upload', data, {
      params: {
        extendname,
        name: baseName,
        ...(options.authorName ? { author_name: options.authorName } : {}),
        audio_id: audioId,
        album_audio_id: albumAudioId,
      },
    });
    // 上游可能返回 HTTP 200 但业务失败（error_code 非 0 / status 非 1），需主动抛错
    const body = res as { error_code?: number | string; status?: number; msg?: string } | null;
    const errorCode = Number(body?.error_code ?? 0);
    if (body && (errorCode !== 0 || Number(body.status ?? 1) !== 1)) {
      const err = new Error(body?.msg || `上传失败（error_code=${errorCode}）`);
      (err as any).response = res;
      throw err;
    }
    return res;
  } catch (error: any) {
    // 后端业务失败时 status=500 且 body 携带 msg，转换为可读错误
    const msg = error?.response?.body?.msg;
    if (msg) {
      const err = new Error(String(msg));
      (err as any).response = error?.response;
      throw err;
    }
    throw error;
  }
}
