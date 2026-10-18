import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';

import { compareVersion, maskDeviceId, parseDeviceIdentity } from '../src/main/soda/discovery.ts';

/**
 * v2.0.0 · 汽水客户端探测的纯逻辑守卫。
 *
 * ## 测试里**不能**出现真实设备指纹
 *
 * `DeviceV1` 的 `did` / `iid` / `cdid` 是请求里唯一的身份凭据。
 * 下面所有样本都是**构造的假值** —— 用真值写测试等于把它永久留在仓库历史里。
 */

/** 构造一个合法的 `DeviceV1` 内容（gzip 压缩的 JSON）。 */
const makeDeviceFile = (json: Record<string, string>, compress = true): Buffer => {
  const text = JSON.stringify(json);
  return compress ? gzipSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
};

test('v2.0.0 ①：能解开 gzip 形态的 DeviceV1 并取出三个身份字段', () => {
  const raw = makeDeviceFile({
    did: '1000000000000001',
    iid: '2000000000000002',
    cdid: 'fake-cdid-0003',
    serial: 'fake-serial-0004',
  });

  const identity = parseDeviceIdentity(raw);
  assert.ok(identity, '应能解析');
  assert.equal(identity?.deviceId, '1000000000000001');
  assert.equal(identity?.installId, '2000000000000002');
  assert.equal(identity?.cdid, 'fake-cdid-0003');
});

test('v2.0.0 ②：未压缩的明文 JSON 也要能解析（不同版本格式不同）', () => {
  const raw = makeDeviceFile(
    { did: '3000000000000003', iid: '4000000000000004', cdid: 'fake-cdid-0005' },
    false,
  );
  const identity = parseDeviceIdentity(raw);
  assert.equal(identity?.deviceId, '3000000000000003');
  assert.equal(identity?.installId, '4000000000000004');
});

test('v2.0.0 ③：脏数据一律返回 null，**不抛错**', () => {
  // 探测路径上抛错会让「音源不可用」变成「主进程启动失败」。
  const cases: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from('not gzip, not json'),
    // gzip 头正确但内容不是 JSON
    gzipSync(Buffer.from('???', 'utf8')),
    // 合法 JSON 但缺关键字段
    makeDeviceFile({ cdid: 'only-cdid' }),
    makeDeviceFile({ did: 'x' }),
  ];

  for (const raw of cases) {
    assert.equal(parseDeviceIdentity(raw), null, `应返回 null：${raw.length} 字节`);
  }
});

test('v2.0.0 ④：`cdid` 缺失不影响解析（它是可选字段）', () => {
  const raw = makeDeviceFile({ did: '5000000000000005', iid: '6000000000000006' });
  const identity = parseDeviceIdentity(raw);
  assert.ok(identity);
  assert.equal(identity?.cdid, '');
});

test('v2.0.0 ⑤：版本比较必须按数字段，不能按字符串', () => {
  // 字符串比较会把 "3.10.0" 排在 "3.9.0" 前面，于是自动探测可能选到旧版本。
  assert.ok(compareVersion('3.10.0', '3.9.0') > 0);
  assert.ok(compareVersion('3.9.0', '3.10.0') < 0);
  assert.equal(compareVersion('3.7.0', '3.7.0'), 0);
  assert.ok(compareVersion('3.8.0', '3.7.0') > 0);
  // 段数不同的也能比
  assert.ok(compareVersion('4.0', '3.99.99') > 0);
});

test('v2.0.0 ⑥：设备 id 脱敏后**不得**保留可复现信息', () => {
  const real = '1325380449383258';
  const masked = maskDeviceId(real);

  assert.notEqual(masked, real, '脱敏结果不能等于原文');
  assert.ok(!masked.includes(real), '不能包含完整原文');
  assert.ok(masked.endsWith('3258'), '应保留尾 4 位以便区分设备');
  // 中间部分必须是星号，不能泄露
  assert.ok(masked.slice(0, -4).replace(/\*/g, '') === '', '除尾 4 位外必须全是星号');

  // 边界：空值与超短值
  assert.equal(maskDeviceId(''), '(空)');
  assert.equal(maskDeviceId(undefined), '(空)');
  assert.equal(maskDeviceId('1234'), '****');
  assert.equal(maskDeviceId('1'), '*');
});
