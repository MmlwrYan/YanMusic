import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 插件源包装函数的**命名债**（V4-15，v1.4.0）。
 *
 * ## 债务是什么
 *
 * `main/plugins.ts` 里曾有四个名字带 `Github` 的包装函数：
 * `toRawGithubUrl` / `toGithubArchiveUrl` / `toGithubBlobUrl` / `applyGithubProxyUrl`。
 * 名字来自「只有 GitHub 一个源」的年代。但 v1.3.1 起插件源已是**可切换的抽象**
 * （`PluginRepository` + `PLUGIN_SOURCE_PROVIDERS`，**默认 Gitee**），
 * 继续叫 Github 会让人误以为这里有 GitHub 专属逻辑 —— 排查插件源问题时
 * 很容易因此走错方向。
 *
 * ## 它们本身只是转发
 *
 * 4 个函数都是**一层转发**（真正实现是 `toRepositoryRawFileUrl` /
 * `toRepositoryArchiveUrl` / `toRepositoryBlobUrl` / `applyPluginSourceProxy`），
 * 所以重命名是纯机械的、不改行为。
 *
 * ## ⚠️ 刻意**不**改的东西
 *
 * 参数名 `githubProxyUrl` **保留原样**：它是**已持久化的用户设置键名**
 * （`pinia:setting` 里的既有字段）。改它会静默丢掉老用户的代理配置 ——
 * 命名债只还到「不误导读者看代码」这一层，**不动对外契约**。
 * 本文件同时守卫这一点（下一条用例），避免以后有人「顺手」把它也改了。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 去掉注释与字符串字面量后的源码。
 *
 * **为什么必须去注释**：本次改名的说明性注释里**逐字写了四个旧名字**
 * （「这四个曾是 `toRawGithubUrl` / …」）。若不断言前剥离注释，守卫会把
 * **正确的文档**判成违规 —— 这正是项目纪律里那条：
 * 「源码守卫必须先剥注释，否则守卫冻住的是书写习惯而不是行为」。
 *
 * 字符串字面量一并剥离：旧名字若出现在字符串里（例如日志文案），
 * 那不是「函数命名」问题，不该由本守卫管。
 */
const stripCommentsAndStrings = (source: string): string => {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'single';
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = 'double';
        i += 1;
        continue;
      }
      if (ch === '`') {
        state = 'template';
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else i += 1;
      continue;
    }
    // 字符串内部：跳过内容，遇到未转义的同类引号结束
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }
  return out;
};

const PLUGINS_TS = 'src/main/plugins.ts';

test('V4-15：四个 Github 命名的包装函数已全部改名（**已剥离注释**）', () => {
  const code = stripCommentsAndStrings(read(PLUGINS_TS));
  for (const legacy of [
    'toRawGithubUrl',
    'toGithubArchiveUrl',
    'toGithubBlobUrl',
    'applyGithubProxyUrl',
  ]) {
    assert.ok(
      !code.includes(legacy),
      `${legacy} 应已重命名为源无关的名字 —— 插件源默认已是 Gitee，名字带 Github 会误导排查方向`,
    );
  }
});

test('V4-15：新名字确实存在且指回真正的实现（不是删掉了事）', () => {
  const code = stripCommentsAndStrings(read(PLUGINS_TS));
  const expectations: Array<[string, string]> = [
    ['toRawFileUrl', 'toRepositoryRawFileUrl'],
    ['toArchiveUrl', 'toRepositoryArchiveUrl'],
    ['toBlobUrl', 'toRepositoryBlobUrl'],
    ['applySourceProxy', 'applyPluginSourceProxy'],
  ];
  for (const [neo, impl] of expectations) {
    assert.ok(new RegExp(`const ${neo} = `).test(code), `应存在 ${neo} 的定义`);
    assert.ok(code.includes(impl), `${neo} 必须转发到 ${impl}，而不是自造一份实现`);
    const occurrences = code.split(neo).length - 1;
    assert.ok(occurrences >= 2, `${neo} 至少要有一处调用（当前出现 ${occurrences} 次）`);
  }
});

/**
 * 反向守卫：**不得**把 `githubProxyUrl` 一起改名。
 *
 * 它是持久化设置键名，改名 = 静默丢配置。这条用例存在的意义是拦住
 * 「既然在还命名债，顺手都改了吧」这种看起来很合理的后续改动。
 */
test('V4-15：持久化设置键名 `githubProxyUrl` 不得被改名（对外契约）', () => {
  const code = stripCommentsAndStrings(read(PLUGINS_TS));
  assert.ok(
    code.includes('githubProxyUrl'),
    'githubProxyUrl 是已持久化的用户设置键名（pinia:setting 既有字段），' +
      '改名会静默丢掉老用户的代理配置 —— 命名债只还到源码可读性这一层，不动对外契约',
  );
});
