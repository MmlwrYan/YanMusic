<script setup lang="ts">
import { ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import ContentBlacklistDialog from '@/components/profile/ContentBlacklistDialog.vue';
import { Icon } from '@iconify/vue';
import {
  sanitizePortableAppSettings,
  type SettingsBackupSummary,
} from '../../../../shared/settingsBackup';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const toastStore = useToastStore();
const showBlacklistDialog = ref(false);
const showImportDialog = ref(false);
const isExporting = ref(false);
const isInspecting = ref(false);
const isImporting = ref(false);
const importToken = ref('');
const importSummary = ref<SettingsBackupSummary | null>(null);
defineProps<{
  onClear: () => void;
}>();

const getBackupApi = () => window.electron?.settingsBackup;

const formatBackupTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN');
};

const handleExportSettings = async () => {
  if (isExporting.value) return;
  const backupApi = getBackupApi();
  if (!backupApi) {
    toastStore.warning('当前版本不支持备份设置');
    return;
  }
  isExporting.value = true;
  try {
    const result = await backupApi.export({
      settings: true,
      plugins: false,
      settingsData: sanitizePortableAppSettings(settingStore.$state),
    });
    if (!result.ok) {
      if (!result.canceled) toastStore.warning(result.error || '备份设置失败');
      return;
    }
    const detail = result.summary.settingCount ? `（${result.summary.settingCount} 项）` : '';
    toastStore.success(`设置已备份${detail}`);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '备份设置失败');
  } finally {
    isExporting.value = false;
  }
};

const handleChooseImport = async () => {
  if (isInspecting.value) return;
  const backupApi = getBackupApi();
  if (!backupApi) {
    toastStore.warning('当前版本不支持导入设置');
    return;
  }
  isInspecting.value = true;
  try {
    const result = await backupApi.inspect();
    if (!result.ok) {
      if (!result.canceled) toastStore.warning(result.error || '无法读取备份文件');
      return;
    }
    importToken.value = result.token;
    importSummary.value = result.summary;
    showImportDialog.value = true;
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '无法读取备份文件');
  } finally {
    isInspecting.value = false;
  }
};

const closeImportDialog = () => {
  if (isImporting.value) return;
  importToken.value = '';
  importSummary.value = null;
  showImportDialog.value = false;
};

const handleImport = async () => {
  if (isImporting.value || !importToken.value) return;
  const backupApi = getBackupApi();
  if (!backupApi) return;
  isImporting.value = true;
  try {
    const result = await backupApi.import({
      token: importToken.value,
      settings: true,
      plugins: false,
    });
    // 主进程在校验后即消耗掉该 token，无论成功失败都需要重新选择备份文件。
    importToken.value = '';
    importSummary.value = null;
    showImportDialog.value = false;
    if (!result.ok) {
      toastStore.warning(`${result.error || '导入设置失败'}，请重新选择备份文件`, 6000);
      return;
    }
    toastStore.success('设置已导入，重启应用后生效', 4000);
  } catch (error) {
    importToken.value = '';
    importSummary.value = null;
    showImportDialog.value = false;
    toastStore.warning(error instanceof Error ? error.message : '导入设置失败', 6000);
  } finally {
    isImporting.value = false;
  }
};
</script>

<template>
  <SettingsSectionShell id="data" :title="sectionTitles.data.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.data.icon"
        :icon="sectionTitles.data.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">备份设置</h3>
        <p class="text-sm text-text-secondary">把可迁移的应用设置导出为本地备份文件</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="settings-button"
        :loading="isExporting"
        :disabled="isExporting"
        @click="handleExportSettings"
      >
        立即备份
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">导入设置</h3>
        <p class="text-sm text-text-secondary">从备份文件恢复应用设置，重启后生效</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="settings-button"
        :loading="isInspecting"
        :disabled="isInspecting"
        @click="handleChooseImport"
      >
        立即导入
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">查看运行日志</h3>
        <p class="text-sm text-text-secondary">打开本地日志目录以供排查问题</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="settings-button"
        @click="settingStore.openLogDirectory()"
      >
        立即查看
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">黑名单管理</h3>
        <p class="text-sm text-text-secondary">管理已屏蔽的歌手与歌曲</p>
      </div>
      <Button variant="ghost" size="xs" class="settings-button" @click="showBlacklistDialog = true">
        立即管理
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">清除应用数据</h3>
        <p class="text-sm text-text-secondary">移除所有持久化设置及缓存信息</p>
      </div>
      <Button variant="ghost" size="xs" class="settings-button danger" @click="onClear">
        立即清除
      </Button>
    </div>
    <ContentBlacklistDialog v-model:open="showBlacklistDialog" />
  </SettingsSectionShell>

  <Dialog
    v-model:open="showImportDialog"
    title="从备份恢复设置"
    description="恢复会覆盖备份中同名的应用设置，登录状态、设备身份和本机文件路径不会被恢复。恢复完成后需要重启应用才会全部生效。"
    :close-on-interact-outside="!isImporting"
    :close-on-escape="!isImporting"
  >
    <div v-if="importSummary" class="backup-meta">
      <span>备份版本：YanMusic {{ importSummary.appVersion || '未知' }}</span>
      <span>创建时间：{{ formatBackupTime(importSummary.createdAt) }}</span>
      <span>可恢复设置：{{ importSummary.settingCount }} 项</span>
    </div>
    <template #footer>
      <Button variant="outline" size="sm" :disabled="isImporting" @click="closeImportDialog">
        取消
      </Button>
      <Button
        size="sm"
        :disabled="isImporting || !importToken"
        :loading="isImporting"
        @click="handleImport"
      >
        恢复设置
      </Button>
    </template>
  </Dialog>
</template>

<style scoped src="../settingsSection.css"></style>
<style scoped>
.backup-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--control-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
  color: var(--color-text-secondary);
  font-size: 11px;
}
</style>
