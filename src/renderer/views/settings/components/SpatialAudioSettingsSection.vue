<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Switch from '@/components/ui/Switch.vue';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconPencil, iconPlus, iconTrash, iconX } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';
import logger from '@/utils/logger';
import {
  normalizeImpulseResponseName,
  type SpatialAudioEffectEntry,
} from '../../../../shared/audio';

const settingStore = useSettingStore();
const toastStore = useToastStore();
const router = useRouter();
const importing = ref(false);
const showFileDialog = ref(false);
const editingFileId = ref('');
const fileNameDraft = ref('');

type EffectCategoryId = 'local' | 'artist' | 'headphone' | 'market';

const fileCategories: { id: EffectCategoryId; label: string; hint: string }[] = [
  { id: 'local', label: '本地导入', hint: '从本地文件导入的空间音效' },
  { id: 'artist', label: '歌手音效', hint: '音效市场中的歌手专属音效' },
  { id: 'headphone', label: '耳机音效', hint: '音效市场中的耳机优化音效' },
  { id: 'market', label: '音效市场', hint: '音效市场下载的其他音效' },
];

const resolveCategory = (file: SpatialAudioEffectEntry): EffectCategoryId => {
  if (file.kind === 'imported-ir') return 'local';
  if (file.source === 'artist' || file.source === 'headphone') return file.source;
  return 'market';
};

const files = computed(() => settingStore.impulseResponseFiles);
const fileGroups = computed(() =>
  fileCategories.map((group) => ({
    ...group,
    files: files.value.filter((file) => resolveCategory(file) === group.id),
  })),
);
const selectedEffect = computed(() => settingStore.getSelectedImpulseResponse());
const mixPercent = computed({
  get: () => Math.round(settingStore.impulseResponseMix * 100),
  set: (value: number) => settingStore.setImpulseResponseMix(Number(value) / 100),
});

const getEffectDisplayName = (name: string) =>
  normalizeImpulseResponseName(name) || '未命名音效';

const handleImpulseResponseEnabledChange = (enabled: boolean) => {
  if (enabled && !selectedEffect.value) {
    toastStore.warning('请先选择或导入一个空间音效');
    return;
  }
  settingStore.impulseResponseEnabled = enabled;
};

const handleImportImpulseResponse = async () => {
  if (!window.electron?.audioEffects || importing.value) return;
  importing.value = true;
  try {
    const result = await window.electron.audioEffects.importImpulseResponse();
    if (result.canceled) return;
    const imported = result.files?.length ? result.files : result.file ? [result.file] : [];
    if (imported.length === 0) {
      toastStore.warning(result.error || '空间音效文件导入失败');
      return;
    }
    settingStore.addImpulseResponseFiles(imported);
    if (result.errors?.length) {
      toastStore.warning(
        `已导入 ${imported.length} 个音效文件，${result.errors.length} 个失败`,
        4200,
      );
    } else {
      toastStore.success(
        imported.length === 1 ? '空间音效文件已导入' : `已导入 ${imported.length} 个音效文件`,
      );
    }
  } catch (error) {
    logger.warn('SpatialAudio', 'Import impulse response failed', error);
    toastStore.danger('空间音效文件导入失败');
  } finally {
    importing.value = false;
  }
};

const handleSelectEffect = (id: string) => {
  settingStore.setSelectedImpulseResponse(id);
  showFileDialog.value = false;
};

const handleRemoveEffect = (id: string) => {
  settingStore.removeImpulseResponseFile(id);
};

const beginRenameEffect = (file: SpatialAudioEffectEntry) => {
  editingFileId.value = file.id;
  fileNameDraft.value = getEffectDisplayName(file.name);
};

const cancelRenameEffect = () => {
  editingFileId.value = '';
  fileNameDraft.value = '';
};

const commitRenameEffect = (id: string) => {
  settingStore.renameImpulseResponseFile(id, fileNameDraft.value);
  cancelRenameEffect();
};
</script>

<template>
  <SettingsSectionShell id="spatialAudio" :title="sectionTitles.spatialAudio.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.spatialAudio.icon"
        :icon="sectionTitles.spatialAudio.icon"
        width="20"
        height="20"
        class="text-primary"
      />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">空间音效</h3>
        <p class="text-sm text-text-secondary">
          通过脉冲响应卷积改变声场；与播放引擎的均衡器、响度归一化可同时生效
        </p>
      </div>
      <Switch
        :model-value="settingStore.impulseResponseEnabled"
        :disabled="settingStore.impulseResponseFiles.length === 0"
        @update:model-value="handleImpulseResponseEnabledChange"
      />
    </div>

    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">当前音效</h3>
        <p class="text-sm text-text-secondary">
          {{ selectedEffect ? getEffectDisplayName(selectedEffect.name) : '未选择音效' }}
        </p>
      </div>
      <div class="effect-actions">
        <Button variant="outline" size="xs" type="button" @click="showFileDialog = true">
          <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
          选择 / 添加
        </Button>
      </div>
    </div>

    <template v-if="settingStore.impulseResponseEnabled && selectedEffect">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">混音比例</h3>
          <p class="text-sm text-text-secondary">空间音效与原声的混合比例</p>
        </div>
        <div class="mix-control">
          <input
            v-model.number="mixPercent"
            class="mix-slider"
            type="range"
            min="10"
            max="100"
            step="1"
            aria-label="空间音效混音比例"
          />
          <span class="mix-value">{{ mixPercent }}%</span>
        </div>
      </div>
    </template>

    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音效文件</h3>
        <p class="text-sm text-text-secondary">
          已管理 {{ files.length }} 个音效文件（本地导入、歌手音效、耳机音效、音效市场）
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        type="button"
        :loading="importing"
        @click="handleImportImpulseResponse"
      >
        <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
        导入
      </Button>
    </div>

    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音效市场</h3>
        <p class="text-sm text-text-secondary">浏览并下载歌手音效、耳机音效等在线音效</p>
      </div>
      <Button variant="outline" size="xs" type="button" @click="router.push('/main/effect-plaza')">
        去音效广场
      </Button>
    </div>

    <Dialog v-model:open="showFileDialog" title="音效管理" showClose :content-style="{ width: '480px' }">
      <div v-if="files.length > 0" class="effect-groups">
        <section v-for="group in fileGroups" v-show="group.files.length > 0" :key="group.id" class="effect-group">
          <header class="effect-group-head">
            <h4 class="effect-group-title">{{ group.label }}</h4>
            <span class="effect-group-count">{{ group.files.length }}</span>
          </header>
          <p class="effect-group-hint">{{ group.hint }}</p>
          <div class="effect-list">
            <div
              v-for="file in group.files"
              :key="file.id"
              class="effect-row"
              :class="{ 'is-active': file.id === settingStore.selectedImpulseResponseId }"
            >
              <span class="effect-row-main">
                <input
                  v-if="editingFileId === file.id"
                  v-model="fileNameDraft"
                  class="effect-rename-input"
                  type="text"
                  maxlength="40"
                  @keydown.enter.prevent="commitRenameEffect(file.id)"
                  @keydown.esc.prevent="cancelRenameEffect"
                />
                <span v-else class="effect-row-name" @click="handleSelectEffect(file.id)">
                  {{ getEffectDisplayName(file.name) }}
                </span>
              </span>
              <template v-if="editingFileId === file.id">
                <button type="button" class="effect-row-btn" title="保存名称" @click.stop="commitRenameEffect(file.id)">
                  <Icon :icon="iconCheckMark" width="14" height="14" />
                </button>
                <button type="button" class="effect-row-btn" title="取消重命名" @click.stop="cancelRenameEffect">
                  <Icon :icon="iconX" width="14" height="14" />
                </button>
              </template>
              <template v-else>
                <button type="button" class="effect-row-btn" title="重命名" @click.stop="beginRenameEffect(file)">
                  <Icon :icon="iconPencil" width="14" height="14" />
                </button>
                <button
                  type="button"
                  class="effect-row-btn is-danger"
                  title="移除音效文件"
                  @click.stop="handleRemoveEffect(file.id)"
                >
                  <Icon :icon="iconTrash" width="14" height="14" />
                </button>
              </template>
            </div>
          </div>
        </section>
      </div>
      <div v-else class="effect-empty">暂无音效文件</div>

      <template #footer>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :loading="importing"
          @click="handleImportImpulseResponse"
        >
          <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
          导入音效文件
        </Button>
      </template>
    </Dialog>
  </SettingsSectionShell>
</template>

<style scoped>
.effect-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mix-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mix-slider {
  width: 160px;
}

.mix-value {
  min-width: 40px;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: right;
}

.effect-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 52vh;
  overflow-y: auto;
}

.effect-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.effect-group-title {
  font-size: 13px;
  font-weight: 650;
}

.effect-group-count {
  padding: 1px 6px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-text-secondary);
  font-size: 10px;
}

.effect-group-hint {
  margin-bottom: 6px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.effect-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.effect-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--control-border);
  border-radius: 8px;
}

.effect-row.is-active {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--control-border));
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}

.effect-row-main {
  min-width: 0;
  flex: 1;
}

.effect-row-name {
  overflow: hidden;
  cursor: pointer;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.effect-rename-input {
  width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--color-bg-elevated);
  font-size: 12px;
}

.effect-row-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border-radius: 6px;
  color: var(--color-text-secondary);
}

.effect-row-btn:hover {
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.effect-row-btn.is-danger:hover {
  color: var(--state-danger);
}

.effect-empty {
  padding: 18px 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: center;
}
</style>
