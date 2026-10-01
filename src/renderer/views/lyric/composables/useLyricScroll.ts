import { ref, watch, nextTick, type Ref } from 'vue';
import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { requestPluginLyricAutoScroll } from '@/plugins/lyricEffects';

/**
 * 歌词滚动逻辑
 * - 自动跟随当前播放行
 * - 用户滚轮滚动时暂停跟随
 * - 滚动结束后自动高亮对应时间行并恢复跟随
 */
export function useLyricScroll(
  lyricListRef: () => HTMLElement | null,
  collapsed?: Ref<boolean>,
  activeIndex?: Ref<number>,
) {
  const lyricStore = useLyricStore();
  const playerStore = usePlayerStore();

  const isUserScrolling = ref(false);
  const scrollHighlightIndex = ref(-1); // 滚轮停止后高亮的行索引
  let userScrollResumeTimer: number | null = null;
  let scrollEndTimer: number | null = null;
  let scrollRafId: number | null = null;
  let smoothScrollRafId: number | null = null;

  /**
   * 自动跟随换句的滑动时长（v1.2.6）。
   *
   * 为什么**不用**浏览器的 `scrollTo({ behavior: 'smooth' })`：
   * 它的时长由浏览器决定（数百毫秒），且**无法取消/重定向**。当下一句紧接着到来时，
   * 旧动画仍在进行、新目标又已下达，两个滚动目标互相打断 —— 这正是用户看到的
   * 「先换到下一句 → 回一下 → 再到下一句」（闪回）。
   *
   * 改为自绘 rAF 动画后：时长可控、每次新滚动都**取消上一个**、起点取当前位置，
   * 因此既保留可见的滑动过程，又不会出现多动画竞争。
   */
  const AUTO_SCROLL_DURATION_MS = 200;

  const clearSmoothScroll = () => {
    if (smoothScrollRafId !== null) {
      cancelAnimationFrame(smoothScrollRafId);
      smoothScrollRafId = null;
    }
  };

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  const applyScrollTop = (container: HTMLElement, targetTop: number, smooth: boolean) => {
    clearSmoothScroll();

    if (!smooth) {
      container.scrollTo({ top: targetTop, behavior: 'auto' });
      return;
    }

    const startTop = container.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 1) {
      container.scrollTo({ top: targetTop, behavior: 'auto' });
      return;
    }

    const startTime = performance.now();
    const step = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / AUTO_SCROLL_DURATION_MS);
      container.scrollTop = startTop + distance * easeOutCubic(progress);
      if (progress < 1) {
        smoothScrollRafId = requestAnimationFrame(step);
      } else {
        smoothScrollRafId = null;
      }
    };
    smoothScrollRafId = requestAnimationFrame(step);
  };

  const clearUserScrollTimer = () => {
    if (userScrollResumeTimer !== null) {
      window.clearTimeout(userScrollResumeTimer);
      userScrollResumeTimer = null;
    }
  };

  const clearScrollEndTimer = () => {
    if (scrollEndTimer !== null) {
      window.clearTimeout(scrollEndTimer);
      scrollEndTimer = null;
    }
  };

  const scrollToLineNow = (index: number, smooth: boolean, collapsed = false) => {
    const container = lyricListRef();
    if (!container || index < 0) return;

    const target = container.querySelector<HTMLElement>(
      `[data-lyric-index="${index}"]:not([hidden])`,
    );
    if (!target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    if (collapsed) {
      // 收起模式：将当前行和下一行定位到容器底部
      const nextTarget = container.querySelector<HTMLElement>(
        `[data-lyric-index="${index + 1}"]:not([hidden])`,
      );
      const twoLineHeight = nextTarget
        ? nextTarget.getBoundingClientRect().bottom - targetRect.top
        : targetRect.height;
      const bottomMargin = 24;
      const offset =
        targetRect.top -
        containerRect.top +
        container.scrollTop -
        container.clientHeight +
        twoLineHeight +
        bottomMargin;
      const targetTop = Math.max(0, offset);
      // 列表已无溢出空间（顶部/底部）时，平滑滚动不会产生可见位移 —— 直接瞬时定位。
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const canSmooth = smooth && targetTop > 0 && targetTop < maxScrollTop;
      const handled = requestPluginLyricAutoScroll('page', {
        index,
        targetTop,
        smooth: canSmooth,
        collapsed,
      });
      if (!handled) applyScrollTop(container, targetTop, canSmooth);
      return;
    }

    const anchorRatio = 0.42;
    const offset =
      targetRect.top -
      containerRect.top +
      container.scrollTop -
      container.clientHeight * anchorRatio +
      targetRect.height / 2;
    const targetTop = Math.max(0, offset);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const canSmooth = smooth && targetTop > 0 && targetTop < maxScrollTop;
    const handled = requestPluginLyricAutoScroll('page', {
      index,
      targetTop,
      smooth: canSmooth,
      collapsed,
    });
    if (!handled) applyScrollTop(container, targetTop, canSmooth);
  };

  const scrollToLine = (index: number, smooth: boolean, collapsed = false) => {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
    }
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      scrollToLineNow(index, smooth, collapsed);
    });
  };

  // 根据当前滚动位置找到对应的歌词行
  const findLineAtScrollPosition = (): number => {
    const container = lyricListRef();
    if (!container) return -1;

    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height * 0.42;

    // 找到最接近中心的歌词行
    const lines = Array.from(
      container.querySelectorAll<HTMLElement>('[data-lyric-index]:not([hidden])'),
    );
    let closestIndex = -1;
    let closestDistance = Infinity;

    for (const line of lines) {
      const rect = line.getBoundingClientRect();
      const lineCenter = rect.top + rect.height / 2;
      const distance = Math.abs(lineCenter - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = parseInt(line.dataset.lyricIndex || '-1', 10);
      }
    }

    return closestIndex;
  };

  let scrollRafPending = false;

  const handleWheel = () => {
    if (lyricStore.lines.length === 0) return;
    isUserScrolling.value = true;

    // 清除之前的定时器
    clearUserScrollTimer();

    // 用 rAF 节流：每帧最多计算一次中心行
    if (!scrollRafPending) {
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        const index = findLineAtScrollPosition();
        if (index >= 0) {
          scrollHighlightIndex.value = index;
        }
      });
    }

    // 5 秒后恢复自动跟随
    userScrollResumeTimer = window.setTimeout(() => {
      userScrollResumeTimer = null;
      isUserScrolling.value = false;
      scrollHighlightIndex.value = -1;
      scrollToLine(activeIndex?.value ?? lyricStore.currentIndex, true);
    }, 5000);
  };

  // 监听歌词行变化，自动滚动
  watch(
    () => activeIndex?.value ?? lyricStore.currentIndex,
    async (index, previous) => {
      if (index === previous) return;
      // 如果用户正在滚动，不自动跟随
      if (isUserScrolling.value) return;
      await nextTick();
      // v1.2.6：自动跟随重新使用**平滑滚动**，但由 `applyScrollTop` 自绘
      // （固定 `AUTO_SCROLL_DURATION_MS`、可被下一次滚动取消），
      // 因此既有可见的滑动过程，又不会出现「多个滚动目标互相打断」的闪回。
      //
      // 说明：这里刻意不再传 `previous !== -1`。原先的条件让「切歌重置」走瞬时定位，
      // 但切歌时 `previous` 同样是 `-1`，语义并不精确；而统一平滑后，
      // 切歌那一次是「从上一句滑到新歌开头」，200ms 内完成，观感可接受。
      scrollToLine(index, true, collapsed?.value ?? false);
    },
  );

  // 切歌时重置
  watch(
    () => playerStore.currentTrackSnapshot?.id,
    () => {
      isUserScrolling.value = false;
      scrollHighlightIndex.value = -1;
      clearUserScrollTimer();
      clearScrollEndTimer();
      nextTick(() => scrollToLine(activeIndex?.value ?? lyricStore.currentIndex, false));
    },
  );

  const dispose = () => {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    clearSmoothScroll();
    clearUserScrollTimer();
    clearScrollEndTimer();
  };

  return {
    isUserScrolling,
    scrollHighlightIndex,
    scrollToLine,
    handleWheel,
    dispose,
  };
}
