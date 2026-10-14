<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import { iconSettings, iconTriangleAlert } from '@/icons';
import type { PluginRuntimeRecord } from '@/plugins/runtime';
import { buildFailureSummary } from './pluginFailureSummary';

type FailureDetail = {
  reason: string;
  isHistorical?: boolean;
  /** V4-18（v1.4.0）：卡片上的**内联**错误摘要，让用户不必先找到告警图标才知道原因。 */
  message?: string;
} | null;

const props = defineProps<{
  record: PluginRuntimeRecord;
  busy: boolean;
  safeMode: boolean;
  iconUrl: string;
  initial: string;
  accentStyle: Record<string, string>;
  statusLabel: string;
  statusTitle: string;
  compatibilityMessage: string;
  featureTags: string[];
  cardFailure: FailureDetail;
  hasCurrentFailure: boolean;
  hasFailure: boolean;
  hasHistoricalFailure: boolean;
  failureTitle: string;
  settingsAvailable: boolean;
  settingsTitle: string;
}>();

const emit = defineEmits<{
  (e: 'toggle', pluginId: string, enabled: boolean): void;
  (e: 'settings', record: PluginRuntimeRecord): void;
  (e: 'uninstall', pluginId: string): void;
  (e: 'failure-detail', pluginId: string): void;
  (e: 'icon-error', pluginId: string): void;
}>();

/**
 * V4-18：卡片内联故障摘要。
 *
 * 刻意**只在「有当前故障」时显示** —— 历史故障（`isHistorical`）不占卡片空间，
 * 它仍可在详情弹窗里查（否则用户修好一个插件后，卡片会永远挂着一行旧错误）。
 *
 * 折叠规则在 `pluginFailureSummary.ts`（零依赖，可直接单测）。
 */
const failureSummary = computed(() =>
  props.hasCurrentFailure ? buildFailureSummary(props.cardFailure?.message) : '',
);
</script>

<template>
  <article
    class="plugin-card"
    :class="{
      'is-disabled':
        !record.descriptor.enabled ||
        record.descriptor.invalid ||
        !record.descriptor.compatibility.compatible,
      'is-error': hasCurrentFailure && cardFailure?.reason !== 'incompatible',
      'is-warning': cardFailure?.reason === 'incompatible',
    }"
  >
    <div class="plugin-card-main">
      <div class="plugin-card-media" :class="{ 'has-icon': iconUrl }" :style="accentStyle">
        <img
          v-if="iconUrl"
          :src="iconUrl"
          :alt="record.descriptor.name"
          class="plugin-card-icon"
          loading="lazy"
          decoding="async"
          @error="emit('icon-error', record.descriptor.id)"
        />
        <span v-else class="plugin-card-initial">
          {{ initial }}
        </span>
      </div>

      <div class="plugin-card-summary">
        <div class="plugin-card-header">
          <h3 class="plugin-card-name" :title="record.descriptor.name">
            {{ record.descriptor.name }}
          </h3>
          <span
            class="plugin-status-badge"
            :title="statusTitle"
            :class="{
              'is-active': record.status === 'active' && !hasCurrentFailure,
              'is-error': hasCurrentFailure && cardFailure?.reason !== 'incompatible',
              'is-safe': safeMode && record.descriptor.enabled && !hasCurrentFailure,
              'is-warning': cardFailure?.reason === 'incompatible',
            }"
          >
            {{ statusLabel }}
          </span>
        </div>

        <div class="plugin-card-meta">
          <span>v{{ record.descriptor.version }}</span>
          <span v-if="record.descriptor.manifest.author">
            · {{ record.descriptor.manifest.author }}
          </span>
        </div>
      </div>
    </div>

    <p class="plugin-card-description">
      {{ record.descriptor.description || '暂无描述' }}
    </p>

    <div v-if="featureTags.length" class="plugin-feature-tags">
      <span v-for="tag in featureTags.slice(0, 5)" :key="tag">
        {{ tag }}
      </span>
    </div>

    <div v-if="compatibilityMessage" class="plugin-card-error is-warning">
      <Icon :icon="iconTriangleAlert" width="14" height="14" />
      <span>{{ compatibilityMessage }}</span>
    </div>

    <!--
      V4-18（v1.4.0）：故障**内联摘要**。

      修复前卡片上只有状态徽标「出错」/「异常」二字，原因要点开右侧那个小三角图标
      才看得到 —— 而运行时实测（water-lyrics）表明：**用户最先看到的就是这行字**，
      看不到原因时只能猜是插件坏了、插件源坏了、还是网络问题（与 v1.3.6 修
      「插件列表静默少显示条目」是同一类体验缺陷）。

      这里只显示**一行摘要**，完整信息（类型/位置/时间/调用栈）仍在详情弹窗里 ——
      卡片空间有限，且调用栈本来就不适合内联。
    -->
    <div v-if="failureSummary" class="plugin-card-error" :title="cardFailure?.message">
      <Icon :icon="iconTriangleAlert" width="14" height="14" />
      <span class="plugin-card-error-text">{{ failureSummary }}</span>
    </div>

    <div class="plugin-card-id" :title="record.descriptor.id">ID: {{ record.descriptor.id }}</div>

    <div class="plugin-card-actions">
      <div class="plugin-card-action-group">
        <div class="plugin-card-primary-actions">
          <Button
            variant="ghost"
            size="xs"
            class="plugin-settings-btn"
            :class="{ 'is-unavailable': !settingsAvailable }"
            :title="settingsTitle"
            :disabled="busy"
            @click="emit('settings', record)"
          >
            <Icon :icon="iconSettings" width="14" height="14" />
            设置
          </Button>

          <Button
            variant="ghost"
            size="xs"
            class="plugin-remove-btn"
            :disabled="busy"
            @click="emit('uninstall', record.descriptor.id)"
          >
            移除
          </Button>
        </div>

        <button
          v-if="hasFailure"
          class="plugin-card-failure-btn"
          :class="{
            'is-historical': hasHistoricalFailure,
            'is-warning': cardFailure?.reason === 'incompatible',
          }"
          type="button"
          :title="failureTitle"
          @click="emit('failure-detail', record.descriptor.id)"
        >
          <Icon :icon="iconTriangleAlert" width="14" height="14" />
        </button>
      </div>

      <Switch
        :model-value="record.descriptor.enabled"
        :disabled="record.descriptor.invalid || !record.descriptor.compatibility.compatible || busy"
        @update:model-value="(value) => emit('toggle', record.descriptor.id, value)"
      />
    </div>
  </article>
</template>
