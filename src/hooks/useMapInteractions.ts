// ═══════════════════════════════════════════════════════════════
// useMapInteractions — вся обработка ввода канваса: wheel-zoom (не-passive),
// touch-панорама/pinch, подписка на запросы зума из глобальных хоткеев.
// Колбэки стабильны: актуальные значения читаются через ref-геттеры,
// поэтому обработчики не переподписываются на каждый mousemove/зум.
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { eventBus } from '../utils/eventBus';

export interface MapInteractionsOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Масштабирование с фокусом в экранных координатах канваса. */
  zoomAt: (factor: number, focusX?: number, focusY?: number) => void;
  /** Панорама дельтой экранных пикселей (offset += delta). */
  panBy: (dx: number, dy: number) => void;
}

/** Максимальный «щелчок» прокрутки за раз — защита от инерционных тачпадов. */
const MAX_WHEEL_DELTA = 120;
/** Базовый шаг зума: один щелчок мыши ≈ ×2. */
const WHEEL_ZOOM_BASE = 60;
/** Минимальное расстояние щипка, ниже которого жест игнорируется (дрожь пальцев). */
const MIN_PINCH_DIST_PX = 8;

type TouchState = { mode: 'pan' | 'pinch'; x: number; y: number; dist: number };

export function useMapInteractions({ canvasRef, zoomAt, panBy }: MapInteractionsOptions): void {
  // ref-геттеры: обработчики навешиваются один раз и всегда видят свежие колбэки
  const zoomAtRef = useRef(zoomAt);
  const panByRef = useRef(panBy);
  useEffect(() => { zoomAtRef.current = zoomAt; }, [zoomAt]);
  useEffect(() => { panByRef.current = panBy; }, [panBy]);

  const touchState = useRef<TouchState | null>(null);

  const handleWheel = useCallback((e: WheelEvent): void => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, e.deltaY || 0));
    const factor = Math.pow(2, -delta / WHEEL_ZOOM_BASE);
    zoomAtRef.current(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, [canvasRef]);

  const handleTouchStart = useCallback((e: TouchEvent): void => {
    if (e.touches.length === 1) {
      touchState.current = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0 };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState.current = {
        mode: 'pinch',
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        dist: Math.hypot(dx, dy),
      };
    }
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent): void => {
    const st = touchState.current;
    if (!st) return;
    e.preventDefault();
    if (st.mode === 'pan' && e.touches.length === 1) {
      panByRef.current(e.touches[0].clientX - st.x, e.touches[0].clientY - st.y);
      touchState.current = { ...st, x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (st.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (dist > MIN_PINCH_DIST_PX && st.dist > MIN_PINCH_DIST_PX) {
        const rect = canvasRef.current?.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect?.left ?? 0);
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect?.top ?? 0);
        zoomAtRef.current(dist / st.dist, cx, cy);
        touchState.current = { ...st, dist };
      }
    }
  }, [canvasRef]);

  const handleTouchEnd = useCallback((): void => { touchState.current = null; }, []);

  // wheel/touch — НЕ через JSX: React навешивает их passive, preventDefault
  // внутри таких слушателей браузер молча игнорирует. Только addEventListener
  // с { passive: false } на самом элементе.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [canvasRef, handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Клавиатурный зум из App.tsx: типобезопасная шина вместо window CustomEvent.
  // Единый zoomAt ⇒ те же границы minZoom..maxNativeZoom, центр не «прыгает».
  useEffect(
    () => eventBus.on('map:zoom-request', ({ factor }) => {
      if (Number.isFinite(factor) && factor > 0) zoomAtRef.current(factor);
    }),
    [],
  );
}
