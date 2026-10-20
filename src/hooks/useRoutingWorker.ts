// Хук-клиент routing-воркера: offload расчёта облёта NFZ из главного потока.
// Падение/ошибка воркера -> reject c понятным сообщением (никогда не «вечный»
// промис), все ожидающие задачи отменяются одним reject'ом.
import { useEffect, useRef, useCallback } from 'react';
import type { Point, Restriction } from '../types';
import type { RoutingRequest, RoutingResponse } from '../workers/routingProtocol';

interface Pending {
  resolve: (p: Point[]) => void;
  reject: (e: Error) => void;
}

export function useRoutingWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, Pending>>(new Map());
  const seqRef = useRef(0);

  useEffect(() => {
    // Vite инкапсулирует ?worker-импорт (класс Worker доступен и в тестах через mock)
    const w = new Worker(new URL('../workers/routing.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<RoutingResponse>) => {
      const res = ev.data;
      const p = pendingRef.current.get(res.id);
      if (!p) return;
      pendingRef.current.delete(res.id);
      if (res.ok && Array.isArray(res.path)) p.resolve(res.path);
      else p.reject(new Error(res.error ?? 'Воркер маршрутизации вернул ошибку без деталей'));
    };
    w.onerror = (ev) => {
      // Крах воркера (syntax/import error внутри) — отклоняем ВСЕ ожидания,
      // главный поток разблокирован.
      const msg = `Воркер маршрутизации аварийно завершился: ${ev.message || 'unknown error'}`;
      pendingRef.current.forEach((p) => p.reject(new Error(msg)));
      pendingRef.current.clear();
    };
    workerRef.current = w;
    return () => {
      pendingRef.current.forEach((p) => p.reject(new Error('Воркер остановлен (unmount)')));
      pendingRef.current.clear();
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const route = useCallback(
    (start: Point, goal: Point, restrictions: Restriction[], mapW: number, mapH: number): Promise<Point[]> => {
      const w = workerRef.current;
      if (!w) return Promise.reject(new Error('Routing worker ещё не инициализирован'));
      const id = ++seqRef.current;
      return new Promise<Point[]>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        const req: RoutingRequest = { id, start, goal, restrictions, mapW, mapH };
        w.postMessage(req);
      });
    },
    [],
  );

  return { route };
}
