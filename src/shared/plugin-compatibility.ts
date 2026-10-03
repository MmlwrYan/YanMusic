/**
 * 插件清单「主程序版本要求」的解析与判定规则（纯函数，可在 node 下直接单测）。
 *
 * 背景：本项目由上游 EchoMusic 二次开发而来，插件清单里并存两个版本要求键：
 *
 * - `requires.echoMusicVersion` —— **上游旧键**，取值是 **EchoMusic 的 2.x 版本号**
 *   （如 `>=2.2.6-beta.9`、`>=2.3.2-beta.7`）；
 * - `requires.yanmusicVersion` —— **本项目自有键**，取值是 **本项目的 1.x 版本号**
 *   （如 `>=1.3.3`）。
 *
 * 两套版本号**不是同一套编号体系**，互相比较没有意义：
 * 本项目版本 `1.3.2` 拿 semver 去判定 `>=2.2.6-beta.9` **恒为 false**，
 * 结果是**全部继承自上游的插件**都被判成「版本不兼容」（实测 13/13）。
 * 而该判定同时是**安装与插件窗口打开的硬门禁**，后果远大于一句提示。
 *
 * 因此本模块把规则固定下来：
 * 1. 旧键（EchoMusic 编号）**只作参考记录，不参与判定**；
 * 2. 只有自有键（同一套编号）才做 semver 比较；
 * 3. 格式校验同样只针对自有键 —— 旧键既已不参与判定，格式怪异也不应拦人。
 */

import {
  coerce as semverCoerce,
  valid as semverValid,
  validRange as semverValidRange,
} from 'semver';

/** 版本要求的来源键。 */
export type PluginVersionRequirementSource = 'yanmusic' | 'echomusic';

/** 清单里一条版本要求的原始取值与来源。 */
export interface PluginVersionRequirement {
  /** 清单里写的原文（未经解析）。 */
  value: unknown;
  source: PluginVersionRequirementSource;
}

/** 裸版本号（无比较运算符）的形态，如 `1.3.3`、`v2.2.6-beta.9`。 */
export const BARE_SEMVER_PATTERN = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const hasText = (value: unknown) =>
  value !== undefined && value !== null && String(value).trim() !== '';

/**
 * 读取插件清单的主程序版本要求。
 *
 * 优先本项目自有键 `yanmusicVersion`；缺失或为空时回退上游旧键 `echoMusicVersion`。
 * 两者都没有（或 `requires` 不是对象）时返回 `null`，表示该插件不设版本门槛。
 */
export const readPluginVersionRequirement = (
  requires: unknown,
): PluginVersionRequirement | null => {
  if (!requires || typeof requires !== 'object') return null;
  const record = requires as { yanmusicVersion?: unknown; echoMusicVersion?: unknown };

  if (hasText(record.yanmusicVersion)) {
    return { value: record.yanmusicVersion, source: 'yanmusic' };
  }
  if (hasText(record.echoMusicVersion)) {
    return { value: record.echoMusicVersion, source: 'echomusic' };
  }
  return null;
};

/**
 * 该来源的版本要求是否参与 semver 兼容判定。
 *
 * **旧键恒为 `false`** —— 它写的是 EchoMusic 的 2.x 编号，与本项目 1.x 不可比。
 */
export const shouldEnforcePluginVersionRequirement = (
  source: PluginVersionRequirementSource,
): boolean => source === 'yanmusic';

/**
 * 规范化版本要求为 semver 范围。
 * 裸版本号（`1.3.3`）按 `>=1.3.3` 处理；其余交给 `semver.validRange`。
 */
export const normalizePluginVersionRange = (value: unknown): { range: string; error: string } => {
  const text = String(value ?? '').trim();
  if (!text) return { range: '', error: '' };

  if (BARE_SEMVER_PATTERN.test(text)) {
    const version = semverValid(text) ?? semverCoerce(text)?.version;
    return version
      ? { range: `>=${version}`, error: '' }
      : { range: '', error: `主程序版本要求无效: ${text}` };
  }

  const range = semverValidRange(text);
  if (!range) return { range: '', error: `主程序版本范围无效: ${text}` };
  return { range, error: '' };
};
