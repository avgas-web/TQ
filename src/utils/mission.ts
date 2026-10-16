// Модуль планирования и оптимизации миссий (Блок 1).
// Чистые функции: валидация, метаданные маршрута, параметры путевых точек,
// алгоритмы оптимизации порядка точек, генерация «змейки» для сплошного
// сканирования полигона. Никаких новых npm-зависимостей.

import type { Point } from '../types';

/** Максимальная разрешённая высота полёта (м) — общий лимит проекта. */
export const MAX_ALTITUDE_M = 500;
/** Физически реализуемая максимальная скорость дрона (м/с). */
export const MAX_SPEED_MS = 30;
/** Диапазон допустимого радиуса принятия (м). */
export const ACCEPTANCE_RADIUS_RANGE: readonly [number, number] = [0.5, 100];

export type WaypointParamKey = 'hold' | 'cameraAngle' | 'speed' | 'acceptanceRadius';

/** Параметры путевой точки (задержка, угол камеры, скорость, радиус принятия). */
export interface WaypointParams {
  /** Задержка в точке, сек [0..3600]. */
  holdSec: number;
  /** Угол камеры, градусы [-90..90] (низ = -90). */
  cameraAngleDeg: number;
  /** Скорость подхода к точке, м/с (0 = унаследованная скорость маршрута). */
  speedMs: number;
  /** Радиус принятия, м [0.5..100]. */
  acceptanceRadiusM: number;
}

export const DEFAULT_WAYPOINT_PARAMS: WaypointParams = {
  holdSec: 0,
  cameraAngleDeg: -90,
  speedMs: 0,
  acceptanceRadiusM: 5,
};

/** Метаданные миссии. */
export interface MissionMeta {
  id: string;
  name: string;
  author: string;
  createdAt: string; // ISO 8601
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Валидирует географические координаты и высоту.
 *
 * Args:
 *   lat (number): Широта, [-90; 90].
 *   lon (number): Долгота, [-180; 180].
 *   alt (number | null): Высота, [0; MAX_ALTITUDE_M]; null — без проверки.
 *
 * Returns:
 *   void
 *
 * Raises:
 *   ValidationError: значение вне диапазона или NaN.
 *
 * Example:
 *   validateLatLng(55.75, 37.62, 120)
 */
export function validateLatLng(lat: number, lon: number, alt?: number | null): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ValidationError(`Некорректная широта: ${lat} (ожидается [-90; 90])`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new ValidationError(`Некорректная долгота: ${lon} (ожидается [-180; 180])`);
  }
  if (alt !== undefined && alt !== null) {
    if (!Number.isFinite(alt) || alt < 0 || alt > MAX_ALTITUDE_M) {
      throw new ValidationError(`Некорректная высота: ${alt} (ожидается [0; ${MAX_ALTITUDE_M}])`);
    }
  }
}

/**
 * Нормализует угол в диапазон [0; 360).
 *
 * Args:
 *   angle (number): Исходный угол, градусы (любое конечное число).
 *
 * Returns:
 *   number: угол в [0; 360).
 *
 * Example:
 *   normalizeAngle360(-90) === 270
 */
export function normalizeAngle360(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return ((angle % 360) + 360) % 360;
}

/**
 * Санитизирует параметры путевой точки, подставляя безопасные значения
 * вместо некорректных (без бросания исключений — пригодно для импорта).
 *
 * Args:
 *   raw (Partial<WaypointParams> | undefined): «сырые» параметры.
 *
 * Returns:
 *   WaypointParams: корректные параметры.
 */
export function sanitizeWaypointParams(raw?: Partial<WaypointParams> | null): WaypointParams {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    holdSec: clamp(raw?.holdSec, 0, 3600, DEFAULT_WAYPOINT_PARAMS.holdSec),
    cameraAngleDeg: clamp(raw?.cameraAngleDeg, -90, 90, DEFAULT_WAYPOINT_PARAMS.cameraAngleDeg),
    speedMs: clamp(raw?.speedMs, 0, MAX_SPEED_MS, DEFAULT_WAYPOINT_PARAMS.speedMs),
    acceptanceRadiusM: clamp(
      raw?.acceptanceRadiusM,
      ACCEPTANCE_RADIUS_RANGE[0],
      ACCEPTANCE_RADIUS_RANGE[1],
      DEFAULT_WAYPOINT_PARAMS.acceptanceRadiusM,
    ),
  };
}

/**
 * Инициализирует метаданные новой миссии (create_mission).
 *
 * Args:
 *   id (string): уникальный ID маршрута.
 *   name (string): название (обрезается до 120 символов).
 *   author (string): автор.
 *
 * Returns:
 *   MissionMeta: метаданные с текущей датой создания.
 *
 * Raises:
 *   ValidationError: пустое название.
 */
export function createMissionMeta(id: string, name: string, author: string): MissionMeta {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('Название миссии не может быть пустым');
  return {
    id,
    name: trimmed.slice(0, 120),
    author: author.trim().slice(0, 60) || '—',
    createdAt: new Date().toISOString(),
  };
}

/** Расстояние между двумя точками (евклидово, в единицах входных координат). */
function dist(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = a.lat - b.lat;
  const dy = a.lon - b.lon;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Полный путь по последовательности точек. */
function pathLength(pts: { lat: number; lon: number }[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export type OptimizeAlgorithm = 'nearest_neighbor' | 'genetic' | 'simulated_annealing';

export interface OptimizeResult<T> {
  waypoints: T[];
  distanceBefore: number;
  distanceAfter: number;
  improvementPct: number;
  algorithm: OptimizeAlgorithm;
}

/** Детерминированный ГПСЧ (mulberry32) — воспроизводимость оптимизаций. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Оптимизация порядка путевых точек (открытая цепь: первая точка фиксирована).
 *
 * Args:
 *   waypoints (T[]): точки с полями lat/lon (минимум).
 *   algorithm ('nearest_neighbor' | 'genetic' | 'simulated_annealing'): метод.
 *   seed (number): зерно ГПСЧ для детерминизма stochastic-алгоритмов.
 *
 * Returns:
 *   OptimizeResult<T>: новый список и метрики сокращения расстояния.
 *   Пустой/одноэлементный список возвращается как есть (improvementPct = 0).
 *
 * Raises:
 *   ValidationError: неизвестный алгоритм.
 */
export function optimizeRoute<T extends { lat: number; lon: number }>(
  waypoints: T[],
  algorithm: OptimizeAlgorithm = 'nearest_neighbor',
  seed = 42,
): OptimizeResult<T> {
  if (waypoints.length <= 1) {
    const d = pathLength(waypoints);
    return { waypoints: [...waypoints], distanceBefore: d, distanceAfter: d, improvementPct: 0, algorithm };
  }
  const before = pathLength(waypoints);
  let order: T[];
  switch (algorithm) {
    case 'nearest_neighbor':
      order = nearestNeighbor(waypoints);
      break;
    case 'genetic':
      order = genetic(waypoints, mulberry32(seed));
      break;
    case 'simulated_annealing':
      order = simulatedAnnealing(waypoints, mulberry32(seed));
      break;
    default:
      throw new ValidationError(`Неизвестный алгоритм оптимизации: ${String(algorithm)}`);
  }
  const after = pathLength(order);
  const improvementPct = before > 0 ? ((before - after) / before) * 100 : 0;
  return {
    waypoints: order,
    distanceBefore: before,
    distanceAfter: after,
    improvementPct: Math.max(0, Math.round(improvementPct * 10) / 10),
    algorithm,
  };
}

function nearestNeighbor<T extends { lat: number; lon: number }>(pts: T[]): T[] {
  const rest = pts.slice(1);
  const route: T[] = [pts[0]];
  let current = pts[0];
  while (rest.length) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const d = dist(current, rest[i]);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    current = rest.splice(bestIdx, 1)[0];
    route.push(current);
  }
  return route;
}

function genetic<T extends { lat: number; lon: number }>(pts: T[], rnd: () => number): T[] {
  const head = pts[0];
  const body = pts.slice(1);
  const n = body.length;
  const popSize = Math.min(50, Math.max(10, n * 4));
  const generations = Math.min(120, Math.max(30, n * 6));
  const shuffle = (arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1 > 0 ? a.length - 1 : 0; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const fit = (perm: T[]): number => pathLength([head, ...perm]);
  let pop: T[][] = Array.from({ length: popSize }, () => shuffle(body));
  for (let g = 0; g < generations; g++) {
    pop.sort((a, b) => fit(a) - fit(b));
    const elite = pop.slice(0, Math.max(2, popSize >> 2));
    const next: T[][] = [...elite];
    while (next.length < popSize) {
      const p1 = elite[Math.floor(rnd() * elite.length)] ?? pop[0];
      const p2 = pop[Math.floor(rnd() * pop.length)];
      // Order crossover (OX1)
      const l = Math.floor(rnd() * p1.length);
      const r = Math.max(l, Math.floor(rnd() * p1.length));
      const mid = p1.slice(l, r + 1);
      const tail = p2.filter((x) => !mid.includes(x));
      next.push([...tail.slice(0, l), ...mid, ...tail.slice(l)]);
    }
    pop = next;
  }
  pop.sort((a, b) => fit(a) - fit(b));
  return [head, ...pop[0]];
}

function simulatedAnnealing<T extends { lat: number; lon: number }>(pts: T[], rnd: () => number): T[] {
  const route = [...pts];
  let currentLen = pathLength(route);
  let best = [...route];
  let bestLen = currentLen;
  let temp = currentLen > 0 ? currentLen / 10 : 1;
  const iterations = Math.min(5000, Math.max(500, route.length * 100));
  for (let it = 0; it < iterations; it++) {
    const i = 1 + Math.floor(rnd() * Math.max(1, route.length - 1));
    const j = 1 + Math.floor(rnd() * Math.max(1, route.length - 1));
    if (i === j || i >= route.length || j >= route.length) continue;
    // 2-opt reverse segment [min..max]
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const cand = [...route.slice(0, lo), ...route.slice(lo, hi + 1).reverse(), ...route.slice(hi + 1)];
    const candLen = pathLength(cand);
    if (candLen < currentLen || rnd() < Math.exp((currentLen - candLen) / Math.max(temp, 1e-9))) {
      route.splice(0, route.length, ...cand);
      currentLen = candLen;
      if (candLen < bestLen) {
        bestLen = candLen;
        best = [...cand];
      }
    }
    temp *= 0.995;
  }
  return best;
}

/**
 * Генерация маршрута «змейка» для сплошного сканирования полигона (scan_area).
 *
 * Аргументы принимаются в пиксельных координатах карты (как и вся геометрия
 * прототипа); пересчёт в geo выполняется на стороне вызывающего кода.
 *
 * Args:
 *   polygon (Point[]): замкнутый многоугольник области (>=3 вершин, без
 *     самопересечений).
 *   spacingPx (number): шаг линий сканирования в пикселях (>0).
 *   startCorner ('nw' | 'sw' | 'ne' | 'se'): угол начала облёта.
 *
 * Returns:
 *   Point[]: упорядоченные точки змейки внутри полигона.
 *
 * Raises:
 *   ValidationError: деградированный полигон, неверный шаг, самопересечения.
 */
export function generateScanLawnmower(polygon: Point[], spacingPx: number, startCorner: 'nw' | 'sw' | 'ne' | 'se' = 'nw'): Point[] {
  if (polygon.length < 3) throw new ValidationError('Полигон должен иметь минимум 3 вершины');
  if (!Number.isFinite(spacingPx) || spacingPx <= 0) {
    throw new ValidationError(`Некорректный шаг сканирования: ${spacingPx}`);
  }
  if (segmentsIntersect(polygon)) throw new ValidationError('Полигон имеет самопересечения');
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const flipY = startCorner === 'sw' || startCorner === 'se';
  const flipX = startCorner === 'ne' || startCorner === 'se';
  const pts: Point[] = [];
  const rows = Math.ceil((maxY - minY) / spacingPx) + 1;
  for (let r = 0; r < rows; r++) {
    const y = minY + r * spacingPx;
    const row = scanRowAtY(polygon, y);
    for (const [xa, xb] of row) {
      if (xb - xa < 1e-9) continue;
      const leftFirst = pts.length % 2 === 0;
      const a = { x: leftFirst ? xa : xb, y };
      const b = { x: leftFirst ? xb : xa, y };
      pts.push(a, b);
    }
  }
  return pts.map((p) => ({
    x: flipX ? maxX + minX - p.x : p.x,
    y: flipY ? maxY + minY - p.y : p.y,
  }));
}

/** Пересечения горизонтальной линии y со сторонами полигона → интервалы [x1,x2]. */
function scanRowAtY(polygon: Point[], y: number): Array<[number, number]> {
  const xsCross: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      const t = (y - a.y) / (b.y - a.y);
      xsCross.push(a.x + t * (b.x - a.x));
    }
  }
  xsCross.sort((u, v) => u - v);
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xsCross.length; i += 2) intervals.push([xsCross[i], xsCross[i + 1]]);
  return intervals;
}

/** Есть ли у полигона самопересекающиеся стороны. */
function segmentsIntersect(poly: Point[]): boolean {
  const ccw = (a: Point, b: Point, c: Point) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
  const inter = (p1: Point, p2: Point, p3: Point, p4: Point) =>
    ccw(p3, p1, p2) !== ccw(p4, p1, p2) && ccw(p1, p3, p4) !== ccw(p1, p2, p4);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // соседние стороны замкнутого полигона
      if (inter(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}
