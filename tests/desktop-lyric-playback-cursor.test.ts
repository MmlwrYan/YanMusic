import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAYBACK_EXTRAPOLATION_LIMIT_MS,
  resolvePlaybackCursorMs,
} from '../src/renderer/desktopLyric/playbackCursor.ts';
import { stripComments } from './helpers/sourceText.ts';

/**
 * 桌面歌词播放游标推算（v1.3.7「歌词卡住」修复的第二半：**接收端**）。
 *
 * ## 缺陷回顾
 *
 * 旧实现在桌面歌词窗口里判断「锚点是否足够新」（`PLAYBACK_STALE_THRESHOLD = 1800`）：
 *
 * ```text
 * if (isPlaying && 锚点 ≤ 1800ms) 外推
 * else                           playSeekMsRaw = baseMs   // 钉死
 * ```
 *
 * 而后台节流会让快照间隔轻易超过 1800ms（见 progressThrottle 的说明），
 * 于是**钉死分支被持续命中** —— 画面永久停在最后一次同步的位置，表现为
 * 「换句时一卡、卡在前面某句中间偏后」，而音频照常播放。
 *
 * 位置本身完全可推：播放中就是「锚点 + 墙钟 × 倍速」。因此改为播放中**一律外推**，
 * 用固定**外推上限**（默认 90s）兜底，避免锚点永久失联时无限跑飞。
 *
 * ⚠️ 鉴别力验证（本文件必须能红；均已实测）：
 *  ① 把 `resolvePlaybackCursorMs` 改回「超过 1800ms 就返回 baseMs」→ 回归用例变红；
 *  ② 去掉时长钳制 → 时长用例变红；
 *  ③ 去掉外推上限 → 上限用例变红；
 *  ④ 从 DesktopLyricView.vue 删掉调用 → 契约用例变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const playing = (overrides: Partial<Parameters<typeof resolvePlaybackCursorMs>[0]> = {}) => ({
  isPlaying: true,
  baseMs: 10_000,
  anchorTick: 1_000,
  nowTick: 1_000,
  ...overrides,
});

test('v1.3.7：未播放时返回锚点位置（不外推）', () => {
  assert.equal(
    resolvePlaybackCursorMs(playing({ isPlaying: false, nowTick: 121_000 })),
    10_000,
    '暂停/拖动后锚点即真实位置，长时间不更新也不应自行推进',
  );
});

test('v1.3.7：播放中按墙钟推进，且尊重倍速', () => {
  assert.equal(resolvePlaybackCursorMs(playing({ nowTick: 1_500 })), 10_500);
  assert.equal(
    resolvePlaybackCursorMs(playing({ nowTick: 1_500, playbackRate: 2 })),
    11_000,
    '倍速 2 时应推进两倍',
  );
});

test('v1.3.7：非法倍速按 1 处理', () => {
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      resolvePlaybackCursorMs(playing({ nowTick: 2_000, playbackRate: rate })),
      11_000,
      `playbackRate=${rate} 应按 1 处理`,
    );
  }
});

test('v1.3.7：锚点时钟在未来时不倒退', () => {
  // 时钟回拨或两处 tick 基准不同时，nowTick 可能小于 anchorTick；
  // 此时必须返回锚点位置，而不是把游标往回推（会造成歌词跳回上一句）。
  assert.equal(resolvePlaybackCursorMs(playing({ nowTick: 500 })), 10_000);
});

test('v1.3.7：【回归】锚点 60s 未更新时仍必须继续推进', () => {
  // 这条直接对应缺陷本身：旧实现会在 1800ms 后钉死。
  // Chromium 隐藏窗口的密集节流可低至 1 次/分钟，故 60s 必须仍在推进。
  assert.equal(
    resolvePlaybackCursorMs(playing({ nowTick: 61_000 })),
    70_000,
    '锚点 60s 未更新时，播放中应继续外推（旧实现会停在 10_000）',
  );
});

test('v1.3.7：外推上限生效，锚点永久失联不会跑飞', () => {
  const limit = PLAYBACK_EXTRAPOLATION_LIMIT_MS;
  const atLimit = resolvePlaybackCursorMs(playing({ nowTick: 1_000 + limit }));
  assert.equal(atLimit, 10_000 + limit);

  // 远超上限：停在上限处，而不是无限增长
  assert.equal(
    resolvePlaybackCursorMs(playing({ nowTick: 1_000 + limit * 10 })),
    atLimit,
    '超过外推上限后不得继续前进',
  );
});

test('v1.3.7：受总时长钳制，且时长未知时不钳制', () => {
  // 锚点放在 60s、当前 65s → 外推 5s，位置 65_000ms
  const at65s = { baseMs: 60_000, anchorTick: 60_000, nowTick: 65_000 };
  assert.equal(
    resolvePlaybackCursorMs(playing({ ...at65s, durationMs: 62_000 })),
    62_000,
    '外推不得超过歌曲总时长',
  );
  assert.equal(
    resolvePlaybackCursorMs(playing({ ...at65s, durationMs: 0 })),
    65_000,
    '时长未知（0）时不做钳制',
  );
});

test('v1.3.7：调用点契约 —— 接收端必须用外推函数，且不得残留「锚点过期即钉死」', () => {
  const view = stripComments(
    readFileSync(path.join(repoRoot, 'src/renderer/desktopLyric/DesktopLyricView.vue'), 'utf8'),
  );

  assert.match(
    view,
    /resolvePlaybackCursorMs\(\{/,
    'DesktopLyricView 必须用 resolvePlaybackCursorMs 推算游标',
  );
  assert.match(
    view,
    /durationMs:\s*\(state\?\.duration \|\| 0\) \* 1000/,
    '快照里的 duration 是**秒**，必须换算为毫秒后再作为 durationMs 传入',
  );

  // 旧机制的残留物必须消失：它们一旦回来，就等于把「钉死」重新接回关键路径。
  assert.doesNotMatch(
    view,
    /PLAYBACK_STALE_THRESHOLD/,
    '不得再残留锚点过期阈值：它正是「后台节流 → 歌词永久卡住」的直接成因',
  );
  assert.doesNotMatch(
    view,
    /lastPlaybackUpdateTick/,
    '不得再残留 lastPlaybackUpdateTick：外推已不依赖锚点新鲜度',
  );
  assert.doesNotMatch(
    view,
    /playSeekMsRaw = baseMs;/,
    '不得再出现「直接钉死 baseMs」的赋值 —— 播放中的位置只能由 resolvePlaybackCursorMs 推算',
  );
});
