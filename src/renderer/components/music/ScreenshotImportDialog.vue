<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import { iconCheckMark, iconChevronLeft, iconPlaylistAdd, iconTriangleAlert } from '@/icons';
import { createScreenshotImportTask, submitImportScreenshot, type NativeImportTask } from '@/api/importPlaylist';
import {
  SCREENSHOT_IMPORT_ACCEPT,
  SCREENSHOT_IMPORT_MAX_FILES,
  createScreenshotTaskSn,
  fileToBase64,
  responseTaskId,
  validateScreenshotFiles,
  waitForNativeImport,
} from '@/composables/useScreenshotImport';
import type { ImportItemResult, ImportSummary } from '@/utils/importPlaylist';
import { useImportTaskStore, type ImportTaskRun } from '@/stores/importTask';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { PlaylistMeta } from '@/models/playlist';
import type { ExternalTrack } from '../../../shared/external';

interface Props {
  open?: boolean;
}
const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const open = useVModel(props, 'open', emit, { defaultValue: false });

const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const importTaskStore = useImportTaskStore();

type Step = 'input' | 'progress';
const step = ref<Step>('input');

const selectedFiles = ref<File[]>([]);
const existingListId = ref<string | number | null>(null);
const screenshotTarget = ref<'existing' | 'new'>('existing');
const newScreenshotPlaylistName = ref('截图导入的歌单');
const isStarting = ref(false);
const isImporting = ref(false);
const abortFlag = ref(false);
const errorMessage = ref('');
const progressDone = ref(0);
const progressTotal = ref(1);
const progressItems = ref<ImportItemResult[]>([]);
const summary = ref<ImportSummary | null>(null);
const backgroundTargetName = ref('截图导入');
const showBackgroundConfirm = ref(false);
const neverShowBackgroundConfirm = ref(false);
const backgroundConfirmDismissed = ref(false);
const showDuplicateNameConfirm = ref(false);
const duplicatePlaylistName = ref('');
let resolveDuplicateNameConfirm: ((name: string | null) => void) | null = null;
let currentDialogRun: ImportTaskRun | null = null;

const canContinueTask = (run: ImportTaskRun) => run.active && !run.signal.aborted;

const currentUserId = computed<number | undefined>(() => {
  const value = userStore.info?.userid ?? userStore.info?.userId;
  return typeof value === 'number' && value > 0 ? value : undefined;
});

const ownedPlaylists = computed<PlaylistMeta[]>(() => {
  const userid = currentUserId.value;
  if (!userid) return [];
  return playlistStore.userPlaylists.filter(
    (playlist) =>
      playlist.source !== 2 &&
      (playlist.listCreateUserid === userid ||
        playlist.isDefault === true ||
        playlist.name === '默认收藏' ||
        playlist.name === '我喜欢的音乐'),
  );
});

const existingPlaylistOptions = computed(() =>
  ownedPlaylists.value.map((playlist) => ({
    label: `${playlist.name}（${playlist.count || playlist.songcount || 0} 首）`,
    value: (playlist.listid || playlist.id) as string | number,
  })),
);

const selectedPlaylist = computed(() =>
  ownedPlaylists.value.find(
    (playlist) => String(playlist.listid || playlist.id) === String(existingListId.value || ''),
  ),
);

const normalizedPlaylistName = (name: string) => name.trim().toLowerCase();
const hasOwnedPlaylistWithName = (name: string) => {
  const normalized = normalizedPlaylistName(name);
  return (
    normalized.length > 0 &&
    ownedPlaylists.value.some(
      (playlist) => normalizedPlaylistName(String(playlist.name ?? '')) === normalized,
    )
  );
};

const finishDuplicateNameConfirm = (confirmed: boolean) => {
  const name = duplicatePlaylistName.value.trim();
  if (confirmed && !name) return;
  showDuplicateNameConfirm.value = false;
  const resolve = resolveDuplicateNameConfirm;
  resolveDuplicateNameConfirm = null;
  resolve?.(confirmed ? name : null);
};

const confirmDuplicatePlaylistName = async (name: string, run: ImportTaskRun) => {
  await playlistStore.fetchUserPlaylists();
  if (!canContinueTask(run)) return null;
  const trimmedName = name.trim();
  if (!hasOwnedPlaylistWithName(trimmedName)) return trimmedName;
  duplicatePlaylistName.value = trimmedName;
  return new Promise<string | null>((resolve) => {
    resolveDuplicateNameConfirm?.(null);
    resolveDuplicateNameConfirm = resolve;
    showDuplicateNameConfirm.value = true;
  });
};

const canStart = computed(() => {
  if (isStarting.value || isImporting.value) return false;
  return (
    selectedFiles.value.length > 0 &&
    (screenshotTarget.value === 'new'
      ? Boolean(newScreenshotPlaylistName.value.trim() && currentUserId.value)
      : Boolean(existingListId.value))
  );
});

const rootTrack: ExternalTrack = { title: '准备导入', artist: '正在准备' };
const nativeStageTracks: Record<'submitted' | 'parsing' | 'playlist' | 'importing', ExternalTrack> =
  {
    submitted: { title: '提交导入任务', artist: '等待提交' },
    parsing: { title: '读取截图信息', artist: '等待读取' },
    playlist: { title: '创建新歌单', artist: '等待创建' },
    importing: { title: '添加歌曲', artist: '等待添加' },
  };

const activeProgressItem = computed(() => {
  return (
    progressItems.value.find((item) => item.status === 'matching' || item.status === 'adding') ||
    progressItems.value.find((item) => item.status === 'pending')
  );
});

const progressLabel = computed(() => {
  if (summary.value) return `已处理 ${summary.value.total} 首`;
  const target = activeProgressItem.value?.external.title;
  return target ? `正在导入 · ${target}` : `正在导入 · ${progressDone.value} / ${progressTotal.value}`;
});

const reset = () => {
  finishDuplicateNameConfirm(false);
  duplicatePlaylistName.value = '';
  step.value = 'input';
  selectedFiles.value = [];
  existingListId.value = null;
  screenshotTarget.value = 'existing';
  newScreenshotPlaylistName.value = '截图导入的歌单';
  isStarting.value = false;
  isImporting.value = false;
  abortFlag.value = false;
  errorMessage.value = '';
  progressDone.value = 0;
  progressTotal.value = 1;
  progressItems.value = [];
  summary.value = null;
  rootTrack.title = '准备导入';
  rootTrack.artist = '正在准备';
};

const resumeFromStore = (completed = false) => {
  step.value = 'progress';
  progressItems.value = importTaskStore.items;
  progressDone.value = importTaskStore.done;
  progressTotal.value = importTaskStore.total || 1;
  isImporting.value = !completed;
  summary.value = completed ? importTaskStore.summary : null;
};

watch(open, (value) => {
  if (!value) {
    if (step.value === 'progress' && isImporting.value) {
      if (backgroundConfirmDismissed.value) {
        importTaskStore.enterBackground(backgroundTargetName.value, () => {
          abortFlag.value = true;
        });
        step.value = 'input';
        return;
      }
      showBackgroundConfirm.value = true;
      open.value = true;
      return;
    }
    if (step.value === 'progress' && importTaskStore.status === 'completed') {
      importTaskStore.dismiss();
    }
    window.setTimeout(reset, 200);
    return;
  }
  if (importTaskStore.status === 'running') resumeFromStore();
  if (value && currentUserId.value) void playlistStore.fetchUserPlaylists();
});

watch(currentUserId, (userid) => {
  if (open.value && userid) void playlistStore.fetchUserPlaylists();
});

let lastOpenRequested = 0;
watch(
  () => importTaskStore.openRequested,
  (value) => {
    if (value === lastOpenRequested || value <= 0) return;
    lastOpenRequested = value;
    if (importTaskStore.status === 'completed') resumeFromStore(true);
  },
);

const updateNativeProgress = (run: ImportTaskRun, task: NativeImportTask) => {
  if (!canContinueTask(run)) return;
  const status = Number(task.status);
  const songs = Number(task.songs_num || 0);
  const imported = Number(task.imported_num || 0);
  const missed = Number(task.missed_num || 0);
  const hasPlaylist = Number(task.listid || 0) > 0;
  const total = Math.max(1, songs, imported + missed);

  nativeStageTracks.submitted.artist = '已提交';
  nativeStageTracks.parsing.artist =
    status === 3 || songs > 0 ? `${songs} 首` : '正在识别截图';
  nativeStageTracks.playlist.artist = hasPlaylist ? '歌单已创建' : '等待创建歌单';
  nativeStageTracks.importing.artist = songs > 0 ? `已导入 ${imported} / ${songs}` : '等待歌曲信息';

  const items: ImportItemResult[] = [
    { external: nativeStageTracks.submitted, status: 'success' },
    {
      external: nativeStageTracks.parsing,
      status: status === 3 || songs > 0 ? 'success' : 'matching',
    },
    {
      external: nativeStageTracks.playlist,
      status: hasPlaylist || status === 3 ? 'success' : 'pending',
    },
    {
      external: nativeStageTracks.importing,
      status: status === 3 ? 'success' : hasPlaylist || songs > 0 ? 'adding' : 'pending',
    },
  ];
  const progressTotalValue = songs > 0 ? total : 4;
  const done = status === 3 ? progressTotalValue : songs > 0 ? Math.min(total - 1, imported) : 1;
  progressDone.value = Math.max(0, done);
  progressTotal.value = progressTotalValue;
  progressItems.value = items;
  items.forEach((item) => run.updateProgress(progressDone.value, progressTotalValue, item));
};

const monitorTask = async (taskId: string | number, run: ImportTaskRun) => {
  isStarting.value = false;
  isImporting.value = true;
  step.value = 'progress';
  updateNativeProgress(run, { id: taskId, status: 0 });

  try {
    const result = await waitForNativeImport(taskId, {
      shouldStop: () => run.signal.aborted || abortFlag.value || importTaskStore.abortRequested,
      onProgress: (task) => updateNativeProgress(run, task),
    });
    if (!canContinueTask(run)) return;
    if (!result) {
      if (importTaskStore.status === 'running') {
        run.dismiss();
        toastStore.warning('已停止查看进度，导入任务仍会继续处理');
      }
      return;
    }

    const total = Math.max(
      1,
      Number(result.task.songs_num || 0),
      Number(result.task.imported_num || 0) + Number(result.task.missed_num || 0),
    );
    const success = Number(result.task.imported_num || 0);
    const skipped = Number(result.task.missed_num || 0);
    const missedItems: ImportItemResult[] = result.missed.map((track) => ({
      external: {
        title: track.audio_name || '未知歌曲',
        artist: track.author_name || '',
      },
      status: 'skipped',
      error: track.reason,
    }));
    const completedItems: ImportItemResult[] = [
      {
        external: {
          title: result.task.name || backgroundTargetName.value,
          artist: `已导入 ${success} 首`,
        },
        status: 'success',
      },
      ...missedItems,
    ];
    const summaryValue: ImportSummary = {
      total,
      success,
      low: 0,
      skipped,
      failed: 0,
    };
    progressItems.value = completedItems;
    progressDone.value = total;
    progressTotal.value = total;
    summary.value = summaryValue;
    run.complete(summaryValue);
    if (!abortFlag.value && !importTaskStore.abortRequested) {
      toastStore.success(`导入完成：成功 ${success} / ${total}`);
    }
    await playlistStore.fetchUserPlaylists();
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    const message = error instanceof Error ? error.message : '导入任务失败';
    const failedItem: ImportItemResult = {
      external: rootTrack,
      status: 'failed',
      error: message,
    };
    progressItems.value = [failedItem];
    summary.value = { total: 1, success: 0, low: 0, skipped: 0, failed: 1 };
    run.updateProgress(1, 1, failedItem);
    run.complete(summary.value);
    toastStore.warning(message);
  }
};

const handleFiles = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const raw = Array.from(input.files || []);
  input.value = '';
  errorMessage.value = '';
  const { files, error } = validateScreenshotFiles(raw);
  selectedFiles.value = files;
  if (error) errorMessage.value = error;
};

const setExistingListId = (value: unknown) => {
  existingListId.value = typeof value === 'string' || typeof value === 'number' ? value : null;
};

const startImport = async () => {
  if (!canStart.value) return;
  abortFlag.value = false;
  const run = importTaskStore.start('截图导入', () => {
    abortFlag.value = true;
  });
  currentDialogRun = run;
  isStarting.value = true;
  errorMessage.value = '';
  summary.value = null;
  progressItems.value = [{ external: rootTrack, status: 'pending' }];

  try {
    if (!currentUserId.value) throw new Error('请先登录');
    let playlistName =
      screenshotTarget.value === 'new'
        ? newScreenshotPlaylistName.value.trim()
        : selectedPlaylist.value?.name || '';
    let listId = existingListId.value;
    if (screenshotTarget.value === 'new') {
      const confirmedName = await confirmDuplicatePlaylistName(playlistName, run);
      if (!confirmedName) {
        run.dismiss();
        if (currentDialogRun === run) currentDialogRun = null;
        isStarting.value = false;
        isImporting.value = false;
        step.value = 'input';
        progressItems.value = [];
        summary.value = null;
        return;
      }
      playlistName = confirmedName;
      listId = await playlistStore.createPlaylistAndReturnId(
        playlistName,
        false,
        currentUserId.value,
      );
      if (!canContinueTask(run)) return;
      if (!listId) throw new Error('新歌单创建失败；如存在同名歌单，请换一个名称后重试');
    }
    if (!listId || !playlistName) throw new Error('请选择或创建目标歌单');
    backgroundTargetName.value = playlistName;
    const taskSn = createScreenshotTaskSn(currentUserId.value);
    for (let index = 0; index < selectedFiles.value.length; index++) {
      if (!canContinueTask(run)) return;
      rootTrack.title = `正在上传截图 ${index + 1} / ${selectedFiles.value.length}`;
      progressDone.value = index;
      progressTotal.value = selectedFiles.value.length + 1;
      step.value = 'progress';
      const item: ImportItemResult = { external: rootTrack, status: 'adding' };
      progressItems.value = [item];
      run.updateProgress(index, progressTotal.value, item);
      const imageBase64 = await fileToBase64(selectedFiles.value[index]);
      if (!canContinueTask(run)) return;
      await submitImportScreenshot(taskSn, imageBase64);
      if (!canContinueTask(run)) return;
    }
    const response = await createScreenshotImportTask(taskSn, listId, playlistName);
    if (!canContinueTask(run)) return;
    rootTrack.title = playlistName;
    await monitorTask(responseTaskId(response), run);
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    run.dismiss();
    isStarting.value = false;
    isImporting.value = false;
    errorMessage.value = error instanceof Error ? error.message : '创建导入任务失败';
    step.value = 'input';
    toastStore.actionFailed('创建导入任务');
  }
};

const stopMonitoring = () => {
  abortFlag.value = true;
  if (importTaskStore.status === 'running') {
    importTaskStore.requestAbort({ feedback: false });
  }
};

const runInBackground = () => {
  importTaskStore.enterBackground(backgroundTargetName.value, () => {
    abortFlag.value = true;
  });
  step.value = 'input';
  open.value = false;
};

const confirmBackgroundImport = () => {
  showBackgroundConfirm.value = false;
  if (neverShowBackgroundConfirm.value) backgroundConfirmDismissed.value = true;
  runInBackground();
};

const goBackToInput = () => {
  if (isImporting.value) return;
  step.value = 'input';
};

const closeResult = () => {
  if (importTaskStore.status === 'completed') importTaskStore.dismiss();
  open.value = false;
};

const itemStatusLabel = (status: ImportItemResult['status']) => {
  if (status === 'success') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '未匹配';
  if (status === 'matching') return '解析中';
  if (status === 'adding') return '导入中';
  return '等待';
};
</script>

<template>
  <Dialog
    v-model:open="open"
    content-class="screenshot-import-dialog"
    show-close
    no-scroll
    :close-on-interact-outside="!isStarting && !isImporting"
    :close-on-escape="!isStarting && !isImporting"
  >
    <template #title>
      <div class="flex items-center justify-between gap-3 w-full pr-8">
        <div class="flex items-center gap-2 min-w-0">
          <Icon :icon="iconPlaylistAdd" width="18" height="18" class="text-primary shrink-0" />
          <span class="truncate">截图导入</span>
        </div>
        <div class="screenshot-import-stepper">
          <span class="screenshot-step-pill" :class="{ 'is-active': step === 'input' }">
            1 选择截图
          </span>
          <span class="screenshot-step-sep" />
          <span class="screenshot-step-pill" :class="{ 'is-active': step === 'progress' }">
            2 导入
          </span>
        </div>
      </div>
    </template>

    <div v-if="step === 'input'" class="flex flex-col gap-3">
      <label class="screenshot-dropzone">
        <input type="file" :accept="SCREENSHOT_IMPORT_ACCEPT" multiple hidden @change="handleFiles" />
        <Icon :icon="iconPlaylistAdd" width="24" height="24" />
        <strong>{{
          selectedFiles.length ? `已选择 ${selectedFiles.length} 张截图` : '选择歌单截图'
        }}</strong>
        <span>JPEG / PNG，最多 {{ SCREENSHOT_IMPORT_MAX_FILES }} 张，单张不超过 10 MB</span>
      </label>

      <div v-if="selectedFiles.length" class="screenshot-file-list">
        <span v-for="file in selectedFiles" :key="`${file.name}-${file.size}`">{{
          file.name
        }}</span>
      </div>

      <div class="screenshot-target-tabs">
        <button
          type="button"
          :class="{ 'is-active': screenshotTarget === 'existing' }"
          @click="screenshotTarget = 'existing'"
        >
          选择歌单
        </button>
        <button
          type="button"
          :class="{ 'is-active': screenshotTarget === 'new' }"
          @click="screenshotTarget = 'new'"
        >
          新建歌单
        </button>
      </div>

      <Select
        v-if="screenshotTarget === 'existing'"
        :model-value="existingListId ?? ''"
        :options="existingPlaylistOptions"
        placeholder="选择要写入的歌单"
        :filterable="ownedPlaylists.length > 8"
        class="w-full"
        @update:model-value="setExistingListId"
      />
      <Input
        v-else
        v-model="newScreenshotPlaylistName"
        placeholder="请输入新歌单名称"
        input-class="h-10 rounded-xl px-3 text-[13px]"
      />

      <p class="screenshot-hint">识别结果会添加到所选歌单，或写入新建歌单。</p>

      <div v-if="errorMessage" class="screenshot-alert">
        <Icon :icon="iconTriangleAlert" width="14" height="14" />
        <span>{{ errorMessage }}</span>
      </div>
    </div>

    <div v-else class="flex flex-col gap-3 pt-1">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[12px] font-semibold text-text-secondary">
          {{ progressLabel }}
        </span>
      </div>
      <div v-if="!summary" class="screenshot-progress-track">
        <div
          class="screenshot-progress-value"
          :style="{ width: `${Math.min(100, (progressDone / Math.max(1, progressTotal)) * 100)}%` }"
        />
      </div>

      <Scrollbar class="screenshot-track-list" :scrollbar-inset="3">
        <div class="flex flex-col">
          <div
            v-for="(item, index) in progressItems"
            :key="index"
            class="screenshot-track-row"
            :class="`status-${item.status}`"
          >
            <span class="screenshot-status-dot" />
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-medium text-text-main truncate">
                {{ item.external.title }}
              </div>
              <div class="text-[11px] text-text-secondary/80 truncate">
                {{ item.external.artist || '未知歌手' }}
                <template v-if="item.matched">
                  → {{ item.matched.title }} - {{ item.matched.artist }}
                </template>
                <template v-if="item.error"> · {{ item.error }}</template>
              </div>
            </div>
            <span class="text-[11px] text-text-secondary/80 shrink-0">
              {{ itemStatusLabel(item.status) }}
            </span>
          </div>
        </div>
      </Scrollbar>

      <p v-if="isImporting" class="screenshot-hint">
        停止查看不会取消当前任务，稍后仍可在歌单列表中查看导入结果。
      </p>
      <div v-if="summary" class="screenshot-summary">
        <Icon
          :icon="summary.success === 0 ? iconTriangleAlert : iconCheckMark"
          width="15"
          height="15"
        />
        <span>
          成功 {{ summary.success }} · 未匹配 {{ summary.skipped }} · 失败 {{ summary.failed }}
        </span>
      </div>
    </div>

    <template #footer>
      <template v-if="step === 'input'">
        <Button variant="ghost" size="sm" :disabled="isStarting" @click="open = false">取消</Button>
        <Button
          variant="primary"
          size="sm"
          :loading="isStarting"
          :disabled="!canStart"
          @click="startImport"
        >
          开始导入
        </Button>
      </template>
      <template v-else-if="summary">
        <Button variant="primary" size="sm" @click="closeResult">完成</Button>
      </template>
      <template v-else>
        <Button variant="ghost" size="sm" :disabled="isStarting" @click="goBackToInput">
          <Icon :icon="iconChevronLeft" width="14" height="14" />
          返回
        </Button>
        <Button v-if="isImporting" variant="secondary" size="sm" @click="stopMonitoring">
          停止查看
        </Button>
        <Button v-if="isImporting" variant="primary" size="sm" @click="runInBackground">
          后台运行
        </Button>
      </template>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showDuplicateNameConfirm"
    title="歌单名称重复"
    :close-on-escape="false"
    :close-on-interact-outside="false"
  >
    <div class="flex flex-col gap-3 py-1">
      <p class="text-[13px] text-text-secondary leading-relaxed">
        已有同名歌单。你可以修改名称，或保留原名称继续创建。
      </p>
      <Input
        v-model="duplicatePlaylistName"
        aria-label="新歌单名称"
        placeholder="请输入新歌单名称"
        input-class="h-10 rounded-xl px-3 text-[13px]"
        @keydown.enter.prevent="finishDuplicateNameConfirm(true)"
      />
      <p class="text-[12px] text-text-secondary leading-relaxed">
        {{
          hasOwnedPlaylistWithName(duplicatePlaylistName)
            ? '该名称仍与已有歌单重复，确定后将创建同名歌单。'
            : '将使用这个新名称创建歌单。'
        }}
      </p>
    </div>
    <template #footer>
      <Button variant="ghost" size="sm" @click="finishDuplicateNameConfirm(false)">取消</Button>
      <Button
        variant="primary"
        size="sm"
        :disabled="!duplicatePlaylistName.trim()"
        @click="finishDuplicateNameConfirm(true)"
      >
        确定
      </Button>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showBackgroundConfirm"
    content-class="screenshot-background-confirm-dialog"
    :close-on-escape="false"
    :close-on-interact-outside="false"
  >
    <template #title>导入将在后台继续</template>
    <div class="flex flex-col gap-4 py-1">
      <p class="text-[13px] text-text-secondary leading-relaxed">
        关闭弹窗不会中断查询，你可以在标题栏任务中心查看进度。
      </p>
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <CheckboxRoot
          v-model:model-value="neverShowBackgroundConfirm"
          class="w-4 h-4 rounded border border-[var(--control-checkbox-border)] flex items-center justify-center data-[state=checked]:bg-[var(--color-primary)] data-[state=checked]:border-[var(--color-primary)]"
        >
          <CheckboxIndicator class="text-white">
            <Icon :icon="iconCheckMark" width="12" height="12" />
          </CheckboxIndicator>
        </CheckboxRoot>
        <span class="text-[12px] text-text-secondary">以后不再提醒</span>
      </label>
    </div>
    <template #footer>
      <Button variant="ghost" size="sm" @click="showBackgroundConfirm = false">留在本页</Button>
      <Button variant="primary" size="sm" @click="confirmBackgroundImport">我知道了</Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-content.screenshot-import-dialog) {
  width: 560px;
  max-height: min(620px, calc(100vh - 64px));
}

.screenshot-dropzone {
  @apply flex flex-col items-center justify-center gap-1.5 rounded-[14px] px-4 py-7 cursor-pointer transition-colors;
  color: var(--color-text-secondary);
  border: 1px dashed color-mix(in srgb, var(--color-primary) 38%, var(--control-border));
  background: var(--control-muted-bg);
}

.screenshot-dropzone:hover {
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

.screenshot-dropzone strong {
  @apply text-[13px] text-text-main;
}

.screenshot-dropzone span {
  @apply text-[11px] text-text-secondary/75;
}

.screenshot-file-list {
  @apply flex flex-wrap gap-1.5;
}

.screenshot-file-list span {
  @apply rounded-full px-2.5 py-1 text-[11px] text-text-secondary max-w-[200px] truncate;
  background: var(--control-muted-bg);
}

.screenshot-target-tabs {
  @apply flex gap-1 rounded-xl p-1;
  background: var(--control-muted-bg);
}

.screenshot-target-tabs button {
  @apply flex-1 rounded-lg py-2 text-[12px] text-text-secondary transition-colors;
}

.screenshot-target-tabs button.is-active {
  background: var(--control-bg);
  color: var(--color-text-main);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.screenshot-hint {
  @apply text-[12px] text-text-secondary/80 leading-relaxed;
}

.screenshot-alert {
  @apply flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px];
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
}

.screenshot-import-stepper {
  @apply flex items-center gap-1.5 shrink-0;
}

.screenshot-step-pill {
  @apply inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-medium;
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
  color: var(--color-text-secondary);
}

.screenshot-step-pill.is-active {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
}

.screenshot-step-sep {
  @apply w-3 h-px;
  background: color-mix(in srgb, var(--color-text-main) 30%, transparent);
}

.screenshot-progress-track {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--control-track-bg);
}

.screenshot-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 0.3s ease;
}

.screenshot-track-list {
  height: clamp(140px, calc(100vh - 420px), 260px);
  min-height: 92px;
}

.screenshot-track-row {
  @apply flex items-center gap-3 px-2 py-2 rounded-[8px];
}

.screenshot-status-dot {
  @apply w-2 h-2 rounded-full shrink-0;
  background: color-mix(in srgb, var(--color-text-main) 30%, transparent);
}

.screenshot-track-row.status-matching .screenshot-status-dot,
.screenshot-track-row.status-adding .screenshot-status-dot {
  background: var(--color-primary);
}

.screenshot-track-row.status-success .screenshot-status-dot {
  background: #10b981;
}

.screenshot-track-row.status-skipped .screenshot-status-dot {
  background: color-mix(in srgb, var(--color-text-main) 25%, transparent);
}

.screenshot-track-row.status-failed .screenshot-status-dot {
  background: var(--state-danger);
}

.screenshot-summary {
  @apply flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px] text-text-main;
  background: color-mix(in srgb, #10b981 10%, transparent);
}

:global(.dialog-content.screenshot-background-confirm-dialog) {
  width: 400px;
  max-width: calc(100vw - 48px);
}

@media (max-width: 640px) {
  :global(.dialog-content.screenshot-import-dialog) {
    width: calc(100vw - 32px);
  }
}
</style>
