import type { IconifyIcon } from '@iconify/types';
import headphones from '@iconify/icons-tabler/headphones';
import loader2 from '@iconify/icons-tabler/loader-2';

// 音效广场专用图标。`src/renderer/icons.ts` 属其他代理的文件域，故单独落在本模块，
// 由队长决定是否后续合并回 icons.ts。
export const iconHeadphones = headphones as IconifyIcon;
export const iconLoader2 = loader2 as IconifyIcon;
