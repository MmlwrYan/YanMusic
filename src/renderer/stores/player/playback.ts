import logger from '@/utils/logger';
import type { Song } from '@/models/song';
import { isPlayableSong } from '@/utils/song';
import type { PlayerState } from './state';
import type { PlayerEngine } from '@/utils/player';
import type { usePlaylistStore } from '../playlist';
import type { useSettingStore } from '../setting';
import { PERSONAL_FM_QUEUE_ID, type PlaybackQueueState } from '../playlist';
import { toRawSong, toRawSongList } from '../playlist/helpers';
import { useHistoryStore } from '../historyStore';
import {
  buildMediaMeta,
  buildMediaState,
  buildStoppedPlaybackState,
  clampNumber,
  findPlayableIndex,
  findTrackById,
} from './utils';
import type { PlaybackSourceKind, ResolvedAudioSource } from './types';

export const createPlaybackManager = (
  state: PlayerState,
  engine: PlayerEngine,
  playlistStore: ReturnType<typeof usePlaylistStore>,
  settingStore: ReturnType<typeof useSettingStore>,
  lyricStore: any,
  resolver: any,
  historyManager: any,
  showPlaybackNotice: (code: string, track?: Song | null) => void,
  clearPlaybackNotice: (trackId?: string | number | null) => void,
) => {
  const applyFailedPlaybackState = (options?: { keepResolvedSource?: boolean }) => {
    state.isLoading = false;
    state.isPlaying = false;
    state.currentTime = 0;
    state.currentTimeUpdatedAt = Date.now();
    state.duration = 0;
    state.awaitingTrackLoad = false;
    if (!options?.keepResolvedSource) {
      state.currentAudioUrl = '';
      state.currentAudioCandidateUrls = [];
      state.currentAudioCandidateIndex = -1;
      state.currentResolvedAudioQuality = null;
      state.currentResolvedAudioEffect = 'none';
    }
    engine.updateMediaPlaybackState(buildStoppedPlaybackState(state));
  };

  const getAudioCandidateUrls = (resolved: ResolvedAudioSource): string[] => {
    const urls: string[] = [];
    [resolved.url, ...(resolved.urls ?? [])].forEach((url) => {
      const candidate = String(url || '').trim();
      if (candidate && !urls.includes(candidate)) urls.push(candidate);
    });
    return urls;
  };

  const applyResolvedAudioSource = (track: Song, resolved: ResolvedAudioSource) => {
    const urls = getAudioCandidateUrls(resolved);
    const currentIndex = Math.max(0, urls.indexOf(resolved.url));
    state.currentAudioQualityOverride = null;
    state.currentAudioUrl = resolved.url;
    state.currentAudioCandidateUrls = urls.length ? urls : resolved.url ? [resolved.url] : [];
    state.currentAudioCandidateIndex = currentIndex;
    state.currentResolvedAudioQuality = resolved.quality;
    state.currentResolvedAudioEffect = resolved.effect;
    track.audioUrl = resolved.url;
  };

  // 预解析音源（preResolved，一起听房间授权地址）的一次性完整解析兜底。
  // 房间授权地址可能在 setSource 成功之后才由 mpv 报告解码错误，此时本地候选链
  // 往往只有一个地址（urls: [roomUrl]），必须回退到完整解析链。
  // 未调用方传入 preResolved 时该变量恒为 null，consumeDeferredPreResolvedFallback
  // 立即返回 false，既有播放路径行为完全不变。
  let deferredPreResolvedFallback: {
    trackId: string;
    onFailure?: (reason: string) => void;
    consumed: boolean;
  } | null = null;

  const consumeDeferredPreResolvedFallback = async (options?: {
    reason?: string;
    autoPlay?: boolean;
    trackId?: string;
  }): Promise<boolean> => {
    const deferred = deferredPreResolvedFallback;
    if (!deferred || deferred.consumed) return false;

    // 关键护栏：只允许为「当前正在失败重试的那一首」消费兜底任务。
    // 否则上一首遗留的 deferred 任务会在新曲目出错时被误消费，
    // 导致把旧曲目的完整解析结果加载进当前播放（串歌）。
    const trackId = String(options?.trackId ?? state.currentTrackId ?? '');
    if (!trackId || deferred.trackId !== trackId) return false;

    const track =
      findTrackById(trackId, state.currentPlaylist, playlistStore) || state.currentTrackSnapshot;
    if (!track) return false;

    // “取值 → 标记 → 清空”在首个 await 之前同步完成：JS 单线程内不会被另一次
    // 事件回调穿插，因此并发的 error/stalled 事件只能有一个消费这次兜底。
    deferred.consumed = true;
    deferredPreResolvedFallback = null;

    const reason = options?.reason ?? 'pre-resolved-candidate-exhausted';
    try {
      deferred.onFailure?.(reason);
    } catch (error) {
      logger.warn('PlayerPlayback', 'Pre-resolved failure callback failed:', error);
    }

    const rejectedUrl = state.currentAudioUrl;
    try {
      // forceReload 取回完整解析链结果，并排除已经失败的预解析地址
      const fallbackResolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      if (String(state.currentTrackId ?? '') !== trackId) return false;
      if (!fallbackResolved?.url || fallbackResolved.url === rejectedUrl) return false;

      applyResolvedAudioSource(track, fallbackResolved);
      state.lastError = null;
      state.isLoading = true;
      state.awaitingTrackLoad = true;
      logger.info('PlayerPlayback', 'Retrying with fully resolved audio source', {
        trackId,
        reason,
      });
      engine.reloadSource(fallbackResolved.url);
      // 与 playTrack 一致：仅在调用方没有显式要求不自动播放时才起播
      if (options?.autoPlay !== false) {
        await engine.play();
        if (String(state.currentTrackId ?? '') !== trackId) return false;
        state.isLoading = false;
        state.isPlaying = true;
      }
      return true;
    } catch (error) {
      logger.warn('PlayerPlayback', 'Pre-resolved fallback failed:', error);
      return false;
    }
  };

  const tryNextAudioCandidate = async (options?: {
    position?: number;
    reason?: string;
    autoPlay?: boolean;
    trackId?: string;
  }): Promise<boolean> => {
    const trackId = String(options?.trackId ?? state.currentTrackId ?? '');
    if (!trackId) return false;
    const candidates = state.currentAudioCandidateUrls;
    // 单候选源仍可能登记了延迟的 preResolved 完整解析兜底，不能在这里直接返回。
    if (candidates.length <= 1) {
      return await consumeDeferredPreResolvedFallback({
        reason: options?.reason,
        autoPlay: options?.autoPlay,
        trackId,
      });
    }

    const track =
      findTrackById(trackId, state.currentPlaylist, playlistStore) || state.currentTrackSnapshot;
    if (!track) return false;

    let nextIndex = state.currentAudioCandidateIndex + 1;
    while (nextIndex >= 0 && nextIndex < candidates.length) {
      const nextUrl = candidates[nextIndex];
      if (!nextUrl || nextUrl === state.currentAudioUrl) {
        nextIndex += 1;
        continue;
      }

      state.currentAudioCandidateIndex = nextIndex;
      state.currentAudioUrl = nextUrl;
      track.audioUrl = nextUrl;
      state.isLoading = true;
      state.awaitingTrackLoad = true;
      state.lastError = null;

      const targetPosition = Math.max(0, Number(options?.position) || 0);
      if (targetPosition > 0) {
        state.stallRecovering = true;
        state.stallRecoverTarget = targetPosition;
        state.stallRecoverDeadline = Date.now() + 20000;
        state.currentTime = targetPosition;
        state.currentTimeUpdatedAt = Date.now();
      }

      logger.warn('PlayerPlayback', 'Trying fallback audio url', {
        trackId,
        reason: options?.reason ?? 'playback-error',
        candidate: nextIndex + 1,
        total: candidates.length,
      });

      try {
        engine.reloadSource(nextUrl);
        await engine.play();
        if (String(state.currentTrackId ?? '') !== trackId) return false;
        if (targetPosition > 0) engine.seek(targetPosition);
        return true;
      } catch (error) {
        logger.warn('PlayerPlayback', 'Fallback audio url failed:', error);
        nextIndex += 1;
      }
    }

    // 候选全部失效后，消费一次性 preResolved 完整解析兜底
    return await consumeDeferredPreResolvedFallback({
      reason: options?.reason,
      autoPlay: options?.autoPlay,
      trackId,
    });
  };

  const clearAutoNextTimer = () => {
    if (state.autoNextTimer !== null) {
      window.clearTimeout(state.autoNextTimer);
      state.autoNextTimer = null;
    }
  };

  const skipToNextAfterFailure = async () => {
    playlistStore.syncQueuedNextTrackIds();
    if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
      const currentTrack =
        findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
        state.currentTrackSnapshot;
      void playlistStore.ensurePersonalFmQueue({
        track: currentTrack,
        playtime: state.currentTime,
        isOverplay: false,
      });
    }
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0 || !state.currentTrackId) return;

    const currentIndex = list.findIndex((song) => String(song.id) === String(state.currentTrackId));
    let nextIndex = -1;

    if (state.playMode === 'random') {
      nextIndex = pickRandomIndex(list.length, currentIndex);
      if (!isPlayableSong(list[nextIndex]))
        nextIndex = findPlayableIndex(list, nextIndex, true, false);
    } else {
      nextIndex = findPlayableIndex(list, Math.max(0, currentIndex), true, false);
    }

    const nextSong = nextIndex >= 0 ? list[nextIndex] : null;
    if (!nextSong) return;

    return playTrack(String(nextSong.id), list, {
      preserveFailureChain: true,
      sourceQueueId: state.currentSourceQueueId,
    });
  };

  const scheduleAutoNext = () => {
    // 一起听房间内听众由房主驱动切歌，本地不得自行兜底推进。
    // autoNextSuppressed 默认 false，既有自动切歌行为不变。
    if (state.autoNextSuppressed) return;
    if (!settingStore.autoNext || !state.currentTrackId) return;
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length <= 1) return;

    const currentTrackId = String(state.currentTrackId);
    const maxAttempts = Math.max(0, Math.floor(settingStore.autoNextMaxAttempts || 0));
    if (maxAttempts > 0 && state.autoNextAttempts >= maxAttempts) return;

    clearAutoNextTimer();
    const delayMs = Math.max(0, Math.floor((settingStore.autoNextDelaySeconds || 0) * 1000));
    state.autoNextTimer = window.setTimeout(() => {
      state.autoNextTimer = null;
      if (
        String(state.currentTrackId ?? '') !== currentTrackId ||
        state.isPlaying ||
        state.isLoading
      )
        return;
      state.autoNextAttempts += 1;
      void skipToNextAfterFailure();
    }, delayMs);
  };

  const playTrack = async (
    id: string,
    playlist?: Song[],
    options?: {
      preserveFailureChain?: boolean;
      autoPlay?: boolean;
      sourceQueueId?: string | null;
      // 可选扩展（一起听房间授权音源）：直接注入已解析音源，跳过完整解析链。
      // 不传时下方解析逻辑与改动前逐字节等价，既有播放行为零回归。
      preResolved?: ResolvedAudioSource;
      // Echo 的插件音源转换阶段标记。Yan 无插件音源流水线，此字段仅作兼容占位，
      // 不参与任何决策。
      preResolvedStage?: PlaybackSourceKind;
      // 预解析音源播放失败时，是否回退到完整解析链
      fallbackOnPreResolvedFailure?: boolean;
      // 回退发生时的一次性通知（用于把房间授权地址标记为不可用）
      onPreResolvedFailure?: (reason: string) => void;
    },
  ) => {
    const requestSeq = ++state.playbackRequestSeq;
    state.historyLocalRecorded = false;
    const recordLocalHistoryOnce = (song: Song) => {
      if (requestSeq !== state.playbackRequestSeq) return;
      if (state.historyLocalRecorded) return;
      state.historyLocalRecorded = true;
      void useHistoryStore().recordPlay(song);
    };
    const sourceList = playlist
      ? toRawSongList(playlist)
      : (playlistStore.activeQueue?.songs ?? playlistStore.defaultList);
    const resolvedId = String(id);
    clearAutoNextTimer();
    if (!options?.preserveFailureChain) {
      state.autoNextAttempts = 0;
      state.autoNextSourceTrackId = null;
    }
    const track =
      sourceList.find((s) => String(s.id) === resolvedId) ||
      playlistStore.favorites.find((s) => String(s.id) === resolvedId);

    if (!track) return;

    if (!isPlayableSong(track)) {
      state.lastError = 'track-not-playable';
      state.currentTrackSnapshot = toRawSong(track);
      state.currentTrackId = resolvedId;
      state.currentPlaylist = sourceList;
      showPlaybackNotice('track-not-playable', track);
      applyFailedPlaybackState();
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
      return;
    }

    const autoPlay = options?.autoPlay ?? true;
    const wasPlaying = autoPlay ? state.isPlaying : false;

    if (wasPlaying && settingStore.volumeFade) {
      const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
      await engine.pause({ fadeOut: true, fadeDurationMs: fadeMs });
    }

    if (requestSeq !== state.playbackRequestSeq) return;

    // 不调用 engine.reset()，避免释放音频设备导致多设备同步抢占
    // mpv 的 loadFile 会直接替换当前文件，无需先 stop
    engine.setPlaybackRate(state.playbackRate);

    state.currentTrackId = resolvedId;
    state.currentSourceQueueId =
      options?.sourceQueueId ??
      playlistStore.activeQueue?.id ??
      playlistStore.activeQueueId ??
      null;
    const snapshot = toRawSong(track);
    state.currentTrackSnapshot = snapshot;
    historyManager.resetHistoryUploadState(track);
    state.currentPlaylist = sourceList;
    playlistStore.updateQueueCurrentTrack(
      resolvedId,
      state.currentSourceQueueId ?? playlistStore.activeQueue?.id ?? playlistStore.activeQueueId,
    );
    state.currentAudioUrl = '';
    state.currentAudioCandidateUrls = [];
    state.currentAudioCandidateIndex = -1;
    state.currentResolvedAudioQuality = null;
    state.currentResolvedAudioEffect = 'none';
    state.currentTime = 0;
    state.currentTimeUpdatedAt = Date.now();
    state.duration = 0;
    state.isPlaying = false;
    state.isLoading = true;
    state.lastError = null;
    state.stallRecovering = false;
    // 开启切歌加载护栏：在新文件 file-loaded 之前丢弃上一首的残留进度回报
    state.awaitingTrackLoad = true;
    clearPlaybackNotice();
    state.climaxMarks = [];

    playlistStore.consumeQueuedNextTrackId(id);
    playlistStore.syncQueuedNextTrackIds();

    const lyricHash = String(track.hash ?? track.id ?? '');
    if (track.lyric) {
      lyricStore.setLyric(track.lyric, lyricHash);
    } else if (lyricHash) {
      lyricStore.clear(lyricHash, '歌词加载中...');
    } else {
      lyricStore.clear('', '暂无歌词');
    }

    if (lyricHash) {
      void lyricStore.fetchLyrics(lyricHash, {
        preserveCurrent: Boolean(track.lyric),
        duration: track.duration ? track.duration * 1000 : 0,
        track,
      });
    }

    // 未使用预解析音源的普通切歌：作废上一首遗留的一次性兜底任务
    if (!options?.preResolved) deferredPreResolvedFallback = null;

    const pendingMediaMeta = buildMediaMeta(track);
    if (pendingMediaMeta) {
      engine.updateMediaMetadata({
        ...pendingMediaMeta,
        durationMs: (track.duration || 0) * 1000,
      });
    }
    // 切歌期间不发送 Paused 状态，避免蓝牙耳机多点连接将音频路由切走
    // 保持上一首的 Playing 状态，直到新歌开始播放或加载失败

    // 一起听房间授权音源：调用方已解析好地址时直接采用，跳过完整解析链。
    // 未传 preResolved 时走原有 resolver.resolveAudioUrl，路径与改动前一致。
    const usedPreResolvedSource = Boolean(options?.preResolved?.url);
    const resolved = usedPreResolvedSource
      ? (options?.preResolved as ResolvedAudioSource)
      : await resolver.resolveAudioUrl(track);
    if (requestSeq !== state.playbackRequestSeq) return;

    if (!resolved.url) {
      state.lastError = 'audio-url-unavailable';
      state.currentTrackSnapshot = toRawSong(track);
      state.currentTrackId = resolvedId;
      state.currentPlaylist = sourceList;
      showPlaybackNotice('audio-url-unavailable', track);
      applyFailedPlaybackState();
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
      return;
    }

    applyResolvedAudioSource(track, resolved);
    // 登记一次性完整解析兜底：预解析地址可能在 setSource 成功后才由 mpv 报解码错误。
    // 未使用预解析音源时不登记，tryNextAudioCandidate 的兜底分支立即返回 false。
    if (usedPreResolvedSource && options?.fallbackOnPreResolvedFailure) {
      deferredPreResolvedFallback = {
        trackId: resolvedId,
        onFailure: options.onPreResolvedFailure,
        consumed: false,
      };
    }

    engine.setSource(resolved.url);
    engine.applyTrackLoudness(resolved.loudness);
    engine.setLoopFile(state.playMode === 'single');

    try {
      if (autoPlay) {
        if (settingStore.volumeFade) {
          const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
          await engine.play({ fadeIn: true, fadeDurationMs: fadeMs });
        } else {
          await engine.play();
        }
      }
      if (requestSeq !== state.playbackRequestSeq) return;

      // 在 engine.play() 成功后立即记录本地历史，使用闭包捕获的 snapshot
      // 避免因 mpv end-file 事件竞态导致 state.currentTrackSnapshot 被下一首覆盖
      recordLocalHistoryOnce(snapshot);

      state.isLoading = false;
      state.autoNextAttempts = 0;
      state.autoNextSourceTrackId = String(track.id);
      clearAutoNextTimer();
      if (!state.duration && !engine.duration && track.duration) state.duration = track.duration;
      if (!autoPlay || !settingStore.volumeFade) engine.setVolume(state.volume);
      if (!autoPlay) {
        state.isPlaying = false;
        engine.updateMediaPlaybackState(buildStoppedPlaybackState(state));
      } else {
        state.isPlaying = true;
      }
      void resolver.fetchClimaxMarks(track);
    } catch (error) {
      logger.error('PlayerPlayback', 'Play track failed:', error);
      if (requestSeq !== state.playbackRequestSeq) return;
      if (await tryNextAudioCandidate({ reason: 'play-track-failed', trackId: resolvedId })) {
        return;
      }
      state.lastError = 'playback-failed';
      showPlaybackNotice('playback-failed', track);
      applyFailedPlaybackState({ keepResolvedSource: true });
      if (settingStore.autoNext && sourceList.length > 0) {
        state.autoNextSourceTrackId = resolvedId;
        scheduleAutoNext();
      }
    }
  };

  const togglePlay = async () => {
    if (state.isResuming) return;

    if (!state.currentTrackId) {
      if ((playlistStore.activeQueue?.songs.length ?? playlistStore.defaultList.length) > 0) {
        const activeSongs = playlistStore.activeQueue?.songs ?? playlistStore.defaultList;
        let firstTrackIndex = 0;
        if (state.playMode === 'random')
          firstTrackIndex = Math.floor(Math.random() * activeSongs.length);
        const playableIndex = findPlayableIndex(activeSongs, firstTrackIndex, true, true);
        if (playableIndex !== -1) playTrack(activeSongs[playableIndex].id, activeSongs);
      }
      return;
    }

    if (state.isPlaying) {
      state.isPlaying = false;
      settingStore.syncPreventSleep(false);
      engine.updateMediaPlaybackState(buildMediaState(state));
      engine.pause().catch((err) => logger.error('PlayerPlayback', 'Pause failed', err));
      return;
    }

    if (!engine.source) {
      await playTrack(state.currentTrackId);
      return;
    }

    state.isResuming = true;
    state.isPlaying = true;
    settingStore.syncPreventSleep(true);
    engine.updateMediaPlaybackState(buildMediaState(state));

    try {
      const timeoutMs = (settingStore.playResumeTimeout ?? 5) * 1000;
      await engine.play({ timeoutMs: timeoutMs > 0 ? timeoutMs : undefined });
    } catch {
      state.isPlaying = false;
      try {
        await playTrack(state.currentTrackId);
      } catch {
        /* ignore */
      }
    } finally {
      state.isResuming = false;
    }
  };

  const seek = (time: number) => {
    const effectiveDuration = engine.duration > 0 ? engine.duration : state.duration;
    const targetTime = Math.max(0, Math.min(effectiveDuration, time));
    state.seekTargetTime = targetTime;
    state.seekTimestamp = Date.now();
    engine.seek(targetTime);
    state.currentTime = targetTime;
    state.currentTimeUpdatedAt = Date.now();

    // 当 seek 目标接近结尾时（距结尾 < 2 秒），不忽略 EOF 事件，
    // 否则播放完毕后不会自动切下一首
    const nearEnd = effectiveDuration > 0 && effectiveDuration - targetTime < 2;
    if (!nearEnd) {
      state.recentSeekIgnoreEnd = true;
      window.setTimeout(() => {
        state.recentSeekIgnoreEnd = false;
      }, 800);
    }

    engine.updateMediaPlaybackState(buildMediaState(state));
  };

  const pushShuffleHistory = (trackId: string | null) => {
    if (!trackId) return;
    const MAX_SHUFFLE_HISTORY = 100;
    state.shuffleHistory.push(trackId);
    if (state.shuffleHistory.length > MAX_SHUFFLE_HISTORY) {
      state.shuffleHistory = state.shuffleHistory.slice(-MAX_SHUFFLE_HISTORY);
    }
  };

  const playQueuedNextOutsidePersonalFm = async (options?: {
    track?: Song | null;
    playtime?: number;
    isOverplay?: boolean;
  }) => {
    if (playlistStore.activeQueue?.id !== PERSONAL_FM_QUEUE_ID) return false;

    const candidateQueues: PlaybackQueueState[] = [];
    const seenQueueIds = new Set<string>();
    const addCandidateQueue = (queueId?: string | number | null) => {
      const resolvedId = String(queueId ?? '');
      if (!resolvedId || resolvedId === PERSONAL_FM_QUEUE_ID || seenQueueIds.has(resolvedId)) {
        return;
      }
      const queue = playlistStore.getQueueById(resolvedId);
      if (!queue) return;
      seenQueueIds.add(resolvedId);
      candidateQueues.push(queue);
    };

    addCandidateQueue(playlistStore.lastNonFmQueueId);
    playlistStore.playbackQueueList.forEach((queue) => {
      if (queue.queuedNextTrackIds.length > 0) addCandidateQueue(queue.id);
    });

    for (const queue of candidateQueues) {
      await playlistStore.ensurePlaybackQueueSongsLoaded(queue.id);
      const targetQueue = playlistStore.getQueueById(queue.id);
      if (!targetQueue) continue;

      playlistStore.syncQueuedNextTrackIds(targetQueue.id);
      let queuedNextId = playlistStore.peekQueuedNextTrackId(targetQueue.id);
      while (queuedNextId) {
        const queuedSong = targetQueue.songs.find(
          (song) => String(song.id) === String(queuedNextId),
        );
        playlistStore.consumeQueuedNextTrackId(queuedNextId, targetQueue.id);
        if (queuedSong && isPlayableSong(queuedSong)) {
          await playlistStore.ensurePersonalFmQueue({
            track: options?.track ?? state.currentTrackSnapshot,
            playtime: options?.playtime ?? state.currentTime,
            isOverplay:
              options?.isOverplay ??
              (state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false),
          });
          const queueSongs = targetQueue.songs.slice();
          playlistStore.setActiveQueue(targetQueue.id);
          await playTrack(String(queuedSong.id), queueSongs, { sourceQueueId: targetQueue.id });
          return true;
        }
        queuedNextId = playlistStore.peekQueuedNextTrackId(targetQueue.id);
      }
    }

    return false;
  };

  // 私人 FM「不喜欢」：上报 garbage、从队列移除当前曲目并切到下一首
  const dislikePersonalFm = async () => {
    if (playlistStore.activeQueue?.id !== PERSONAL_FM_QUEUE_ID) return false;
    if (!state.currentTrackId) return false;

    playlistStore.syncQueuedNextTrackIds();
    const list = playlistStore.activeQueue?.songs ?? state.currentPlaylist ?? [];
    const currentIndex = list.findIndex((s) => String(s.id) === String(state.currentTrackId));
    const currentTrack =
      (currentIndex >= 0 ? list[currentIndex] : null) ||
      findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
      state.currentTrackSnapshot;
    if (!currentTrack) return false;

    clearAutoNextTimer();

    // 上报「不喜欢」
    await playlistStore.ensurePersonalFmQueue({
      track: currentTrack,
      playtime: Math.max(0, Math.floor(state.currentTime || 0)),
      action: 'garbage',
      isOverplay: false,
    });

    // 从私人 FM 队列移除当前曲目
    playlistStore.removeFromQueue(String(currentTrack.id));

    // 删除后优先播放队列中原位置的下一首；队列没有下一首时再从 FM buffer 消费
    const queueSongs = playlistStore.activeQueue?.songs ?? [];
    const fmNextSong =
      currentIndex >= 0 && currentIndex < queueSongs.length
        ? queueSongs[currentIndex]
        : await playlistStore.consumeNextPersonalFmTrack({
            playtime: 0,
            isOverplay: false,
          });
    if (!fmNextSong) {
      stop();
      return true;
    }

    const fmList =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : list;
    await playTrack(String(fmNextSong.id), fmList, { sourceQueueId: PERSONAL_FM_QUEUE_ID });
    return true;
  };

  const next = async () => {
    playlistStore.syncQueuedNextTrackIds();
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0) return;

    clearAutoNextTimer();

    // 随机模式下，切歌前将当前曲目记入历史
    if (state.playMode === 'random' && state.currentTrackId) {
      pushShuffleHistory(state.currentTrackId);
    }

    if (
      playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID &&
      (await playQueuedNextOutsidePersonalFm({
        track:
          list.find((song) => String(song.id) === String(state.currentTrackId)) ||
          findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
          state.currentTrackSnapshot,
        playtime: state.currentTime,
        isOverplay:
          state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false,
      }))
    ) {
      return;
    }

    const queuedNextId = playlistStore.peekQueuedNextTrackId();
    if (queuedNextId) {
      const queuedSong = list.find((song) => String(song.id) === queuedNextId);
      if (queuedSong && isPlayableSong(queuedSong)) {
        playlistStore.consumeQueuedNextTrackId(queuedNextId);
        void playTrack(String(queuedSong.id), list, { sourceQueueId: state.currentSourceQueueId });
        return;
      }
      playlistStore.consumeQueuedNextTrackId(queuedNextId);
    }

    let nextIndex = 0;
    const currentIndex = list.findIndex((s) => String(s.id) === String(state.currentTrackId));

    if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
      void playlistStore.ensurePersonalFmQueue({
        track:
          list[currentIndex] ||
          findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
          state.currentTrackSnapshot,
        playtime: state.currentTime,
        isOverplay:
          state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false,
      });
      const fmNextSong =
        currentIndex >= 0 && currentIndex < list.length - 1
          ? list[currentIndex + 1]
          : await playlistStore.consumeNextPersonalFmTrack({
              track:
                list[currentIndex] ||
                findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
                state.currentTrackSnapshot,
              playtime: state.currentTime,
              isOverplay:
                state.duration > 0 ? state.currentTime >= Math.max(0, state.duration - 2) : false,
            });
      if (fmNextSong) {
        const fmList = playlistStore.activeQueue?.songs || list;
        await playTrack(String(fmNextSong.id), fmList, { sourceQueueId: PERSONAL_FM_QUEUE_ID });
      }
      return;
    }

    if (state.playMode === 'random') {
      nextIndex = pickRandomIndex(list.length, currentIndex);
    } else if (state.playMode === 'sequential') {
      if (currentIndex >= list.length - 1) {
        state.isPlaying = false;
        engine.pause();
        return;
      }
      nextIndex = currentIndex + 1;
    } else {
      nextIndex = (currentIndex + 1) % list.length;
    }

    if (state.playMode !== 'random') {
      nextIndex = findPlayableIndex(list, nextIndex, true, true);
    } else if (!isPlayableSong(list[nextIndex])) {
      nextIndex = findPlayableIndex(list, nextIndex, true, false);
    }

    if (state.playMode === 'sequential' && nextIndex <= currentIndex) {
      state.isPlaying = false;
      engine.pause();
      return;
    }

    const nextSong = list[nextIndex];
    if (!nextSong) return;
    await playTrack(String(nextSong.id), list, { sourceQueueId: state.currentSourceQueueId });
  };

  const prev = async () => {
    const list =
      (playlistStore.activeQueue?.songs?.length ?? 0) > 0
        ? (playlistStore.activeQueue?.songs ?? [])
        : (state.currentPlaylist ?? []);
    if (list.length === 0) return;

    clearAutoNextTimer();

    // 随机模式下，从播放历史中回退
    if (state.playMode === 'random' && state.shuffleHistory.length > 0) {
      const prevTrackId = state.shuffleHistory.pop()!;
      const prevSong = list.find((s) => String(s.id) === prevTrackId);
      if (prevSong && isPlayableSong(prevSong)) {
        void playTrack(String(prevSong.id), list, {
          sourceQueueId: state.currentSourceQueueId,
        });
        return;
      }
      // 历史中的歌曲在列表中已不存在或不可播放，继续尝试更早的历史
      while (state.shuffleHistory.length > 0) {
        const olderTrackId = state.shuffleHistory.pop()!;
        const olderSong = list.find((s) => String(s.id) === olderTrackId);
        if (olderSong && isPlayableSong(olderSong)) {
          void playTrack(String(olderSong.id), list, {
            sourceQueueId: state.currentSourceQueueId,
          });
          return;
        }
      }
      // 历史全部耗尽，回退到默认行为
    }

    const currentIndex = list.findIndex((s) => String(s.id) === String(state.currentTrackId));
    let prevIndex = (currentIndex - 1 + list.length) % list.length;
    prevIndex = findPlayableIndex(list, prevIndex, false, true);
    const prevSong = list[prevIndex];
    if (!prevSong) return;
    void playTrack(prevSong.id, list, { sourceQueueId: state.currentSourceQueueId });
  };

  const stop = () => {
    const sourceQueueId =
      state.currentSourceQueueId ?? playlistStore.activeQueue?.id ?? playlistStore.activeQueueId;
    clearAutoNextTimer();
    state.autoNextAttempts = 0;
    state.autoNextSourceTrackId = null;
    state.currentTrackSnapshot = null;
    state.historyUploadCommitted = false;
    state.historyUploadTrackId = null;
    engine.reset();
    state.currentTime = 0;
    state.currentTimeUpdatedAt = Date.now();
    state.duration = 0;
    state.isPlaying = false;
    state.stallRecovering = false;
    state.awaitingTrackLoad = false;
    state.stallRecoverTrackId = null;
    state.stallRecoverAttempts = 0;
    state.currentTrackId = null;
    state.currentSourceQueueId = null;
    state.currentAudioUrl = '';
    state.currentAudioCandidateUrls = [];
    state.currentAudioCandidateIndex = -1;
    state.currentResolvedAudioQuality = null;
    state.currentResolvedAudioEffect = 'none';
    state.currentAudioQualityOverride = null;
    state.audioEffect = 'none';
    state.playbackRequestSeq += 1;
    state.climaxRequestSeq += 1;
    state.isLoading = false;
    playlistStore.updateQueueCurrentTrack(null, sourceQueueId);
    engine.updateMediaPlaybackState(buildMediaState(state));
  };

  // 主进程看门狗检测到播放卡死后的恢复：重取最新地址 → 从断点续播。
  // 进度防跳由 store 的 stallRecovering 护栏保证（UI 停在断点，忽略 reload 期间的归零/回跳）。
  const recoverFromStall = async (position: number) => {
    if (!state.currentTrackId) return;
    // 用户已暂停 / 正在加载 / 已在恢复中，均不处理
    if (!state.isPlaying || state.isLoading || state.stallRecovering) return;

    const trackId = String(state.currentTrackId);
    const track =
      findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore) ||
      state.currentTrackSnapshot;
    if (!track) return;

    // 按曲目统计恢复次数；切到新曲目则重置计数
    if (state.stallRecoverTrackId !== trackId) {
      state.stallRecoverTrackId = trackId;
      state.stallRecoverAttempts = 0;
    }
    const maxAttempts = Math.max(0, Math.floor(settingStore.playbackStallMaxAttempts ?? 3));
    if (maxAttempts > 0 && state.stallRecoverAttempts >= maxAttempts) {
      logger.warn('PlayerPlayback', 'Stall recovery gave up after max attempts', {
        trackId,
        attempts: state.stallRecoverAttempts,
      });
      state.lastError = 'playback-failed';
      showPlaybackNotice('playback-failed', track);
      applyFailedPlaybackState({ keepResolvedSource: true });
      if (settingStore.autoNext && (state.currentPlaylist?.length ?? 0) > 0) {
        state.autoNextSourceTrackId = trackId;
        scheduleAutoNext();
      }
      return;
    }
    state.stallRecoverAttempts += 1;

    const targetPosition = Math.max(0, Number(position) || state.currentTime || 0);

    // 开启进度防跳护栏：UI 停在断点位置
    state.stallRecovering = true;
    state.stallRecoverTarget = targetPosition;
    state.stallRecoverDeadline = Date.now() + 20000;
    state.currentTime = targetPosition;
    state.currentTimeUpdatedAt = Date.now();

    logger.warn('PlayerPlayback', 'Recovering from playback stall', {
      trackId,
      position: targetPosition,
      attempt: state.stallRecoverAttempts,
    });

    try {
      const triedCandidate = await tryNextAudioCandidate({
        reason: 'playback-stall',
        position: targetPosition,
        trackId,
      });
      if (triedCandidate) return;

      const resolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      if (String(state.currentTrackId) !== trackId) {
        state.stallRecovering = false;
        return;
      }
      if (!resolved.url) {
        state.stallRecovering = false;
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        if (settingStore.autoNext && (state.currentPlaylist?.length ?? 0) > 0) {
          state.autoNextSourceTrackId = trackId;
          scheduleAutoNext();
        }
        return;
      }
      applyResolvedAudioSource(track, resolved);
      engine.reloadSource(resolved.url);
      engine.applyTrackLoudness(resolved.loudness);
      await engine.play();
      if (String(state.currentTrackId) !== trackId) {
        state.stallRecovering = false;
        return;
      }
      if (targetPosition > 0) engine.seek(targetPosition);
    } catch (error) {
      logger.error('PlayerPlayback', 'Recover from stall failed:', error);
      state.stallRecovering = false;
    }
  };

  const pickRandomIndex = (length: number, currentIndex: number) => {
    if (length <= 1) return currentIndex;
    state.shufflePlayed.add(currentIndex);
    if (!state.shuffleQueue || state.shuffleQueueLength !== length) {
      if (state.shuffleQueue && state.shuffleQueueLength !== length) {
        const remaining = new Set(state.shuffleQueue.filter((i) => i < length));
        const newIndices: number[] = [];
        for (let i = 0; i < length; i++) {
          if (i !== currentIndex && !state.shufflePlayed.has(i) && !remaining.has(i))
            newIndices.push(i);
        }
        for (const idx of state.shufflePlayed) {
          if (idx >= length) state.shufflePlayed.delete(idx);
        }
        shuffleInsert(newIndices);
        const validRemaining = state.shuffleQueue.filter((i) => i < length && i !== currentIndex);
        state.shuffleQueue = [...validRemaining, ...newIndices];
      } else {
        state.shufflePlayed = new Set([currentIndex]);
        state.shuffleQueue = buildShuffleQueue(length, currentIndex);
      }
      state.shuffleQueueLength = length;
    }
    if (state.shuffleQueue.length === 0) {
      state.shufflePlayed = new Set([currentIndex]);
      state.shuffleQueue = buildShuffleQueue(length, currentIndex);
    }
    const nextIndex = state.shuffleQueue.shift()!;
    state.shufflePlayed.add(nextIndex);
    return nextIndex;
  };

  const shuffleInsert = (arr: number[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  const buildShuffleQueue = (length: number, excludeIndex: number): number[] => {
    const indices = Array.from({ length }, (_, i) => i).filter((i) => i !== excludeIndex);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  };

  return {
    applyFailedPlaybackState,
    clearAutoNextTimer,
    skipToNextAfterFailure,
    scheduleAutoNext,
    playTrack,
    togglePlay,
    seek,
    next,
    dislikePersonalFm,
    playQueuedNextOutsidePersonalFm,
    prev,
    stop,
    recoverFromStall,
    tryNextAudioCandidate,
    pickRandomIndex,
    shuffleInsert,
    buildShuffleQueue,
  };
};
