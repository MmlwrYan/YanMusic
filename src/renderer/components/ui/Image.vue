<script setup lang="ts">
import { ref, watch } from 'vue';
import { iconImage } from '@/icons';

interface Props {
  src?: string;
  alt?: string;
  class?: string;
  skeletonClass?: string;
  showSkeleton?: boolean;
  /**
   * 原生图片加载策略。
   *
   * 默认 `lazy`：列表 / 网格 / 长页面里的封面与头像在接近视口时才请求，
   * 避免「一次渲染 50 张封面 → 同时发起 50 个请求 + 主线程排队解码」，
   * 从而减少页面切换白屏与滚动时的图片跳动。
   *
   * 首屏关键图（当前播放封面、歌词页主视觉等）请显式传 `eager`。
   */
  loading?: 'lazy' | 'eager';
  /** 原生解码策略；默认 `async`，让解码不阻塞主线程。 */
  decoding?: 'async' | 'sync' | 'auto';
}

const props = withDefaults(defineProps<Props>(), {
  src: '',
  alt: '',
  class: 'w-full h-full object-cover',
  showSkeleton: true,
  loading: 'lazy',
  decoding: 'async',
});

const status = ref<'loading' | 'success' | 'error'>('loading');

watch(
  () => props.src,
  (newSrc) => {
    if (newSrc) status.value = 'loading';
    else status.value = 'error';
  },
  { immediate: true },
);

const handleLoad = () => (status.value = 'success');
const handleError = () => (status.value = 'error');
</script>

<template>
  <div :class="['relative overflow-hidden', props.class]">
    <!-- 1. Skeleton Loading -->
    <div
      v-if="status === 'loading' && showSkeleton"
      :class="['absolute inset-0 bg-[var(--control-hover-bg)] animate-pulse z-10', skeletonClass]"
    ></div>

    <!-- 2. Image -->
    <img
      v-if="src"
      :src="src"
      :alt="alt"
      :loading="loading"
      :decoding="decoding"
      @load="handleLoad"
      @error="handleError"
      :class="[
        'w-full h-full object-cover transition-opacity duration-500',
        status === 'success' ? 'opacity-100' : 'opacity-0',
      ]"
    />

    <!-- 3. Error State -->
    <div
      v-if="status === 'error' || (!src && status !== 'loading')"
      class="absolute inset-0 flex items-center justify-center bg-[var(--control-muted-bg)] z-20"
    >
      <Icon :icon="iconImage" width="24" height="24" class="opacity-10" />
    </div>
  </div>
</template>
