// ═══════════════════════════════════════════════════════════════
// useCanvasRenderer — каркас цикла отрисовки канваса на requestAnimationFrame.
// Инкапсулирует: ресайз с devicePixelRatio, один rAF-цикл (idle ⇒ не крутится),
// батчинг нескольких «грязных» подписок в один кадр. Саму логику рисования
// компонент передаёт колбэком draw(ctx) — хук про неё ничего не знает (SRP).
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export interface CanvasRendererOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  /** Вызывается в кадре, когда есть грязные подписки. ctx уже очищать не нужно —
   *  renderer отвечает за transform/DPR до вызова. */
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  /** Изменение размеров контейнера (для записи canvasSize в стор/стейт). */
  onResize?: (width: number, height: number) => void;
}

/** Хук-результат: ручной инвалид + актуальные размеры буфера. */
export interface CanvasRendererApi {
  invalidate: () => void;
  getSize: () => { width: number; height: number };
}

const DPR_MAX = 2; // выше 2× визуального выигрыша нет, память растёт квадратично

export function useCanvasRenderer({ canvasRef, containerRef, draw, onResize }: CanvasRendererOptions): CanvasRendererApi {
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; }, [draw]);
  const onResizeRef = useRef(onResize);
  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

  const rafId = useRef<number | null>(null);
  const dirty = useRef(false);
  const sizeRef = useRef({ width: 0, height: 0 });

  const renderFrame = useCallback((): void => {
    rafId.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = sizeRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawRef.current(ctx, width, height);
  }, [canvasRef]);

  const invalidate = useCallback((): void => {
    dirty.current = true;
    if (rafId.current == null) rafId.current = requestAnimationFrame(renderFrame);
  }, [renderFrame]);

  // Ресайз буфера под контейнер × DPR; при старте и на каждое изменение размера.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const applySize = (): void => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      sizeRef.current = { width: w, height: h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      onResizeRef.current?.(w, h);
      invalidate();
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [canvasRef, containerRef, invalidate]);

  // Единственный rAF-цикл на компонент; отменяется на unmount (нет утечек кадров).
  useEffect(() => () => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
  }, []);

  const getSize = useCallback(() => ({ ...sizeRef.current }), []);

  return { invalidate, getSize };
}
