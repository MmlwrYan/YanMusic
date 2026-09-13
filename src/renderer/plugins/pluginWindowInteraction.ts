import { useWindowResize, type WindowResizeBounds } from '@/composables/useWindowResize';
import { createRendererSessionId, createRendererSessionNonce } from '@/utils/sessionId';

/**
 * 插件浮窗拖拽 / 缩放通道（8 方向）的访客侧封装。
 *
 * 主进程侧已经提供 `plugins:windows:start-drag|drag-move|end-drag|cancel-drag` 与
 * `...start-resize|resize|end-resize|cancel-resize` 通道，这里负责把 PointerEvent
 * 生命周期、会话 ID 生成与 releasePointerCapture 语义收拢到一个可绑定到元素上的
 * 句柄，插件只需 `bind(element)` 即可使用。
 */

/** 浮窗缩放手柄支持的方向，与主进程 8 通道一一对应。 */
export type PluginWindowResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** 浮窗缩放手柄绑定选项：方向与尺寸约束。 */
export interface PluginWindowResizeOptions {
  direction?: PluginWindowResizeDirection;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export type WindowDragElementAdapter = {
  start: (sessionId: string) => Promise<boolean>;
  move: (sessionId: string, event: PointerEvent) => void;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export type WindowDragOptions = {
  adapter: WindowDragElementAdapter;
  sessionPrefix: string;
  sessionNonce?: Promise<string | null>;
  disabled?: () => boolean;
  isTargetDraggable?: (target: EventTarget | null) => boolean;
  onStart?: (event: PointerEvent, sessionId: string) => void;
  onMove?: (event: PointerEvent) => void;
  onFinish?: (sessionId: string, commit: boolean) => void;
  onSettled?: (sessionId: string, commit: boolean, result: unknown) => void;
};

type WindowResizeElementAdapter = {
  getBounds: () => Promise<WindowResizeBounds | null>;
  start: (sessionId: string) => Promise<boolean>;
  resize: (sessionId: string, bounds: WindowResizeBounds) => void;
  end: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
};

export type WindowResizeBindOptions = PluginWindowResizeOptions;

type PendingDrag = {
  id: string | null;
  pointerId: number;
  epoch: number;
  pressed: boolean;
  captureTarget: HTMLElement;
};

type ActiveDrag = Omit<PendingDrag, 'id'> & {
  id: string;
};

/**
 * 统一处理浮窗拖动的渲染进程生命周期。实际屏幕坐标与窗口边界仍由主进程决定，
 * 渲染进程只转发 PointerEvent 的屏幕坐标。
 */
export const createWindowDragLifecycle = (
  options: WindowDragOptions,
  setDragging: (value: boolean) => void = () => undefined,
) => {
  let epoch = 0;
  let settlementEpoch = 0;
  let pending: PendingDrag | null = null;
  let active: ActiveDrag | null = null;
  let fallbackListeners = false;
  const localSessionNonce = createRendererSessionNonce();
  const sessionNonce =
    options.sessionNonce?.then((nonce) => nonce || localSessionNonce) ??
    Promise.resolve(localSessionNonce);

  const callAsyncSafely = <T>(call: () => Promise<T>) => {
    try {
      return Promise.resolve().then(call);
    } catch {
      return Promise.reject();
    }
  };

  const cancelSafely = (sessionId: string) => {
    void callAsyncSafely(() => options.adapter.cancel(sessionId)).catch(() => undefined);
  };

  const releasePointerCapture = (session: Pick<PendingDrag, 'captureTarget' | 'pointerId'>) => {
    try {
      if (session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
    } catch {
      // 指针可能已被系统释放。
    }
  };

  const removeFallbackListeners = () => {
    if (!fallbackListeners) return;
    fallbackListeners = false;
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
  };

  const cancelPending = () => {
    const session = pending;
    if (!session) return;
    session.pressed = false;
    pending = null;
    epoch += 1;
    if (session.id) cancelSafely(session.id);
    releasePointerCapture(session);
    removeFallbackListeners();
  };

  const addFallbackListeners = () => {
    if (fallbackListeners) return;
    fallbackListeners = true;
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
  };

  const finish = (event: PointerEvent | undefined, commit: boolean, notifyMain = true) => {
    const session = active;
    if (!session || (event && event.pointerId !== session.pointerId)) return;
    active = null;
    setDragging(false);
    const settlementId = ++settlementEpoch;
    options.onFinish?.(session.id, commit);
    releasePointerCapture(session);
    removeFallbackListeners();
    const settle = notifyMain
      ? commit
        ? callAsyncSafely(() => options.adapter.end(session.id))
        : callAsyncSafely(() => options.adapter.cancel(session.id))
      : Promise.resolve(undefined);
    void settle
      .then((result) => {
        if (settlementId === settlementEpoch) options.onSettled?.(session.id, commit, result);
      })
      .catch(() => undefined);
  };

  const onPointerDown = async (event: PointerEvent) => {
    if (
      options.disabled?.() ||
      event.button !== 0 ||
      pending ||
      active ||
      (options.isTargetDraggable && !options.isTargetDraggable(event.target))
    )
      return;

    const captureTarget = event.currentTarget;
    if (!(captureTarget instanceof HTMLElement)) return;
    const session: PendingDrag = {
      id: null,
      pointerId: event.pointerId,
      epoch: ++epoch,
      pressed: true,
      captureTarget,
    };
    pending = session;
    addFallbackListeners();
    try {
      captureTarget.setPointerCapture(session.pointerId);
    } catch {
      cancelPending();
      return;
    }
    event.preventDefault();
    let nonce: string;
    try {
      nonce = await sessionNonce;
    } catch {
      if (pending === session) cancelPending();
      return;
    }
    if (pending !== session || session.epoch !== epoch || !session.pressed) return;
    if (options.disabled?.()) {
      cancelPending();
      return;
    }
    session.id = createRendererSessionId(options.sessionPrefix, nonce, session.epoch);
    let started = false;
    try {
      started = await callAsyncSafely(() => options.adapter.start(session.id!));
    } catch {
      started = false;
    }

    if (
      pending !== session ||
      session.epoch !== epoch ||
      !session.pressed ||
      options.disabled?.()
    ) {
      if (pending === session) cancelPending();
      else if (session.id) cancelSafely(session.id);
      return;
    }
    pending = null;
    if (!started) {
      cancelSafely(session.id);
      releasePointerCapture(session);
      removeFallbackListeners();
      return;
    }

    active = { ...session, id: session.id };
    setDragging(true);
    options.onStart?.(event, session.id);
    // 指针捕获在异步 start 之前就已请求，快速释放也不会丢事件。
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    options.onMove?.(event);
    try {
      void Promise.resolve(options.adapter.move(active.id, event)).catch(() => undefined);
    } catch {
      // 同步 IPC 失败不能逃出指针事件处理器。
    }
    event.preventDefault();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (active) finish(event, true);
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (active) finish(event, false);
    else if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onPointerLeave = (event: PointerEvent) => {
    if (pending?.pointerId === event.pointerId) cancelPending();
  };

  const onWindowBlur = () => {
    cancelPending();
    finish(undefined, false);
  };

  const cancel = (notifyMain = true) => {
    cancelPending();
    finish(undefined, false, notifyMain);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    cancel,
    dispose: () => {
      cancelPending();
      finish(undefined, false);
      removeFallbackListeners();
    },
  };
};

/** 把浮窗拖动生命周期绑定到元素，返回解绑函数。 */
export const createWindowDragHandlers =
  (
    adapter: WindowDragElementAdapter,
    sessionPrefix: string,
    onCancelInteraction?: (cancel: () => void) => () => void,
  ) =>
  (element: HTMLElement) => {
    const lifecycle = createWindowDragLifecycle({
      adapter,
      sessionPrefix,
    });
    const onDown = (event: PointerEvent) => void lifecycle.onPointerDown(event);
    const onMove = lifecycle.onPointerMove;
    const onUp = lifecycle.onPointerUp;
    const onCancel = lifecycle.onPointerCancel;
    const onLeave = lifecycle.onPointerLeave;
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove, { passive: false });
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    element.addEventListener('pointerleave', onLeave);
    const cancelDisposer = onCancelInteraction?.(() => lifecycle.cancel(false));
    return () => {
      cancelDisposer?.();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      element.removeEventListener('pointerleave', onLeave);
      lifecycle.dispose();
    };
  };

/** 把浮窗缩放手柄绑定到元素，返回解绑函数。 */
export const createWindowResizeHandlers =
  (
    adapter: WindowResizeElementAdapter,
    sessionPrefix: string,
    options: WindowResizeBindOptions = {},
    onCancelInteraction?: (cancel: () => void) => () => void,
  ) =>
  (element: HTMLElement) => {
    const resize = useWindowResize({
      adapter,
      sessionPrefix,
      minBounds: { width: options.minWidth, height: options.minHeight },
      maxBounds: { width: options.maxWidth, height: options.maxHeight },
      getStartBounds: async (event) =>
        (await adapter.getBounds()) ?? {
          x: Math.round(event.screenX - event.clientX),
          y: Math.round(event.screenY - event.clientY),
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
        },
    });
    const onPointerDown = (event: PointerEvent) => {
      void resize.onPointerDown(event, options.direction ?? 'se');
    };
    element.addEventListener('pointerdown', onPointerDown);
    const cancelDisposer = onCancelInteraction?.(() => resize.cancel(false));
    return () => {
      cancelDisposer?.();
      element.removeEventListener('pointerdown', onPointerDown);
      resize.cancel();
    };
  };
