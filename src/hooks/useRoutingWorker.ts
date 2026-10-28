// ═══════════════════════════════════════════════════════════════
// useRoutingWorker — мост UI ↔ routing.worker. Состояния loading/error/success,
// отмена устаревших задач (task id), graceful fallback на синхронный расчёт в
// main thread, если Worker недоступен (SSR/тесты/жёсткие CSP).
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Point } from '../types';
import { planPathAroundZones } from '../utils/routing';
import type { RoutingRequest, RoutingResponse } from '../workers/routing.worker';

export type RoutingStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseRoutingWorkerResult {
  status: RoutingStatus;
  path: Point[] | null;
  error: string | null;
  /** Проложить сегмент start→goal вокруг зон в воркере. Отменяет предыдущую задачу. */
  planSegment: (req: Omit<RoutingRequest, 'taskId'>) => void;
  /** Отменить активную задачу и сбросить статус. */
  cancel: () => void;
}

/** Синхронный фолбэк (воркер не создан) — только для маленьких карт/тестов. */
function planSync(req: Omit<RoutingRequest, 'taskId'>): Point[] {
  return planPathAroundZones(req.start, req.goal, req.restrictions, req.mapWidth, req.mapHeight);
}

export function useRoutingWorker(): UseRoutingWorkerResult {
  const [status, setStatus] = useState<RoutingStatus>('idle');
  const [path, setPath] = useState<Point[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const taskIdRef = useRef(0);

  // Один воркер на хук; создаётся лениво при первом плане. Уничтожается на unmount.
  useEffect(() => {
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('../workers/routing.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      w = null; // окружение без Workers — пойдём синхронным фолбэком
    }
    workerRef.current = w;
    return () => {
      w?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Приём ответов: принимаем ТОЛЬКО задачу с актуальным id (защита от гонок).
  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    const onMessage = (e: MessageEvent<RoutingResponse>): void => {
      const res = e.data;
      if (!res || res.taskId !== taskIdRef.current) return;
      if (res.ok && res.path) {
        setPath(res.path);
        setError(null);
        setStatus('success');
      } else {
        setPath(null);
        setError(res.error ?? 'worker returned no path');
        setStatus('error');
      }
    };
    const onError = (): void => {
      setError('routing worker crashed');
      setStatus('error');
    };
    w.addEventListener('message', onMessage as EventListener);
    w.addEventListener('error', onError);
    return () => {
      w.removeEventListener('message', onMessage as EventListener);
      w.removeEventListener('error', onError);
    };
  }, []);

  const planSegment = useCallback((req: Omit<RoutingRequest, 'taskId'>): void => {
    const w = workerRef.current;
    if (!w) {
      try {
        setPath(planSync(req));
        setError(null);
        setStatus('success');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
      return;
    }
    taskIdRef.current += 1;
    setStatus('loading');
    setError(null);
    w.postMessage({ ...req, taskId: taskIdRef.current } satisfies RoutingRequest);
  }, []);

  const cancel = useCallback((): void => {
    taskIdRef.current += 1; // все in-flight ответы станут «устаревшими»
    setStatus('idle');
    setPath(null);
    setError(null);
  }, []);

  return { status, path, error, planSegment, cancel };
}
