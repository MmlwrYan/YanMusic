import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapNeteaseSong, mapNeteaseSongs } from '../src/main/netease/map.ts';

/**
 * v1.5.0 · 封面映射守卫（**一个真 bug 的回归守卫**）。
 *
 * ## 现象
 *
 * 网易云搜索结果的**封面全是占位图、主题色也取不到**（酷狗正常）。
 *
 * ## 根因：两个端点的「贫富」关系与直觉相反（我曾判断错并写进注释）
 *
 * - `/api/search/get`：元数据够，但封面**只有 `album.picId`（数字）**，
 *   **没有 `picUrl`**。实测 30 首里 **0 首**带 URL。
 *   而 `picId` **无法直接拼成 URL**（CDN 路径含一段 hash，
 *   实测裸拼 p1–p4 四个 host 全部 404）。
 * - `/api/song/detail`：给**完整 `album` 对象**，含 `album.picUrl`，实测 **30/30**。
 *
 * ⇒ 所以我早先写的注释「song/detail 更贫瘠、al.picUrl 缺失」是**错的** ——
 * 我当时只查了 `al`（detail 用的是 `album`）就下了结论。
 *
 * ## 为什么用真实响应形状做夹具
 *
 * 这两个字段名（`al` vs `album`、`picId` vs `picUrl`）正是出错的地方，
 * 手写一个「我以为的」样本就会把这个 bug 一起写进测试里。
 * 下面的夹具**逐字取自真实响应**（见 `.workbuddy/tmp/probe-cover*.mjs`）。
 */

/** 真实 `/api/search/get` 的一条（**无封面 URL**）。 */
const SEARCH_SHAPE = {
  id: 2688454170,
  name: '老男孩 筷子兄弟',
  fee: 0,
  duration: 296615,
  artists: [{ id: 62021172, name: 'ORCA特米' }],
  album: {
    id: 267074890,
    name: '老男孩',
    // ⚠️ 关键：只有 picId，没有 picUrl
    picId: 109951170650096300,
  },
};

/** 真实 `/api/song/detail` 的同一条（**有封面 URL**）。 */
const DETAIL_SHAPE = {
  id: 2688454170,
  name: '老男孩 筷子兄弟',
  fee: 0,
  dt: 296615,
  artists: [{ id: 62021172, name: 'ORCA特米' }],
  album: {
    id: 267074890,
    name: '老男孩',
    picId: 109951170650096300,
    picUrl: 'https://p1.music.126.net/ZmH_1JWrtnxVEGJ9b125nQ==/109951170650096300.jpg',
  },
};

test('v1.5.0 ①：搜索端点的形状映射后**没有**封面（如实反映上游）', () => {
  const song = mapNeteaseSong(SEARCH_SHAPE);
  assert.ok(song, '应能映射');
  assert.equal(
    song.coverUrl,
    '',
    '搜索端点只给 picId、没有 picUrl ⇒ 映射结果**就该是空**。' +
      '这不是 bug，而是上游事实；封面必须靠 song/detail 补（见 api.ts enrichCovers）',
  );
  assert.equal(song.cover, '');
});

test('v1.5.0 ②：detail 端点的形状（完整 album 对象）必须映射出封面 URL', () => {
  const song = mapNeteaseSong(DETAIL_SHAPE);
  assert.ok(song, '应能映射');
  assert.ok(
    song.coverUrl.startsWith('https://p1.music.126.net/'),
    `detail 的 album.picUrl 必须被取出（实际 coverUrl=${JSON.stringify(song.coverUrl)}）`,
  );
  // 必须带上尺寸参数：不带会拉原图，列表里明显变慢
  assert.ok(
    song.coverUrl.includes('?param='),
    `封面 URL 必须带 ?param= 裁剪参数（实际 ${song.coverUrl}）`,
  );
  assert.equal(song.cover, song.coverUrl, 'cover 与 coverUrl 应一致（渲染层两处都在用）');
  // 详情形状用 dt 而不是 duration，单位毫秒 → 秒
  assert.equal(song.duration, 297, 'duration 应为秒（296615ms → 297s）');
});

test('v1.5.0 ③：`al` 与 `album`、`dt` 与 `duration` 两套字段都要认（防端点漂移）', () => {
  const viaAl = mapNeteaseSong({
    id: 1,
    name: 'a',
    dt: 60000,
    al: { name: 'alb', picUrl: 'https://p1.music.126.net/x.jpg' },
  });
  assert.ok(viaAl);
  assert.ok(viaAl.coverUrl.includes('p1.music.126.net'), '`al` 形状也应能取到封面');
  assert.equal(viaAl.duration, 60, '`dt` 毫秒→秒');

  const viaDuration = mapNeteaseSong({
    id: 2,
    name: 'b',
    duration: 120000,
    album: { name: 'alb2', picUrl: 'https://p2.music.126.net/y.jpg' },
  });
  assert.ok(viaDuration);
  assert.equal(viaDuration.duration, 120, '`duration` 字段也应被认（同样毫秒→秒）');
  assert.ok(viaDuration.coverUrl.includes('p2.music.126.net'));
});

test('v1.5.0 ④：批量映射不得因为个别缺字段而丢条目', () => {
  const list = mapNeteaseSongs([SEARCH_SHAPE, DETAIL_SHAPE, { id: 3 }, null, 'x']);
  assert.equal(list.length, 2, '缺 name / 非对象的条目应被丢弃，其余保留');
  assert.equal(list[0].id, '2688454170');
  assert.equal(list[1].id, '2688454170');
});
