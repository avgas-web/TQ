// ═══════════════════════════════════════════════════════════════
// routing.worker — тяжёлая геометрия (A*/граф видимости/RRT) ВНЕ Main Thread.
// Vite-формат: new Worker(new URL('./routing.worker.ts', import.meta.url), { type: 'module' }).
// Обмен только сериализуемыми DTO (structured clone), никаких DOM/Zustand.
// ═══════════════════════════════════════════════════════════════
import type { Point, Restriction } from '../types';
import { planPathAroundZones } from '../utils/routing';

/** Вход задачи прокладки одного сегмента вокруг зон. */
export interface PlanSegmentRequest {
  taskId: number;
  kind: 'plan-segment';
  start: Point;
  goal: Point;
  restrictions: Restriction[];
  mapWidth: number;
  mapHeight: number;
}

/** Ответ воркера: готовая цепочка точек сегмента (в пикселях растра). */
export interface PlanSegmentResponse {
  taskId: number;
  ok: boolean;
  path?: Point[];
  error?: string;
}

export type RoutingRequest = PlanSegmentRequest;
export type RoutingResponse = PlanSegmentResponse;

self.addEventListener('message', (event: MessageEvent<RoutingRequest>) => {
  const req = event.data;
  if (!req || typeof req.taskId !== 'number') return;
  try {
    if (req.kind === 'plan-segment') {
      const path = planPathAroundZones(req.start, req.goal, req.restrictions, req.mapWidth, req.mapHeight);
      const res: PlanSegmentResponse = { taskId: req.taskId, ok: true, path };
      (self as unknown as Worker).postMessage(res);
    }
  } catch (err) {
    const res: PlanSegmentResponse = {
      taskId: req.taskId,
      ok: false,
      error: err instanceof Error ? err.message : 'unknown worker error',
    };
    (self as unknown as Worker).postMessage(res);
  }
});
