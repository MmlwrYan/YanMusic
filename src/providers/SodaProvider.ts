/**
 * SodaProvider —— 第三方音源（Soda / qishui）适配层。
 *
 * ## ⚠️ 合规边界（先读这一段）
 *
 * 1. **`bdms.node` 不得随安装包分发**。它是目标客户端的私有原生模块。
 *    本文件的 `init()` 采用**用户本地路径动态加载**：从设置/环境变量读取绝对路径，
 *    `require` 该文件。仓库里**不包含**、**不打包**、**不转存**它。
 * 2. **不实现任何 DRM 绕过**。VIP 曲目完整播放只能依赖**用户自己的账号**
 *    （Cookie 由用户自行提供）。未登录时只请求服务端本来就给的
 *    **30 秒试听**（`limited_free` 链路），这是平台自身的公开能力，不是破解。
 * 3. 设备指纹是**调用方自己捕获**的游客身份，见 `SodaProviderConfig`。
 *    ⚠️ 不要把真实指纹提交到公开仓库。
 *
 * ## 为什么这个文件不 import electron
 *
 * 签名、加解密、URL 组装都是纯逻辑。**零 electron 依赖**带来两个实打实的好处：
 * - 可以被 `node --test` 直接驱动单测（本仓库大量守卫都要求这一点）；
 * - 主进程/未来的渲染侧 worker 都能复用，不必绑死在某一个进程里。
 *
 * ## 证据来源
 *
 * 本文件所有协议细节都来自 `restored_src` 的真实源码，不臆造：
 * - 签名链路：`src/app.ts:52-97`（拦截器）
 * - 通用参数：`src/services/request/request.ts:109-138`
 * - body 摘要：`src/utils/request.ts:134-137,184-201`（`X-SS-STUB`）
 * - 端点与方法：`src/services/request/methods.ts:89,91`
 * - track_v2 契约：`src/idl/goapi/contract/track.ts:87-122`
 * - 搜索契约：`src/idl/goapi/contract/search.ts:59-87`
 * - 试听 sign：`src/idl/goapi/entity/media.ts:81-92`
 * - 原生模块导出：对 `bdms.node` 二进制做字符串取证（`init` / `report` /
 *   `generateHttpSignatureHeaders` 三个符号确实存在）
 *
 * 无法从源码取证、因此**明确标注为未知**的部分见各字段注释与
 * `docs/agent/v1.5.0/SodaProvider_Report.md` §5。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface SodaProviderConfig {
  /**
   * `bdms.node` 的**绝对路径**（用户本地安装目录）。
   *
   * 为什么不写死：该模块属于第三方的私有产物，随安装包分发有版权风险，
   * 且它按 **Electron ABI** 编译 —— 版本不匹配会 `ERR_DLOPEN_FAILED`。
   * 由用户指向自己机器上的副本，是唯一稳妥的做法。
   */
  bdmsModulePath: string;

  /** 游客设备指纹（调用方自行捕获）。⚠️ 不要提交到公开仓库。 */
  deviceId: string;
  installId: string;
  /** 目标客户端里对应的 `device_token`（若抓包里有就带上） */
  deviceToken?: string;

  /**
   * 【实验性】用户自己的登录 Cookie（原样字符串，如 `sessionid=...; sessionid_ss=...`）。
   *
   * 未提供时 = 匿名态：VIP 曲目只能走 30 秒试听。
   * 提供后是否真能播完整版，取决于**该 Cookie 自身的权益**——
   * 本 provider 不做任何提权。
   */
  cookie?: string;

  /**
   * `user-agent` 里的版本号部分。
   *
   * 源码（`src/app.ts:58`）是 `LunaPC/${APP_VERSION}(${TRON_BUILD_ID})`，
   * 但 `APP_VERSION` / `TRON_BUILD_ID` 是构建期注入的常量，
   * **restored_src 里没有它们的值**。因此这里必须由调用方提供。
   */
  clientUserAgent?: string;

  /** 请求超时（ms）。 */
  timeoutMs?: number;

  /** 诊断日志出口；默认丢弃，避免污染主进程日志。 */
  logger?: (message: string, detail?: unknown) => void;
}

/**
 * 默认客户端的骨架参数。
 *
 * ⚠️ **只有能取证的部分才写默认值**：
 * - `app_name` / `device_platform` / `region` 等取自 `request.ts:109-138`，是**确定的**；
 * - `aid` / `version_name` / `version_code` / `channel` / `build_mode` 是构建期常量，
 *   **源码里取不到值**，这里留空并由调用方补。留空不是偷懒，
 *   而是**不编造**——编一个错的 appid 只会让签名一直失败且难排查。
 */
const DEFAULT_APP_NAME = 'luna_pc';

/* ------------------------------------------------------------------ *
 * 原生模块契约
 * ------------------------------------------------------------------ */

/** `bdms.node` 暴露的、本 provider 真正用到的能力。 */
interface BdmsModule {
  /** 初始化；源码 `afterReady.ts:164` 只传了 `deviceId`。 */
  init(options: { deviceId: string }): void;
  /**
   * 生成 HTTP 签名头。
   *
   * ⚠️ **第二个参数是字符串，不是 headers 对象** —— 这是本任务里最容易搞错的一点：
   * 源码 `app.ts:69` 传的是 `headerLines.join('\r\n')`，
   * 其中每行本身由 `${key}\r\n${value}` 组成。
   * 返回值同样是 `\r\n` 分隔的 **key/value 交替序列**（见 `parseSignatureHeaders`）。
   */
  generateHttpSignatureHeaders(url: string, headerLines: string): string;
  /** 埋点上报；缺失时忽略。 */
  report?(scene: string): void;
}

/* ------------------------------------------------------------------ *
 * 对外数据类型
 * ------------------------------------------------------------------ */

/** 一个音源曲目（已归一化，供 YanMusic 侧映射成 `Song`）。 */
export interface SodaTrack {
  /** 平台曲目 id（字符串，避免大整数精度丢失） */
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  /** 秒 */
  duration?: number;
  /** 平台侧的 VIP/付费标记（仅用于 UI 提示，不作为可播性硬判据） */
  vip?: boolean;
}

/** 取链结果：要么拿到流地址，要么明确告诉调用方「为什么没有」。 */
export type SodaPlayResult =
  | {
      ok: true;
      url: string;
      /** `true` 表示这是 30 秒试听片段（未登录 / 无权益时的正常降级） */
      isPreview: boolean;
      /** 服务端给的绝对过期时间（毫秒时间戳），若上游提供 */
      expireAt?: number;
      /** 实际命中的音质标识（诊断用） */
      quality?: string;
    }
  | {
      ok: false;
      /**
       * - `not-configured`：没配 bdms 路径 / 指纹
       * - `need-login`：需要 VIP，且当前没有可用 Cookie
       * - `unavailable`：平台明确不给（下架/无版权）
       * - `network`：请求或签名失败
       */
      reason: 'not-configured' | 'need-login' | 'unavailable' | 'network';
      message: string;
    };

/* ------------------------------------------------------------------ *
 * 纯函数（可单测）
 * ------------------------------------------------------------------ */

/**
 * 把多值 headers 展平成 `bdms` 需要的多行字符串。
 *
 * 与源码 `app.ts:60-66` **逐字对齐**：每个 header 的每个值都占两行
 * （先 key 再 value），最后整体用 `\r\n` 连接。
 */
export const buildHeaderLines = (headers: Record<string, string[]>): string => {
  const lines: string[] = [];
  for (const [key, values] of Object.entries(headers)) {
    for (const value of values) {
      lines.push(`${key}\r\n${value}`);
    }
  }
  return lines.join('\r\n');
};

/**
 * 解析 `generateHttpSignatureHeaders` 的返回值。
 *
 * 源码 `app.ts:70-75` 的形态是：按 `\r\n` 切成数组、丢掉空项，
 * 然后**每两个元素**当作一对 `[名字, 值]`。
 * 因此这里必须校验数组长度为偶数 —— 奇数说明原生模块行为变了，
 * **应当显式失败**，而不是悄悄丢最后一项导致签名残缺。
 */
export const parseSignatureHeaders = (
  raw: string,
): { ok: true; headers: Record<string, string> } | { ok: false; message: string } => {
  const parts = String(raw ?? '')
    .split('\r\n')
    .filter((t) => t.trim());
  if (parts.length === 0) return { ok: false, message: '签名模块返回空结果' };
  if (parts.length % 2 !== 0) {
    return {
      ok: false,
      message: `签名结果不是成对的 key/value（${parts.length} 项，应为偶数）`,
    };
  }
  const headers: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 2) {
    headers[parts[i]] = parts[i + 1];
  }
  return { ok: true, headers };
};

/**
 * 计算 `X-SS-STUB`：请求体 MD5 的**大写**十六进制。
 *
 * 证据：`src/utils/request.ts:134-137`（`digest('hex').toUpperCase()`）
 * 与 `:183-201`（读取 body 时边读边算）。
 * 注意它**只对非空 body 生效**：GET/无 body 的请求不加这个头。
 */
export const computeSsStub = (body: string | null | undefined): string | null => {
  if (!body) return null;
  return createHash('md5').update(body, 'utf8').digest('hex').toUpperCase();
};

/**
 * 从 `track_player.url_player_info` 里尽力取出播放地址。
 *
 * ## ⚠️ 这里是本文件**唯一的关键未知**
 *
 * `media.PlayerInfo`（`entity/media.ts:257-265`）只有
 * `url_player_info?: string` 这一个字符串字段，**没有解析它的代码**在
 * restored_src 里（`src/services/player` 目录基本是空的，
 * 承载 `PlayablePlayInfo` 的 `player/v4/engine` 缺失）。
 *
 * 因此本函数**不臆造字段名**，而是：
 * 1. 若该字符串是 JSON，就递归找「看起来像 http(s) 媒体地址」的字符串；
 * 2. 若它本身就是 URL，直接返回；
 * 3. 都失败则返回 `null`，由上层记录**原始片段**便于定位。
 *
 * 这样在字段名猜错时，行为是「明确报错 + 留下证据」，而不是静默放不出声。
 */
export const extractUrlFromPlayerInfo = (
  urlPlayerInfo: unknown,
): { url: string; expireAt?: number } | null => {
  const looksLikeMediaUrl = (value: string): boolean => /^https?:\/\//i.test(value);

  if (typeof urlPlayerInfo === 'string') {
    const trimmed = urlPlayerInfo.trim();
    if (!trimmed) return null;
    if (looksLikeMediaUrl(trimmed)) return { url: trimmed };

    // 尝试当 JSON 解析（上游常把结构化信息塞进字符串里）
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return extractUrlFromPlayerInfo(parsed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(urlPlayerInfo)) {
    for (const item of urlPlayerInfo) {
      const hit = extractUrlFromPlayerInfo(item);
      if (hit) return hit;
    }
    return null;
  }

  if (urlPlayerInfo && typeof urlPlayerInfo === 'object') {
    const record = urlPlayerInfo as Record<string, unknown>;

    // 优先取常见字段名；取不到再递归兜底。
    // ⚠️ 这些字段名是「候选」而不是「已知契约」，故必须有递归兜底。
    for (const key of ['url', 'main_url', 'play_url', 'backup_url', 'src']) {
      const value = record[key];
      if (typeof value === 'string' && looksLikeMediaUrl(value)) {
        const expireAt =
          typeof record['expire_at'] === 'number' ? record['expire_at'] * 1000 : undefined;
        return { url: value, expireAt };
      }
    }
    for (const value of Object.values(record)) {
      const hit = extractUrlFromPlayerInfo(value);
      if (hit) return hit;
    }
    return null;
  }

  return null;
};

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export class SodaProvider {
  private readonly config: SodaProviderConfig;
  private bdms: BdmsModule | null = null;
  private initError: string | null = null;

  constructor(config: SodaProviderConfig) {
    this.config = config;
  }

  /* ---------------- ① 初始化 ---------------- */

  /**
   * 加载并注册原生签名模块。
   *
   * ## 为什么用 `createRequire` 而不是 `import`
   *
   * `.node` 是 CJS 原生插件，**不能**用 ESM `import` 静态引入
   * （打包器会试图分析它、且路径是运行期才确定的）。
   * `createRequire` 拿到 `require` 后按**绝对路径**加载，才符合
   * 「用户本地动态加载」的要求。
   *
   * ## 常见失败与判据
   *
   * - `MODULE_NOT_FOUND`：路径写错；
   * - `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` 不匹配：
   *   该 `.node` 是按**另一个 Electron ABI** 编译的。
   *   这时**不要**尝试自己重编（那等于二次分发），
   *   而是要求用户在**与目标客户端同版本的 Electron** 下运行，
   *   或改用目标客户端自带的 `bdms` 桥接。
   */
  public async init(): Promise<void> {
    if (this.bdms) return;

    const { bdmsModulePath, deviceId } = this.config;
    if (!bdmsModulePath) {
      this.initError = '未配置 bdms.node 路径';
      throw new Error(this.initError);
    }
    if (!deviceId) {
      this.initError = '未配置设备指纹 deviceId';
      throw new Error(this.initError);
    }

    let loaded: BdmsModule;
    try {
      // 延迟到 init 才 require：避免模块加载期就因路径不存在而崩主进程
      const requireFn = createRequire(import.meta.url);
      loaded = requireFn(bdmsModulePath) as BdmsModule;
    } catch (error) {
      this.initError = `加载 bdms.node 失败：${toMessage(error)}`;
      throw new Error(this.initError);
    }

    if (typeof loaded?.generateHttpSignatureHeaders !== 'function') {
      this.initError = 'bdms.node 未导出 generateHttpSignatureHeaders';
      throw new Error(this.initError);
    }

    loaded.init({ deviceId });
    this.bdms = loaded;
    this.initError = null;
    this.log('bdms 初始化完成', { deviceId });
  }

  /* ---------------- ② 搜索 ---------------- */

  /**
   * 搜索歌曲。
   *
   * ## 端点与方法的实测修正（与需求描述不同，务必看）
   *
   * 需求里写的是 `POST /luna/pc/search`，但源码证据是：
   * - `src/services/request/methods.ts:91` → `Search: { method: 'GET' }`
   * - `src/idl/goapi/main.ts:3030` → `GET /luna/pc/search/${search_type}`
   *
   * 也就是说**真实请求是 GET，且路径带 `search_type` 段**。
   * `apiCaller` 的挑选顺序（`request.ts:31-33`）先找 `/luna/pc/` 且方法匹配者，
   * 对 GET 正好命中 `/luna/pc/search/${search_type}`。
   *
   * 因此这里按 **GET + query** 实现。若按需求写的 POST 去打，
   * 只会得到一个不认参数的结果，而**不会**报「方法错」——极难排查。
   */
  public async search(keyword: string, searchType = 'song'): Promise<SodaTrack[]> {
    const q = String(keyword ?? '').trim();
    if (!q) return [];

    const url = `${SODA_API_BASE}/luna/pc/search/${encodeURIComponent(searchType)}`;
    const query: Record<string, string> = {
      // 契约字段见 `contract/search.ts:59-73`
      q,
      cursor: '0',
      search_id: '',
      search_method: '',
      debug_params: '',
      from_search_id: '',
      search_scene: '',
    };

    const response = await this.request<{ status_code?: number; result_groups?: unknown[] }>({
      method: 'GET',
      url,
      query,
    });

    // `status_code` 非 0 视为业务失败；0 或缺省视为成功
    if (typeof response.status_code === 'number' && response.status_code !== 0) {
      throw new Error(`搜索失败，status_code=${response.status_code}`);
    }

    return parseSearchResultGroups(response.result_groups);
  }

  /* ---------------- ③ 取播放地址 ---------------- */

  /**
   * 取播放地址（核心）。
   *
   * ## 流程
   *
   * 1. 直接请求 `POST /luna/pc/track_v2`（body 见 `buildTrackV2Body`）；
   * 2. 成功 → 解析 `track_player.url_player_info` 拿 URL；
   * 3. **拿不到 / 判定为受限** → 走试听降级：先 `POST /luna/track/mcheck`
   *    取 `limited_free_info.sign`，再带上 `limited_free_param` 重试 track_v2；
   * 4. 仍未拿到 → 返回结构化失败（`need-login` / `unavailable`），
   *    **不抛异常** —— 上层需要区分「这首不能放」和「接口挂了」。
   *
   * ⚠️ `LimitedFreeParam` 的精确结构在 restored_src 中**缺失**
   * （`entity/common.ts` 不存在）。本实现采用「把服务端给的
   * `limited_free_info` 里除纯响应字段外的东西原样带回」的保守策略，
   * 详见 `buildLimitedFreeParam` 的注释。
   */
  public async getPlayUrl(trackId: string, quality = 'standard'): Promise<SodaPlayResult> {
    if (!this.bdms) {
      return {
        ok: false,
        reason: 'not-configured',
        message: this.initError ?? '请先调用 init() 并配置 bdms.node 路径',
      };
    }
    const id = String(trackId ?? '').trim();
    if (!id) return { ok: false, reason: 'unavailable', message: '缺少 trackId' };

    // ① 正常请求
    const first = await this.requestTrack(id, quality);
    if (first) return first;

    // ② 降级：30 秒试听。
    // 这是平台自身的「未登录/无权益可听 30 秒」能力，不是绕过。
    try {
      const limitedFreeParam = await this.fetchLimitedFreeParam(id);
      if (!limitedFreeParam) {
        return {
          ok: false,
          reason: this.config.cookie ? 'unavailable' : 'need-login',
          message: this.config.cookie
            ? '平台未提供该曲目的播放地址（可能已下架或无版权）'
            : '该曲目需要 VIP/购买；未配置登录 Cookie，且平台未提供试听',
        };
      }
      const preview = await this.requestTrack(id, quality, limitedFreeParam);
      if (preview) return preview;
    } catch (error) {
      this.log('试听降级失败', { trackId: id, error: toMessage(error) });
    }

    return {
      ok: false,
      reason: this.config.cookie ? 'unavailable' : 'need-login',
      message: this.config.cookie
        ? '已登录但仍未取得播放地址（该 Cookie 可能无此曲权益）'
        : '该曲目需要 VIP/购买；未配置登录 Cookie',
    };
  }

  /* ---------------- 内部：单次 track_v2 ---------------- */

  private async requestTrack(
    trackId: string,
    quality: string,
    limitedFreeParam?: Record<string, unknown>,
  ): Promise<SodaPlayResult | null> {
    const body: Record<string, unknown> = {
      track_id: trackId,
      // 契约（`contract/track.ts:87-97`）：这两个是必填
      media_type: 'audio',
      queue_type: 'default',
    };
    if (limitedFreeParam) body.limited_free_param = limitedFreeParam;

    let payload: {
      status_code?: number;
      track_player?: { url_player_info?: unknown };
      expire_at?: number;
    };
    try {
      payload = await this.request({
        method: 'POST',
        url: `${SODA_API_BASE}/luna/pc/track_v2`,
        body,
      });
    } catch (error) {
      const message = toMessage(error);
      // 403 是最典型的「需要权益」信号
      if (/status:\s*403/.test(message)) return null;
      throw error;
    }

    const statusCode = payload?.status_code;
    if (typeof statusCode === 'number' && statusCode !== 0) {
      // 非 0 = 业务失败，交给上层决定是否降级
      this.log('track_v2 业务失败', { trackId, statusCode });
      return null;
    }

    const hit = extractUrlFromPlayerInfo(payload?.track_player?.url_player_info);
    if (!hit) {
      this.log('track_v2 未解析出 URL', {
        trackId,
        // 只记片段，避免日志爆炸；同时留下定位证据
        raw: JSON.stringify(payload?.track_player ?? null).slice(0, 400),
      });
      return null;
    }

    return {
      ok: true,
      url: hit.url,
      isPreview: Boolean(limitedFreeParam),
      expireAt:
        hit.expireAt ??
        (typeof payload?.expire_at === 'number' ? payload.expire_at * 1000 : undefined),
      quality,
    };
  }

  /* ---------------- 内部：试听 sign ---------------- */

  /**
   * 取试听所需的 `limited_free_param`。
   *
   * 证据链：
   * 1. `POST /luna/track/mcheck`（`main.ts:2652`），body `{ track_ids, scene }`
   *    （`contract/track.ts:123-133`）；
   * 2. 响应 `track_status[].limited_free_info`（`contract/track.ts:165`）；
   * 3. `LimitedFreeInfo`（`entity/media.ts:81-92`）含
   *    `sign` / `sign_version` / `expire_time` / `limited_free` /
   *    `limited_free_type` / `queue_types` / `rewind_prev_intercept_type`。
   *
   * ⚠️ 第 4 步「把这些塞进 `limited_free_param`」的确切结构**无法取证**
   * （`entity/common.ts` 缺失）。这里只回填**看起来是请求参数**的字段，
   * 并显式说明这是**待验证的推断**；若实际字段不同，
   * 上层会走到 `need-login`，不会静默出错。
   */
  private async fetchLimitedFreeParam(trackId: string): Promise<Record<string, unknown> | null> {
    const payload = await this.request<{ status_code?: number; track_status?: unknown[] }>({
      method: 'POST',
      url: `${SODA_API_BASE}/luna/track/mcheck`,
      body: { track_ids: [trackId] },
    });

    const list = Array.isArray(payload?.track_status) ? payload.track_status : [];
    const status = list[0] as Record<string, unknown> | undefined;
    const info = status?.['limited_free_info'] as Record<string, unknown> | undefined;
    if (!info || info['limited_free'] !== true) return null;

    return buildLimitedFreeParam(info);
  }

  /* ---------------- 内部：HTTP（含签名） ---------------- */

  private async request<T>(options: {
    method: 'GET' | 'POST';
    url: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<T> {
    const bdms = this.bdms;
    if (!bdms) throw new Error('bdms 未初始化');

    const url = new URL(options.url);
    // ① 注入 TT 通用参数 + fp（`request.ts:151-169` 的顺序：通用参数在前）
    const queryParams: Record<string, string> = {
      ...this.getTTCommonParams(),
      fp: this.config.deviceId ?? '',
      ...(options.query ?? {}),
    };
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }

    // ② 组装 headers（多值形态，因为签名接口吃的是「多行」）
    const headers: Record<string, string[]> = {
      'user-agent': [this.getUserAgent()],
      'x-luna-is-local-user': [this.config.cookie ? '1' : '0'],
    };
    if (this.config.cookie) headers['cookie'] = [this.config.cookie];

    let bodyText: string | undefined;
    if (options.method !== 'GET' && options.body) {
      bodyText = JSON.stringify(options.body);
      headers['content-type'] = ['application/json; charset=utf-8'];
      // ③ body 摘要头（`utils/request.ts:134-137`）；必须在签名**之前**加
      const stub = computeSsStub(bodyText);
      if (stub) headers['X-SS-STUB'] = [stub];
    }

    // ④ 签名（`app.ts:60-75`）
    const signed = this.signHeaders(url.toString(), headers);

    // ⑤ 发请求
    const flat: Record<string, string> = {};
    for (const [key, values] of Object.entries(signed)) flat[key] = values[0] ?? '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: flat,
        body: bodyText,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`request (${options.url}) failed with status: ${response.status}`);
      }
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 调用原生模块生成签名头，并与原 headers 合并。
   *
   * 与源码 `app.ts:52-76` 对齐；失败时抛错而**不**返回未签名请求 ——
   * 未签名的请求在服务端看来就是非法流量，静默发出只会得到莫名的空结果。
   */
  private signHeaders(url: string, headers: Record<string, string[]>): Record<string, string[]> {
    const bdms = this.bdms;
    if (!bdms) throw new Error('bdms 未初始化');

    const raw = bdms.generateHttpSignatureHeaders(url, buildHeaderLines(headers));
    const parsed = parseSignatureHeaders(raw);
    if (!parsed.ok) throw new Error(`签名解析失败：${parsed.message}`);

    const merged: Record<string, string[]> = { ...headers };
    for (const [key, value] of Object.entries(parsed.headers)) {
      merged[key] = [value];
    }
    return merged;
  }

  private getUserAgent(): string {
    // 源码里是 `LunaPC/${APP_VERSION}(${TRON_BUILD_ID})`（`app.ts:58`）。
    // 构建期常量取不到值 ⇒ 由调用方给；没给就用一个明显「需要补配」的形态。
    return this.config.clientUserAgent ?? 'LunaPC/0.0.0(0)';
  }

  /**
   * TT 通用参数（`request.ts:109-138`）。
   *
   * 能取证的字段照抄；**构建期常量留空并由调用方通过 `deviceToken` 等补**
   * —— 宁可少传，也不编造。
   */
  private getTTCommonParams(): Record<string, string> {
    return {
      app_name: DEFAULT_APP_NAME,
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: this.config.deviceId ?? '',
      cdid: '',
      iid: this.config.installId ?? '',
      channel: '',
      build_mode: '',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: '',
    };
  }

  private log(message: string, detail?: unknown): void {
    this.config.logger?.(message, detail);
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

const SODA_API_BASE = 'https://api.qishui.com';

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `LimitedFreeInfo` → `limited_free_param` 的**保守**回填。
 *
 * ⚠️ 明确标注：`common.LimitedFreeParam` 的定义在 restored_src 中缺失，
 * 因此下面的字段选择是**推断**。只带「明显是请求参数」的字段，
 * 不带 `config` / `intercept_type` 这类纯响应字段。
 * 若线上字段名不同，行为是降级到 `need-login`，不会静默出错。
 */
export const buildLimitedFreeParam = (
  limitedFreeInfo: Record<string, unknown>,
): Record<string, unknown> | null => {
  const sign = limitedFreeInfo['sign'];
  if (typeof sign !== 'string' || !sign) return null;

  const param: Record<string, unknown> = {
    sign,
    sign_version: limitedFreeInfo['sign_version'],
  };
  if (limitedFreeInfo['expire_time'] !== undefined) {
    param.expire_time = limitedFreeInfo['expire_time'];
  }
  if (limitedFreeInfo['limited_free_type'] !== undefined) {
    param.limited_free_type = limitedFreeInfo['limited_free_type'];
  }
  if (limitedFreeInfo['queue_types'] !== undefined) {
    param.queue_types = limitedFreeInfo['queue_types'];
  }
  return param;
};

/**
 * 把 `SearchResponse.result_groups` 拍平成曲目数组。
 *
 * `entity/search.ts` 缺失，所以**不假设**组内结构：
 * 递归扫描，凡是带 `id` 且带名字的对象就当一条曲目。
 * 这样即使字段名与预期不同（如 `title` vs `name`），也能尽量捞出来，
 * 且不会因为某个字段缺失就整批失败。
 */
export const parseSearchResultGroups = (groups: unknown): SodaTrack[] => {
  const out: SodaTrack[] = [];
  const seen = new Set<string>();

  const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const id = pickString(record, ['id', 'track_id', 'trackId']);
    const title = pickString(record, ['title', 'name', 'track_name']);

    if (id && title && !seen.has(id)) {
      seen.add(id);
      const durationRaw = record['duration'] ?? record['duration_ms'] ?? record['dt'];
      const durationMs = typeof durationRaw === 'number' ? durationRaw : undefined;
      out.push({
        id,
        title,
        artist: pickString(record, ['artist', 'artist_name', 'singer', 'author']) ?? '未知歌手',
        album: pickString(record, ['album', 'album_name']),
        coverUrl: pickString(record, ['cover_url', 'cover', 'pic', 'pic_url']),
        // ⚠️ 单位不确定：`duration` 可能是秒也可能是毫秒。
        // 大于 1000 一律按毫秒处理（1000 秒以上的单曲几乎不存在）。
        duration:
          durationMs === undefined
            ? undefined
            : durationMs > 1000
              ? Math.round(durationMs / 1000)
              : durationMs,
        vip: false,
      });
      return;
    }

    for (const value of Object.values(record)) walk(value);
  };

  walk(groups);
  return out;
};
