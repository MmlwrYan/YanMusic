import { getPersistedRendererSettings } from '../storage/persistedStores';
import {
  normalizeNativeAudioOptions,
  type NativeAudioOptions,
} from '../../shared/native-audio-options';

/**
 * 读取渲染层持久化设置中的原生音频/缓存选项。
 *
 * 纯逻辑（默认值与归一化）在 `src/shared/native-audio-options.ts`，
 * 这里只负责从 KV 取数据 —— 与 `networkSettings.ts` 读取网络设置的方式一致。
 */
export const readNativeAudioOptions = (): NativeAudioOptions =>
  normalizeNativeAudioOptions(getPersistedRendererSettings());

export {
  DEFAULT_NATIVE_AUDIO_OPTIONS,
  normalizeNativeAudioOptions,
  type NativeAudioOptions,
} from '../../shared/native-audio-options';
