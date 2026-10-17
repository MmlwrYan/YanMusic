import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlayableSong } from '../src/renderer/utils/song.ts';
import type { Song } from '../src/renderer/models/song.ts';

/**
 * v2.0.0 · 网易云曲目必须被判为「具备取链依据」（**一个真 bug 的回归守卫**）。
 *
 * ## 这个 bug 长什么样（用户实际遇到的现象）
 *
 * 原判据是 `hash || audioUrl`，而网易云曲目：
 * - `hash` 恒为空（网易云没有酷狗 hash，靠 `songId`）；
 * - `audioUrl` 是**懒解析**的，播放前本来就是空。
 *
 * 于是它们一律被判为「不可播」，`resolvePlayableQueue` 把整队列过滤掉并
 * **回退到队列里第一首酷狗歌**（往往是上一次播放留下的队列）。
 *
 * 用户的观察是：
 * - **点了网易云的歌，却播放了另一首**（歌名/封面都对不上）；
 * - **日志里一行 `netease` 都没有** —— 因为取链请求根本没发出去。
 *
 * 这个形态极难从现象反推：看起来像「网易云取链失败」，
 * 实际是**根本没走到取链**。
 *
 * ## 为什么单元的 `isPlayableSong` 就能钉住它
 *
 * 它是队列过滤（`resolvePlayableQueue` / `splitValidSongs`）的唯一判据，
 * 且是纯函数 —— 用真实的网易云曲目形状喂进去即可复现，不需要起 GUI。
 */

/** 真实网易云曲目形状（由 `src/main/netease/map.ts` 产出）。 */
const neteaseSong = (overrides: Partial<Song> = {}): Song =>
  ({
    id: '2684510360',
    songId: '2684510360',
    title: '英雄主义',
    name: '英雄主义',
    artist: '在虚无中永存',
    artists: [{ id: '1', name: '在虚无中永存' }],
    duration: 127,
    coverUrl: 'https://p1.music.126.net/x.jpg?param=300y300',
    cover: '',
    // ⚠️ 这两个正是 bug 的关键：网易云曲目两者都为空
    audioUrl: '',
    hash: '',
    mixSongId: '',
    source: 'netease',
    ...overrides,
  }) as Song;

test('v2.0.0 ⑪：网易云曲目（hash 与 audioUrl 均为空）必须判为可播', () => {
  const song = neteaseSong();
  assert.equal(song.hash, '', '前提：网易云曲目 hash 为空');
  assert.equal(song.audioUrl, '', '前提：网易云曲目 audioUrl 懒解析，播放前为空');

  assert.equal(
    isPlayableSong(song),
    true,
    '网易云曲目必须判为可播 —— 否则会被队列过滤掉，并**回退去播另一首酷狗歌**，' +
      '而日志里连 netease 请求都不会出现（极难排查）',
  );
});

test('v2.0.0 ⑫：酷狗曲目判据不得被放宽（防止顺带改坏原有行为）', () => {
  // 有 hash 的酷狗曲目：可播
  assert.equal(
    isPlayableSong({ hash: 'ABC123', audioUrl: '', mixSongId: 1 } as Song),
    true,
    '带 hash 的酷狗曲目仍应可播',
  );

  // 无 hash 且无 audioUrl、且**不是**网易云来源：仍应判为不可播
  assert.equal(
    isPlayableSong({ hash: '', audioUrl: '', mixSongId: '' } as Song),
    false,
    '无 hash / 无 audioUrl 的**非网易云**曲目仍应不可播 —— ' +
      '这条是防止「为了让网易云能播」而把整个判据放宽成恒真',
  );

  // 无版权（privilege=5）且 oldCpy!==1：即使来源是网易云也不可播
  assert.equal(
    isPlayableSong(neteaseSong({ privilege: 5, oldCpy: 0 })),
    false,
    'canPlaySong 的既有约束对网易云同样适用（无版权时不可播）',
  );
});
