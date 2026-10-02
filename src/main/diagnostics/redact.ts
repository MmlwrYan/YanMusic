/**
 * S-6（v1.3.0）：诊断包导出前的**脱敏**。
 *
 * ## 为什么必须脱敏，且必须在这里做
 *
 * 诊断包是**用户主动导出、然后发给维护者**的文件 —— 它一旦离开用户机器，
 * 任何残留的凭据都是不可撤回的泄漏。而这个应用的 KV 里确实有敏感数据：
 * `pinia:user`（酷狗登录票据）、`pinia:device`（设备指纹）、
 * 网络设置里的代理凭据等（见 `main/storage/kv.ts` 的 `ENCRYPTED_KV_KEYS`
 * 与 `shared/kvEnvelope.ts`）。
 *
 * 因此本模块采取**两条互补的防线**：
 *
 * 1. **白名单**（调用侧）：诊断包**只收录明确安全的字段**，不整对象 dump
 *   —— 这是 fail-closed 的主防线，见 `bundle.ts`；
 * 2. **逐值脱敏**（本模块）：即使白名单遗漏了什么，值级规则也会再兜一层
 *   （路径、URL 查询串、长密钥、敏感键名）。
 *
 * ## 本模块是纯函数
 *
 * 零依赖（无 electron、无 IO），路径由调用方传入 —— 因此可在 `node --test`
 * 下**直接驱动真行为**，覆盖各种凭据形态。脱敏逻辑**最怕写完没验证**
 *（一个规则写错就可能把 token 原样带出去），故这里逐条做了鉴别力验证。
 */

export interface RedactContext {
  /** 用户数据目录（如 `C:\Users\x\AppData\Roaming\YanMusic`）—— 会被替换为 `<userData>` */
  userDataPath?: string;
  /** 用户主目录 —— 会被替换为 `<home>` */
  homePath?: string;
}

const REDACTED_SECRET = '<redacted-secret>';
const REDACTED_VALUE = '<redacted>';

/**
 * 键名命中即**整值丢弃**（不看值长什么样）。
 *
 * 保守到「宁可少给维护者一点信息」：诊断包的价值主要是日志与运行环境，
 * 这些键的值对排障几乎没有用，但对攻击者很有用。
 *
 * 除凭据外也覆盖**个人/设备标识**（`dfid` / `mid` / `uuid` / `guid` / `mac` 等）——
 * 它们正是 `kv.ts` 的 `ENCRYPTED_KV_KEYS` 里 `pinia:device` 的内容（v1.2.9 的 W-3
 * 认定其敏感），诊断包没有理由把它们带出用户机器。
 */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|credential|authorization|cookie|session|signature|api[_-]?key|access[_-]?key|private[_-]?key|refresh|dfid|fingerprint|device[_-]?id|user[_-]?id|userid|mid|uuid|guid)/i;

/** 长且无空格的字符串（base64/hex 样）—— 极可能就是密钥或签名。 */
const looksLikeSecret = (value: string): boolean => {
  if (value.length < 32) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=_.:-]+$/.test(value);
};

/** 把 URL 收敛成 `scheme://host`，丢弃 path/query/hash（query 里常带 token）。 */
const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
};

/** 判断一个字符串整体是否就是个 URL（用于先做 URL 专项收敛）。 */
const isLikelyUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * 字符串脱敏。**顺序重要**：先做 URL 收敛（否则 `?token=` 会被后面的
 * 「长密钥」规则漏掉，因为它带 `=` 与 `&` 而整体长度可能不足 32）。
 */
export const redactString = (value: string, context: RedactContext = {}): string => {
  let result = value;

  // 1) 路径前缀替换（Windows 反斜杠与正斜杠都要覆盖）
  const { userDataPath, homePath } = context;
  const replaceAll = (input: string, needle: string, replacement: string): string => {
    if (!needle) return input;
    const variants = [needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')];
    let output = input;
    for (const variant of new Set(variants)) {
      if (!variant) continue;
      output = output.split(variant).join(replacement);
    }
    return output;
  };

  if (userDataPath) result = replaceAll(result, userDataPath, '<userData>');
  if (homePath) result = replaceAll(result, homePath, '<home>');

  // 2) URL 收敛（整串是 URL 的情况）
  if (isLikelyUrl(result)) result = redactUrl(result);

  // 3) 长密钥样字符串整体遮蔽
  if (looksLikeSecret(result)) return REDACTED_SECRET;

  return result;
};

/**
 * 递归脱敏任意值。
 *
 * - 命中敏感**键名** → 整值替换为 `<redacted>`（键名保留，便于维护者知道「这里有个 token 配置」）
 * - 字符串 → 走 {@link redactString}
 * - 数组/对象 → 递归（限制深度，避免循环引用或超深结构拖垮导出）
 */
export const redactValue = (value: unknown, context: RedactContext = {}, depth = 0): unknown => {
  if (depth > 6) return '<max-depth>';

  if (typeof value === 'string') return redactString(value, context);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactValue(item, context, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = REDACTED_VALUE;
        continue;
      }
      output[key] = redactValue(item, context, depth + 1);
    }
    return output;
  }

  // 函数 / symbol 等不可序列化类型：不导出（避免 JSON.stringify 变成 undefined 造成歧义）
  return null;
};

/** 供测试与调用方复用，避免两处字面量不一致。 */
export const REDACTED_MARKERS = {
  secret: REDACTED_SECRET,
  value: REDACTED_VALUE,
} as const;
