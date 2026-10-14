import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';

/**
 * **仅供端到端验证**的最小测试钩子（V4-07，v1.4.0）。
 *
 * ## 为什么必须有它
 *
 * 桌面歌词的播放游标由 `desktopLyric/sync.ts` 的 `buildPlaybackPayload()` 驱动，
 * 而它的数据源是 **player store 的 `isPlaying` / `currentTime`**，不是 mpv 本身。
 * 端到端脚本能调到的只有 `window.electron.mpv.*`：
 *
 * **直接调 `mpv.load()` + `mpv.play()` 不会把 store 的 `isPlaying` 置为 true。**
 * 这一点已实测确认（2026-10-14）：日志显示 `[MpvController]` 已就绪，但歌词窗口
 * 读到的 `data-yan-lyric-playing` 恒为 `false`、游标恒为 `0ms` —— 于是「红」与「绿」
 * 都不反映真实播放，这样的护栏毫无意义。
 *
 * ## 它刻意走**真实**播放链路
 *
 * 用生产代码里**已有的** `preResolved` 选项（一起听房间授权音源走的就是它）
 * 把「取音频 URL」这一步换成固定本地音源，其余全部走生产代码：
 * `playTrack()` → `engine.setSource()` → `engine.play()` → `play` 事件
 * → `state.isPlaying = true` → `desktopLyric/sync` 推快照。
 * 也就是说 **v1.3.7 修复的那条链路（含 `progressThrottle`）是被完整执行的**，
 * 而不是被绕过去造一个假状态。
 *
 * ⚠️ 曾经试过「给 store 的 `resolveAudioUrl` 打补丁」——**行不通**：
 * `playback.ts` 闭包持有 `resolver` 对象，闭包里调的是 `resolver.resolveAudioUrl`，
 * 替换 store 上的同名 action 根本影响不到它（已实测确认）。`preResolved`
 * 是唯一**公开且受支持**的入口，且不引入任何 monkey-patching。
 *
 * ## 安全边界（重要）
 *
 * 整段代码由**构建期常量**判定：`VITE_YANMUSIC_E2E` 未设置时会被 rolldown
 * **静态消除**，不进入正式发布产物（有测试守卫，见
 * `tests/e2e-hook-not-in-production.test.ts`）。
 *
 * 之所以只靠构建期开关、**不再加运行时 URL 校验**：主窗口的 URL 由主进程
 * `createWindow()` 决定（`loadFile(dist/index.html)` 或 `VITE_DEV_SERVER_URL`），
 * **命令行传入的 URL 与 query 会被完全忽略** —— 这一点已实测确认（2026-10-14：
 * 传 `index.html?yanmusicE2e=1` 后，渲染层里 `location.search` 为空串）。
 * 保留一个永远为假的运行时条件只会误导读者，故删除。
 */

/** 测试曲目的固定 id（脚本侧不依赖它的具体值，只在钩子内部使用）。 */
const E2E_SONG_ID = '__yanmusic_e2e_tone__';

export const installE2eTestHook = (): void => {
  // ⚠️ **不要**在这里加 `import.meta.env.DEV` 条件：冒烟脚本跑的是**生产构建**
  // （`vite build`），`DEV` 恒为 false，两者相与会让整个函数体变成死代码，
  // 被 rolldown 直接消除 —— 钩子永远装不上（本项第一次实现就栽在这里）。
  // 因此**唯一**的开关就是 `VITE_YANMUSIC_E2E`。
  if (import.meta.env.VITE_YANMUSIC_E2E !== '1') return;

  const testApi = {
    /**
     * 用真实播放链路播放一个本地测试音源。
     *
     * `Song` 的必填字段见 `models/song.ts`：title / coverUrl / mixSongId
     * 缺一个都过不了类型检查，故这里填最小可用值。
     */
    async playTone(url: string) {
      if (!url?.trim()) throw new Error('playTone 需要一个音频 URL');

      const playlistStore = usePlaylistStore();
      const playerStore = usePlayerStore();

      const song = {
        id: E2E_SONG_ID,
        songId: E2E_SONG_ID,
        hash: 'e2e-tone-hash',
        name: 'E2E tone',
        title: 'E2E tone',
        artist: 'smoke',
        artists: [{ name: 'smoke' }],
        album: 'smoke',
        albumName: 'smoke',
        coverUrl: '',
        mixSongId: E2E_SONG_ID,
        duration: 300,
        audioUrl: url,
        source: 'local',
      };

      // 挂进默认列表，让 playTrack 能按 id 找到它
      const list = Array.isArray(playlistStore.defaultList) ? [...playlistStore.defaultList] : [];
      const withoutPrev = list.filter((item) => String(item?.id) !== E2E_SONG_ID);
      playlistStore.defaultList = [...withoutPrev, song] as never;

      // **走生产代码已有的 `preResolved`**：跳过取流解析，其余链路完全真实。
      // 不用 monkey-patching 的原因见文件头注释（打补丁对闭包无效）。
      await playerStore.playTrack(E2E_SONG_ID, playlistStore.defaultList, {
        autoPlay: true,
        preResolved: {
          url,
          urls: [url],
          quality: null,
          effect: 'none',
          loudness: null,
        },
      });
      return true;
    },

    /** 读 store 的真实播放状态 —— 把「脚本以为在放」与「store 认为在放」区分开。 */
    state() {
      const playerStore = usePlayerStore();
      return JSON.stringify({
        isPlaying: playerStore.isPlaying,
        currentTime: playerStore.currentTime,
        duration: playerStore.duration,
        isLoading: playerStore.isLoading,
        lastError: playerStore.lastError,
        currentTrackId: playerStore.currentTrackId,
      });
    },

    async pause() {
      await usePlayerStore().togglePlay();
      return true;
    },

    /**
     * V4-07：桌面歌词游标采样 —— **非阻塞**版。
     *
     * ## 为什么不能用「一次长时 await」
     *
     * 前两版都栽在同一处，且症状极具误导性：
     *
     *   · 第一版：由**脚本**每 400ms 通过 CDP `Runtime.evaluate` 读一次
     *     `data-yan-lyric-timeline-ms`（20 秒约 100 次往返）；
     *   · 第二版：把采样搬进页面，但由脚本发一次
     *     `Runtime.evaluate({ awaitPromise: true })` **阻塞等 20 秒**。
     *
     * 两版都让**脚本进程** RSS 在 1.5 秒内冲到 ~2GB 并
     * `FATAL ERROR: Ineffective mark-compacts near heap limit`（退出码 134）。
     * 而 `process.memoryUsage()` 的 `heapUsed` 全程只有 9MB、`external` /
     * `arrayBuffers` 也都正常 —— 常规内存诊断完全指不到它。
     * 已实测排除：不是 Electron 侧（其各 target 堆稳定在 6–14MB）、
     * 不是我的 heap 上限（`--max-old-space-size` 各种取值同样崩）。
     *
     * **结论：在 Node 24 + 内建 WebSocket 上，让一次 CDP `Runtime.evaluate`
     * 长时间 pending 会触发这个爆内存。** 因此本版改成：
     *   `start…` 立即返回（只挂一个 `setInterval`），由脚本用**短**求值轮询。
     *
     * 判据本身不受影响：它只看「同一游标值持续了多久」。
     */
    startDesktopLyricTimelineRecording(pollMs = 400) {
      const state = { samples: [] as Array<{ at: number; ms: number; playing: string }> };
      (window as unknown as { __YANMUSIC_E2E_REC__?: typeof state }).__YANMUSIC_E2E_REC__ = state;
      const started = Date.now();
      const timer = window.setInterval(() => {
        const el = document.querySelector('[data-yan-lyric-host="desktop"]');
        if (!el) return;
        state.samples.push({
          at: Date.now() - started,
          ms: Number((el as HTMLElement).dataset.yanLyricTimelineMs ?? 'NaN'),
          playing: (el as HTMLElement).dataset.yanLyricPlaying ?? '',
        });
      }, pollMs);
      (window as unknown as { __YANMUSIC_E2E_REC_TIMER__?: number }).__YANMUSIC_E2E_REC_TIMER__ =
        timer;
      return true;
    },

    /** 读取已采到的样本（短求值，不阻塞）。 */
    readDesktopLyricTimelineRecording() {
      const state = (window as unknown as { __YANMUSIC_E2E_REC__?: { samples: unknown[] } })
        .__YANMUSIC_E2E_REC__;
      return JSON.stringify(state?.samples ?? []);
    },

    /** 停止采样（清掉定时器，避免测试结束后继续跑）。 */
    stopDesktopLyricTimelineRecording() {
      const w = window as unknown as { __YANMUSIC_E2E_REC_TIMER__?: number };
      if (w.__YANMUSIC_E2E_REC_TIMER__) window.clearInterval(w.__YANMUSIC_E2E_REC_TIMER__);
      return true;
    },
  };

  Object.defineProperty(window, '__YANMUSIC_E2E__', {
    value: testApi,
    configurable: true,
    enumerable: false,
    writable: false,
  });
};
