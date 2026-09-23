import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MUSIC_JOURNAL_MAX_EVENTS,
  MUSIC_JOURNAL_SCHEMA_VERSION,
  appendJournalEvent,
  createPlayEvent,
  normalizeJournalState,
  summarizeJournal,
  synthesizeBaselineEvents,
} from '../src/shared/musicJournal.ts';

/**
 * 听歌档案（C2）子批次 1：事件采集与基线合成 —— 纯逻辑测试。
 *
 * 背景（依赖快照，2026-09-21）：
 *   yan-storage 的 play_history 是「一曲一行」（native/yan-storage/src/lib.rs:1366-1376
 *   的 ON CONFLICT(song_key) DO UPDATE），只保留 last_played_at 与 play_count，
 *   **不存在逐次播放事件日志**。因此档案必须自行采集事件；
 *   历史存量只能以「近似基线」形式合成，且必须显式标记为 synthetic，不得伪造时间点。
 */

const song = (overrides: Record<string, unknown> = {}) => ({
  id: 'song-1',
  mixSongId: 'mx-1',
  title: '夜航',
  artist: '某人',
  albumName: '第一张',
  duration: 215,
  source: 'kugou',
  ...overrides,
});

test('normalizeJournalState：非对象输入回落默认值', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const state = normalizeJournalState(bad);
    assert.equal(state.schemaVersion, MUSIC_JOURNAL_SCHEMA_VERSION);
    assert.deepEqual(state.events, []);
    assert.equal(state.baselineSynthesized, false);
  }
});

test('normalizeJournalState：丢弃非法事件并保留合法事件', () => {
  const state = normalizeJournalState({
    events: [
      { id: 'ok', songKey: 'k', title: 't', artist: 'a', playedAt: 1000 },
      { id: '', songKey: 'k', title: 't', artist: 'a', playedAt: 1000 },
      { id: 'no-time', songKey: 'k', title: 't', artist: 'a', playedAt: 'x' },
      { id: 'nan-time', songKey: 'k', title: 't', artist: 'a', playedAt: Number.NaN },
      'not-an-object',
      null,
    ],
  });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].id, 'ok');
});

test('normalizeJournalState：事件按时间倒序且裁剪到上限', () => {
  const events = Array.from({ length: MUSIC_JOURNAL_MAX_EVENTS + 25 }, (_v, index) => ({
    id: `e${index}`,
    songKey: `k${index}`,
    title: 't',
    artist: 'a',
    playedAt: index + 1,
  }));
  const state = normalizeJournalState({ events });
  assert.equal(state.events.length, MUSIC_JOURNAL_MAX_EVENTS);
  // 保留的是最新的那批（时间戳最大）
  assert.equal(state.events[0].playedAt, MUSIC_JOURNAL_MAX_EVENTS + 25);
  assert.equal(state.events.at(-1)!.playedAt, 26);
});

test('normalizeJournalState：数值字段被夹取为非负整数', () => {
  const state = normalizeJournalState({
    events: [
      {
        id: 'e',
        songKey: 'k',
        title: 't',
        artist: 'a',
        playedAt: 5000,
        durationSec: -12.7,
        baselinePlayCount: -3,
      },
    ],
  });
  assert.equal(state.events[0].durationSec, 0);
  assert.equal(state.events[0].baselinePlayCount, 0);
});

test('createPlayEvent：从 Song 提取字段并归一化来源', () => {
  const event = createPlayEvent(song(), 1_700_000_000_000);
  assert.ok(event);
  assert.equal(event!.songKey, 'mx-1');
  assert.equal(event!.title, '夜航');
  assert.equal(event!.artist, '某人');
  assert.equal(event!.album, '第一张');
  assert.equal(event!.durationSec, 215);
  assert.equal(event!.source, 'kugou');
  assert.equal(event!.playedAt, 1_700_000_000_000);
  assert.equal(event!.synthetic, false);

  const unknown = createPlayEvent(song({ source: 'weird-source' }), 1);
  assert.equal(unknown!.source, 'unknown');

  const local = createPlayEvent(song({ source: 'local' }), 1);
  assert.equal(local!.source, 'local');
});

test('createPlayEvent：缺失字段回落占位符，非法时间返回 null', () => {
  const event = createPlayEvent(song({ title: '', artist: '  ', albumName: undefined }), 42);
  assert.ok(event);
  assert.equal(event!.title, '未知曲目');
  assert.equal(event!.artist, '未知歌手');
  assert.equal(event!.album, '');

  assert.equal(createPlayEvent(song(), Number.NaN), null);
  assert.equal(createPlayEvent(song(), -1), null);
  assert.equal(createPlayEvent(null, 1), null);
});

test('createPlayEvent：songKey 在缺少 mixSongId 时回落到 id/fileId', () => {
  assert.equal(createPlayEvent(song({ mixSongId: undefined }), 1)!.songKey, 'song-1');
  assert.equal(
    createPlayEvent(song({ mixSongId: undefined, id: '', fileId: 'f-9' }), 1)!.songKey,
    'f-9',
  );
});

test('appendJournalEvent：追加、裁剪并保持倒序；同 id 幂等', () => {
  const base = [{ id: 'a', songKey: 'k', title: 't', artist: 'a', playedAt: 3000 }] as ReturnType<
    typeof createPlayEvent
  >[];

  const older = createPlayEvent(song(), 1000)!;
  const merged = appendJournalEvent(base as never, older, 10);
  // 时间倒序：playedAt 3000 的既有事件在前，新追加的 1000 在后
  assert.deepEqual(
    merged.map((item) => item.id),
    [base[0]!.id, older.id],
  );
  assert.equal(merged.length, 2);

  // 幂等：同一个事件重复追加不产生第二条
  const again = appendJournalEvent(merged, older, 10);
  assert.equal(again.length, 2);

  // 裁剪：上限为 2 时保留最新的两条
  const newer = createPlayEvent(song(), 9000)!;
  const trimmed = appendJournalEvent(again, newer, 2);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].playedAt, 9000);
});

test('synthesizeBaselineEvents：每曲一条合成事件，标记 synthetic 并携带历史次数', () => {
  const entries = [
    {
      historyKey: 'mx-1:1700000000000',
      lastPlayedAt: 1_700_000_000_000,
      playCount: 7,
      song: {
        mixSongId: 'mx-1',
        title: '夜航',
        artist: '某人',
        albumName: '第一张',
        duration: 200,
      },
    },
  ];
  const events = synthesizeBaselineEvents(entries, 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].synthetic, true);
  assert.equal(events[0].playedAt, 1_700_000_000_000);
  assert.equal(events[0].baselinePlayCount, 7);
  assert.equal(events[0].songKey, 'mx-1');
});

test('synthesizeBaselineEvents：跳过无效条目并遵守上限', () => {
  const entries = [
    { historyKey: 'a:1000', lastPlayedAt: 1000, playCount: 1, song: { mixSongId: 'a' } },
    { historyKey: '', lastPlayedAt: 0, playCount: 1, song: { mixSongId: 'b' } },
    { historyKey: 'c:x', lastPlayedAt: Number.NaN, playCount: 1, song: { mixSongId: 'c' } },
    { historyKey: 'd:4000', lastPlayedAt: 4000, playCount: 2, song: { mixSongId: 'd' } },
  ];
  const events = synthesizeBaselineEvents(entries, 10);
  assert.deepEqual(
    events.map((item) => item.songKey),
    ['d', 'a'],
  );

  const capped = synthesizeBaselineEvents(entries, 1);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].songKey, 'd');
});

test('summarizeJournal：合成事件按历史次数计权，真实事件计 1', () => {
  const real = createPlayEvent(song({ mixSongId: 'real' }), 5000)!;
  const synthetic = synthesizeBaselineEvents(
    [
      {
        historyKey: 'base:1000',
        lastPlayedAt: 1000,
        playCount: 4,
        song: { mixSongId: 'base', title: '旧曲', artist: '旧人' },
      },
    ],
    10,
  );
  const summary = summarizeJournal([...synthetic, real]);

  assert.equal(summary.totalPlays, 5);
  assert.equal(summary.distinctSongs, 2);
  assert.equal(summary.syntheticEvents, 1);
  assert.equal(summary.realEvents, 1);
  assert.equal(summary.firstPlayedAt, 1000);
  assert.equal(summary.lastPlayedAt, 5000);
});
