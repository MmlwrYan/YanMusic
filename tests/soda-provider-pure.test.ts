import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildHeaderLines,
  buildLimitedFreeParam,
  computeSsStub,
  extractUrlFromPlayerInfo,
  parseSearchResultGroups,
  parseSignatureHeaders,
} from '../src/providers/SodaProvider.ts';

/**
 * v1.5.0 · SodaProvider 纯逻辑守卫。
 *
 * ## 为什么只测纯函数
 *
 * `SodaProvider` 的真实链路需要两样东西：用户本地的 `bdms.node`（私有原生模块，
 * 不随仓库分发）与线上接口。二者在 CI 里都**不存在**，所以端到端不可能自动化。
 *
 * 但**最容易写错、且写错后最难发现**的部分恰好是纯函数：
 * 签名头的拼装格式、`X-SS-STUB` 的大小写、`url_player_info` 的解析。
 * 这些全部可以离线钉死 —— 它们一旦错了，症状是「接口一直失败但看不出原因」。
 */

/* ------------------------------------------------------------------ *
 * ① 签名输入格式
 * ------------------------------------------------------------------ */

test('v1.5.0-S1：headerLines 必须是 `key\r\nvalue` 的多行拼接（源码 app.ts:60-66）', () => {
  const lines = buildHeaderLines({
    'user-agent': ['LunaPC/1.0(abc)'],
    'x-luna-is-local-user': ['0'],
  });

  // 单个 header 的值：key 与 value 各占一行，用 \r\n 分隔
  assert.equal(
    lines.includes('user-agent\r\nLunaPC/1.0(abc)'),
    true,
    '必须是 `${key}\\r\\n${value}` 形态 —— 传成 JSON 或 `key: value` 都会让签名对不上',
  );
  assert.equal(lines.includes('x-luna-is-local-user\r\n0'), true);

  // ⚠️ 分隔符必须是 CRLF，不是 LF。
  // 若写成 `\n`，签名模块算出的摘要与真实客户端不同，服务端会拒。
  assert.equal(lines.includes('\r\n'), true);
  assert.equal(/[^\r]\n/.test(lines), false, '不得出现孤立的 LF（必须全是 \\r\\n）');
});

test('v1.5.0-S2：多值 header 的每个值都要单独成对（源码 app.ts:62-65 是双层循环）', () => {
  const lines = buildHeaderLines({ cookie: ['a=1', 'b=2'] });
  assert.equal(lines.includes('cookie\r\na=1'), true, '第一个值要成对');
  assert.equal(lines.includes('cookie\r\nb=2'), true, '第二个值也要成对');
});

/* ------------------------------------------------------------------ *
 * ② 签名输出解析
 * ------------------------------------------------------------------ */

test('v1.5.0-S3：签名结果按「每两项一对」解析（源码 app.ts:70-75）', () => {
  const result = parseSignatureHeaders('X-Helios\r\nsignature-value\r\nx-other\r\nother-value');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.headers, {
    'X-Helios': 'signature-value',
    'x-other': 'other-value',
  });
});

test('v1.5.0-S4：签名结果为空 / 奇数项时必须**显式失败**，不得静默截断', () => {
  // 空
  const empty = parseSignatureHeaders('');
  assert.equal(empty.ok, false, '空结果必须报错，否则会发出未签名请求');

  // 奇数项（3 项）：说明原生模块行为变了，应报错而不是丢掉最后一项
  const odd = parseSignatureHeaders('X-Helios\r\nonly-value\r\nx-dangling');
  assert.equal(odd.ok, false, '奇数项意味着签名残缺，必须显式失败');
  if (!odd.ok) {
    assert.match(odd.message, /偶数/, '错误信息要能指出根因，便于排查');
  }

  // 对照：恰好 2 项是**合法**的一对，不得误判为奇数
  const pair = parseSignatureHeaders('X-Helios\r\nv1');
  assert.equal(pair.ok, true, '2 项是合法的一对，不能误报');
});

/* ------------------------------------------------------------------ *
 * ③ X-SS-STUB
 * ------------------------------------------------------------------ */

test('v1.5.0-S5：X-SS-STUB 必须是 body 的 MD5 **大写**十六进制（utils/request.ts:199）', () => {
  // 源码：digest('hex').toUpperCase()
  // 用已知向量锁死算法与大小写（'abc' 的 MD5 是公开标准向量）
  assert.equal(computeSsStub('abc'), '900150983CD24FB0D6963F7D28E17F72');
  assert.equal(computeSsStub('abc')?.length, 32);
  assert.equal(
    computeSsStub('abc'),
    computeSsStub('abc')?.toUpperCase(),
    '必须是大写 —— 小写会让服务端校验失败且不告诉你原因',
  );

  // 对照：小写形态必须**不等**于正确值（防止将来有人把 toUpperCase 去掉还能过测）
  assert.notEqual(computeSsStub('abc'), '900150983cd24fb0d6963f7d28e17f72');
});

test('v1.5.0-S6：无 body 时不得输出 X-SS-STUB', () => {
  assert.equal(computeSsStub(undefined), null, 'undefined → 不带头');
  assert.equal(computeSsStub(null), null);
  assert.equal(computeSsStub(''), null, '空串 → 不带头（源码 :185 只在有 body 时算）');
});

/* ------------------------------------------------------------------ *
 * ④ url_player_info 解析（关键未知点）
 * ------------------------------------------------------------------ */

test('v1.5.0-S7：url_player_info 是裸 URL 时应直接取出', () => {
  const hit = extractUrlFromPlayerInfo('https://cdn.example.com/a.mp3');
  assert.deepEqual(hit, { url: 'https://cdn.example.com/a.mp3' });
});

test('v1.5.0-S8：url_player_info 是 JSON 字符串时应能解析出 URL', () => {
  const raw = JSON.stringify({ main_url: 'https://cdn.example.com/b.flac', bitrate: 999000 });
  const hit = extractUrlFromPlayerInfo(raw);
  assert.equal(hit?.url, 'https://cdn.example.com/b.flac');
});

test('v1.5.0-S9：字段名未知时的兜底 —— 嵌套/数组里也要能捞到 URL', () => {
  // 这是最可能出问题的地方：`PlayablePlayInfo` 的解析代码不在 restored_src 里，
  // 字段名（url / main_url / play_url …）只是候选。兜底必须能救命。
  const nested = { data: { list: [{ backup_url: 'https://cdn.example.com/c.m4a' }] } };
  assert.equal(extractUrlFromPlayerInfo(nested)?.url, 'https://cdn.example.com/c.m4a');

  const inArray = [{ nothing: 1 }, { url: 'https://cdn.example.com/d.mp3' }];
  assert.equal(extractUrlFromPlayerInfo(inArray)?.url, 'https://cdn.example.com/d.mp3');
});

test('v1.5.0-S10：解析不出来时必须返回 null（而不是编一个地址）', () => {
  assert.equal(extractUrlFromPlayerInfo(null), null);
  assert.equal(extractUrlFromPlayerInfo(undefined), null);
  assert.equal(extractUrlFromPlayerInfo({}), null);
  assert.equal(extractUrlFromPlayerInfo('not-a-url'), null);
  assert.equal(extractUrlFromPlayerInfo({ url: 123 }), null, '非字符串的值不算命中');
});

/* ------------------------------------------------------------------ *
 * ⑤ 试听参数
 * ------------------------------------------------------------------ */

test('v1.5.0-S11：没有 sign 的 limited_free_info 不得构造出试听参数', () => {
  // sign 是试听凭证的核心；没有它就是不可用，不能"尽力而为"地发出去
  assert.equal(buildLimitedFreeParam({}), null);
  assert.equal(buildLimitedFreeParam({ limited_free: true }), null);
  assert.equal(buildLimitedFreeParam({ sign: '' }), null);
});

test('v1.5.0-S12：有 sign 时回填请求参数，且不带纯响应字段', () => {
  const param = buildLimitedFreeParam({
    sign: 'SIG-123',
    sign_version: 'v2',
    expire_time: 1700000000,
    limited_free: true,
    limited_free_type: 'trial',
    queue_types: ['default'],
    intercept_type: 7, // 纯响应字段，不应回填
    config: { a: 1 }, // 纯响应字段
  });

  assert.ok(param);
  assert.equal(param.sign, 'SIG-123');
  assert.equal(param.sign_version, 'v2');
  assert.equal(param.expire_time, 1700000000);
  assert.equal(param.limited_free_type, 'trial');
  assert.deepEqual(param.queue_types, ['default']);
  assert.equal(
    'intercept_type' in param,
    false,
    'intercept_type 是响应字段，回填会让请求体带上未知字段',
  );
  assert.equal('config' in param, false);
});

/* ------------------------------------------------------------------ *
 * ⑥ 搜索结果拍平
 * ------------------------------------------------------------------ */

test('v1.5.0-S13：搜索组要递归拍平并去重（结构未取证，故必须容错）', () => {
  const groups = [
    { cards: [{ id: '1', title: 'A', artist: 'X', duration: 180 }] },
    { cards: [{ id: '1', title: 'A 重复', artist: 'X' }] }, // 同 id 应去重
    { nested: { deep: [{ id: 2, name: 'B', singer: 'Y', duration: 200_000 }] } },
  ];
  const tracks = parseSearchResultGroups(groups);

  assert.equal(tracks.length, 2, '应按 id 去重');
  assert.equal(tracks[0].id, '1');
  assert.equal(tracks[0].duration, 180, '小于 1000 视为秒');
  assert.equal(tracks[1].id, '2', '数字 id 要转成字符串（避免大整数精度问题）');
  assert.equal(tracks[1].duration, 200, '大于 1000 视为毫秒 → 200s');
});

test('v1.5.0-S14：搜索组结构异常时返回空数组而不是抛错', () => {
  assert.deepEqual(parseSearchResultGroups(null), []);
  assert.deepEqual(parseSearchResultGroups(undefined), []);
  assert.deepEqual(parseSearchResultGroups('x'), []);
  // 缺 id 或缺标题的条目直接跳过
  assert.deepEqual(parseSearchResultGroups([{ title: 'no-id' }, { id: '9' }]), []);
});
