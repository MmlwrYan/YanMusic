import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 听歌档案页面（/main/journal）主题回归守卫。
 *
 * 复现的缺陷（用户可见症状：整页被灰/白半透明遮罩覆盖、文字对比度极低）：
 *   `src/renderer/views/MusicJournal.vue` 使用了两个**全仓从未定义**的 CSS 变量
 *   —— `--text-primary`（真实令牌是 `--text-main`）与 `--accent`（真实令牌是 `--color-primary`），
 *   于是回退到为深色背景写死的近白色 `#e8e8ea`；而应用默认主题是浅色
 *   （`src/main/storage/settings.ts` 默认 `theme: 'system'`，`style.css:5-105` 的 `:root`
 *   是浅色令牌：`--surface-main-base: #f5f5f7`、`--text-main: #1d1d1f`）。
 *   近白文字压在浅灰底上 → 对比度约 1.05（远低于 WCAG AA 的 4.5）。
 *   同时页面里大量 `rgb(255 255 255 / n%)` / `rgb(0 0 0 / n%)` 半透明面板在浅色主题下
 *   表现为一层白/灰雾，即用户看到的「整页遮罩」。
 *
 * 本测试用「解析真实 CSS 令牌 → 计算 WCAG 对比度」的方式把该症状变成可自动复现的断言，
 * 无需启动 GUI。同时守卫两类回归：变量名再次写错、以及「近似基线虚线柱」这一设计特性被误删。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styleSource = readFileSync(path.join(repoRoot, 'src', 'renderer', 'style.css'), 'utf8');
const viewSource = readFileSync(
  path.join(repoRoot, 'src', 'renderer', 'views', 'MusicJournal.vue'),
  'utf8',
);

/** 取出 Vue 单文件组件里的 <style> 块。 */
const extractStyleBlock = (source: string): string => {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  assert.ok(match, 'MusicJournal.vue 未找到 <style> 块');
  return match[1];
};

const viewStyle = extractStyleBlock(viewSource);

/** 解析某段 CSS 里定义的自定义属性（`--x: value;`）。 */
const collectCustomProperties = (css: string): Map<string, string> => {
  const map = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of css.matchAll(pattern)) {
    map.set(match[1], match[2].trim());
  }
  return map;
};

/**
 * 截取某个顶层选择器块的内容。
 * 必须把选择器**锚定到行首**：style.css 第 3 行的 Tailwind 指令
 * `@custom-variant dark (&:where(.dark, .dark *));` 里也含 `.dark` 子串，
 * 用朴素 indexOf 会先命中它并把 `:root` 块误当成 `.dark` 块。
 */
const extractBlock = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchored = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{`);
  const match = anchored.exec(css);
  assert.ok(match, `未找到顶层选择器块 ${selector}`);
  const open = css.indexOf('{', match.index);
  let depth = 0;
  let index = open;
  for (; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(open + 1, index);
};

const rootTokens = collectCustomProperties(extractBlock(styleSource, ':root'));
const darkTokens = collectCustomProperties(extractBlock(styleSource, '.dark'));
const viewTokens = collectCustomProperties(viewStyle);
/**
 * 「变量是否被定义过」的全集：取**整个 style.css**（而不仅是 :root/.dark）。
 * 因为部分令牌定义在其它顶层块里（例如 `--color-primary` 定义于
 * `body.accent-scoped .main-layout`，并由运行时 accent 注入 —— 见 `color.ts` 的
 * `applyAccentToRoot`），只查 :root/.dark 会误报。
 * 而本次缺陷的 `--text-primary` / `--accent` 在整个样式表里**从未定义**，
 * 因此放宽全集后依然能抓到。
 */
const stylesheetTokens = collectCustomProperties(styleSource);
const allDefined = new Set([...stylesheetTokens.keys(), ...viewTokens.keys()]);

/** 取到字面颜色（沿 var() 链解析；遇到 color-mix 等无法静态求值的表达式返回 null）。 */
const resolveColor = (value: string, tokens: Map<string, string>, depth = 0): string | null => {
  const trimmed = value.trim();
  if (depth > 6) return null;
  const varMatch = trimmed.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/i);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    const next = tokens.get(name) ?? rootTokens.get(name) ?? darkTokens.get(name);
    if (next) return resolveColor(next, tokens, depth + 1);
    return fallback ? resolveColor(fallback, tokens, depth + 1) : null;
  }
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) || /^rgba?\(/i.test(trimmed) ? trimmed : null;
};

/** 解析 #rgb / #rrggbb / rgb() / rgba() 为 [r,g,b]。 */
const parseColor = (value: string): [number, number, number] => {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? raw
            .split('')
            .map((c) => c + c)
            .join('')
        : raw;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  assert.ok(rgb, `无法解析颜色：${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
};

/** WCAG 2.x 相对亮度。 */
const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (
  foreground: [number, number, number],
  background: [number, number, number],
) => {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
};

const journalPageColor = (() => {
  const block = extractBlock(viewStyle, '.journal-page');
  const match = block.match(/(?:^|\s)color\s*:\s*([^;]+);/);
  assert.ok(match, '.journal-page 未声明 color');
  return match[1].trim();
})();

test('页面根元素的文字颜色只使用已定义的主题令牌（防止 var() 回退到写死颜色）', () => {
  const undeclared = [...viewStyle.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)]
    .map((match) => match[1])
    .filter((name) => !allDefined.has(name));
  assert.deepEqual(
    [...new Set(undeclared)],
    [],
    '视图引用了 style.css 未定义的 CSS 变量，会导致 var() 回退到硬编码颜色',
  );
});

test('浅色主题下主标题对比度达到 WCAG AA（≥ 4.5）', () => {
  const pageBackground = resolveColor('var(--surface-main-base)', rootTokens);
  assert.ok(pageBackground, '未取到 --surface-main-base');
  const textColor = resolveColor(journalPageColor, rootTokens);
  assert.ok(
    textColor,
    `页面文字颜色无法解析为字面颜色（当前声明：${journalPageColor}）；请改用 --text-main 一类的主题令牌`,
  );

  const pageForeground = parseColor(textColor);
  const pageBackdrop = parseColor(pageBackground);
  const ratio = contrastRatio(pageForeground, pageBackdrop);

  assert.ok(
    ratio >= 4.5,
    `文字 ${textColor} 在页面底色 ${pageBackground} 上的对比度为 ${ratio.toFixed(2)}，低于 4.5`,
  );
});

test('深色主题下同一声明同样达到 WCAG AA（令牌需在 .dark 中被覆盖）', () => {
  const merged = new Map([...rootTokens, ...darkTokens]);
  const backdrop = resolveColor('var(--surface-main-base)', merged);
  const text = resolveColor(journalPageColor, merged);
  assert.ok(backdrop && text, '深色主题令牌解析失败');
  const ratio = contrastRatio(parseColor(text), parseColor(backdrop));
  assert.ok(ratio >= 4.5, `深色主题对比度为 ${ratio.toFixed(2)}，低于 4.5`);
});

test('视图样式不含硬编码颜色（面板/边框/强调色一律走主题令牌）', () => {
  const literals = [
    ...viewStyle.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...viewStyle.matchAll(/\brgba?\(/gi),
  ].map((match) => match[0]);
  assert.deepEqual(
    [...new Set(literals)],
    [],
    '视图样式里存在硬编码颜色；浅色主题下 rgb(255 255 255 / n%) 会表现为整页白雾',
  );
});

test('「近似基线」虚线柱标识必须保留（设计特性，非缺陷）', () => {
  assert.ok(
    /\.journal-bar--synthetic\s*\{/.test(viewStyle),
    '缺少 .journal-bar--synthetic 规则，近似基线柱将失去视觉区分',
  );
  const block = extractBlock(viewStyle, '.journal-bar--synthetic');
  assert.ok(/dashed|repeating-linear-gradient/.test(block), '近似基线柱缺少虚线/斜纹标识');
  assert.ok(
    /journal-bar--synthetic/.test(viewSource),
    '模板不再引用 journal-bar--synthetic，标识失效',
  );
});
