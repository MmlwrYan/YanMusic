import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inferKuwoQualityLabel,
  normalizeKuwoRid,
  parseKuwoUrlMeta,
  upgradeKuwoUrl,
} from '../src/main/kuwo/parsers.ts';

/**
 * v2.0.0 · 酷我解析的纯函数守卫。
 *
 * ## 样本全部来自实测（不是手写的「我以为」）
 *
 * 直链样本取自 2026-10-18 对 `oiapi.net/api/Kuwo` 的真实响应
 *（见 `docs/reports-for-other-apps/JJ-Music-逆向分析报告.md` §4.5）。
 * 用手写样本的问题在于：它只能证明「函数符合我的想象」，
 * 而线上出错恰恰发生在想象之外（查询串用 `$` 分隔就是典型）。
 */

/** 实测：晴天 / FLAC 2000（DL 签发于 2026-10-02，已 410） */
const URL_FLAC =
  'http://kw-er.kuwo.cn/305ab72f05c40231084b32bb66710be5/6abf8890/resource/30106/trackmedia/F000000bYDlc2XxKLs.flac' +
  '?bitrate$2000&format$flac&source$kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&type$convert_url_with_sign&user$0&loginUid$';

/** 实测：晴天 / OGG 192（当次新签，206 可用） */
const URL_OGG =
  'http://kw-er.kuwo.cn/bb2b5bc18461fa324177a29670bb07c5/6ad44ce7/resource/30106/trackmedia/O600000bYDlc2XxKLs.ogg' +
  '?bitrate$192&format$ogg&source$kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&type$convert_url_with_sign&user$0&loginUid$';

test('v2.0.0 ①：rid 归一化 —— `MUSIC_` 前缀可去可不去', () => {
  assert.equal(normalizeKuwoRid('MUSIC_228908'), '228908');
  assert.equal(normalizeKuwoRid('music_228908'), '228908');
  assert.equal(normalizeKuwoRid('228908'), '228908');
  assert.equal(normalizeKuwoRid(undefined), '');
  assert.equal(normalizeKuwoRid('  MUSIC_118980  '), '118980');
  // 只剥前缀，不做别的加工
  assert.equal(normalizeKuwoRid('MUSIC_'), '');
});

test('v2.0.0 ②：直链解析必须按 `$` 分隔符取参数（不是 `=`）', () => {
  const flac = parseKuwoUrlMeta(URL_FLAC);
  assert.equal(flac.format, 'flac');
  assert.equal(flac.bitrate, 2000);
  // 路径第二段是十六进制签发时间戳：6abf8890 → 2026-10-02
  assert.ok(flac.signedAt instanceof Date, '应能解析出签发时间');
  assert.equal(flac.signedAt?.toISOString().slice(0, 10), '2026-10-02');

  const ogg = parseKuwoUrlMeta(URL_OGG);
  assert.equal(ogg.format, 'ogg');
  assert.equal(ogg.bitrate, 192);
  assert.equal(ogg.signedAt?.toISOString().slice(0, 10), '2026-10-18');
});

test('v2.0.0 ③：非法输入不抛错（探测路径上不能因为解析炸掉）', () => {
  assert.deepEqual(parseKuwoUrlMeta(''), {});
  assert.deepEqual(parseKuwoUrlMeta('not-a-url'), {});
  // 缺 format / bitrate 时字段为 undefined，而不是 0 或空串
  const bare = parseKuwoUrlMeta('https://kw-er.kuwo.cn/aaa/bbb/resource/1/x.flac');
  assert.equal(bare.format, undefined);
  assert.equal(bare.bitrate, undefined);
});

test('v2.0.0 ④：`http://` 直链必须升级为 https（混合内容）', () => {
  assert.ok(upgradeKuwoUrl(URL_FLAC).startsWith('https://'));
  assert.equal(upgradeKuwoUrl(''), '');
  // 已经是 https 的不能被改坏
  const https = 'https://kw-er.kuwo.cn/a/b/resource/1/x.flac';
  assert.equal(upgradeKuwoUrl(https), https);
});

test('v2.0.0 ⑤：音质标签按 format 推导，且**宁可标低不标高**', () => {
  assert.equal(inferKuwoQualityLabel('flac'), 'flac');
  assert.equal(inferKuwoQualityLabel('FLAC'), 'flac');
  assert.equal(inferKuwoQualityLabel('wav'), 'flac');
  assert.equal(inferKuwoQualityLabel('ape'), 'flac');
  // 有损一律 320 —— 但**不标 flac**。原客户端会把 192K 的 OGG 标成 320K，
  // 这里至少不会把它标成无损。
  assert.equal(inferKuwoQualityLabel('ogg'), '320');
  assert.equal(inferKuwoQualityLabel('mp3'), '320');
  assert.equal(inferKuwoQualityLabel(undefined), '320');
});
