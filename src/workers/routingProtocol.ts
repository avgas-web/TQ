// Общий протокол главного потока и routing-воркера. Держится отдельно от
// .worker.ts, чтобы импортировать типы без side-effect загрузки воркера.
import type { Point, Restriction } from '../types';

export interface RoutingRequest {
  /** Идентификатор задачи для сопоставления ответа */
  id: number;
  start: Point;
  goal: Point;
  restrictions: Restriction[];
  mapW: number;
  mapH: number;
}

export interface RoutingResponse {
  id: number;
  ok: boolean;
  path?: Point[];
  error?: string;
}
