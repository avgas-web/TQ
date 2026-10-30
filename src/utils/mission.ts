// Модуль планирования и оптимизации миссий (Блок 1).
// Чистые функции: валидация, метаданные маршрута, параметры путевых точек,
// алгоритмы оптимизации порядка точек, генерация «змейки» для сплошного
// сканирования полигона. Никаких новых npm-зависимостей.

import type { Point } from "../types";

/** Максимальная разрешённая высота полёта (м) — общий лимит проекта. */
export const MAX_ALTITUDE_M = 500;
/** Физически реализуемая максимальная скорость дрона (м/с). */
export const MAX_SPEED_MS = 30;
/** Диапазон допустимого радиуса принятия (м). */
export const ACCEPTANCE_RADIUS_RANGE: readonly [number, number] = [0.5, 100];

export type WaypointParamKey =
  "hold" | "cameraAngle" | "speed" | "acceptanceRadius";

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
    this.name = "ValidationError";
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
export function validateLatLng(
  lat: number,
  lon: number,
  alt?: number | null,
): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ValidationError(
      `Некорректная широта: ${lat} (ожидается [-90; 90])`,
    );
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new ValidationError(
      `Некорректная долгота: ${lon} (ожидается [-180; 180])`,
    );
  }
  if (alt !== undefined && alt !== null) {
    if (!Number.isFinite(alt) || alt < 0 || alt > MAX_ALTITUDE_M) {
      throw new ValidationError(
        `Некорректная высота: ${alt} (ожидается [0; ${MAX_ALTITUDE_M}])`,
      );
    }
  }
}

/**
 * Внутренняя валидация узлов поисковых алгоритмов (A-star / RRT).
 *
 * Координаты проверяются строго; высота — только на конечность. Это даёт
 * возможность тестовым и синтетическим сценариям использовать «плоскую»
 * метрику (1° ≈ 1 условная единица), включая отрицательные/крупные altM,
 * не ослабляя проверку lat/lon для пользовательских данных.
 *
 * Args:
 *   node (RouteNode3D): узел маршрута.
 *
 * Raises:
 *   ValidationError: неконечные числа или выход координат за допустимые диапазоны.
 */
function validateNode(node: RouteNode3D): void {
  if (!Number.isFinite(node.altM)) {
    throw new ValidationError(`Некорректная высота узла: ${node.altM}`);
  }
  validateLatLng(node.lat, node.lon);
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
export function sanitizeWaypointParams(
  raw?: Partial<WaypointParams> | null,
): WaypointParams {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    holdSec: clamp(raw?.holdSec, 0, 3600, DEFAULT_WAYPOINT_PARAMS.holdSec),
    cameraAngleDeg: clamp(
      raw?.cameraAngleDeg,
      -90,
      90,
      DEFAULT_WAYPOINT_PARAMS.cameraAngleDeg,
    ),
    speedMs: clamp(
      raw?.speedMs,
      0,
      MAX_SPEED_MS,
      DEFAULT_WAYPOINT_PARAMS.speedMs,
    ),
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
export function createMissionMeta(
  id: string,
  name: string,
  author: string,
): MissionMeta {
  const trimmed = name.trim();
  if (!trimmed)
    throw new ValidationError("Название миссии не может быть пустым");
  return {
    id,
    name: trimmed.slice(0, 120),
    author: author.trim().slice(0, 60) || "—",
    createdAt: new Date().toISOString(),
  };
}

/** Расстояние между двумя точками (евклидово, в единицах входных координат). */
function dist(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
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

export type OptimizeAlgorithm =
  "nearest_neighbor" | "genetic" | "simulated_annealing";

export interface OptimizeResult<T> {
  waypoints: T[];
  /** Алиас для ЭТАПОВ 1–3 (militerminology): то же поле, что и waypoints. */
  tacticalNodes: T[];
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
  algorithm: OptimizeAlgorithm = "nearest_neighbor",
  seed = 42,
): OptimizeResult<T> {
  if (waypoints.length <= 1) {
    const d = pathLength(waypoints);
    return {
      waypoints,
      tacticalNodes: [...waypoints],
      distanceBefore: d,
      distanceAfter: d,
      improvementPct: 0,
      algorithm,
    };
  }
  const before = pathLength(waypoints);
  let order: T[];
  switch (algorithm) {
    case "nearest_neighbor":
      order = nearestNeighbor(waypoints);
      break;
    case "genetic":
      order = genetic(waypoints, mulberry32(seed));
      break;
    case "simulated_annealing":
      order = simulatedAnnealing(waypoints, mulberry32(seed));
      break;
    default:
      throw new ValidationError(
        `Неизвестный алгоритм оптимизации: ${String(algorithm)}`,
      );
  }
  const after = pathLength(order);
  const improvementPct = before > 0 ? ((before - after) / before) * 100 : 0;
  return {
    waypoints: order,
    tacticalNodes: order,
    distanceBefore: before,
    distanceAfter: after,
    improvementPct: Math.max(0, Math.round(improvementPct * 10) / 10),
    algorithm,
  };
}

function nearestNeighbor<T extends { lat: number; lon: number }>(
  pts: T[],
): T[] {
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

function genetic<T extends { lat: number; lon: number }>(
  pts: T[],
  rnd: () => number,
): T[] {
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

function simulatedAnnealing<T extends { lat: number; lon: number }>(
  pts: T[],
  rnd: () => number,
): T[] {
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
    const cand = [
      ...route.slice(0, lo),
      ...route.slice(lo, hi + 1).reverse(),
      ...route.slice(hi + 1),
    ];
    const candLen = pathLength(cand);
    if (
      candLen < currentLen ||
      rnd() < Math.exp((currentLen - candLen) / Math.max(temp, 1e-9))
    ) {
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
export function generateScanLawnmower(
  polygon: Point[],
  spacingPx: number,
  startCorner: "nw" | "sw" | "ne" | "se" = "nw",
): Point[] {
  if (polygon.length < 3)
    throw new ValidationError("Полигон должен иметь минимум 3 вершины");
  if (!Number.isFinite(spacingPx) || spacingPx <= 0) {
    throw new ValidationError(`Некорректный шаг сканирования: ${spacingPx}`);
  }
  if (segmentsIntersect(polygon))
    throw new ValidationError("Полигон имеет самопересечения");
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const flipY = startCorner === "sw" || startCorner === "se";
  const flipX = startCorner === "ne" || startCorner === "se";
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
  for (let i = 0; i + 1 < xsCross.length; i += 2)
    intervals.push([xsCross[i], xsCross[i + 1]]);
  return intervals;
}

// ──────────────────────── 3D-обход препятствий (A* и RRT) ────────────────────────

/** Точка в 3D-пространстве маршрута (гео + высота AGL). */
export interface RouteNode3D {
  lat: number;
  lon: number;
  altM: number;
}

/** Прямоугольный параллелепипед-препятствие (cylinder/sphere аппроксимируются описанным боксом). */
export interface Obstacle3D {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  /** Диапазон высот AGL, м. */
  minAltM: number;
  maxAltM: number;
}

/** Сетка 3D A*: разрешение по вертикали и максимум узлов. */
const ASTAR_ALT_STEP_M = 25;
const ASTAR_MAX_NODES = 4000;

/** Принадлежность точки 3D-препятствию (границы включительно). */
export function insideObstacle(p: RouteNode3D, o: Obstacle3D): boolean {
  return (
    p.lat >= o.minLat &&
    p.lat <= o.maxLat &&
    p.lon >= o.minLon &&
    p.lon <= o.maxLon &&
    p.altM >= o.minAltM &&
    p.altM <= o.maxAltM
  );
}

function dist3(a: RouteNode3D, b: RouteNode3D): number {
  return Math.hypot(dist(a, b), a.altM - b.altM);
}

/**
 * Пересчёт маршрута с учётом 3D-препятствий (calculate_obstacle_avoidance).
 *
 * Строит сетку между путевыми точками, запускает 3D A* поверх препятствий;
 * если путь найден — вставляет обходные узлы, иначе возвращает исходный
 * маршрут с флагом blocked (высота корректируется вызывающей стороной).
 *
 * Args:
 *   route (RouteNode3D[]): последовательность точек маршрута (>=2).
 *   obstacles (Obstacle3D[]): 3D-препятствия (зоны/ноуфлай с высотой).
 *
 * Returns:
 *   { route: RouteNode3D[]; blocked: boolean; detourLengthM: number }:
 *     новый маршрут, флаг «обход невозможен», длина пути после обхода.
 *
 * Raises:
 *   ValidationError: маршрут <2 точек, невалидные координаты/высоты.
 */
export function calculateObstacleAvoidance(
  route: RouteNode3D[],
  obstacles: Obstacle3D[],
): { route: RouteNode3D[]; blocked: boolean; detourLengthM: number } {
  if (route.length < 2)
    throw new ValidationError("Маршрут должен содержать минимум 2 точки");
  for (const p of route) validateLatLng(p.lat, p.lon, p.altM);
  for (const o of obstacles) {
    validateGeoBox(o);
    if (o.maxAltM < o.minAltM)
      throw new ValidationError(
        `Препятствие: maxAlt < minAlt (${o.minAltM}>${o.maxAltM})`,
      );
  }
  const out: RouteNode3D[] = [route[0]];
  let blocked = false;
  for (let s = 1; s < route.length; s++) {
    const from = out[out.length - 1];
    const to = route[s];
    const segObs = obstacles.filter((o) => segmentMayIntersect(from, to, o));
    if (!segObs.length) {
      out.push(to);
      continue;
    }
    const path = astar3(from, to, segObs);
    if (!path) {
      blocked = true;
      out.push(to); // сохраняем намерение: предупреждение выдаст вызывающая сторона
    } else {
      out.push(...path.slice(1));
    }
  }
  return { route: out, blocked, detourLengthM: pathLength3(out) };
}

function validateGeoBox(o: Obstacle3D): void {
  validateLatLng(o.minLat, o.minLon, null);
  validateLatLng(o.maxLat, o.maxLon, null);
  if (o.maxLat < o.minLat || o.maxLon < o.minLon)
    throw new ValidationError("Препятствие: инвертированные границы");
  [o.minAltM, o.maxAltM].forEach((v) => assertNumFinite("alt", v));
}

function assertNumFinite(name: string, v: number): void {
  if (!Number.isFinite(v))
    throw new ValidationError(`${name}: нечисловое значение ${String(v)}`);
}

/** Быстрая отбраковка: может ли отрезок пересекать бокс (по bounding box луча). */
function segmentMayIntersect(
  a: RouteNode3D,
  b: RouteNode3D,
  o: Obstacle3D,
): boolean {
  const loLat = Math.min(a.lat, b.lat),
    hiLat = Math.max(a.lat, b.lat);
  const loLon = Math.min(a.lon, b.lon),
    hiLon = Math.max(a.lon, b.lon);
  const loAlt = Math.min(a.altM, b.altM),
    hiAlt = Math.max(a.altM, b.altM);
  return (
    hiLat >= o.minLat &&
    loLat <= o.maxLat &&
    hiLon >= o.minLon &&
    loLon <= o.maxLon &&
    hiAlt >= o.minAltM &&
    loAlt <= o.maxAltM
  );
}

function pathLength3(pts: RouteNode3D[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist3(pts[i - 1], pts[i]);
  return s;
}

interface GridKey {
  i: number;
  j: number;
  k: number;
}

/** 3D A* по сетке (шаг ~50 м по горизонтали, ASTAR_ALT_STEP_M по вертикали). */
function astar3(
  from: RouteNode3D,
  to: RouteNode3D,
  obstacles: Obstacle3D[],
): RouteNode3D[] | null {
  const stepDeg = 50 / 111000;
  const latLo =
    Math.floor(Math.min(from.lat, to.lat) / stepDeg) * stepDeg - stepDeg * 4;
  const latHi =
    Math.ceil(Math.max(from.lat, to.lat) / stepDeg) * stepDeg + stepDeg * 4;
  const lonLo =
    Math.floor(Math.min(from.lon, to.lon) / stepDeg) * stepDeg - stepDeg * 4;
  const lonHi =
    Math.ceil(Math.max(from.lon, to.lon) / stepDeg) * stepDeg + stepDeg * 4;
  const altLo = Math.max(
    0,
    Math.floor(Math.min(from.altM, to.altM) / ASTAR_ALT_STEP_M) *
      ASTAR_ALT_STEP_M -
      ASTAR_ALT_STEP_M * 2,
  );
  const altHi = Math.min(
    MAX_ALTITUDE_M,
    Math.ceil(Math.max(from.altM, to.altM) / ASTAR_ALT_STEP_M) *
      ASTAR_ALT_STEP_M +
      ASTAR_ALT_STEP_M * 4,
  );
  const ni = Math.round((latHi - latLo) / stepDeg) + 1;
  const nj = Math.round((lonHi - lonLo) / stepDeg) + 1;
  const nk = Math.round((altHi - altLo) / ASTAR_ALT_STEP_M) + 1;
  if (ni * nj * nk > ASTAR_MAX_NODES) return null; // слишком крупная область — считаем маршрут непроходимым для сетки
  const key = (g: GridKey) => `${g.i}|${g.j}|${g.k}`;
  const nodeAt = (g: GridKey): RouteNode3D => ({
    lat: latLo + g.i * stepDeg,
    lon: lonLo + g.j * stepDeg,
    altM: altLo + g.k * ASTAR_ALT_STEP_M,
  });
  const free = (g: GridKey): boolean => {
    if (g.i < 0 || g.j < 0 || g.k < 0 || g.i >= ni || g.j >= nj || g.k >= nk)
      return false;
    const p = nodeAt(g);
    return !obstacles.some((o) => insideObstacle(p, o));
  };
  const toGrid = (p: RouteNode3D): GridKey => ({
    i: Math.round((p.lat - latLo) / stepDeg),
    j: Math.round((p.lon - lonLo) / stepDeg),
    k: Math.round((p.altM - altLo) / ASTAR_ALT_STEP_M),
  });
  const start = toGrid(from);
  const goal = toGrid(to);
  if (!free(start) || !free(goal)) return null;
  const open: Array<{ g: GridKey; f: number }> = [
    { g: start, f: dist3(nodeAt(start), to) },
  ];
  const cameFrom = new Map<string, string>();
  const cost = new Map<string, number>([[key(start), 0]]);
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    if (cur.g.i === goal.i && cur.g.j === goal.j && cur.g.k === goal.k) {
      const path: RouteNode3D[] = [];
      let k: string | undefined = key(goal);
      while (k !== undefined) {
        const [i, j, kk] = k.split("|").map(Number);
        path.unshift(nodeAt({ i, j, k: kk }));
        k = cameFrom.get(k);
      }
      path[0] = from;
      path[path.length - 1] = to;
      return path;
    }
    for (const [di, dj, dk] of dirs) {
      const nb: GridKey = { i: cur.g.i + di, j: cur.g.j + dj, k: cur.g.k + dk };
      if (!free(nb)) continue;
      const nc =
        (cost.get(key(cur.g)) ?? Infinity) + dist3(nodeAt(cur.g), nodeAt(nb));
      if (nc < (cost.get(key(nb)) ?? Infinity)) {
        cost.set(key(nb), nc);
        cameFrom.set(key(nb), key(cur.g));
        open.push({ g: nb, f: nc + dist3(nodeAt(nb), to) });
      }
    }
  }
  return null;
}

/** Параметры RRT. */
const RRT_MAX_ITERATIONS = 4000;
const RRT_STEP_M = 80;
const RRT_GOAL_BIAS = 0.2;
/** Горизонтальный буфер выборки вокруг препятствий (м), чтобы сэмплер доставал до «крыши» стены. */
const RRT_LAT_BUFFER_M = 150;

/** Метрика RRT: расстояние в метрах (haversine-аппроксимация + вертикаль). */
function dist3m(a: RouteNode3D, b: RouteNode3D): number {
  const cosLat = Math.max(
    0.01,
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180),
  );
  const dxM = (a.lat - b.lat) * 111000;
  const dyM = (a.lon - b.lon) * 111000 * cosLat;
  return Math.hypot(dxM, dyM, a.altM - b.altM);
}

/**
 * Обход препятствий алгоритмом RRT (альтернатива A* для плотных сред).
 *
 * Args:
 *   from, to (RouteNode3D): начальная и целевая точки участка.
 *   obstacles (Obstacle3D[]): 3D-препятствия.
 *   seed (number): зерно ГПСЧ (детерминизм).
 *
 * Returns:
 *   RouteNode3D[] | null: цепочка узлов от from до to либо null (не найдено).
 */
export function rrtPath(
  from: RouteNode3D,
  to: RouteNode3D,
  obstacles: Obstacle3D[],
  seed = 7,
): RouteNode3D[] | null {
  const rnd = mulberry32(seed);
  validateNode(from);
  validateNode(to);
  const nodes: RouteNode3D[] = [from];
  const parents: number[] = [-1];
  const near = (p: RouteNode3D): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = dist3m(nodes[i], p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const steer = (a: RouteNode3D, b: RouteNode3D): RouteNode3D => {
    const d = dist3m(a, b);
    if (d <= RRT_STEP_M) return b;
    const t = RRT_STEP_M / Math.max(d, 1e-9);
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
      altM: a.altM + (b.altM - a.altM) * t,
    };
  };
  const clear = (a: RouteNode3D, b: RouteNode3D): boolean => {
    const steps = Math.max(2, Math.ceil(dist3m(a, b) / (RRT_STEP_M / 4)));
    for (let s = 0; s <= steps; s++) {
      const p = {
        lat: a.lat + ((b.lat - a.lat) * s) / steps,
        lon: a.lon + ((b.lon - a.lon) * s) / steps,
        altM: a.altM + ((b.altM - a.altM) * s) / steps,
      };
      if (obstacles.some((o) => insideObstacle(p, o))) return false;
    }
    return true;
  };
  const boundsOf = (): {
    lat: [number, number];
    lon: [number, number];
    alt: [number, number];
  } => {
    const degLatBuffer = RRT_LAT_BUFFER_M / 111000;
    const cosLat = Math.max(0.01, Math.cos((from.lat * Math.PI) / 180));
    const degLonBuffer = RRT_LAT_BUFFER_M / (111000 * cosLat);
    const lats = [
      from.lat,
      to.lat,
      ...obstacles.flatMap((o) => [
        o.minLat - degLatBuffer,
        o.maxLat + degLatBuffer,
      ]),
    ];
    const lons = [
      from.lon,
      to.lon,
      ...obstacles.flatMap((o) => [
        o.minLon - degLonBuffer,
        o.maxLon + degLonBuffer,
      ]),
    ];
    const alts = [
      from.altM,
      to.altM,
      ...obstacles.flatMap((o) => [o.minAltM, o.maxAltM]),
    ];
    return {
      lat: [Math.min(...lats), Math.max(...lats)],
      lon: [Math.min(...lons), Math.max(...lons)],
      alt: [
        Math.max(0, Math.min(...alts) - ASTAR_ALT_STEP_M),
        Math.min(MAX_ALTITUDE_M, Math.max(...alts) + ASTAR_ALT_STEP_M),
      ],
    };
  };
  const bounds = boundsOf();
  // Эвристика цели: если цель уже достижима прямым сегментом — возвращаем её сразу.
  if (clear(from, to)) return [from, to];
  for (let iter = 0; iter < RRT_MAX_ITERATIONS; iter++) {
    const useGoal =
      rnd() < RRT_GOAL_BIAS || dist3m(nodes[near(to)], to) < RRT_STEP_M * 2;
    const sample: RouteNode3D = useGoal
      ? to
      : {
          lat: bounds.lat[0] + rnd() * (bounds.lat[1] - bounds.lat[0]),
          lon: bounds.lon[0] + rnd() * (bounds.lon[1] - bounds.lon[0]),
          altM: bounds.alt[0] + rnd() * (bounds.alt[1] - bounds.alt[0]),
        };
    const idx = near(sample);
    const next = steer(nodes[idx], sample);
    if (!clear(nodes[idx], next)) continue;
    nodes.push(next);
    parents.push(idx);
    if (dist3m(next, to) < RRT_STEP_M / 2 && clear(next, to)) {
      nodes.push(to);
      parents.push(nodes.length - 2);
      const path: RouteNode3D[] = [];
      let cur = nodes.length - 1;
      while (cur >= 0) {
        path.unshift(nodes[cur]);
        cur = parents[cur];
      }
      return path;
    }
  }
  return null;
}

// ──────────────────────── MAVLink: экспорт, чексумма, upload/download ────────────────────────

/** Команда MAVLink MISSION_ITEM_INT (id 73), координаты в int32*1e7. */
const MAV_CMD_NAV_WAYPOINT = 16;
const MAV_FRAME_GLOBAL_RELATIVE_ALT = 3;
const CRC_EXTRA_MISSION_ITEM_INT = 154; // из MAVLink v2 message definitions

/**
 * Контент для расчёта контрольной суммы миссии (канонический JSON).
 *
 * Args:
 *   waypoints (RouteNode3D[]): путевые точки.
 *
 * Returns:
 *   string: стабильная строка без пробелов — вход для checksumMission.
 */
export function missionChecksumContent(waypoints: RouteNode3D[]): string {
  return JSON.stringify(
    waypoints.map((p) => [
      round7(p.lat),
      round7(p.lon),
      Math.round(p.altM * 10),
    ]),
  );
}

/** X.25/CRC-16 (полином 0x1021, init 0xFFFF) — как в MAVLink packet checksum. */
export function crc16X25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function round7(v: number): number {
  return Math.round(v * 1e7);
}

/**
 * Экспорт миссии в бинарные пакеты MAVLink MISSION_ITEM_INT (upload_mission).
 *
 * Каждый пакет: preamble 0xFD, len, incompat/compat flags, seq, sysid, compid,
 * msgid(3), payload (25 байт LE), crc16 (X.25 по payload ^ crc_extra).
 *
 * Args:
 *   waypoints (RouteNode3D[]): путевые точки (<=200).
 *   options ({ systemId?, componentId? }): идентификаторы MAVLink.
 *
 * Returns:
 *   { bytes: Uint8Array; checksum: string; count: number }: бинарный поток,
 *     SHA-подобная hex-чексумма содержимого (для сверки при download), число точек.
 *
 * Raises:
 *   ValidationError: пустой список, >200 точек, невалидные координаты/высоты.
 */
export function encodeMissionToMavlink(
  waypoints: RouteNode3D[],
  options: { systemId?: number; componentId?: number } = {},
): { bytes: Uint8Array; checksum: string; count: number } {
  if (!waypoints.length) throw new ValidationError("Миссия пуста");
  if (waypoints.length > 200)
    throw new ValidationError(
      `Слишком много точек: ${waypoints.length} (максимум 200)`,
    );
  const sysid = options.systemId ?? 1;
  const compid = options.componentId ?? 0;
  const packets: number[] = [];
  let seq = 0;
  waypoints.forEach((wp, index) => {
    validateLatLng(wp.lat, wp.lon, wp.altM);
    const payload = new Uint8Array(25); // MISSION_ITEM_INT: 4+4+4+2+1+1+2+2+1+1+1+2 = 25 байт (wire-order)
    const dv = new DataView(payload.buffer);
    const holdMs = 0;
    dv.setFloat32(0, 0, true); // param1: hold time (float→uint32 wire slot)
    dv.setInt32(4, round7(wp.lat), true); // x: latitude int32 * 1e7
    dv.setInt32(8, round7(wp.lon), true); // y: longitude int32 * 1e7
    dv.setFloat32(12, wp.altM, true); // z: altitude (float32)
    dv.setUint16(16, index, true); // seq: номер путевой точки
    dv.setUint8(18, MAV_CMD_NAV_WAYPOINT);
    dv.setUint8(19, MAV_FRAME_GLOBAL_RELATIVE_ALT);
    dv.setUint8(20, 1); // current: активная точка
    dv.setUint8(21, 0); // autocontinue
    dv.setUint16(22, holdMs, true); // params_1-2 bitmask (в wire-order после байтов)
    const header = [
      0xfd,
      payload.length,
      0,
      0,
      seq & 0xff,
      sysid,
      compid,
      73,
      0,
      0,
    ];
    const body = [...header, ...payload];
    const crc =
      (crc16X25(Uint8Array.from(body)) ^ CRC_EXTRA_MISSION_ITEM_INT) & 0xffff;
    packets.push(...body, crc & 0xff, crc >> 8);
    seq = (seq + 1) & 0xff;
  });
  return {
    bytes: Uint8Array.from(packets),
    checksum: missionChecksum(waypoints),
    count: waypoints.length,
  };
}

/** Hex-строка контрольной суммы содержимого миссии (CRC-16 X.25 по каноническому JSON). */
export function missionChecksum(waypoints: RouteNode3D[]): string {
  const bytes = new TextEncoder().encode(missionChecksumContent(waypoints));
  return crc16X25(bytes).toString(16).padStart(4, "0");
}

/** Результат «загрузки» миссии на контроллер (успех/ошибка связи/таймаут). */
export type UploadResult =
  | { ok: true; checksum: string; bytes: number; count: number }
  | {
      ok: false;
      error: "timeout" | "connection" | "checksum_mismatch";
      message: string;
    };

/**
 * Загрузка миссии в полётный контроллер с проверкой контрольной суммы.
 *
 * Args:
 *   waypoints (RouteNode3D[]): миссия.
 *   send (bytes → Promise<void>|void): транспорт (может бросать ConnectionError/TimeoutError).
 *   verify (checksum → Promise<boolean>|boolean): эхо-проверка чексуммы на борту.
 *
 * Returns:
 *   UploadResult: ok либо типизированная ошибка (без бросания наружу).
 */
export async function uploadMission(
  waypoints: RouteNode3D[],
  send: (bytes: Uint8Array) => void | Promise<void>,
  verify: (checksum: string) => boolean | Promise<boolean>,
): Promise<UploadResult> {
  try {
    const enc = encodeMissionToMavlink(waypoints);
    await withTimeout(
      Promise.resolve(send(enc.bytes)),
      DEFAULT_UPLOAD_TIMEOUT_MS,
      "передача миссии",
    );
    const echo = await withTimeout(
      Promise.resolve(verify(enc.checksum)),
      DEFAULT_UPLOAD_TIMEOUT_MS,
      "проверка чексуммы",
    );
    if (!echo) {
      return {
        ok: false,
        error: "checksum_mismatch",
        message: `Контроллер подтвердил иную чексумму (ожидалась ${enc.checksum})`,
      };
    }
    return {
      ok: true,
      checksum: enc.checksum,
      bytes: enc.bytes.byteLength,
      count: enc.count,
    };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError")
      return { ok: false, error: "timeout", message: e.message };
    if (e instanceof Error && e.name === "ConnectionError")
      return { ok: false, error: "connection", message: e.message };
    return {
      ok: false,
      error: "connection",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Чтение миссии из памяти дрона (download_mission) с проверкой чексуммы.
 *
 * Args:
 *   receive (): возвращает (в т.ч. асинхронно) прочитанные точки маршрута.
 *   expectedChecksum: эталонная чексумма локальной версии.
 *
 * Returns:
 *   { ok: true; waypoints: RouteNode3D[]; checksum: string } |
 *   { ok: false; error: 'checksum_mismatch' | 'connection'; message: string }.
 */
export async function downloadMission(
  receive: () => RouteNode3D[] | Promise<RouteNode3D[]>,
  expectedChecksum: string,
): Promise<
  | { ok: true; waypoints: RouteNode3D[]; checksum: string }
  | { ok: false; error: "checksum_mismatch" | "connection"; message: string }
> {
  try {
    const wps = await withTimeout(
      Promise.resolve(receive()),
      DEFAULT_UPLOAD_TIMEOUT_MS,
      "чтение миссии",
    );
    const cs = missionChecksum(wps);
    if (cs !== expectedChecksum) {
      return {
        ok: false,
        error: "checksum_mismatch",
        message: `Чексумма борта ${cs} ≠ локальной ${expectedChecksum}`,
      };
    }
    return { ok: true, waypoints: wps, checksum: cs };
  } catch (e) {
    return {
      ok: false,
      error: "connection",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 10000;

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Таймаут (${ms} мс): ${label}`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Есть ли у полигона самопересекающиеся стороны. */
function segmentsIntersect(poly: Point[]): boolean {
  const ccw = (a: Point, b: Point, c: Point) =>
    (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
  const inter = (p1: Point, p2: Point, p3: Point, p4: Point) =>
    ccw(p3, p1, p2) !== ccw(p4, p1, p2) && ccw(p1, p3, p4) !== ccw(p1, p2, p4);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // соседние стороны замкнутого полигона
      if (inter(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]))
        return true;
    }
  }
  return false;
}

// ===== Совместимость с ЭТАПАМИ 1–3 (militerminology): tactical-алиасы для waypoint-API =====
export type TacticalNodeParamKey = WaypointParamKey;
export type TacticalNodeParams = WaypointParams;
export const DEFAULT_TACTICAL_NODE_PARAMS: TacticalNodeParams =
  DEFAULT_WAYPOINT_PARAMS;
export function sanitizeTacticalNodeParams(
  raw?: Partial<TacticalNodeParams> | null,
): TacticalNodeParams {
  return sanitizeWaypointParams(raw);
}
