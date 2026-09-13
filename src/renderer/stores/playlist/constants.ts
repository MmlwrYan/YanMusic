import type { PersonalFmMode } from './types';

export const DEFAULT_PLAYBACK_QUEUE_ID = 'queue:default';
export const MANUAL_PLAYBACK_QUEUE_ID = 'queue:manual';
export const PERSONAL_FM_QUEUE_ID = 'queue:personal-fm';
// 一起听房间播放队列 id。沿用 Yan 播放队列的 'queue:' 命名约定，取值与 Echo 一致。
// 注意：stores/player/queueAdvancePolicy.ts 内另有一个未被任何代码引用的字面值
// 'listen-together'，两者目前不互通；接线一起听页面时以本常量为准。
export const LISTEN_TOGETHER_QUEUE_ID = 'queue:listen-together';
export const FAVORITES_PAGE_SIZE = 200;
export const MAX_PLAYBACK_QUEUE_COUNT = 4;
export const PERSONAL_FM_MODE: PersonalFmMode = 'normal';
