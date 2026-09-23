import { defineStore } from 'pinia';
import {
  MUSIC_JOURNAL_BASELINE_MAX_EVENTS,
  MUSIC_JOURNAL_MAX_EVENTS,
  appendJournalEvent,
  applyEventMood,
  createPlayEvent,
  createEmptyJournalState,
  normalizeJournalState,
  summarizeJournal,
  synthesizeBaselineEvents,
  type MusicJournalState,
} from '../../shared/musicJournal';

/**
 * 听歌档案（C2）本地事件仓。
 *
 * 持久化：复用既有 `sqlitePersist` 插件（`src/renderer/stores/sqlitePersist.ts:84-126`），
 * `persist: true` 会写入 KV 键 `pinia:musicJournal`（经既有 `storage:kv` IPC），
 * **不新增存储表、不新增 IPC 通道、不改文件格式**。
 *
 * 数据来源：
 *  - 实时事件：`recordPlay()` 由播放器在「本地历史记录一次」的同一时机调用。
 *  - 近似基线：`ensureBaseline()` 由视图首次挂载时用既有 `play_history` 合成一次。
 */
export const useMusicJournalStore = defineStore('musicJournal', {
  state: (): MusicJournalState => createEmptyJournalState(),

  getters: {
    /** 已归一化的事件（倒序）。渲染层统一走这里，避免直接信任持久化数据。 */
    safeEvents: (state) => normalizeJournalState({ events: state.events }).events,
    summary: (state) => summarizeJournal(state.events),
  },

  actions: {
    /**
     * 归一化一次当前状态。
     * 持久化数据由 `sqlitePersist` 通过 `$patch` 直接写入，不做形状校验，
     * 因此视图在 hydration 完成后必须调用本方法一次。
     */
    ensureHydratedShape() {
      this.$patch(normalizeJournalState(this.$state));
    },

    /** 记录一次播放事件；曲目/时间非法时静默忽略（不抛错，不影响播放）。 */
    recordPlay(song: unknown, playedAt: number = Date.now()) {
      const event = createPlayEvent(song, playedAt);
      if (!event) return;
      this.events = appendJournalEvent(this.events, event, MUSIC_JOURNAL_MAX_EVENTS);
    },

    /**
     * 用既有 `play_history` 条目合成一次近似基线（幂等：只做一次）。
     * 返回合成的事件条数。
     */
    ensureBaseline(entries: unknown): number {
      if (this.baselineSynthesized) return 0;
      const synthesized = synthesizeBaselineEvents(entries, MUSIC_JOURNAL_BASELINE_MAX_EVENTS);
      this.baselineSynthesized = true;
      if (synthesized.length === 0) return 0;

      let merged = normalizeJournalState({ events: this.events }).events;
      for (const event of synthesized) {
        merged = appendJournalEvent(merged, event, MUSIC_JOURNAL_MAX_EVENTS);
      }
      this.events = merged;
      return synthesized.length;
    },

    /** 标注情绪标签（用户手动，空字符串表示清除）。纯逻辑在 shared 层，便于测试。 */
    setMood(eventId: string, mood: string) {
      this.events = applyEventMood(this.events, eventId, mood);
    },

    /** 清空档案事件（保留 baselineSynthesized，避免清空后又被基线填回）。 */
    clear() {
      this.events = [];
    },
  },

  persist: true,
});
