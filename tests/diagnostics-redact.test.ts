import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED_MARKERS,
  redactString,
  redactValue,
  type RedactContext,
} from '../src/main/diagnostics/redact.ts';

/**
 * S-6（v1.3.0）守卫：诊断包脱敏。
 *
 * ## 为什么这条守卫最不能省
 *
 * 诊断包是**用户主动导出、然后发给维护者**的文件 —— 一旦带着凭据离开用户机器，
 * 泄漏不可撤回。而本应用 KV 里确实有敏感数据：`pinia:user`（酷狗登录票据）、
 * `pinia:device`（设备指纹），以及网络设置里的代理凭据。
 *
 * 脱敏逻辑**最怕写完没验证**：一条规则写错（比如 URL 规则没处理 query、
 * 敏感键名正则漏了个近义词）就会让 token 原样出门，而且不会有任何报错。
 *
 * 因此这里用**真实形态的凭据**做断言（而不是编造的短字符串），
 * 并覆盖「白名单遗漏时逐值兜底」这条第二防线。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `redactString` 里 `isLikelyUrl` 的 URL 收敛分支删掉 → 用例 2 变红；
 *  把 `SENSITIVE_KEY_PATTERN` 改成 `/(never-match)/` → 用例 3、4 变红。
 */

const CTX: RedactContext = {
  userDataPath: 'C:\\Users\\someone\\AppData\\Roaming\\YanMusic',
  homePath: 'C:\\Users\\someone',
};

test('S-6：用户目录与主目录路径必须被替换为占位符', () => {
  assert.equal(
    redactString('C:\\Users\\someone\\AppData\\Roaming\\YanMusic\\logs\\a.log', CTX),
    '<userData>\\logs\\a.log',
    '用户数据目录（Windows 反斜杠）必须被替换',
  );
  assert.equal(
    redactString('C:/Users/someone/AppData/Roaming/YanMusic/logs/a.log', CTX),
    '<userData>/logs/a.log',
    '正斜杠形式同样必须被替换（日志里两种都可能出现）',
  );
  // 主目录替换：userData 在 home 之下，故先替换更长的 userData 才不会误留片段
  assert.equal(redactString('C:\\Users\\someone\\Music\\x.mp3', CTX), '<home>\\Music\\x.mp3');
});

test('S-6：URL 必须收敛为 scheme://host，丢弃 path/query（query 常含 token）', () => {
  assert.equal(
    redactString('https://api.example.com/v1/user?token=supersecrettoken123456', CTX),
    'https://api.example.com',
    'query 里的 token 必须被丢弃 —— 这是最容易漏的一类',
  );
  assert.equal(redactString('http://127.0.0.1:8080/data?key=abcdef', CTX), 'http://127.0.0.1:8080');
  // 非 URL 字符串不受影响
  assert.equal(redactString('普通日志文本', CTX), '普通日志文本');
});

test('S-6：敏感键名的值必须被整值丢弃（不看值长什么样）', () => {
  const redacted = redactValue(
    {
      theme: 'dark',
      token: 'anything-at-all',
      apiKey: 'short',
      authorization: 'Bearer x',
      proxyPassword: 'p@ss',
      deviceId: 'abc',
      userid: 12345,
      dfid: 'device-fingerprint-value',
    },
    CTX,
  ) as Record<string, unknown>;

  assert.equal(redacted.theme, 'dark', '非敏感字段必须保留（否则诊断包失去价值）');
  for (const key of [
    'token',
    'apiKey',
    'authorization',
    'proxyPassword',
    'deviceId',
    'userid',
    'dfid',
  ]) {
    assert.equal(
      redacted[key],
      REDACTED_MARKERS.value,
      `敏感键 ${key} 的值必须被丢弃 —— 键名本身保留，便于维护者知道这里有个凭据配置`,
    );
  }
});

test('S-6：真实形态的 pinia:user 内容（含酷狗票据）必须被脱敏', () => {
  // 这是 KV 里 pinia:user 的典型结构：info.token 是酷狗登录票据
  const piniaUser = {
    info: {
      userid: 987654321,
      username: 'some-user',
      token: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      dfid: '0ioWM50eaDqk48VwwJ1unRov',
      nickname: '昵称',
    },
    isLoggedIn: true,
  };

  const redacted = redactValue({ 'pinia:user': piniaUser }, CTX) as Record<
    string,
    Record<string, unknown>
  >;
  const inner = redacted['pinia:user'].info as Record<string, unknown>;

  assert.equal(inner.token, REDACTED_MARKERS.value, '登录票据必须被丢弃');
  assert.equal(inner.userid, REDACTED_MARKERS.value, '用户 id 必须被丢弃');
  assert.equal(inner.dfid, REDACTED_MARKERS.value, '设备指纹必须被丢弃');
  assert.equal(inner.username, 'some-user', '用户名不属于键名命中项，保留（白名单层会进一步收紧）');
});

test('S-6：长且无空格的密钥样字符串被整体遮蔽（白名单遗漏时的第二防线）', () => {
  const longSecret = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart';
  assert.equal(redactString(longSecret, CTX), REDACTED_MARKERS.secret, 'JWT 样的长串必须被遮蔽');
  // 短字符串与含空格的普通文本不得被误伤（误伤过多会让诊断包失去价值）
  assert.equal(redactString('短', CTX), '短');
  assert.equal(redactString('这是一句普通的日志 说明文字', CTX), '这是一句普通的日志 说明文字');
});

test('S-6：递归脱敏覆盖嵌套对象与数组', () => {
  const redacted = redactValue(
    {
      logs: [
        { message: 'C:\\Users\\someone\\AppData\\Roaming\\YanMusic\\x.log', token: 't' },
        { message: '正常', secret: 's' },
      ],
      nested: { deeper: { apiKey: 'k', keep: 'v' } },
    },
    CTX,
  ) as {
    logs: Array<Record<string, unknown>>;
    nested: { deeper: Record<string, unknown> };
  };

  assert.equal(redacted.logs[0].message, '<userData>\\x.log', '数组内的字符串也要脱敏');
  assert.equal(redacted.logs[0].token, REDACTED_MARKERS.value);
  assert.equal(redacted.logs[1].message, '正常');
  assert.equal(redacted.logs[1].secret, REDACTED_MARKERS.value);
  assert.equal(redacted.nested.deeper.apiKey, REDACTED_MARKERS.value, '深层嵌套同样覆盖');
  assert.equal(redacted.nested.deeper.keep, 'v');
});

test('S-6：深度与数组长度受限（防止异常结构拖垮导出）', () => {
  // 超深结构：截断为 <max-depth>，不抛错
  let deep: unknown = 'bottom';
  for (let i = 0; i < 12; i++) deep = { level: deep };
  const result = redactValue(deep, CTX);
  assert.doesNotThrow(() => JSON.stringify(result), '结果必须可 JSON 序列化（导出要写文件）');
  assert.match(JSON.stringify(result), /max-depth/, '超深结构必须被截断并留下标记');

  // 超长数组：截断到 200
  const longArray = Array.from({ length: 500 }, (_, i) => i);
  const truncated = redactValue(longArray, CTX) as number[];
  assert.equal(truncated.length, 200, '超长数组必须被截断');
});

test('S-6：不可序列化类型统一产出 null（避免 JSON.stringify 出现 undefined 歧义）', () => {
  const redacted = redactValue({ fn: () => 1, sym: Symbol('s'), undef: undefined }, CTX) as Record<
    string,
    unknown
  >;

  assert.equal(redacted.fn, null);
  assert.equal(redacted.sym, null);
  assert.equal(redacted.undef, null);
  // 关键：整个对象必须能稳定 JSON.stringify（不含函数/symbol）
  assert.doesNotThrow(() => JSON.stringify(redacted));
  assert.ok(!JSON.stringify(redacted).includes('undefined'), '不应出现 undefined 字面量');
});
