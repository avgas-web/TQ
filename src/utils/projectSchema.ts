// Строгая валидация внешних данных (импорт проектов / восстановленный persist)
// на базе zod. Контракт: функции валидации НИКОГДА не бросают исключение и
// никогда не возвращают NaN/битые значения наружу — вместо этого
//   parseProject(...)  -> { ok: false, errors: ['пункт: причина', ...] }
//   parseViewState(...)-> безопасные дефолты ({offsetX:0, offsetY:0, scale:1}).
import { z } from 'zod';
import type { Project, ViewState } from '../types';

const finiteNumber = z.number().finite();

/** Точка пиксельной системы карты */
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber });

/** Гео-координаты WGS-84 с проверкой допустимого диапазона lat/lng */
const geoPointSchema = z.object({
  lat: finiteNumber.min(-90).max(90),
  lng: finiteNumber.min(-180).max(180),
});

const routePointSchema = geoPointSchema.extend({
  x: finiteNumber,
  y: finiteNumber,
  auto: z.boolean().optional(),
  terrainM: finiteNumber.nullable().optional(),
  altitudeAbs: finiteNumber.nullable().optional(),
  altitudeAGL: finiteNumber.nullable().optional(),
});

const restrictionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['rectangle', 'polygon', 'circle']),
  points: z.array(pointSchema),
  radius: finiteNumber.nonnegative().optional(),
  color: z.string(),
  name: z.string(),
  active: z.boolean(),
  minHeightAGL: finiteNumber.nullable().optional(),
  maxHeightAGL: finiteNumber.nullable().optional(),
});

const markerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  x: finiteNumber,
  y: finiteNumber,
  lat: finiteNumber.min(-90).max(90).nullable(),
  lon: finiteNumber.min(-180).max(180).nullable(),
  type: z.string(),
  color: z.string(),
  comment: z.string(),
  layer: z.string(),
  createdAt: z.string(),
  terrainM: finiteNumber.nullable().optional(),
});

const mapBoundsSchema = z.object({
  north: finiteNumber.min(-90).max(90),
  south: finiteNumber.min(-90).max(90),
  east: finiteNumber.min(-180).max(180),
  west: finiteNumber.min(-180).max(180),
});

const mapDataSchema = z.object({
  name: z.string(),
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  dataUrl: z.string(),
  bounds: mapBoundsSchema.optional(),
  source: z.enum(['local', 'google', 'yandex', 'osm']).optional(),
  mapId: z.string().optional(),
});

const waypointParamsLiteSchema = z.object({
  holdSec: finiteNumber.nonnegative(),
  cameraAngleDeg: finiteNumber,
  speedMs: finiteNumber.nonnegative(),
  acceptanceRadiusM: finiteNumber.nonnegative(),
});

const routeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
  points: z.array(routePointSchema),
  active: z.boolean(),
  visible: z.boolean(),
  createdAt: z.string(),
  shape: z.enum(['straight', 'curve']).optional(),
  rangeMode: z.enum(['off', 'max', 'min']).optional(),
  rangeM: finiteNumber.nonnegative().optional(),
  missionMeta: z.object({ author: z.string(), createdAt: z.string() }).optional(),
  waypointParams: z.record(z.coerce.number().finite(), waypointParamsLiteSchema).optional(),
});

const importPointSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  lat: finiteNumber.min(-90).max(90),
  lng: finiteNumber.min(-180).max(180),
  routeId: z.string().nullable(),
  placeName: z.string().optional(),
});

const projectSchema = z.object({
  version: z.string(),
  projectName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  map: mapDataSchema.nullable(),
  calibration: z.object({
    enabled: z.boolean(),
    points: z.array(z.object({
      pixelX: finiteNumber,
      pixelY: finiteNumber,
      lat: finiteNumber.min(-90).max(90),
      lon: finiteNumber.min(-180).max(180),
    })),
  }),
  restrictions: z.array(restrictionSchema),
  markers: z.array(markerSchema),
  routes: z.array(routeSchema).optional(),
  importLists: z.object({
    starts: z.array(importPointSchema),
    goals: z.array(importPointSchema),
  }).optional(),
  layers: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    visible: z.boolean(),
    locked: z.boolean(),
  })),
  settings: z.object({
    showGrid: z.boolean(),
    gridSize: finiteNumber.nonnegative(),
    showCoordinates: z.boolean(),
    theme: z.enum(['dark', 'light']),
    tileStyle: z.literal('scheme').optional(),
    tilesEnabled: z.boolean().optional(),
    elevationAuto: z.boolean().optional(),
    altitudeClearanceM: finiteNumber.nonnegative().optional(),
  }),
  googleMaps: z.object({ apiKey: z.string(), enabled: z.boolean() }),
  yandexMaps: z.object({ apiKey: z.string(), enabled: z.boolean() }),
  openStreetMap: z.object({
    enabled: z.boolean(),
    tileServer: z.enum(['osm', 'opentopomap', 'carto']),
  }),
});

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

/** Форматирование ошибок zod в человекочитаемый список «path: сообщение». */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Валидация импортированного проекта. Битые данные (NaN, отсутствующие поля,
 * out-of-bounds lat/lon) приводят к `{ ok: false, errors: [...] }` — функция
 * НЕ крашится и не пропускает невалидные данные в стор.
 */
export function parseProject(raw: unknown): ParseResult<Project> {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  // Дополнительная семантика, которую schema не выражает: polygon >= 3 вершин,
  // circle — центр + радиус, route >= 2 точек.
  const extra: string[] = [];
  const data = parsed.data as Project;
  data.restrictions.forEach((r, i) => {
    if (r.type === 'polygon' && r.points.length < 3) {
      extra.push(`restrictions[${i}] («${r.name}»): polygon требует >= 3 вершин, получено ${r.points.length}`);
    }
    if (r.type === 'circle' && !(typeof r.radius === 'number' && r.radius > 0)) {
      extra.push(`restrictions[${i}] («${r.name}»): circle требует radius > 0`);
    }
  });
  (data.routes ?? []).forEach((rt, i) => {
    if (rt.points.length < 2) {
      extra.push(`routes[${i}] («${rt.name}»): маршрут требует >= 2 точек, получено ${rt.points.length}`);
    }
  });
  if (extra.length > 0) return { ok: false, errors: extra };
  return { ok: true, data };
}

/** Дефолтное безопасное состояние вида карты. */
export const DEFAULT_VIEW_STATE: ViewState = { offsetX: 0, offsetY: 0, scale: 1 };

/**
 * Валидация viewState из внешнего источника (localStorage / postMessage).
 * ВСЕГДА возвращает корректный ViewState: битые/отсутствующие поля заменяются
 * безопасными дефолтами (scale=1, offset=0); никогда не бросает исключение.
 */
export function parseViewState(raw: unknown): ViewState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VIEW_STATE };
  const candidate = raw as Record<string, unknown>;
  const numOr = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  const scale = numOr(candidate.scale, DEFAULT_VIEW_STATE.scale);
  const z0raw = candidate.z0;
  const z0 = typeof z0raw === 'number' && Number.isFinite(z0raw) ? z0raw : undefined;
  return {
    offsetX: numOr(candidate.offsetX, DEFAULT_VIEW_STATE.offsetX),
    offsetY: numOr(candidate.offsetY, DEFAULT_VIEW_STATE.offsetY),
    // scale <= 0 ломает аффинные преобразования канваса (деление на scale)
    scale: scale > 0 ? scale : DEFAULT_VIEW_STATE.scale,
    ...(z0 !== undefined ? { z0 } : {}),
  };
}
