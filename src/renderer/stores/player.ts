import { defineStore } from 'pinia';
import { computed, reactive, toRefs, watch } from 'vue';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import { useToastStore } from './toast';
import { useUserStore } from './user';
import logger from '@/utils/logger';
import { PlayerEngine, type PlayerEngineEvents } from '@/utils/player';
import type { Song } from '@/models/song';

import { createPlayerState } from './player/state';
import { createPlaybackManager } from './player/playback';
import { createAudioManager } from './player/audio';
import { createResolver } from './player/resolver';
import { createHistoryManager } from './player/history';
import { createListeningTimeManager } from './player/listeningTime';
import { createDeviceManager } from './player/device';
import {
  createPlayerEventBus,
  type PlayerEventName,
  type PlayerEventPayload,
} from './player/events';
import {
  buildMediaMeta,
  buildMediaState,
  findTrackById,
  resolvePlaybackNotice,
} from './player/utils';
import { toRawSong } from './playlist/helpers';

const engine = new PlayerEngine();

export const usePlayerStore = defineStore(
  'player',
  () => {
    const state = reactive(createPlayerState());
    const playlistStore = usePlaylistStore();
    const settingStore = useSettingStore();
    const lyricStore = useLyricStore();
    const toastStore = useToastStore();

    const resolver = createResolver(state, playlistStore, settingStore);
    const historyManager = createHistoryManager(state);
const listeningTimeManager = createListeningTimeManager(state);

    // 播放生命周期事件总线：随 store 单例创建，全程存活，供插件等订阅方感知播放事件
    const playerEvents = createPlayerEventBus();
    const getPlayerEventPayload = (
      event: PlayerEventName,
      extra?: Partial<PlayerEventPayload>,
    ): PlayerEventPayload => ({
      event,
      track: state.currentTrackSnapshot ?? null,
      trackId: state.currentTrackId != null ? String(state.currentTrackId) : null,
      currentTime: state.currentTime,
      duration: state.duration,
      isPlaying: state.isPlaying,
      ...extra,
    });
    const emitPlayerEvent = (event: PlayerEventName, extra?: Partial<PlayerEventPayload>) =>
      playerEvents.emit(event, getPlayerEventPayload(event, extra));

    // 播放展示状态。Yan 没有 Echo 的 playbackIntent / enginePlayback 状态机，
    // 因此按 Yan 既有 state 派生（Echo 对应 getPlaybackDisplayState）。
    // 一起听 store 仅判断是否 === 'error'，此处只保证该判定与 Yan 的失败态
    // （isLoading=false 且 lastError 已置位）一致。
    const playbackDisplayState = computed<'loading' | 'playing' | 'paused' | 'error'>(() => {
      if (state.isLoading) return 'loading';
      if (state.lastError) return 'error';
      if (state.isPlaying) return 'playing';
      return 'paused';
    });

    // 切歌与跳转事件来自状态跃迁，覆盖所有调用路径（含快捷键、媒体控制、mini 播放器等）
    watch(
      () => state.currentTrackId,
      () => emitPlayerEvent('trackchange'),
    );
    watch(
      () => state.seekTimestamp,
      (next, prev) => {
        if (next && next !== prev) emitPlayerEvent('seek');
      },
    );
    // 同步播放状态到主进程，更新 Windows 任务栏缩略图按钮图标
    watch(
      () => state.isPlaying,
      (isPlaying) => {
        window.electron?.ipcRenderer?.send('thumbar:update-play-state', isPlaying);
      },
    );

    const refreshCurrentTrack = async () => {
      if (!state.currentTrackId) return;
      if (state.isLoading) {
        state.pendingSettingRefresh = true;
        return;
      }
      const requestSeq = ++state.playbackRequestSeq;
      const track = findTrackById(state.currentTrackId, state.currentPlaylist, playlistStore);
      if (!track) return;

      state.pendingSettingRefresh = false;
      const wasPlaying = state.isPlaying;
      const previousTime = state.currentTime;
      state.isLoading = true;

      const resolved = await resolver.resolveAudioUrl(track, { forceReload: true });
      if (requestSeq !== state.playbackRequestSeq) return;
      if (!resolved.url) {
        state.isLoading = false;
        state.lastError = 'audio-url-unavailable';
        showPlaybackNotice('audio-url-unavailable', track);
        return;
      }

      clearPlaybackNotice();

      audioManager.setVolume(state.volume);
      if (requestSeq !== state.playbackRequestSeq) return;

      state.currentAudioUrl = resolved.url;
      state.currentResolvedAudioQuality = resolved.quality;
      state.currentResolvedAudioEffect = resolved.effect;
      track.audioUrl = resolved.url;
      const savedDuration = state.duration;
      engine.setSource(resolved.url);
      if (!state.duration && !engine.duration && savedDuration) state.duration = savedDuration;
      engine.applyTrackLoudness(resolved.loudness);
      engine.setPlaybackRate(state.playbackRate);
      void resolver.fetchClimaxMarks(track);

      if (previousTime > 0) {
        state.recentSeekIgnoreEnd = true;
        window.setTimeout(() => {
          state.recentSeekIgnoreEnd = false;
        }, 1500);
        let actualDuration = engine.duration;
        if (actualDuration <= 0) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => window.setTimeout(r, 50));
            actualDuration = engine.duration;
            if (actualDuration > 0) break;
          }
        }
        let safeTime = previousTime;
        if (actualDuration > 0 && previousTime >= actualDuration - 0.5) safeTime = 0;
        engine.seek(safeTime);
        state.currentTime = safeTime;
        state.currentTimeUpdatedAt = Date.now();
      }

      if (wasPlaying) {
        try {
          await engine.play();
          if (requestSeq !== state.playbackRequestSeq) return;
        } catch (error) {
          logger.error('PlayerStore', 'Reload track failed:', error);
        }
      }
      if (!state.duration && !engine.duration && track.duration) state.duration = track.duration;
      if (wasPlaying) engine.setVolume(state.volume);
      state.isLoading = false;
      if (state.pendingSettingRefresh) {
        state.pendingSettingRefresh = false;
        void refreshCurrentTrack();
      }
    };

    const audioManager = createAudioManager(state, engine, refreshCurrentTrack);
    const deviceManager = createDeviceManager(state, engine, settingStore);
    const getActiveImpulseResponsePath = () => {
      if (!settingStore.impulseResponseEnabled) return null;
      return settingStore.getSelectedImpulseResponse()?.impulseResponsePath ?? null;
    };
    const showPlaybackNotice = (code: string, track?: Song | null) => {
      const userStore = useUserStore();
      const vipInfo = (userStore.info?.extendsInfo?.vip as any) || {};
      const busiVip: any[] = vipInfo?.busi_vip || [];
      const hasSvip = busiVip.some((v: any) => v.product_type === 'svip' && v.is_vip === 1);
      const hasTvip = busiVip.some((v: any) => v.product_type === 'tvip' && v.is_vip === 1);
      const isUserNovip = userStore.isLoggedIn && !hasSvip && !hasTvip;

      state.playbackNotice = resolvePlaybackNotice({
        code,
        track,
        autoNextEnabled: settingStore.autoNext,
        autoNextDelaySeconds: settingStore.autoNextDelaySeconds,
        isUserNovip,
      });
    };

    const clearPlaybackNotice = (trackId?: string | number | null) => {
      if (!state.playbackNotice) return;
      if (
        trackId !== undefined &&
        trackId !== null &&
        state.playbackNotice.trackId !== String(trackId)
      )
        return;
      state.playbackNotice = null;
    };

    const playbackManager = createPlaybackManager(
      state,
      engine,
      playlistStore,
      settingStore,
      lyricStore,
      resolver,
      historyManager,
      showPlaybackNotice,
      clearPlaybackNotice,
    );
    let impulseResponseFailureListenerRegistered = false;
    let audioDeviceListListenerRegistered = false;

    const toggleLyricView = (open?: boolean) => {
      state.isLyricViewOpen = open ?? !state.isLyricViewOpen;
    };

    // 切歌重入保护：防止极短音频 / 临近结尾 seek / 异常重复 EOF 等场景下
    // handlePlaybackEnded 在上一次切歌尚未完成时被再次触发，导致连续多次切换。
    let handlingPlaybackEnd = false;
    const handlePlaybackEnded = async () => {
      if (handlingPlaybackEnd) return;
      handlingPlaybackEnd = true;
      try {
        // 一起听房间内听众（非房主）不得自行推进到下一首，由房主的远端状态驱动。
        // autoNextSuppressed 默认 false，普通播放路径行为不变。
        if (state.autoNextSuppressed) {
          state.isPlaying = false;
          engine.updateMediaPlaybackState(buildMediaState(state));
          return;
        }
        if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
          const playedQueuedNext = await playbackManager.playQueuedNextOutsidePersonalFm({
            track: state.currentTrackSnapshot,
            playtime: state.duration,
            isOverplay: true,
          });
          if (playedQueuedNext) return;

          const nextFmSong = await playlistStore.consumeNextPersonalFmTrack({
            track: state.currentTrackSnapshot,
            playtime: state.duration,
            isOverplay: true,
          });

          if (nextFmSong) {
            await playbackManager.playTrack(
              String(nextFmSong.id),
              playlistStore.activeQueue.songs,
              {
                sourceQueueId: PERSONAL_FM_QUEUE_ID,
              },
            );
          } else {
            playbackManager.stop();
          }
          return;
        }
        if (state.playMode === 'single') {
          if (state.currentAudioUrl) {
            engine.setSource(state.currentAudioUrl);
            void engine.play();
          }
          return;
        }
        await playbackManager.next();
      } finally {
        handlingPlaybackEnd = false;
      }
    };

    const registerSettingWatchers = () => {
      if (state.settingsWatcherRegistered) return;
      state.settingsWatcherRegistered = true;
      let snapshot = {
        defaultAudioQuality: settingStore.defaultAudioQuality,
        compatibilityMode: settingStore.compatibilityMode,
        volumeFade: settingStore.volumeFade,
        volumeFadeTime: settingStore.volumeFadeTime,
        outputDevice: settingStore.outputDevice,
        exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
        impulseResponseEnabled: settingStore.impulseResponseEnabled,
        selectedImpulseResponseId: settingStore.selectedImpulseResponseId,
        impulseResponseMix: settingStore.impulseResponseMix,
        impulseResponseCount: settingStore.impulseResponseFiles.length,
        playbackStallTimeout: settingStore.playbackStallTimeout,
      };
      // 保存取消函数，以便在需要时清理订阅
      const unsubscribeSettings = settingStore.$subscribe(() => {
        const shouldRefresh =
          (state.currentAudioQualityOverride === null &&
            settingStore.defaultAudioQuality !== snapshot.defaultAudioQuality) ||
          settingStore.compatibilityMode !== snapshot.compatibilityMode;
        const shouldUpdateFade =
          settingStore.volumeFade !== snapshot.volumeFade ||
          settingStore.volumeFadeTime !== snapshot.volumeFadeTime;
        const shouldUpdateOutputDevice =
          settingStore.outputDevice !== snapshot.outputDevice ||
          settingStore.exclusiveAudioDevice !== snapshot.exclusiveAudioDevice;
        const shouldUpdateImpulseResponse =
          settingStore.impulseResponseEnabled !== snapshot.impulseResponseEnabled ||
          settingStore.selectedImpulseResponseId !== snapshot.selectedImpulseResponseId ||
          settingStore.impulseResponseMix !== snapshot.impulseResponseMix ||
          settingStore.impulseResponseFiles.length !== snapshot.impulseResponseCount;
        const shouldUpdateStallTimeout =
          settingStore.playbackStallTimeout !== snapshot.playbackStallTimeout;
        snapshot = {
          defaultAudioQuality: settingStore.defaultAudioQuality,
          compatibilityMode: settingStore.compatibilityMode,
          volumeFade: settingStore.volumeFade,
          volumeFadeTime: settingStore.volumeFadeTime,
          outputDevice: settingStore.outputDevice,
          exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
          impulseResponseEnabled: settingStore.impulseResponseEnabled,
          selectedImpulseResponseId: settingStore.selectedImpulseResponseId,
          impulseResponseMix: settingStore.impulseResponseMix,
          impulseResponseCount: settingStore.impulseResponseFiles.length,
          playbackStallTimeout: settingStore.playbackStallTimeout,
        };
        if (shouldRefresh) {
          if (state.isLoading || state.pendingSettingRefresh) state.pendingSettingRefresh = true;
          else void refreshCurrentTrack();
        }
        if (shouldUpdateFade && state.isPlaying) {
          void audioManager.fadeVolume(state.volume, { durationMs: 120, respectUserVolume: false });
        }
        if (shouldUpdateOutputDevice)
          void deviceManager.applyOutputDevice(settingStore.outputDevice);
        if (shouldUpdateImpulseResponse)
          audioManager.setImpulseResponse(
            getActiveImpulseResponsePath(),
            settingStore.impulseResponseMix,
          );
        if (shouldUpdateStallTimeout)
          engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
      });
      // 返回清理函数
      return () => {
        unsubscribeSettings();
      };
    };

    const disableActiveImpulseResponse = (failedPath?: string) => {
      const active = settingStore.getSelectedImpulseResponse();
      const activePath = active?.impulseResponsePath ?? active?.vpfPath;
      if (failedPath && activePath && activePath !== failedPath) return;
      if (!settingStore.impulseResponseEnabled) return;
      settingStore.impulseResponseEnabled = false;
      audioManager.setImpulseResponse(null, settingStore.impulseResponseMix);
      toastStore.warning('空间音效加载失败，已自动关闭', 4200);
    };

    const restorePlaybackSessionFromQueue = () => {
      const activeQueue = playlistStore.activeQueue;
      const activeSongs = activeQueue?.songs ?? [];
      const queueTrackId = String(activeQueue?.currentTrackId ?? '');
      const persistedTrackId = String(state.currentTrackId ?? '');
      const targetTrackId = queueTrackId || persistedTrackId;
      const targetTrack = targetTrackId
        ? activeSongs.find((song) => String(song.id) === targetTrackId)
        : undefined;

      state.isPlaying = false;
      state.isLoading = false;
      state.currentTime = 0;
      state.currentTimeUpdatedAt = Date.now();
      state.currentAudioUrl = '';
      state.currentAudioCandidateUrls = [];
      state.currentAudioCandidateIndex = -1;
      state.currentResolvedAudioQuality = null;
      state.currentResolvedAudioEffect = 'none';
      state.currentAudioQualityOverride = null;
      state.historyUploadCommitted = false;
      state.historyUploadTrackId = null;

      if (!targetTrack || !targetTrackId) {
        if (queueTrackId && activeQueue) {
          playlistStore.updateQueueCurrentTrack(null, activeQueue.id);
        }
        state.currentTrackId = null;
        state.currentSourceQueueId = null;
        state.currentPlaylist = null;
        state.currentTrackSnapshot = null;
        state.duration = 0;
        state.lastError = null;
        clearPlaybackNotice();
        engine.updateMediaPlaybackState(buildMediaState(state));
        return;
      }

      state.currentTrackId = targetTrackId;
      state.currentSourceQueueId = activeQueue?.id ?? playlistStore.activeQueueId ?? null;
      state.currentPlaylist = activeSongs.length > 0 ? activeSongs : null;
      state.currentTrackSnapshot = toRawSong(targetTrack);
      state.duration = targetTrack.duration || 0;
      state.lastError = null;
      clearPlaybackNotice();

      const mediaMeta = buildMediaMeta(targetTrack);
      if (mediaMeta) {
        engine.updateMediaMetadata({
          ...mediaMeta,
          durationMs: (targetTrack.duration || 0) * 1000,
        });
      }
      engine.updateMediaPlaybackState(buildMediaState(state));
    };

    const init = () => {
      // 提前注册 MediaSession handlers，避免启动时丢失系统媒体控制事件
      engine.setMediaSessionHandlers({
        play: () => {
          if (!state.isPlaying) playbackManager.togglePlay();
        },
        pause: () => {
          if (state.isPlaying) playbackManager.togglePlay();
        },
        previoustrack: () => playbackManager.prev(),
        nexttrack: () => playbackManager.next(),
        seekto: (time) => playbackManager.seek(time),
        seekbackward: (offset) => playbackManager.seek(Math.max(0, state.currentTime - offset)),
        seekforward: (offset) =>
          playbackManager.seek(Math.min(state.duration, state.currentTime + offset)),
      });

      restorePlaybackSessionFromQueue();
      audioManager.setVolume(state.volume);
      engine.setPlaybackRate(state.playbackRate);
      engine.setEqualizer(state.equalizerGains);
      if (!settingStore.impulseResponseSafetyMigrationDone) {
        settingStore.impulseResponseEnabled = false;
        settingStore.impulseResponseSafetyMigrationDone = true;
      }
      void settingStore
        .reconcileImpulseResponseFiles()
        .finally(() =>
          engine.setImpulseResponse(
            getActiveImpulseResponsePath(),
            settingStore.impulseResponseMix,
          ),
        );
      engine.setVolumeNormalization(settingStore.volumeNormalization);
      engine.setReferenceLufs(settingStore.volumeNormalizationLufs);
      engine.setLoopFile(state.playMode === 'single');
      engine.setStallTimeout(settingStore.playbackStallTimeout ?? 8);
      registerSettingWatchers();
      if (!impulseResponseFailureListenerRegistered) {
        impulseResponseFailureListenerRegistered = true;
        window.electron?.mpv?.onImpulseResponseDisabled?.((payload) => {
          disableActiveImpulseResponse(payload?.path);
        });
      }
      if (!audioDeviceListListenerRegistered) {
        audioDeviceListListenerRegistered = true;
        window.electron?.mpv?.onAudioDeviceListChanged?.(() => {
          void deviceManager.refreshOutputDevices();
        });
      }
      void deviceManager.refreshOutputDevices();

      let lastMediaSessionSync = 0;
      const MEDIA_SESSION_SYNC_MS = 2000;
      let lastHistoryCheck = 0;
      const HISTORY_CHECK_MS = 5000;
      let lastEventTimeUpdate = 0;
      const EVENT_TIMEUPDATE_MS = 1000;

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime) => {
          // 切歌加载护栏：新文件 file-loaded 之前到达的回报多为上一首的残留位置，一律丢弃，
          // 避免进度条切歌瞬间先跳到旧进度再归零
          if (state.awaitingTrackLoad) return;
          // 卡死恢复护栏：reload 期间还没追回断点的回报值（含归零）一律忽略，UI 停在断点不跳动；
          // 追回到断点附近或超时兜底后解除护栏。
          if (state.stallRecovering) {
            if (
              Date.now() < state.stallRecoverDeadline &&
              currentTime < state.stallRecoverTarget - 1
            )
              return;
            state.stallRecovering = false;
          }
          if (
            state.seekTargetTime !== null &&
            Date.now() - state.seekTimestamp < 500 &&
            currentTime < state.seekTargetTime - 0.5
          )
            return;
          state.seekTargetTime = null;
          state.currentTime = currentTime;
          state.currentTimeUpdatedAt = Date.now();
          const now = Date.now();
          if (now - lastEventTimeUpdate >= EVENT_TIMEUPDATE_MS) {
            lastEventTimeUpdate = now;
            emitPlayerEvent('timeupdate');
          }
          if (now - lastHistoryCheck >= HISTORY_CHECK_MS) {
            lastHistoryCheck = now;
            void historyManager.commitListeningHistory();
            // 听歌时长累计（等级积分）：与历史记录同一 5s 节拍，内部自带
            // 播放中/非加载/非酷狗源等护栏与 60s 阈值、5min 失败退避
            void listeningTimeManager.tick();
          }
          if (now - lastMediaSessionSync >= MEDIA_SESSION_SYNC_MS) {
            lastMediaSessionSync = now;
            engine.updateMediaPlaybackState(buildMediaState(state));
          }
        },
        durationChange: (duration) => {
          // 切歌加载护栏：file-loaded 之前的 duration 回报（含 setSource 的归零与上一首残留）一律丢弃，
          // 真实时长在 fileLoaded 时从引擎补回
          if (state.awaitingTrackLoad) return;
          // 卡死恢复 reload 期间，mpv 会先回报 duration=0，忽略以免进度条最大值瞬间归零
          if (state.stallRecovering && duration <= 0) return;
          state.duration = duration;
          engine.updateMediaPlaybackState(buildMediaState(state));
          const trackDuration = state.currentTrackSnapshot?.duration ?? 0;
          if (duration > 0 && trackDuration > 0) {
            const diff = Math.abs(duration - trackDuration);
            lyricStore.lyricSyncWarning = diff > 10 && diff / trackDuration > 0.1;
          } else {
            lyricStore.lyricSyncWarning = false;
          }
        },
        fileLoaded: () => {
          // 切歌后立即重置听歌时长累计基准点，避免跨曲目误累计
          listeningTimeManager.resetPosition();
          // 新文件真正加载完成，解除切歌加载护栏，放行后续进度回报
          if (!state.awaitingTrackLoad) return;
          state.awaitingTrackLoad = false;
          // 补回加载窗口内被丢弃的真实时长，避免进度条最大值停留在 0
          if (engine.duration > 0) {
            state.duration = engine.duration;
            engine.updateMediaPlaybackState(buildMediaState(state));
          }
        },
        ended: () => {
          if (!state.recentSeekIgnoreEnd) {
            emitPlayerEvent('ended');
            handlePlaybackEnded();
            // 播放结束：尝试上报已累计的听歌时长（未达 60s 阈值或处于退避窗口时自动跳过）
            void listeningTimeManager.flush();
          } else state.recentSeekIgnoreEnd = false;
        },
        play: () => {
          state.isPlaying = true;
          state.isLoading = false;
          clearPlaybackNotice(state.currentTrackId);
          settingStore.syncPreventSleep(true);
          engine.updateMediaPlaybackState(buildMediaState(state));
          emitPlayerEvent('play');
          // 本地历史记录已在 playback.ts 的 playTrack 中调用
          // 此处不再重复调用，避免同一首歌被记录两次
        },
        pause: () => {
          state.isPlaying = false;
          settingStore.syncPreventSleep(false);
          engine.updateMediaPlaybackState(buildMediaState(state));
          emitPlayerEvent('pause');
        },
        error: (event) => {
          if (event && !event.isTrusted && !(event as any)?.detail) return;
          void (async () => {
            const triedFallback = await playbackManager.tryNextAudioCandidate({
              reason: 'mpv-error',
              position: state.currentTime,
            });
            if (triedFallback) return;

            state.lastError = (event as any)?.type ?? 'playback-error';
            showPlaybackNotice('playback-failed', state.currentTrackSnapshot);
            playbackManager.applyFailedPlaybackState({ keepResolvedSource: true });
            settingStore.syncPreventSleep(false);
            if (settingStore.autoNext && state.currentPlaylist?.length)
              playbackManager.scheduleAutoNext();
            else playbackManager.clearAutoNextTimer();
            emitPlayerEvent('error', { error: state.lastError ?? 'playback-error' });
          })();
        },
        stalled: (position) => {
          void playbackManager.recoverFromStall(position);
        },
      };
      engine.setEvents(events);
      window.electron?.mpv?.getState?.().then((mpvState) => {
        if (!mpvState) return;
        if (mpvState.playing && !state.isPlaying) {
          state.isPlaying = true;
          state.isLoading = false;
          settingStore.syncPreventSleep(true);
        }
        if (mpvState.duration > 0) state.duration = mpvState.duration;
        if (mpvState.timePos > 0) {
          state.currentTime = mpvState.timePos;
          state.currentTimeUpdatedAt = Date.now();
        }
      });
    };

    const setVolumeSmooth = async (value: number, durationMs?: number) => {
      await engine.fadeTo(value, durationMs ?? 1000);
      state.volume = engine.volume;
      if (state.volume > 0) state.lastNonZeroVolume = state.volume;
    };

    // 自动切歌抑制开关（一起听：听众侧抑制本地自动推进）。
    // suppressed=true 时清掉已排定的自动切歌定时器，避免听众本地抢跳。
    // Echo 此处还会 clearGaplessPreparedSource；Yan 无无缝预解析音源子系统，故不迁移。
    const setAutoNextSuppressed = (suppressed: boolean) => {
      state.autoNextSuppressed = suppressed;
      if (suppressed) playbackManager.clearAutoNextTimer();
    };

    // Explicitly return state and actions to help TypeScript
    return {
      ...toRefs(state),
      playbackDisplayState,
      // State-like (actually actions but Pinia treats them as actions)
      getEffectiveAudioQuality: resolver.getEffectiveAudioQuality,
      getResolvedAudioQuality: resolver.getResolvedAudioQuality,
      ensureTrackRelateGoods: resolver.ensureTrackRelateGoods,
      resolveAudioUrl: resolver.resolveAudioUrl,
      fetchClimaxMarks: resolver.fetchClimaxMarks,

      resetHistoryUploadState: historyManager.resetHistoryUploadState,
      commitListeningHistory: historyManager.commitListeningHistory,
      flushListeningTime: listeningTimeManager.flush,
      resetListeningTimePosition: listeningTimeManager.resetPosition,

      setVolume: audioManager.setVolume,
      adjustVolume: audioManager.adjustVolume,
      toggleMute: audioManager.toggleMute,
      setPlaybackRate: audioManager.setPlaybackRate,
      setPlayMode: audioManager.setPlayMode,
      setVolumeNormalization: audioManager.setVolumeNormalization,
      setReferenceLufs: audioManager.setReferenceLufs,
      setEq: audioManager.setEq,
      setImpulseResponse: audioManager.setImpulseResponse,
      setAudioEffect: audioManager.setAudioEffect,
      fadeVolume: audioManager.fadeVolume,
      setCurrentAudioQualityOverride: audioManager.setCurrentAudioQualityOverride,

      refreshOutputDevices: deviceManager.refreshOutputDevices,
      applyOutputDevice: deviceManager.applyOutputDevice,

      playTrack: playbackManager.playTrack,
      togglePlay: playbackManager.togglePlay,
      seek: playbackManager.seek,
      next: playbackManager.next,
      dislikePersonalFm: playbackManager.dislikePersonalFm,
      prev: playbackManager.prev,
      stop: playbackManager.stop,

      toggleLyricView,
      showPlaybackNotice,
      clearPlaybackNotice,
      refreshCurrentTrack,
      init,
      setVolumeSmooth,
      setAutoNextSuppressed,
      onPlayerEvent: playerEvents.on,
      getPlayerEventPayload,
    };
  },
  {
    persist: {
      pick: [
        'volume',
        'lastNonZeroVolume',
        'playMode',
        'currentTrackId',
        'playbackRate',
        'audioEffect',
        'equalizerGains',
      ],
    },
  },
);
