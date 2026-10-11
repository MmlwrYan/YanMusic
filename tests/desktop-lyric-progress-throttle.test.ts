import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeadingEdgeThrottle } from '../src/renderer/desktopLyric/progressThrottle.ts';
import { stripComments, sliceDeclaration } from './helpers/sourceText.ts';

/**
 * 桌面歌词进度推送的节流器（v1.3.7「歌词卡住」修复的第一半：**发送端**）。
 *
 * ## 缺陷回顾
 *
 * 主窗口（`main/window.ts`）是 `backgroundThrottling: true`，窗口被遮挡/最小化时
 * Chromium 会节流渲染层的 `setTimeout`：普通后台节流 ≥1s，隐藏超过 5 分钟进入
 * 「密集节流」后可低至 **1 次/分钟**。
 *
 * 而原实现用 `setTimeout(80ms)` 防抖来推送进度快照（`desktopLyric/sync.ts`）。
 * 于是后台时快照流变得极稀疏 → 桌面歌词（过期阈值 1.8s）**硬钉在最后一次同步的
 * 位置不再推进** → 用户所见「换句时一卡、卡在前面某句中间偏后，音乐却正常播放」。
 *
 * 修法：改为**按调用时刻判断**的领先沿节流，**完全不注册定时器** ——
 * 数据源（主进程 200ms 推送的 `mpv:time-update`）与 Vue watcher（微任务）
 * 都不受定时器节流影响。
 *
 * ⚠️ 鉴别力验证（本文件必须能红；均已实测）：
 *  ① 让 `shouldRun()` 在抑制分支里也更新 `lastRunAt` → 「抑制不推进基准」用例变红；
 *  ② 把 `shouldRun()` 改成恒 `true` → 「间隔内抑制」用例变红；
 *  ③ 把 `sync.ts` 的 `scheduleProgressSync` 改回 `setTimeout` → 契约用例变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可控时钟：完全脱离真实定时器，证明节流只依赖调用时刻。 */
const createClock = (start = 0) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

test('v1.3.7：首次调用立即放行（领先沿）', () => {
  const clock = createClock(1_000);
  const throttle = createLeadingEdgeThrottle(80, clock.now);
  assert.equal(throttle.shouldRun(), true);
});

test('v1.3.7：间隔内抑制，到达间隔后放行', () => {
  const clock = createClock(0);
  const throttle = createLeadingEdgeThrottle(80, clock.now);

  assert.equal(throttle.shouldRun(), true, '首次应放行');
  clock.advance(79);
  assert.equal(throttle.shouldRun(), false, '79ms < 80ms 应抑制');
  clock.advance(1);
  assert.equal(throttle.shouldRun(), true, '满 80ms 应放行');
});

test('v1.3.7：被抑制的调用**不得**推进时间基准', () => {
  // 这条是节流器语义的核心：否则密集到达的调用会把窗口一直往后推，
  // 形成「饥饿」——数据源越密集反而越久不推送。
  const clock = createClock(0);
  const throttle = createLeadingEdgeThrottle(80, clock.now);

  assert.equal(throttle.shouldRun(), true);
  for (let i = 1; i <= 79; i++) {
    clock.advance(1);
    assert.equal(throttle.shouldRun(), false, `第 ${i}ms 应抑制`);
  }
  clock.advance(1); // 累计 80ms
  assert.equal(throttle.shouldRun(), true, '从**上次真正执行**起算满 80ms 即放行');
});

test('v1.3.7：后台节流场景 —— 间隔 60s 后仍然放行（不依赖定时器）', () => {
  // 旧实现把「下一次推送」交给 setTimeout；定时器被节流到 1 次/分钟时，
  // 推送随之稀疏。本实现只看调用时刻，因此这里必须放行。
  const clock = createClock(0);
  const throttle = createLeadingEdgeThrottle(80, clock.now);

  assert.equal(throttle.shouldRun(), true);
  clock.advance(60_000);
  assert.equal(throttle.shouldRun(), true);
  clock.advance(60_000);
  assert.equal(throttle.shouldRun(), true);
});

test('v1.3.7：reset 之后必定放行', () => {
  const clock = createClock(0);
  const throttle = createLeadingEdgeThrottle(80, clock.now);

  assert.equal(throttle.shouldRun(), true);
  clock.advance(10);
  assert.equal(throttle.shouldRun(), false);
  throttle.reset();
  assert.equal(throttle.shouldRun(), true, 'reset 后不应再受上次时间约束');
});

test('v1.3.7：非法间隔按「不节流」处理（永远放行）', () => {
  for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const clock = createClock(0);
    const throttle = createLeadingEdgeThrottle(interval, clock.now);
    assert.equal(throttle.shouldRun(), true, `interval=${interval} 首次应放行`);
    assert.equal(throttle.shouldRun(), true, `interval=${interval} 第二次也应放行`);
  }
});

test('v1.3.7：调用点契约 —— 发送端必须用领先沿节流且不得注册定时器', () => {
  const source = stripComments(
    readFileSync(path.join(repoRoot, 'src/renderer/desktopLyric/sync.ts'), 'utf8'),
  );

  const schedule = sliceDeclaration(source, 'const scheduleProgressSync = ', assert.ok);
  assert.match(
    schedule,
    /progressThrottle\.shouldRun\(\)/,
    'scheduleProgressSync 必须使用领先沿节流器（否则后台定时器节流会再次让快照流稀疏）',
  );
  assert.doesNotMatch(
    schedule,
    /setTimeout/,
    'scheduleProgressSync **不得**注册定时器 —— 主窗口 backgroundThrottling:true 会把它' +
      '节流到 ≥1s、密集节流下可低至 1 次/分钟，这正是「歌词卡住」的成因',
  );
  assert.doesNotMatch(
    source,
    /progressSyncTimer|progressSyncQueued/,
    '旧的定时器防抖状态（progressSyncTimer / progressSyncQueued）必须彻底移除，' +
      '否则容易在后续重构里被重新接回关键路径',
  );
  assert.match(
    source,
    /createLeadingEdgeThrottle\(DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS\)/,
    '节流器应使用既有的推送间隔常量创建',
  );
});
