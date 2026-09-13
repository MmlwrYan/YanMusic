<script setup lang="ts">
defineOptions({ name: 'effect-plaza' });
import { onMounted } from 'vue';
import EffectPlaza from './EffectPlaza.vue';
import { useAudioEffectPlaza } from '@/composables/useAudioEffectPlaza';

// 音效广场以独立页面承载；面板组件本身只依赖传入的 plaza 状态。
// composable 的生命周期挂在本页面上，切换分类不会丢失下载状态与分页缓存。
const plaza = useAudioEffectPlaza();

onMounted(() => plaza.ensureLoaded());
</script>

<template>
  <div class="effect-plaza-page">
    <div class="effect-plaza-shell">
      <EffectPlaza :plaza="plaza" />
    </div>
  </div>
</template>

<style scoped>
.effect-plaza-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-elevated);
}
.effect-plaza-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  max-width: 920px;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--control-border);
  border-right: 1px solid var(--control-border);
}
</style>
