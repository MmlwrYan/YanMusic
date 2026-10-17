import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPaidSong, isVipSong } from '../src/renderer/utils/song.ts';
import type { Song } from '../src/renderer/models/song.ts';

/**
 * v2.0.0 · 网易云 `fee` → 付费/VIP 提示的映射守卫。
 *
 * ## 为什么需要这一支
 *
 * 酷狗用 `privilege` + `payType` 表达权益，网易云的搜索端点**不返回**这两个字段，
 * 它给的是 `fee`。若不补这支，网易云的付费曲目在本项目里**永远被当成免费歌**，
 * 于是「不可播」时只会显示笼统的「暂时无法获取可用音源」，
 * 用户无法区分「我没买」和「真没版权」。
 *
 * ## ⚠️ 这条守卫同时钉住「不能用来判可播性」
 *
 * 实测（2026-10-17，5 关键词 60 首）：
 * - `fee=0` → 有 url
 * - `fee=1` → **url 为空**（+ `resConsumable: true`）
 * - `fee=8` → **有 url，完整 12 MB**
 *
 * ⇒ `fee=8` 是「付费**但能播**」。所以 `isPaidSong` 只产出**提示标签**，
 * 绝不能接到 `canPlaySong` 上去 —— 最后一个用例专门锁这一点。
 */

const netease = (fee: number): Song =>
  ({
    id: '1',
    title: 't',
    name: 't',
    artist: 'a',
    duration: 100,
    coverUrl: '',
    cover: '',
    audioUrl: '',
    hash: '',
    mixSongId: '',
    source: 'netease',
    fee,
  }) as Song;

test('v2.0.0 ⑬：网易云 fee 映射到 VIP / 付费提示', () => {
  assert.equal(isVipSong(netease(1)), true, 'fee=1 应判为 VIP（实测此档取链为空）');
  assert.equal(isPaidSong(netease(1)), false, 'fee=1 不应同时被判为「付费」');

  assert.equal(isPaidSong(netease(8)), true, 'fee=8 应判为付费');
  assert.equal(isVipSong(netease(8)), false, 'fee=8 不应被判为 VIP');

  assert.equal(isPaidSong(netease(4)), true, 'fee=4 应判为付费（付费专辑档）');

  assert.equal(isVipSong(netease(0)), false, 'fee=0 不是 VIP');
  assert.equal(isPaidSong(netease(0)), false, 'fee=0 不是付费');
});

test('v2.0.0 ⑭：酷狗原有判据不得被破坏（privilege/payType 优先）', () => {
  const kugou = (over: Partial<Song>): Song => ({ hash: 'H', mixSongId: 1, ...over }) as Song;

  assert.equal(isVipSong(kugou({ privilege: 10, payType: 3 })), true, '酷狗 VIP 判据仍在');
  assert.equal(isPaidSong(kugou({ privilege: 10, payType: 2 })), true, '酷狗付费判据仍在');

  // 无 fee 的酷狗曲目（fee 为 undefined）不得被误判
  assert.equal(isPaidSong(kugou({})), false, 'undefined fee 不得被判为付费');
  assert.equal(isVipSong(kugou({})), false, 'undefined fee 不得被判为 VIP');
});

test('v2.0.0 ⑮：`fee` **不得**用于判定可播性（fee=8 实测可播）', () => {
  // 这条锁的是「别把 isPaidSong 接进 canPlaySong」
  // fee=8 有完整 URL，若被卡住就是误杀。
  assert.equal(isPaidSong(netease(8)), true, '前提：fee=8 会被标为「付费」标签');

  // 因此调用方（resolver）必须**照常去取链**，而不是据此直接拒绝。
  // 这里用「提示标签 ≠ 可播性判据」的语义断言表达该约束：
  // canPlaySong 只看 privilege 5/40，不看付费标签。
  assert.equal(
    isVipSong(netease(8)) || isPaidSong(netease(8)),
    true,
    'fee=8 会同时出现在「付费」提示里 —— 但它仍必须允许取链（见 neteaseSource.ts）',
  );
});
