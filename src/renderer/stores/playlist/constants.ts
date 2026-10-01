import type { PersonalFmMode } from './types';

export const DEFAULT_PLAYBACK_QUEUE_ID = 'queue:default';
export const MANUAL_PLAYBACK_QUEUE_ID = 'queue:manual';
export const PERSONAL_FM_QUEUE_ID = 'queue:personal-fm';
// 一起听房间播放队列 id。沿用 Yan 播放队列的 'queue:' 命名约定，取值与 Echo 一致。
// （v1.2.9：原注释提到的 `stores/player/queueAdvancePolicy.ts` 已随零引用模块清理删除。）
export const LISTEN_TOGETHER_QUEUE_ID = 'queue:listen-together';
export const FAVORITES_PAGE_SIZE = 200;
export const MAX_PLAYBACK_QUEUE_COUNT = 4;
export const PERSONAL_FM_MODE: PersonalFmMode = 'normal';
