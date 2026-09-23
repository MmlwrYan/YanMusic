import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_SHARE_WEB_BASE_URLS,
  SHARE_WEB_BASE_URL,
  buildShareWebUrl,
  parseShareWebUrl,
} from '../src/shared/share.ts';

/**
 * IMP-14：分享落地页域名切换为自有 Pages，并保留旧域名兼容解析。
 *
 * 复现（修复前）：`src/shared/share.ts:2-3`
 *   `// TODO(source): 分享落地页仍指向原实现的 GitHub Pages 地址，待自有部署确认后替换`
 *   `export const SHARE_WEB_BASE_URL = 'https://hoowhoami.github.io/yanmusic/share/';`
 * 而仓库内已存在自有落地页 `docs/share/index.html`（7889 bytes）与 `docs/.nojekyll`。
 *
 * 修复口径：`SHARE_WEB_BASE_URL` 指向自有 Pages；`parseShareWebUrl` 同时接受旧域名，
 * 保证历史分享链接不失效。
 */

const SONG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LEGACY_BASE = 'https://hoowhoami.github.io/yanmusic/share/';

test('SHARE_WEB_BASE_URL 指向自有 Pages，不再指向上游', () => {
  assert.equal(SHARE_WEB_BASE_URL, 'https://mmlwryan.github.io/YanMusic/share/');
  assert.equal(/hoowhoami/i.test(SHARE_WEB_BASE_URL), false);
  assert.ok(LEGACY_SHARE_WEB_BASE_URLS.includes(LEGACY_BASE));
});

test('parseShareWebUrl：解析新域名的查询参数形式', () => {
  const target = parseShareWebUrl(`${SHARE_WEB_BASE_URL}?type=song&id=${SONG_ID}`);
  assert.ok(target);
  assert.equal(target!.type, 'song');
  assert.equal(target!.id, SONG_ID);
});

test('parseShareWebUrl：解析新域名的路径形式', () => {
  const target = parseShareWebUrl(`https://mmlwryan.github.io/YanMusic/share/song/${SONG_ID}`);
  assert.ok(target);
  assert.equal(target!.type, 'song');
  assert.equal(target!.id, SONG_ID);
});

test('parseShareWebUrl：仍兼容旧域名的查询参数形式（历史链接不失效）', () => {
  const target = parseShareWebUrl(`${LEGACY_BASE}?type=song&id=${SONG_ID}`);
  assert.ok(target, '旧域名链接必须仍可解析');
  assert.equal(target!.type, 'song');
  assert.equal(target!.id, SONG_ID);
});

test('parseShareWebUrl：仍兼容旧域名的嵌套 target 形式', () => {
  const nested = `${LEGACY_BASE}?target=${encodeURIComponent(`yanmusic://song/${SONG_ID}`)}`;
  const target = parseShareWebUrl(nested);
  assert.ok(target, '旧域名嵌套 target 必须仍可解析');
  assert.equal(target!.type, 'song');
  assert.equal(target!.id, SONG_ID);

  const nestedNew = `${SHARE_WEB_BASE_URL}?target=${encodeURIComponent(`yanmusic://song/${SONG_ID}`)}`;
  assert.equal(parseShareWebUrl(nestedNew)?.id, SONG_ID);
});

test('parseShareWebUrl：非白名单域名与非法路径一律拒绝', () => {
  assert.equal(parseShareWebUrl(`https://evil.example.com/share/?type=song&id=${SONG_ID}`), null);
  // 同源但路径不在 /share 下
  assert.equal(
    parseShareWebUrl(`https://mmlwryan.github.io/YanMusic/other/?type=song&id=${SONG_ID}`),
    null,
  );
  // 旧域名下的非 /share 路径
  assert.equal(
    parseShareWebUrl(`https://hoowhoami.github.io/yanmusic/?type=song&id=${SONG_ID}`),
    null,
  );
});

test('buildShareWebUrl → parseShareWebUrl 往返一致', () => {
  const url = buildShareWebUrl({ type: 'song', id: SONG_ID });
  assert.ok(url.startsWith(SHARE_WEB_BASE_URL), `生成的链接应基于自有域名，实际：${url}`);
  const parsed = parseShareWebUrl(url);
  assert.ok(parsed);
  assert.equal(parsed!.type, 'song');
  assert.equal(parsed!.id, SONG_ID);
});
