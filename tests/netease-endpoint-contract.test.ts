import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * v2.0.0 · 网易云端点与参数契约守卫。
 *
 * ## 为什么这条必须守（这是本次最容易反复踩的坑）
 *
 * 网易云这套 legacy `/api/*` 接口**端点写错时不返回 HTTP 404**，
 * 而是 **HTTP 200 + body 里 `code: 404`**。
 * 也就是说：**写错端点的症状是「静默没有结果」，而不是报错。**
 *
 * 本次实测就逐个撞上过（详见 `src/main/netease/api.ts` 顶部的实测表）：
 * - `/api/search`            → `code:404`，可用的是 `/api/search/get`
 * - `/api/song/url`          → `code:404`，可用的是 `/api/song/enhance/player/url`
 * - `/api/lyric`             → `code:404`，可用的是 `/api/song/lyric`
 * - `/api/check/music`       → `code:404`，**无可用替代，已移除**
 *
 * 以及参数层面：
 * - 取链端点是 `ids=[id]` + **`br`**（不是 `level`；传 `level` 得到 `code:400 参数错误`）
 * - `expi` 是**剩余秒数**（实测 1200），不是绝对时间戳
 *
 * 这些都是「错了不会报错、只会静默失效」的形态，靠人眼 review 极难发现，
 * 所以用源码级断言钉住。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

const apiSource = read('src/main/netease/api.ts');
const clientSource = read('src/main/netease/client.ts');
const mapSource = read('src/main/netease/map.ts');

test('v2.0.0 ⑥：端点是实测可用的那三个（不许改回“看起来更 RESTful”的名字）', () => {
  // 必须使用实测可用端点
  assert.ok(
    apiSource.includes("endpoint: 'search/get'"),
    '搜索必须用 /api/search/get —— /api/search 会返回 HTTP 200 + code:404',
  );
  assert.ok(
    apiSource.includes("endpoint: 'song/enhance/player/url'"),
    '取链必须用 /api/song/enhance/player/url —— /api/song/url 会返回 code:404',
  );
  assert.ok(
    apiSource.includes("endpoint: 'song/lyric'"),
    '歌词必须用 /api/song/lyric —— /api/lyric 会返回 code:404',
  );

  // 必须**不再**出现已证伪的端点
  const forbidden: Array<[string, string]> = [
    ["endpoint: 'search'", '/api/search'],
    ["endpoint: 'song/url'", '/api/song/url'],
    ["endpoint: 'lyric'", '/api/lyric'],
    ["endpoint: 'check/music'", '/api/check/music'],
  ];
  for (const [needle, name] of forbidden) {
    assert.ok(
      !apiSource.includes(needle),
      `不应再调用已证实为 404 的端点 ${name}（它会 HTTP 200 + code:404，静默失效）`,
    );
  }

  // 端点的类型白名单必须与之一致
  for (const endpoint of ['search/get', 'song/enhance/player/url', 'song/lyric']) {
    assert.ok(
      clientSource.includes(`'${endpoint}'`),
      `NeteaseEndpoint 白名单里必须有 '${endpoint}'`,
    );
  }
});

test('v2.0.0 ⑦：取链必须用 br（不是 level），且 br 候选有序', () => {
  assert.ok(
    apiSource.includes('br,') || apiSource.includes('{ ids: `[${id}]`, br }'),
    '取链请求必须带 br 参数 —— 实测传 level 会得到 code:400 参数错误',
  );
  assert.ok(
    !/endpoint: 'song\/enhance\/player\/url'[\s\S]{0,200}level:/.test(apiSource),
    '取链请求里不得出现 level 参数（该端点不认）',
  );
  // 实测必需：ids 也一定要带（缺 ids 也会 code:400）
  assert.ok(apiSource.includes('ids: `[${id}]`'), '取链必须带 ids=[id]；缺它会 code:400');

  // 候选表必须「由高到低」——高中低顺序写反会让降级链失去意义
  const candidates = apiSource.match(/case 'super':[\s\S]*?return \[([\s\S]*?)\];/);
  assert.ok(candidates, '应存在 super/high 的候选表');
  const numbers = [...candidates[1].matchAll(/NETEASE_BITRATE_(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    numbers,
    ['HIRES', 'LOSSLESS', 'EXHIGH', 'HIGHER', 'STANDARD'],
    'br 候选必须由高到低排列，否则「从高到低试」的语义就反了',
  );
});

test('v2.0.0 ⑧：expi 必须按「剩余秒数」换算成绝对时间', () => {
  assert.ok(
    /expi[\s\S]{0,160}Date\.now\(\)\s*\+\s*item\.expi\s*\*\s*1000/.test(apiSource),
    'expi 是剩余秒数，必须换算成绝对时间（Date.now() + expi*1000）。' +
      '直接当时间戳会得到 1970 年，链接立刻被判过期',
  );
});

test('v2.0.0 ⑨：**每一个**读接口都必须显式检查 body.code', () => {
  assert.ok(
    apiSource.includes('assertBusinessOk'),
    '必须存在业务码检查函数；否则 HTTP 200 + code:404 会被当成「没有结果」',
  );

  // 四个读接口：搜索 / 详情 / 取链 / 歌词。
  // 取链这一路最初漏了检查 —— 而它的后果最隐蔽：
  // 「参数写错」会被当成「这首不可播」，用户只看到放不出来。
  const calls = (apiSource.match(/assertBusinessOk\(/g) ?? []).length;
  assert.ok(
    calls === 4,
    `assertBusinessOk 应恰好在 4 个读接口处被调用（搜索/详情/取链/歌词），实际 ${calls} 处。` +
      '漏掉任何一个，那一路的端点/参数错误就会静默失效',
  );
  assert.ok(
    /assertBusinessOk\(payload, '取播放链'\)/.test(apiSource),
    '取链必须检查业务码：该端点在参数错误时返回 HTTP 200 + code:400',
  );
});

test('v2.0.0 ⑩：映射必须处理 dt/duration 的毫秒→秒，且兼容两种封面字段', () => {
  assert.ok(
    mapSource.includes('/ 1000'),
    'duration 必须毫秒→秒 —— 写错不报错，只会让进度条与歌词时间轴整体偏移',
  );
  assert.ok(
    mapSource.includes('picUrl') && mapSource.includes('picture'),
    '新版端点给 picUrl、旧版 search/get 给 picture，两个都要认（否则封面全空）',
  );
});
