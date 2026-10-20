// ═══════════════════════════════════════════════════════════════
// Чистая геометрия взаимодействия с канвасом (ПРОБЛЕМЫ 2, 3, 6):
// конвертация экран→карта, hit-test точек маршрута, вставка точки на
// линию, превью-линия рисования полигона. Вынесена из MapCanvas, чтобы
// быть покрытой юнит-тестами без DOM-canvas (Vitest).
// ═══════════════════════════════════════════════════════════════
import type { Point } from '../types';

export interface ScreenView { offsetX: number; offsetY: number; scale: number }

/** Экранные координаты → координаты карты (растра). Инверсия к
 *  screen = map*scale + offset. НЕ mutate'ит вход. */
export function screenToMapPoint(screenX: number, screenY: number, v: ScreenView): Point {
  const scale = Number.isFinite(v.scale) && v.scale !== 0 ? v.scale : 1; // защита от деления на 0
  return { x: (screenX - v.offsetX) / scale, y: (screenY - v.offsetY) / scale };
}

/** Радиус захвата точки маршрута в ЭКРАННЫХ пикселях (~12 px — удобно
 *  попадать мышью независимо от зума; раньше был меньше — «не цепляется»). */
export const ROUTE_GRAB_SCREEN_PX = 12;

/** Ближайшая точка маршрута к карте-координате p. Возвращает индекс и
 *  расстояние в пикселях КАРТЫ; null, если массив пуст. */
export function nearestRoutePoint(
  p: Point,
  pts: ReadonlyArray<{ x: number; y: number }>,
): { index: number; distPx: number } | null {
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(p.x - pts[i].x, p.y - pts[i].y);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI >= 0 ? { index: bestI, distPx: bestD } : null;
}

/** Попадание в точку маршрута с учётом зума: радиус grabScreenPx экранных
 *  пикселей конвертируется в пиксели карты (del / scale). */
export function hitTestRoutePoint(
  screenPoint: Point,
  view: ScreenView,
  routePoints: ReadonlyArray<{ x: number; y: number }>,
  grabScreenPx: number = ROUTE_GRAB_SCREEN_PX,
): number | null {
  if (routePoints.length === 0) return null;
  const mapPoint = screenToMapPoint(screenPoint.x, screenPoint.y, view);
  const nearest = nearestRoutePoint(mapPoint, routePoints);
  if (!nearest) return null;
  const radiusMapPx = grabScreenPx / (Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1);
  return nearest.distPx <= radiusMapPx ? nearest.index : null;
}

/** Проекция точки p на отрезок a-b (параметр t ∈ [0,1] и сама проекция). */
export function projectOnSegment(p: Point, a: Point, b: Point): { t: number; point: Point; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return { t: 0, point: { x: a.x, y: a.y }, dist: Math.hypot(p.x - a.x, p.y - a.y) };
  }
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const proj = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, point: proj, dist: Math.hypot(p.x - proj.x, p.y - proj.y) };
}

/** findClosestPointOnLine: ближайшая позиция НА ломаной polyline для точки p.
 *  Возвращает индекс сегмента i (сегмент между точками i и i+1), проекцию и
 *  расстояние. null при длине ломаной < 2. */
export function findClosestPointOnLine(
  p: Point,
  polyline: ReadonlyArray<Point>,
): { segmentIndex: number; point: Point; dist: number } | null {
  if (polyline.length < 2) return null;
  let best: { segmentIndex: number; point: Point; dist: number } | null = null;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const pr = projectOnSegment(p, polyline[i], polyline[i + 1]);
    if (!best || pr.dist < best.dist) best = { segmentIndex: i, point: pr.point, dist: pr.dist };
  }
  return best;
}

/** insertPointAtIndex: иммутабельная вставка новой точки маршрута ПОСЛЕ
 *  позиции index (для вставки «на линию» index = segmentIndex). Вставка за
 *  пределами диапазона трактуется как append. Возвращает новый массив. */
export function insertPointAtIndex<T extends Point>(pts: ReadonlyArray<T>, index: number, np: T): T[] {
  const out = pts.slice();
  const at = Math.max(0, Math.min(out.length, Math.trunc(index) + 1));
  out.splice(at, 0, np);
  return out;
}

/** Координата курсора мыши для превью-линии рисования. Троттлинговый
 *  cursorPosition в сторе обновляется ~10 Гц — для «резиновой» пунктирной
 *  линии нужен актуальный курсор: ref, который MapCanvas пишет напрямую
 *  в onMouseMove (без ре-рендера). */
export const hoverCursorRef: { current: Point | null } = { current: null };

/** rubberBandPreviewPoint: конец пунктирной «резиновой» линии от последней
 *  поставленной вершины к текущему положению курсора. null — когда рисование
 *  не активно или курсор неизвестен (тогда превью не рисуем). */
export function rubberBandPreviewPoint(drawingPoints: ReadonlyArray<Point>): Point | null {
  const c = hoverCursorRef.current;
  if (!c || drawingPoints.length === 0) return null;
  return { x: c.x, y: c.y };
}
