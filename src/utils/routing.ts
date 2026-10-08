// Маршруты режима действий: быстрая геометрия, проверка зон ограничений,
// автоматический обход запретных областей (маршрут не обязан быть прямым).
import type { MapBounds, Point, Restriction, Route, RoutePoint } from '../types';
import { geoToPixelFromBounds } from './googleMaps';
import { haversineDistanceM, bearingDeg, type GeoPoint } from './actionMode';

import { latToMercatorY, mercatorYToLat } from './googleMaps';

/** Пиксель -> гео (корректная обратная Mercator-проекция) */
export function pixelToGeoExact(p: Point, bounds: MapBounds, mapW: number, mapH: number): GeoPoint {
  const topY = latToMercatorY(bounds.north);
  const bottomY = latToMercatorY(bounds.south);
  const fy = Math.max(0, Math.min(1, p.y / mapH));
  const fx = Math.max(0, Math.min(1, p.x / mapW));
  return {
    lat: mercatorYToLat(topY + (bottomY - topY) * fy),
    lng: bounds.west + (bounds.east - bounds.west) * fx,
  };
}

/** Пиксельные границы зоны ограничения (без запаса) */
export function restrictionPixelBox(r: Restriction): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (r.type === 'circle') {
    if (r.points.length < 1 || !r.radius) return null;
    const c = r.points[0];
    return { minX: c.x - r.radius, minY: c.y - r.radius, maxX: c.x + r.radius, maxY: c.y + r.radius };
  }
  // rectangle хранится как два противоположных угла — нормализуем в полноценный бокс
  if (r.type === 'rectangle' && r.points.length >= 2) {
    return {
      minX: Math.min(r.points[0].x, r.points[1].x),
      maxX: Math.max(r.points[0].x, r.points[1].x),
      minY: Math.min(r.points[0].y, r.points[1].y),
      maxY: Math.max(r.points[0].y, r.points[1].y),
    };
  }
  if (r.points.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of r.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Принадлежность точки зоне (пиксельная геометрия совпадает с геометрией рисования зон) */
export function isPointInZone(p: Point, r: Restriction): boolean {
  if (r.type === 'rectangle') {
    if (r.points.length < 2) return false;
    const minX = Math.min(r.points[0].x, r.points[1].x);
    const maxX = Math.max(r.points[0].x, r.points[1].x);
    const minY = Math.min(r.points[0].y, r.points[1].y);
    const maxY = Math.max(r.points[0].y, r.points[1].y);
    return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
  }
  if (r.type === 'circle') {
    if (r.points.length < 1 || !r.radius) return false;
    const dx = p.x - r.points[0].x, dy = p.y - r.points[0].y;
    return dx * dx + dy * dy <= r.radius * r.radius;
  }
  if (r.points.length < 3) return false;
  // ray casting
  let inside = false;
  const poly = r.points;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Пересечение отрезка a-b с зоной (bbox → отрезок×RECT/circle → отрезок×рёбра полигона + точка внутри) */
export function segmentHitsZone(a: Point, b: Point, r: Restriction): boolean {
  const box = restrictionPixelBox(r);
  if (!box) return false;
  if (b.x < box.minX && a.x < box.minX) return false;
  if (b.x > box.maxX && a.x > box.maxX) return false;
  if (b.y < box.minY && a.y < box.minY) return false;
  if (b.y > box.maxY && a.y > box.maxY) return false;

  if (isPointInZone(a, r) || isPointInZone(b, r)) return true;

  if (r.type === 'rectangle' && r.points.length >= 2) {
    const edges: [Point, Point][] = [
      [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }],
      [{ x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }],
      [{ x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }],
      [{ x: box.minX, y: box.maxY }, { x: box.minX, y: box.minY }],
    ];
    return edges.some(([e1, e2]) => segmentsIntersect(a, b, e1, e2));
  }
  if (r.type === 'polygon') {
    const poly = r.points;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      if (segmentsIntersect(a, b, poly[i], poly[j])) return true;
    }
    return false;
  }
  if (r.type === 'circle' && r.points.length >= 1 && r.radius) {
    return segmentCircleIntersect(a, b, r.points[0], r.radius);
  }
  return false;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (o: Point, a: Point, b: Point) =>
    Math.abs(cross(o, a, b)) < 1e-9 &&
    a.x >= Math.min(o.x, b.x) - 1e-9 && a.x <= Math.max(o.x, b.x) + 1e-9 &&
    a.y >= Math.min(o.y, b.y) - 1e-9 && a.y <= Math.max(o.y, b.y) + 1e-9;
  return onSeg(p3, p1, p2) || onSeg(p4, p1, p2) || onSeg(p1, p3, p4) || onSeg(p2, p3, p4);
}

function segmentCircleIntersect(a: Point, b: Point, c: Point, radius: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const aa = dx * dx + dy * dy;
  if (aa < 1e-12) return fx * fx + fy * fy <= radius * radius;
  const bb = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - radius * radius;
  let disc = bb * bb - 4 * aa * cc;
  if (disc < 0) return false;
  disc = Math.sqrt(disc);
  const t1 = (-bb - disc) / (2 * aa);
  const t2 = (-bb + disc) / (2 * aa);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
}

/** Зоны, которые пересекает ломаная маршрутa */
export function zonesCrossedBy(points: Point[], restrictions: Restriction[]): Restriction[] {
  // Круг задаётся ОДНОЙ точкой + radius: старый фильтр points.length >= 2
  // полностью исключал круговые зоны из проверки пересечений (ложно-чистые
  // маршруты, проходящие через круг).
  const active = restrictions.filter(
    (r) => r.active && (r.type === 'circle' ? r.points.length >= 1 && !!r.radius : r.points.length >= 2)
  );
  if (active.length === 0 || points.length < 2) return [];
  const hitIds = new Set<string>();
  for (let i = 0; i < points.length - 1; i++) {
    for (const r of active) {
      if (hitIds.has(r.id)) continue;
      if (segmentHitsZone(points[i], points[i + 1], r)) hitIds.add(r.id);
    }
  }
  return active.filter((r) => hitIds.has(r.id));
}

/** Суммарная длина ломаной в метрах (WGS-84) */
export function routeLengthM(points: GeoPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += haversineDistanceM(points[i], points[i + 1]);
  return total;
}

export interface RouteStats {
  lengthM: number;
  legs: { distanceM: number; azimuth: number }[];
  crossedZones: Restriction[];
  /** Итоговый азимут старт→финиш */
  finalAzimuth: number;
}

export function analyzeRoute(route: Route, restrictions: Restriction[]): RouteStats {
  const pts = route.points;
  const geos: GeoPoint[] = pts.map((p) => ({ lat: p.lat, lng: p.lng }));
  const legs: { distanceM: number; azimuth: number }[] = [];
  for (let i = 0; i < geos.length - 1; i++) {
    legs.push({ distanceM: haversineDistanceM(geos[i], geos[i + 1]), azimuth: bearingDeg(geos[i], geos[i + 1]) });
  }
  const pxPts: Point[] = pts.map((p) => ({ x: p.x, y: p.y }));
  return {
    lengthM: routeLengthM(geos),
    legs,
    crossedZones: zonesCrossedBy(pxPts, restrictions),
    finalAzimuth: geos.length >= 2 ? bearingDeg(geos[0], geos[geos.length - 1]) : 0,
  };
}

// ─── Обходной поиск (видимость + A* по сетке) ───────────────────────────────

interface Obstacle { type: 'rectangle' | 'circle' | 'polygon'; box: { minX: number; minY: number; maxX: number; maxY: number }; r?: Restriction; margin: number; }

function buildObstacles(restrictions: Restriction[], margin: number): Obstacle[] {
  const out: Obstacle[] = [];
  for (const r of restrictions) {
    if (!r.active) continue;
    const box = restrictionPixelBox(r);
    if (!box) continue;
    out.push({
      type: r.type,
      r,
      margin,
      box: { minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin },
    });
  }
  return out;
}

/** Точка внутри буферной полосы ВДОЛЬ границ зон (сами зоны — проходимы) */
function blockedPoint(p: Point, obstacles: Obstacle[]): boolean {
  for (const o of obstacles) {
    if (p.x < o.box.minX || p.x > o.box.maxX || p.y < o.box.minY || p.y > o.box.maxY) continue;
    if (!o.r) continue;
    // «Ограничения работают только внутри себя»: если точка внутри самой зоны —
    // она НЕ запретная. Маршрут может проходить через зону (с предупреждением).
    if (isPointInZone(p, o.r)) return false;
    // запретна только буферная полоса снаружи границы зоны
    if (o.type === 'rectangle') {
      return true; // bbox с margin без внутренней части = рамка-буфер
    }
    if (o.type === 'circle' && o.r.points.length >= 1) {
      const c = o.r.points[0];
      const rad = (o.r.radius || 0) + o.margin;
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy <= rad * rad) return true;
    }
    if (o.type === 'polygon' && pointNearPolygonEdges(p, o.r.points, o.margin)) return true;
  }
  return false;
}

function isInsideAnyZone(p: Point, obstacles: Obstacle[]): boolean {
  for (const o of obstacles) {
    if (!o.r) continue;
    if (isPointInZone(p, o.r)) return true;
  }
  return false;
}

/** Отрезок запрещён, если хоть где-то попадает в буферную полосу вдоль границ зон */
function segmentBlocked(a: Point, b: Point, obstacles: Obstacle[]): boolean {
  if (obstacles.length === 0) return false;
  const aIn = isInsideAnyZone(a, obstacles);
  const bIn = isInsideAnyZone(b, obstacles);
  if (!aIn && blockedPoint(a, obstacles)) return true;
  if (!bIn && blockedPoint(b, obstacles)) return true;
  // семплирование отрезка: попадание в буфер (вне зон) запрещено
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.min(96, Math.max(4, Math.ceil(len / 16)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (!isInsideAnyZone(p, obstacles) && blockedPoint(p, obstacles)) return true;
  }
  return false;
}

function pointNearPolygonEdges(p: Point, poly: Point[], dist: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    if (pointToSegmentDist(p, poly[i], poly[j]) <= dist) return true;
  }
  return false;
}

function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Граф видимости: узлы = start/goal + углы зон (вынесенные за буфер) */
function visibilityGraph(start: Point, goal: Point, obstacles: Obstacle[]): { nodes: Point[]; adj: Map<number, Set<number>> } {
  const nodes: Point[] = [start, goal];
  for (const o of obstacles) {
    if (o.type === 'polygon' && o.r) {
      const cx = (o.box.minX + o.box.maxX) / 2, cy = (o.box.minY + o.box.maxY) / 2;
      for (const v of o.r.points) {
        const dx = v.x - cx, dy = v.y - cy;
        const l = Math.hypot(dx, dy) || 1;
        nodes.push({ x: v.x + (dx / l) * (o.margin + 4), y: v.y + (dy / l) * (o.margin + 4) });
      }
    } else {
      nodes.push({ x: o.box.minX, y: o.box.minY }, { x: o.box.maxX, y: o.box.minY });
      nodes.push({ x: o.box.maxX, y: o.box.maxY }, { x: o.box.minX, y: o.box.maxY });
    }
  }
  const n = nodes.length;
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) adj.set(i, new Set());
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!segmentBlocked(nodes[i], nodes[j], obstacles)) {
        adj.get(i)!.add(j);
        adj.get(j)!.add(i);
      }
    }
  }
  return { nodes, adj };
}

function astarGrid(
  start: Point, goal: Point, obstacles: Obstacle[], cell: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }, maxCells: number
): Point[] | null {
  const cols = Math.min(256, Math.max(8, Math.ceil((bounds.maxX - bounds.minX) / cell)));
  const rows = Math.min(256, Math.max(8, Math.ceil((bounds.maxY - bounds.minY) / cell)));
  const cw = (bounds.maxX - bounds.minX) / cols;
  const ch = (bounds.maxY - bounds.minY) / rows;
  const idx = (cx: number, cy: number) => cy * cols + cx;
  const total = cols * rows;
  if (total > maxCells) return null;

  const passable = (cx: number, cy: number): boolean => {
    const p = { x: bounds.minX + (cx + 0.5) * cw, y: bounds.minY + (cy + 0.5) * ch };
    return !blockedPoint(p, obstacles);
  };

  const sc = { cx: clamp(Math.floor((start.x - bounds.minX) / cw), 0, cols - 1), cy: clamp(Math.floor((start.y - bounds.minY) / ch), 0, rows - 1) };
  const gc = { cx: clamp(Math.floor((goal.x - bounds.minX) / cw), 0, cols - 1), cy: clamp(Math.floor((goal.y - bounds.minY) / ch), 0, rows - 1) };

  const g = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const open: number[] = [];
  const inOpen = new Uint8Array(total);
  const h = (i: number) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    return Math.hypot((cx - gc.cx) * cw, (cy - gc.cy) * ch);
  };
  const si = idx(sc.cx, sc.cy);
  g[si] = 0;
  open.push(si); inOpen[si] = 1;
  const target = idx(gc.cx, gc.cy);
  let found = false;
  let guard = 0;
  const maxIter = Math.min(total * 4, 60000);

  while (open.length && guard++ < maxIter) {
    // извлечение минимума (простой поиск — при <=65k узлов достаточно быстро)
    let bestK = 0;
    let bestF = g[open[0]] + h(open[0]);
    for (let k = 1; k < open.length; k++) {
      const f = g[open[k]] + h(open[k]);
      if (f < bestF) { bestF = f; bestK = k; }
    }
    const cur = open[bestK];
    open.splice(bestK, 1);
    inOpen[cur] = 0;
    if (cur === target) { found = true; break; }
    const cx = cur % cols, cy = Math.floor(cur / cols);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = idx(nx, ny);
        if (!passable(nx, ny)) continue;
        if (dx && dy) { // срез угла — не допускаем диагональ сквозь угол зон
          if (!passable(cx + dx, cy) || !passable(cx, cy + dy)) continue;
        }
        const step = Math.hypot(dx * cw, dy * ch);
        const ng = g[cur] + step;
        if (ng < g[ni] - 1e-9) {
          g[ni] = ng;
          parent[ni] = cur;
          if (!inOpen[ni]) { open.push(ni); inOpen[ni] = 1; }
        }
      }
    }
  }
  if (!found) return null;
  const path: Point[] = [];
  let cur = target;
  while (cur !== -1) {
    const cx = cur % cols, cy = Math.floor(cur / cols);
    path.push({ x: bounds.minX + (cx + 0.5) * cw, y: bounds.minY + (cy + 0.5) * ch });
    cur = parent[cur];
  }
  path.reverse();
  path[0] = start;
  path[path.length - 1] = goal;
  return path;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Удаление лишних точек (строгость: collinear) */
function simplify(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    if (Math.abs(cross(a, b, c)) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Построить путь старт→цель, обходящий активные зоны ограничений.
 * Стратегия (максимально просто и быстро):
 *  1) если прямая не пересекает зоны — возвращаем прямую (2 точки);
 *  2) граф видимости по углам зон (точный, для малых/выпуклых зон);
 *  3) A* по адаптивной сетке (для вогнутых зон), затем string-pulling.
 */
export function planPathAroundZones(
  start: Point, goal: Point, restrictions: Restriction[],
  mapW: number, mapH: number
): Point[] {
  const margin = Math.max(6, Math.min(mapW, mapH) * 0.01);
  const obstacles = buildObstacles(restrictions, margin);
  if (obstacles.length === 0) return [start, goal];

  // 1) прямая
  if (!segmentBlocked(start, goal, obstacles)) return [start, goal];

  // 2) граф видимости
  const vg = visibilityGraph(start, goal, obstacles);
  const pathVg = dijkstraOnGraph(vg.nodes, vg.adj, 0, 1);
  if (pathVg) {
    const pulled = stringPull(pathVg, obstacles);
    return simplify(pulled);
  }

  // 3) A* по сетке
  const minX = Math.min(start.x, goal.x) - mapW * 0.15;
  const maxX = Math.max(start.x, goal.x) + mapW * 0.15;
  const minY = Math.min(start.y, goal.y) - mapH * 0.15;
  const maxY = Math.max(start.y, goal.y) + mapH * 0.15;
  const span = Math.max(maxX - minX, maxY - minY);
  for (const cells of [64, 128, 200]) {
    const grid = astarGrid(start, goal, obstacles, span / cells, { minX, minY, maxX, maxY }, cells * cells);
    if (grid) {
      const pulled = stringPull(grid, obstacles);
      return simplify(pulled);
    }
  }
  // ничего не найдено — оставляем прямой путь (будет предупреждение о пересечении)
  return [start, goal];
}

function dijkstraOnGraph(nodes: Point[], adj: Map<number, Set<number>>, s: number, t: number): Point[] | null {
  const n = nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[s] = 0;
  for (;;) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u === -1) break;
    if (u === t) break;
    done[u] = 1;
    for (const v of adj.get(u)!) {
      const w = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
  }
  if (dist[t] === Infinity) return null;
  const path: Point[] = [];
  let cur = t;
  while (cur !== -1) { path.push(nodes[cur]); cur = prev[cur]; }
  return path.reverse();
}

/** String pulling: жадно убираем промежуточные точки, если прямая между соседними проходимыми свободна */
function stringPull(path: Point[], obstacles: Obstacle[]): Point[] {
  if (path.length <= 2) return path;
  const out: Point[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    for (; j > i + 1; j--) {
      if (!segmentBlocked(path[i], path[j], obstacles)) break;
    }
    out.push(path[j]);
    i = j;
  }
  return out;
}

/** Пересчитать пиксели всех точек маршрута из гео-координат (строгая привязка) */
export function recomputeRoutePixels(route: Route, bounds: MapBounds, mapW: number, mapH: number): Route {
  return {
    ...route,
    points: route.points.map((p) => {
      const px = geoToPixelFromBounds({ lat: p.lat, lng: p.lng }, bounds, mapW, mapH);
      return { ...p, x: px.x, y: px.y };
    }),
  };
}

export function routePointsToGeo(points: RoutePoint[]): GeoPoint[] {
  return points.map((p) => ({ lat: p.lat, lng: p.lng }));
}

/**
 * Сглаживание ломаной (Catmull-Rom → «кривая»): ключевые точки остаются на месте,
 * между ними добавляются промежуточные точки для плавного изгиба.
 */
export function smoothPolyline(pts: Point[], steps = 8): Point[] {
  if (pts.length < 3 || steps <= 0) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      const t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
    out.push(p2);
  }
  return out;
}
