<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  MOOD_PRESETS,
  buildJournalShareText,
  buildJournalView,
  toLocalTimeZoneOffsetMinutes,
} from '../../shared/musicJournal';
import { useMusicJournalStore } from '@/stores/musicJournal';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import type { StorageHistoryEntry } from '../../shared/storage';

/**
 * 听歌档案（C2 完整版）视图。
 *
 * 设计要点：
 *  - 视图**不承载聚合逻辑**：全部数据来自 `buildJournalView()`（纯逻辑、有单测覆盖），
 *    组件只做渲染与交互。
 *  - 图表用 CSS 自绘，不引入图表库（避免为一张柱状图新增渲染层依赖）。
 *  - 情绪标签是**用户手动标注**，不做自动推断（见 shared/musicJournal.ts 的口径说明）。
 *  - 导出复用既有 `share:capture-rect-to-clipboard` 通道，不新增 IPC。
 */

const journal = useMusicJournalStore();

const now = ref(Date.now());
const windowDays = ref(14);
const windowWeeks = ref(6);
const timeZoneOffsetMinutes = ref(toLocalTimeZoneOffsetMinutes());

const captureRef = ref<HTMLElement | null>(null);
const exporting = ref(false);
const exportHint = ref('');

const year = computed(() => new Date(now.value).getFullYear());

const view = computed(() =>
  buildJournalView(journal.safeEvents, {
    now: now.value,
    days: windowDays.value,
    weeks: windowWeeks.value,
    year: year.value,
    timeZoneOffsetMinutes: timeZoneOffsetMinutes.value,
  }),
);

/** 柱高百分比：以窗口内峰值为基准，0 次也留 2% 让基线可见。 */
const barHeight = (plays: number): string => {
  const max = view.value.maxDailyPlays;
  if (max <= 0) return '2%';
  return `${Math.max(2, Math.round((plays / max) * 100))}%`;
};

const recentEvents = computed(() => journal.safeEvents.slice(0, 50));

const taggedRatio = computed(() => {
  const total = view.value.summary.totalPlays;
  if (total <= 0) return 0;
  return Math.round((view.value.moods.taggedPlays / total) * 100);
});

const formatTimestamp = (value: number): string =>
  new Date(value).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatDayLabel = (dayKey: string): string => dayKey.slice(5);

/** 首次挂载：等持久化 hydration 完成 → 归一化形状 → 用既有播放历史合成一次近似基线。 */
onMounted(async () => {
  await waitForSqlitePersistHydration();
  journal.ensureHydratedShape();
  try {
    const entries = (await window.electron?.storage?.getHistoryEntries({
      limit: 500,
    })) as StorageHistoryEntry[] | undefined;
    if (Array.isArray(entries) && entries.length > 0) {
      journal.ensureBaseline(entries);
    } else {
      journal.ensureBaseline([]);
    }
  } catch {
    // 历史不可用时仍可展示实时采集的档案
    journal.ensureBaseline([]);
  }
});

const tagMood = (eventId: string, mood: string) => {
  journal.setMood(eventId, mood);
};

const exportAsImage = async () => {
  if (exporting.value) return;
  const element = captureRef.value;
  if (!element) return;
  exporting.value = true;
  exportHint.value = '';
  try {
    const rect = element.getBoundingClientRect();
    const ok = await window.electron?.share?.captureRectToClipboard({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    exportHint.value = ok ? '已复制到剪贴板' : '导出失败，请重试';
  } catch {
    exportHint.value = '导出失败，请重试';
  } finally {
    exporting.value = false;
  }
};

const copySummary = async () => {
  const text = buildJournalShareText(view.value);
  try {
    const ok = await window.electron?.share?.copy(text);
    exportHint.value = ok ? '摘要已复制' : '复制失败';
  } catch {
    exportHint.value = '复制失败';
  }
};

const clearJournal = () => {
  journal.clear();
  exportHint.value = '档案已清空';
};
</script>

<template>
  <div class="journal-page">
    <header class="journal-header">
      <div>
        <h1 class="journal-title">听歌档案</h1>
        <p class="journal-subtitle">
          全部数据仅保存在本机（<code>pinia:musicJournal</code>），不上传、不依赖登录。
        </p>
      </div>
      <div class="journal-actions">
        <label class="journal-field">
          窗口
          <select v-model.number="windowDays" class="journal-select">
            <option :value="7">最近 7 天</option>
            <option :value="14">最近 14 天</option>
            <option :value="30">最近 30 天</option>
            <option :value="90">最近 90 天</option>
          </select>
        </label>
        <button class="journal-button" :disabled="exporting" @click="exportAsImage">
          导出图片
        </button>
        <button class="journal-button" @click="copySummary">复制摘要</button>
        <button class="journal-button journal-button--ghost" @click="clearJournal">清空档案</button>
      </div>
    </header>

    <p v-if="exportHint" class="journal-hint">{{ exportHint }}</p>

    <section ref="captureRef" class="journal-capture">
      <div class="journal-cards">
        <div class="journal-card">
          <span class="journal-card-label">总播放</span>
          <strong class="journal-card-value">{{ view.summary.totalPlays }}</strong>
          <span class="journal-card-foot">次</span>
        </div>
        <div class="journal-card">
          <span class="journal-card-label">曲目</span>
          <strong class="journal-card-value">{{ view.summary.distinctSongs }}</strong>
          <span class="journal-card-foot">首</span>
        </div>
        <div class="journal-card">
          <span class="journal-card-label">活跃天数</span>
          <strong class="journal-card-value">{{ view.review.activeDays }}</strong>
          <span class="journal-card-foot">天</span>
        </div>
        <div class="journal-card">
          <span class="journal-card-label">情绪标注率</span>
          <strong class="journal-card-value">{{ taggedRatio }}%</strong>
          <span class="journal-card-foot">手动标注</span>
        </div>
      </div>

      <p v-if="view.summary.syntheticEvents > 0" class="journal-note">
        含 {{ view.summary.syntheticEvents }} 条<b>近似基线</b>：由升级前的播放历史合成，
        时间点取「最后一次播放」，次数按历史累计计入（图中以虚线柱标识）。
      </p>

      <section class="journal-section">
        <h2 class="journal-section-title">时间轴（最近 {{ windowDays }} 天）</h2>
        <div v-if="view.timeline.length === 0" class="journal-empty">暂无数据</div>
        <div v-else class="journal-timeline">
          <div v-for="point in view.timeline" :key="point.dayKey" class="journal-bar-column">
            <span class="journal-bar-value">{{ point.plays || '' }}</span>
            <div
              class="journal-bar"
              :class="{ 'journal-bar--synthetic': point.hasSynthetic }"
              :style="{ height: barHeight(point.plays) }"
              :title="`${point.dayKey}：${point.plays} 次 / ${point.distinctSongs} 首`"
            />
            <span class="journal-bar-label">{{ formatDayLabel(point.dayKey) }}</span>
          </div>
        </div>
      </section>

      <section class="journal-section">
        <h2 class="journal-section-title">周汇总（最近 {{ windowWeeks }} 周）</h2>
        <table class="journal-table">
          <thead>
            <tr>
              <th>区间</th>
              <th>播放</th>
              <th>曲目</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="week in view.weekly" :key="week.weekIndex">
              <td>{{ week.label }}</td>
              <td>{{ week.plays }}</td>
              <td>{{ week.distinctSongs }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="journal-section">
        <h2 class="journal-section-title">时段分布</h2>
        <div class="journal-buckets">
          <div v-for="bucket in view.timeOfDay" :key="bucket.id" class="journal-bucket">
            <span class="journal-bucket-label">{{ bucket.label }}</span>
            <div class="journal-bucket-track">
              <div
                class="journal-bucket-fill"
                :style="{
                  width: barHeight(bucket.plays),
                }"
              />
            </div>
            <span class="journal-bucket-value">{{ bucket.plays }}</span>
          </div>
        </div>
      </section>

      <section class="journal-section">
        <h2 class="journal-section-title">情绪分布（手动标注）</h2>
        <div v-if="view.moods.moods.length === 0" class="journal-empty">
          还没有标注。可在下方「最近播放」中为任意一次播放选择情绪。
        </div>
        <div v-else class="journal-moods">
          <span v-for="mood in view.moods.moods" :key="mood.mood" class="journal-mood-chip">
            {{ mood.mood }} · {{ mood.plays }}
          </span>
          <span class="journal-mood-chip journal-mood-chip--muted">
            未标注 · {{ view.moods.untaggedPlays }}
          </span>
        </div>
      </section>

      <section class="journal-section">
        <h2 class="journal-section-title">{{ view.year }} 年度回顾</h2>
        <div class="journal-review">
          <div class="journal-review-block">
            <h3>最常听</h3>
            <ol class="journal-rank">
              <li v-for="song in view.review.topSongs.slice(0, 10)" :key="song.songKey">
                <span class="journal-rank-title">{{ song.title }}</span>
                <span class="journal-rank-meta">{{ song.artist }} · {{ song.plays }} 次</span>
              </li>
            </ol>
          </div>
          <div class="journal-review-block">
            <h3>最常听歌手</h3>
            <ol class="journal-rank">
              <li v-for="artist in view.review.topArtists.slice(0, 10)" :key="artist.artist">
                <span class="journal-rank-title">{{ artist.artist }}</span>
                <span class="journal-rank-meta">{{ artist.plays }} 次</span>
              </li>
            </ol>
          </div>
          <div class="journal-review-block">
            <h3>最常听专辑</h3>
            <ol class="journal-rank">
              <li v-for="album in view.review.topAlbums.slice(0, 10)" :key="album.album">
                <span class="journal-rank-title">{{ album.album }}</span>
                <span class="journal-rank-meta">{{ album.plays }} 次</span>
              </li>
            </ol>
          </div>
          <div class="journal-review-block">
            <h3>最忙的一天</h3>
            <p v-if="view.review.busiestDay" class="journal-busiest">
              {{ view.review.busiestDay.dayKey }} · {{ view.review.busiestDay.plays }} 次
            </p>
            <p v-else class="journal-empty">暂无数据</p>
          </div>
        </div>
      </section>
    </section>

    <section class="journal-section">
      <h2 class="journal-section-title">最近播放（可标注情绪）</h2>
      <div v-if="recentEvents.length === 0" class="journal-empty">暂无记录</div>
      <ul v-else class="journal-events">
        <li v-for="item in recentEvents" :key="item.id" class="journal-event">
          <div class="journal-event-main">
            <span class="journal-event-title">{{ item.title }}</span>
            <span class="journal-event-meta">
              {{ item.artist }} · {{ formatTimestamp(item.playedAt) }}
              <template v-if="item.synthetic"
                >· 近似基线（{{ item.baselinePlayCount }} 次）</template
              >
            </span>
          </div>
          <div class="journal-event-moods">
            <button
              v-for="mood in MOOD_PRESETS"
              :key="mood"
              class="journal-mood-button"
              :class="{ 'journal-mood-button--active': item.mood === mood }"
              @click="tagMood(item.id, item.mood === mood ? '' : mood)"
            >
              {{ mood }}
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.journal-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
  overflow-y: auto;
  height: 100%;
  color: var(--text-primary, #e8e8ea);
}

.journal-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  justify-content: space-between;
}

.journal-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.journal-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.65;
}

.journal-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.journal-field {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  opacity: 0.8;
}

.journal-select,
.journal-button {
  padding: 6px 10px;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
  background: rgb(255 255 255 / 6%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
}

.journal-button--ghost {
  opacity: 0.7;
}

.journal-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.journal-hint {
  margin: 0;
  font-size: 12px;
  color: var(--accent, #7aa2f7);
}

.journal-capture {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 18px;
  background: rgb(255 255 255 / 3%);
  border-radius: 14px;
}

.journal-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.journal-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: rgb(255 255 255 / 5%);
  border-radius: 10px;
}

.journal-card-label {
  font-size: 12px;
  opacity: 0.65;
}

.journal-card-value {
  font-size: 22px;
  font-weight: 600;
}

.journal-card-foot {
  font-size: 11px;
  opacity: 0.55;
}

.journal-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.75;
}

.journal-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.journal-section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  opacity: 0.9;
}

.journal-empty {
  font-size: 12px;
  opacity: 0.55;
}

.journal-timeline {
  display: flex;
  gap: 4px;
  align-items: flex-end;
  height: 160px;
  padding: 8px;
  overflow-x: auto;
  background: rgb(0 0 0 / 12%);
  border-radius: 10px;
}

.journal-bar-column {
  display: flex;
  flex: 0 0 22px;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}

.journal-bar-value {
  font-size: 10px;
  opacity: 0.7;
}

.journal-bar {
  width: 100%;
  background: linear-gradient(180deg, #7aa2f7, #4a6fd4);
  border-radius: 4px 4px 2px 2px;
  transition: height 0.2s ease;
}

.journal-bar--synthetic {
  background: repeating-linear-gradient(
    45deg,
    rgb(122 162 247 / 45%),
    rgb(122 162 247 / 45%) 4px,
    rgb(122 162 247 / 15%) 4px,
    rgb(122 162 247 / 15%) 8px
  );
  border: 1px dashed rgb(122 162 247 / 60%);
}

.journal-bar-label {
  font-size: 9px;
  white-space: nowrap;
  opacity: 0.5;
}

.journal-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}

.journal-table th,
.journal-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.journal-table th {
  font-weight: 600;
  opacity: 0.7;
}

.journal-buckets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.journal-bucket {
  display: grid;
  grid-template-columns: 48px 1fr 40px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}

.journal-bucket-track {
  height: 10px;
  overflow: hidden;
  background: rgb(255 255 255 / 8%);
  border-radius: 5px;
}

.journal-bucket-fill {
  height: 100%;
  background: linear-gradient(90deg, #4a6fd4, #7aa2f7);
}

.journal-bucket-value {
  text-align: right;
  opacity: 0.7;
}

.journal-moods {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.journal-mood-chip {
  padding: 4px 10px;
  font-size: 12px;
  background: rgb(122 162 247 / 18%);
  border-radius: 999px;
}

.journal-mood-chip--muted {
  background: rgb(255 255 255 / 6%);
  opacity: 0.7;
}

.journal-review {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

.journal-review-block h3 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}

.journal-rank {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}

.journal-rank li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

.journal-rank-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journal-rank-meta {
  flex: none;
  opacity: 0.55;
}

.journal-busiest {
  margin: 0;
  font-size: 13px;
}

.journal-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.journal-event {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: rgb(255 255 255 / 4%);
  border-radius: 8px;
}

.journal-event-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.journal-event-title {
  font-size: 13px;
}

.journal-event-meta {
  font-size: 11px;
  opacity: 0.6;
}

.journal-event-moods {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.journal-mood-button {
  padding: 3px 8px;
  font-size: 11px;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgb(255 255 255 / 15%);
  border-radius: 999px;
}

.journal-mood-button--active {
  background: rgb(122 162 247 / 28%);
  border-color: rgb(122 162 247 / 60%);
}
</style>
