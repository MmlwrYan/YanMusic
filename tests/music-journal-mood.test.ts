import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MOOD_PRESETS,
  applyEventMood,
  normalizeMoodText,
  summarizeMoods,
  type JournalPlayEvent,
} from '../src/shared/musicJournal.ts';

/**
 * 听歌档案（C2）子批次 3：情绪标签 —— 纯逻辑测试。
 *
 * 重要口径：本功能**不做情绪自动推断**。产品卡片里的「按情绪/时段聚类」中，
 * 时段聚类由子批次 2 的 `clusterByTimeOfDay` 提供；情绪维度只接受**用户手动标注**，
 * 因为项目内不存在任何音频情绪分析能力（依赖快照：`src/**` 无相关实现），
 * 凭空推断会产出无依据的结论。
 */

const event = (
  id: string,
  playedAt: number,
  extra: Partial<JournalPlayEvent> = {},
): JournalPlayEvent => ({
  id,
  songKey: `k-${id}`,
  title: `曲-${id}`,
  artist: `人-${id}`,
  album: '',
  durationSec: 180,
  playedAt,
  source: 'kugou',
  synthetic: false,
  baselinePlayCount: 0,
  ...extra,
});

test('MOOD_PRESETS：非空、唯一、无空白项', () => {
  assert.ok(MOOD_PRESETS.length >= 4);
  assert.equal(new Set(MOOD_PRESETS).size, MOOD_PRESETS.length);
  assert.ok(MOOD_PRESETS.every((mood) => mood.trim() === mood && mood.length > 0));
});

test('normalizeMoodText：去空白、去控制字符、截断长度', () => {
  assert.equal(normalizeMoodText('  专注  '), '专注');
  assert.equal(normalizeMoodText('专\u0000注'), '专注');
  assert.equal(normalizeMoodText('换\n行\t符'), '换行符');
  assert.equal(normalizeMoodText(''), '');
  assert.equal(normalizeMoodText(null), '');
  assert.equal(normalizeMoodText(12345), '');
  assert.equal(normalizeMoodText('x'.repeat(100)).length, 24);
});

test('applyEventMood：设置、覆盖、清除，且不影响其他事件', () => {
  const events = [event('a', 1000), event('b', 2000)];

  const tagged = applyEventMood(events, 'a', '专注');
  assert.equal(tagged.find((item) => item.id === 'a')!.mood, '专注');
  assert.equal(tagged.find((item) => item.id === 'b')!.mood, undefined);

  const retagged = applyEventMood(tagged, 'a', '放松');
  assert.equal(retagged.find((item) => item.id === 'a')!.mood, '放松');

  const cleared = applyEventMood(retagged, 'a', '');
  assert.equal('mood' in cleared.find((item) => item.id === 'a')!, false);

  // 未知 id / 空 id：不新增、不删除、不修改任何事件。
  // 契约：返回值始终是**归一化后的数组**（按时间倒序），因此这里断言集合等价而非顺序相同。
  const unknown = applyEventMood(events, 'nope', '专注');
  assert.equal(unknown.length, 2);
  assert.ok(unknown.every((item) => item.mood === undefined));
  assert.deepEqual(unknown.map((item) => item.id).sort(), ['a', 'b']);
  assert.equal(applyEventMood(events, '', '专注').length, 2);
  // 不修改入参
  assert.equal(events[0].mood, undefined);
});

test('summarizeMoods：按情绪聚合，次数降序、并列按码位序', () => {
  const events = [
    event('a', 1000, { mood: '专注' }),
    event('b', 2000, { mood: '专注' }),
    event('c', 3000, { mood: '放松' }),
    event('d', 4000, { mood: '伤感' }),
    event('e', 5000, { mood: '伤感' }),
    event('f', 6000),
  ];

  const summary = summarizeMoods(events);
  assert.deepEqual(
    summary.moods.map((item) => [item.mood, item.plays]),
    [
      ['专注', 2],
      ['伤感', 2],
      ['放松', 1],
    ],
  );
  // 并列 2 次时按码位序：伤(U+4F24) < 专(U+4E13)? 实际 专 U+4E13 < 伤 U+4F24
  assert.equal(summary.moods[0].mood, '专注');
  assert.equal(summary.untaggedPlays, 1);
  assert.equal(summary.taggedPlays, 5);
  assert.equal(summary.taggedEvents, 5);
  assert.equal(summary.totalEvents, 6);
});

test('summarizeMoods：合成事件按历史次数计权，空输入返回零值', () => {
  const events = [
    event('a', 1000, { mood: '专注', synthetic: true, baselinePlayCount: 7 }),
    event('b', 2000, { synthetic: true, baselinePlayCount: 3 }),
  ];
  const summary = summarizeMoods(events);
  assert.equal(summary.moods[0].mood, '专注');
  assert.equal(summary.moods[0].plays, 7);
  assert.equal(summary.untaggedPlays, 3);
  assert.equal(summary.totalEvents, 2);

  const empty = summarizeMoods([]);
  assert.deepEqual(empty.moods, []);
  assert.equal(empty.totalEvents, 0);
  assert.equal(empty.taggedEvents, 0);

  const invalid = summarizeMoods('x' as never);
  assert.equal(invalid.totalEvents, 0);
});
