import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 图片替代文本守卫。
 *
 * 背景（1.2.1 审计发现 `N-03`）：全渲染层共 13 个 `<img>` 标签，其中 2 个缺少 `alt`——
 * `views/lyric/LyricPage.vue` 与 `views/lyric/PortraitMode.vue` 的封面模糊背景层。
 * 二者都是**纯装饰**图片，缺少 `alt` 时部分读屏器会退化为朗读 `src` 路径，
 * 正确处置是显式 `alt=""`（WCAG 2.1 1.1.1 对装饰性图片的要求）。
 *
 * 本守卫把「`<img>` 必须显式声明替代文本」固化为断言：有意义的图片给文案，
 * 装饰性图片给空串，但不得两者都不给。`alt=""` 与 `:alt="..."` 都算显式声明。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = path.join(repoRoot, 'src', 'renderer');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
};

const files = walk(rendererRoot);

/** 跨行标签：`[^>]*` 配合 `s` 标志，避免漏掉把属性分行书写的写法。 */
const IMG_TAG = /<img\b[^>]*>/gs;

/** `alt` / `:alt` / `v-bind:alt` 都算显式声明（属性前须有空白，防止匹配到 `data-alt`）。 */
const HAS_ALT = /(^|\s)(:|v-bind:)?alt\s*=/;

interface ImgSite {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
}

const collect = (): ImgSite[] => {
  const sites: ImgSite[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMG_TAG)) {
      const line = source.slice(0, match.index).split('\n').length;
      sites.push({
        file: path.relative(repoRoot, file).split(path.sep).join('/'),
        line,
        tag: match[0],
      });
    }
  }
  return sites;
};

const sites = collect();

test('语料非空：必须真的扫到 <img> 标签（防止正则失效导致守卫空转）', () => {
  assert.ok(sites.length > 0, '未扫到任何 <img> 标签，正则或扫描范围可能已失效');
});

test('每个 <img> 都必须显式声明替代文本（alt="" 或 :alt="..."）', () => {
  const offenders = sites
    .filter((site) => !HAS_ALT.test(site.tag))
    .map((site) => `${site.file}:${site.line}  ${site.tag.replace(/\s+/g, ' ').slice(0, 80)}`);

  assert.deepEqual(
    offenders,
    [],
    `以下 <img> 缺少 alt：装饰性图片请写 alt=""，有意义的图片请写 :alt="文案"\n${offenders.join('\n')}`,
  );
});

test('装饰性模糊背景层使用 alt=""（而非冗余文案）', () => {
  const decorative = [
    'src/renderer/views/lyric/LyricPage.vue',
    'src/renderer/views/lyric/PortraitMode.vue',
  ];

  for (const file of decorative) {
    const site = sites.find((item) => item.file === file);
    assert.ok(site, `${file} 未扫到 <img>，文件结构可能已变化`);
    assert.match(site.tag, /(^|\s)alt=""/, `${file} 的模糊背景层应为装饰性图片，需显式 alt=""`);
  }
});
