import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  JOOX_LOSSLESS_KEYS,
  JOOX_PREVIEW_KEY,
  JOOX_QUALITY_KEYS,
  jooxCandidateKeys,
  parseJooxDuration,
  qualityLabelOfJooxKey,
} from '../src/main/joox/parsers.ts';

/**
 * v2.0.0 · JOOX 解析与音质候选的守卫。
 *
 * 这里的断言全部对应**原客户端的实际缺陷**（见逆向报告 §6.2.1 / §6.2.2）：
 * 1. 候选顺序以 Atmos 打头 → 永远轮不到母带；
 * 2. `atmos` 命中「无损」正则 → 被标成无损音质。
 * 若这两条回归，测试必须红。
 */

test('v2.0.0 ①：时长 `mm:ss` / `hh:mm:ss` 都要能解析成秒', () => {
  assert.equal(parseJooxDuration('04:29'), 269);
  assert.equal(parseJooxDuration('04:30'), 270);
  assert.equal(parseJooxDuration('1:02:03'), 3723);
  assert.equal(parseJooxDuration('00:00'), 0);
});

test('v2.0.0 ②：时长解析失败返回 0，**绝不返回 NaN**', () => {
  // NaN 会让进度条与总时长直接坏掉；0 只表示「未知」。
  for (const bad of ['', 'abc', '12', '-1:30', '::']) {
    const value = parseJooxDuration(bad);
    assert.equal(Number.isNaN(value), false, `不应产出 NaN：${JSON.stringify(bad)}`);
    assert.equal(value, 0, `应返回 0：${JSON.stringify(bad)}`);
  }
  assert.equal(parseJooxDuration(undefined), 0);
});

test('v2.0.0 ③：音质候选**必须**把母带/Hi-Res/无损排在 Atmos 之前', () => {
  // 把只读字面量元组放宽成 string[]，只为在测试里做位置比较；
  // 生产代码的 `jooxCandidateKeys` 仍然受字面量联合类型约束。
  const order: readonly string[] = [...JOOX_QUALITY_KEYS];
  const indexOf = (key: string) => order.indexOf(key);

  assert.ok(indexOf('母带无损') < indexOf('Atmos全景声'), '母带必须早于 Atmos');
  assert.ok(indexOf('Hi-Res无损') < indexOf('Atmos全景声'), 'Hi-Res 必须早于 Atmos');
  assert.ok(indexOf('无损FLAC') < indexOf('Atmos全景声'), '无损 FLAC 必须早于 Atmos');
  // 有损必须在无损之后
  assert.ok(indexOf('无损FLAC') < indexOf('OGG 320'), '无损必须早于有损');
  // 试听片段永远最后
  assert.equal(order[order.length - 1], JOOX_PREVIEW_KEY);
});

test('v2.0.0 ④：`flac` 偏好下第一候选是母带，不是 Atmos', () => {
  const candidates = jooxCandidateKeys('flac');
  assert.equal(candidates[0], '母带无损');
  assert.notEqual(candidates[0], 'Atmos全景声');
});

test('v2.0.0 ⑤：要 320 时不去试母带（避免无谓的探测延迟）', () => {
  const candidates = jooxCandidateKeys('320');
  assert.equal(candidates[0], 'OGG 320');
  assert.ok(!candidates.includes('母带无损'), '320 档不该探测母带');
  assert.ok(!candidates.includes('无损FLAC'), '320 档不该探测无损');
});

test('v2.0.0 ⑥：`Atmos全景声` **不能**被标成无损', () => {
  // 这是原客户端的实际 bug：atmos 命中 /母带|无损|flac|hi-res|atmos/ 正则，
  // 于是被标成「无损音质」。Atmos 是对象音频，与无损 PCM 不是一回事。
  assert.notEqual(qualityLabelOfJooxKey('Atmos全景声'), 'flac');
  assert.equal(qualityLabelOfJooxKey('Atmos全景声'), '128');

  // 真正的无损三档才标 flac
  for (const key of JOOX_LOSSLESS_KEYS) {
    assert.equal(qualityLabelOfJooxKey(key), 'flac', `${key} 应标为 flac`);
  }
});

test('v2.0.0 ⑦：有损档按码率标注，不虚标 320', () => {
  assert.equal(qualityLabelOfJooxKey('OGG 192'), '128');
  assert.equal(qualityLabelOfJooxKey('AAC 96'), '128');
  assert.equal(qualityLabelOfJooxKey('OGG 320'), '320');
  assert.equal(qualityLabelOfJooxKey(JOOX_PREVIEW_KEY), '128');
});

test('v2.0.0 ⑧：每个偏好档的候选序列都以试听片段兜底', () => {
  for (const quality of ['super', 'high', 'flac', '320', '128', undefined]) {
    const candidates = jooxCandidateKeys(quality);
    assert.ok(candidates.length > 0, `${String(quality)} 的候选不能为空`);
    assert.equal(
      candidates[candidates.length - 1],
      JOOX_PREVIEW_KEY,
      `${String(quality)} 的最后一档应是试听片段`,
    );
  }
});
