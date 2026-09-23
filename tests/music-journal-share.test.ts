import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildJournalShareText,
  buildJournalView,
  type JournalPlayEvent,
} from '../src/shared/musicJournal.ts';

/**
 * 听歌档案（C2）子批次 5：导出/分享 —— 纯逻辑测试 + 通道未新增守卫。
 *
 * 口径：导出**复用既有 IPC 通道**（`share:capture-rect-to-clipboard` 截图、
 * `share:copy` 文本），因此本批次的验收包含一条「未新增 IPC 通道」的静态守卫，
 * 防止实现过程中偷偷加通道（那属于对外接口变更，必须显式声明）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 480;

const local = (year: number, month: number, day: number, hour = 0): number =>
  Date.UTC(year, month - 1, day, hour) - TZ * 60_000;

const event = (
  id: string,
  playedAt: number,
  extra: Partial<JournalPlayEvent> = {},
): JournalPlayEvent => ({
  id,
  songKey: `k-${id}`,
  title: `曲-${id}`,
  artist: `人-${id}`,
  album: `专-${id}`,
  durationSec: 200,
  playedAt,
  source: 'kugou',
  synthetic: false,
  baselinePlayCount: 0,
  ...extra,
});

test('buildJournalShareText：包含年份、总量与 Top5', () => {
  // 同一首歌的两次播放：id 不同（真实 id 方案是 `${songKey}:${playedAt}`）、songKey 相同
  const events = [
    { ...event('a1', local(2026, 3, 9, 10)), songKey: 'k-a', title: '曲-a', artist: '人-a' },
    { ...event('a2', local(2026, 3, 10, 11)), songKey: 'k-a', title: '曲-a', artist: '人-a' },
    event('b', local(2026, 3, 10, 12)),
  ];
  const text = buildJournalShareText(
    buildJournalView(events, {
      now: local(2026, 3, 10, 12),
      days: 7,
      weeks: 4,
      year: 2026,
      timeZoneOffsetMinutes: TZ,
    }),
  );

  assert.match(text, /2026 年听歌档案/);
  assert.match(text, /总播放 3 次/);
  assert.match(text, /曲目 2 首/);
  assert.match(text, /1\. 曲-a — 人-a（2 次）/);
  assert.match(text, /2\. 曲-b — 人-b（1 次）/);
  // 只取前 5 条
  assert.equal((text.match(/^\d+\. /gm) ?? []).length, 2);
});

test('buildJournalShareText：有近似基线时显式声明，无则不提', () => {
  const withSynthetic = buildJournalView(
    [event('s', local(2026, 3, 10, 8), { synthetic: true, baselinePlayCount: 4 })],
    {
      now: local(2026, 3, 10, 12),
      days: 7,
      weeks: 4,
      year: 2026,
      timeZoneOffsetMinutes: TZ,
    },
  );
  const text = buildJournalShareText(withSynthetic);
  assert.match(text, /近似基线/);
  assert.match(text, /总播放 4 次/);

  const withoutSynthetic = buildJournalView([event('a', local(2026, 3, 10, 8))], {
    now: local(2026, 3, 10, 12),
    days: 7,
    weeks: 4,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });
  assert.equal(/近似基线/.test(buildJournalShareText(withoutSynthetic)), false);
});

test('buildJournalShareText：空数据返回可读文案且不抛错', () => {
  const empty = buildJournalView([], {
    now: local(2026, 3, 10, 12),
    days: 7,
    weeks: 4,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });
  const text = buildJournalShareText(empty);
  assert.match(text, /2026 年听歌档案/);
  assert.match(text, /总播放 0 次/);
  assert.match(text, /暂无记录/);

  assert.doesNotThrow(() => buildJournalShareText(null as never));
  assert.equal(typeof buildJournalShareText(null as never), 'string');
});

test('导出未新增 IPC 通道（复用 share:copy / share:capture-rect-to-clipboard）', () => {
  const ipcDir = path.join(repoRoot, 'src', 'main', 'ipc');
  const ipcSources = readdirSync(ipcDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(path.join(ipcDir, name), 'utf8'))
    .join('\n');
  const preloadSource = readFileSync(path.join(repoRoot, 'src', 'preload', 'index.ts'), 'utf8');

  // 不应存在任何名为 journal* 的通道
  const channelPattern = /register(?:Handler|Listener)\(\s*['"`]([^'"`]+)/g;
  const channels: string[] = [];
  for (const match of ipcSources.matchAll(channelPattern)) channels.push(match[1]);
  assert.ok(channels.length > 0, '未解析到任何 IPC 通道，守卫失效');
  assert.deepEqual(
    channels.filter((channel) => /journal/i.test(channel)),
    [],
    '听歌档案新增了 IPC 通道；若确需新增必须显式声明为对外接口变更',
  );

  // preload 也不应出现 journal 通道
  assert.equal(/['"`][a-z-]*journal/i.test(preloadSource), false);

  // 导出所依赖的既有通道必须仍在
  assert.ok(ipcSources.includes("'share:copy'") || ipcSources.includes('"share:copy"'));
  assert.ok(
    ipcSources.includes('share:capture-rect-to-clipboard'),
    '截图导出通道缺失，导出功能会失效',
  );
});
