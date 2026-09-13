import type {
  EchoPluginDescriptor,
  PluginNetworkJsonValue,
  PluginNetworkRequestOptions,
  PluginNetworkResponse,
} from '../../shared/plugins';

/**
 * 插件原生网络能力（主渲染进程与插件浮窗入口共用）。
 *
 * 与 `src/main/plugins/network.ts` 配合：所有请求经 `plugins:net:request|cancel` 通道
 * 交给主进程的原生 HTTP 适配器执行，渲染进程只负责会话生命周期、中断与请求体归一化。
 */

/** 原生网络请求入参：在 IPC 选项之外支持 Blob 请求体、AbortSignal 与 responseType 重载。 */
export type PluginNetworkRequestInit = Omit<PluginNetworkRequestOptions, 'body'> & {
  body?: PluginNetworkRequestOptions['body'] | Blob;
  signal?: AbortSignal;
};

export interface PluginNetworkRequest {
  <T = PluginNetworkJsonValue>(
    options: PluginNetworkRequestInit & { responseType?: 'json' },
  ): Promise<PluginNetworkResponse<T>>;
  (
    options: PluginNetworkRequestInit & { responseType: 'text' },
  ): Promise<PluginNetworkResponse<string>>;
  (
    options: PluginNetworkRequestInit & { responseType: 'arrayBuffer' },
  ): Promise<PluginNetworkResponse<ArrayBuffer>>;
  (options: PluginNetworkRequestInit): Promise<PluginNetworkResponse>;
}

let networkRequestSequence = 0;

const createAbortError = () => new DOMException('The operation was aborted', 'AbortError');

const createRequestId = (pluginId: string) => {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${pluginId}:${Date.now()}:${++networkRequestSequence}:${random}`;
};

const hasContentTypeHeader = (headers: PluginNetworkRequestOptions['headers']) => {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    return headers.some(([name]) => name.toLowerCase() === 'content-type');
  }
  return Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
};

const withBlobContentType = (
  headers: PluginNetworkRequestOptions['headers'],
  contentType: string,
): PluginNetworkRequestOptions['headers'] => {
  if (!contentType || hasContentTypeHeader(headers)) return headers;
  if (Array.isArray(headers)) return [...headers, ['Content-Type', contentType]];
  return { ...headers, 'Content-Type': contentType };
};

/**
 * 创建插件网络 API。
 *
 * - `fetch`：渲染进程原生 fetch，受同源与禁用请求头规则约束，始终可用；
 * - `request`：走主进程原生 HTTP 适配器，需清单显式声明 `capabilities.unrestrictedNetwork === true`，
 *   未声明时明确拒绝（与主进程 `hasUnrestrictedNetwork` 判定一致）。
 */
export const createPluginNetworkApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const pendingRequestIds = new Set<string>();
  const getNativeApi = () => window.electron.plugins?.net;

  // 插件停用时取消所有尚未落地的请求，避免卸载后回调继续触发。
  addDisposable(() => {
    const api = getNativeApi();
    if (api) {
      for (const requestId of pendingRequestIds) {
        void api.cancel(descriptor.id, requestId).catch(() => {});
      }
    }
    pendingRequestIds.clear();
  });

  const request = (async (options: PluginNetworkRequestInit): Promise<PluginNetworkResponse> => {
    if (descriptor.manifest.capabilities?.unrestrictedNetwork !== true) {
      throw new Error('插件未声明不受限网络能力');
    }
    const api = getNativeApi();
    if (!api) throw new Error('原生网络 API 不可用');

    const { signal, body, ...requestOptions } = options;
    if (signal?.aborted) throw createAbortError();

    const normalizedBody = body instanceof Blob ? await body.arrayBuffer() : body;
    if (signal?.aborted) throw createAbortError();
    const normalizedOptions: PluginNetworkRequestOptions = {
      ...requestOptions,
      headers:
        body instanceof Blob
          ? withBlobContentType(requestOptions.headers, body.type)
          : requestOptions.headers,
      body: normalizedBody,
    };

    const requestId = createRequestId(descriptor.id);
    const abort = () => {
      void api.cancel(descriptor.id, requestId).catch(() => {});
    };
    pendingRequestIds.add(requestId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await api.request(descriptor.id, requestId, normalizedOptions);
      if (signal?.aborted) throw createAbortError();
      return response;
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw error;
    } finally {
      pendingRequestIds.delete(requestId);
      signal?.removeEventListener('abort', abort);
    }
  }) as PluginNetworkRequest;

  return {
    /** 浏览器 Fetch 语义，包含 Chromium 的禁用请求头规则。 */
    fetch: window.fetch.bind(window),
    /** 主进程原生 HTTP 请求，用于 Fetch 受限于同源/禁用头的场景。 */
    request,
  };
};
