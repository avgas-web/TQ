// ═══════════════════════════════════════════════════════════════
// projectSchema — строгая валидация внешних данных (localStorage, IndexedDB,
// импорт .tqproj/JSON) ПЕРЕД попаданием в стейт. Дефолты закрывают краши вида
// «Cannot read properties of undefined» на битых/старых снапшотах.
// ═══════════════════════════════════════════════════════════════
import { z } from "zod";
import type { Project, ViewState } from "../types";

const finiteNumber = z.number().finite();
/** Координаты — с диапазоном; null допустим (маркер ещё не геопривязан). */
const latOrNull = finiteNumber
  .refine((v) => v >= -90 && v <= 90, "Широта вне [-90; 90]")
  .nullable();
const lonOrNull = finiteNumber
  .refine((v) => v >= -180 && v <= 180, "Долгота вне [-180; 180]")
  .nullable();

export const PointSchema = z.object({ x: finiteNumber, y: finiteNumber });

/** Маркер: полные атрибуты + дефолты; доп. поля (binding и т.п.) сохраняются. */
export const MarkerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    x: finiteNumber,
    y: finiteNumber,
    lat: latOrNull,
    lon: lonOrNull,
    type: z.string().default("default"),
    color: z.string().default("#00ff00"),
    comment: z.string().default(""),
    layer: z.string().default("default"),
    createdAt: z.string().default(() => new Date().toISOString()),
    terrainM: finiteNumber.nullable().optional(),
  })
  .passthrough();

/**
 * Тип зоны. Продуктово оставлены только полигоны NFZ произвольной геометрии,
 * но legacy-сохранённые проекты ('rectangle'/'circle') обязаны переживать
 * миграцию без потери данных — принимаем все три значения, канонализируем ниже.
 */
export const RestrictionSchema = z
  .object({
    id: z.string(),
    type: z.enum(["rectangle", "polygon", "circle"]),
    points: z.array(PointSchema).default([]),
    radius: finiteNumber.nonnegative().optional(),
    color: z.string().default("#ff000080"),
    name: z.string().default("Ограничение"),
    active: z.boolean().default(true),
    minHeightAGL: finiteNumber.nonnegative().nullable().optional(),
    maxHeightAGL: finiteNumber.nonnegative().nullable().optional(),
  })
  .transform((r): typeof r => {
    // Legacy-канонизация: прямоугольник → полигон из 4 углов (без потерь формы).
    if (r.type === "rectangle" && r.points.length === 2) {
      const [a, b] = r.points;
      return {
        ...r,
        type: "polygon",
        points: [
          { x: a.x, y: a.y },
          { x: b.x, y: a.y },
          { x: b.x, y: b.y },
          { x: a.x, y: b.y },
        ],
      };
    }
    return r;
  })
  .refine(
    (r) => (r.type === "circle" ? r.points.length >= 1 : r.points.length !== 1),
    "Зона недопустима: circle требует центр; polygon — 0 или ≥2 точек (1 точка — вырожденная зона)",
  );

export const LayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
});

export const CalibrationPointSchema = z.object({
  pixelX: finiteNumber,
  pixelY: finiteNumber,
  lat: finiteNumber.min(-90).max(90),
  lon: finiteNumber.min(-180).max(180),
});

export const MapBoundsSchema = z
  .object({
    north: finiteNumber.min(-90).max(90),
    south: finiteNumber.min(-90).max(90),
    east: finiteNumber.min(-180).max(180),
    west: finiteNumber.min(-180).max(180),
  })
  .refine(
    (b) => b.north > b.south && b.east > b.west,
    "Bounds: требуется north>south и east>west",
  );

export const MapDataSchema = z.object({
  name: z.string(),
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  dataUrl: z.string().default(""),
  bounds: MapBoundsSchema.optional(),
  source: z.enum(["local", "google", "yandex", "osm"]).optional(),
  mapId: z.string().optional(),
});

export const RoutePointSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  lat: finiteNumber.min(-90).max(90),
  lng: finiteNumber.min(-180).max(180),
  auto: z.boolean().optional(),
  terrainM: finiteNumber.nullable().optional(),
  altitudeAbs: finiteNumber.nullable().optional(),
  altitudeAGL: finiteNumber.nonnegative().nullable().optional(),
});

export const RouteSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  points: z.array(RoutePointSchema).default([]),
  active: z.boolean().default(false),
  visible: z.boolean().default(true),
  createdAt: z.string().default(() => new Date().toISOString()),
  shape: z.enum(["straight", "curve"]).default("straight"),
  rangeMode: z.enum(["off", "max", "min"]).optional(),
  rangeM: finiteNumber.positive().optional(),
});

/** viewState: жёсткие дефолты + scale строго положительный — источник былых крашей. */
export const ViewStateSchema = z.object({
  offsetX: finiteNumber.default(0),
  offsetY: finiteNumber.default(0),
  scale: finiteNumber.positive().default(1),
  z0: finiteNumber.int().min(3).max(19).optional(),
});

export const ProjectSchema = z.object({
  version: z.string().default("1.1"),
  projectName: z.string().default("Новый проект"),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
  map: MapDataSchema.nullable().default(null),
  calibration: z
    .object({
      enabled: z.boolean().default(false),
      points: z.array(CalibrationPointSchema).default([]),
    })
    .default({ enabled: false, points: [] }),
  restrictions: z.array(RestrictionSchema).default([]),
  markers: z.array(MarkerSchema).default([]),
  routes: z.array(RouteSchema).optional(),
  layers: z
    .array(LayerSchema)
    .default([
      { id: "default", name: "Основной", visible: true, locked: false },
    ]),
  settings: z
    .object({
      showGrid: z.boolean().default(true),
      gridSize: finiteNumber.nonnegative().default(0),
      showCoordinates: z.boolean().default(true),
      theme: z.enum(["dark", "light"]).default("dark"),
      tileStyle: z.literal("scheme").optional(),
      tilesEnabled: z.boolean().default(true),
      elevationAuto: z.boolean().default(true),
      altitudeClearanceM: finiteNumber.nonnegative().default(50),
    })
    .default({
      showGrid: true,
      gridSize: 0,
      showCoordinates: true,
      theme: "dark",
      tilesEnabled: true,
      elevationAuto: true,
      altitudeClearanceM: 50,
    }),
  // ЭТАП 1.2: apiKey принудительно выбрасывается из любых внешних/legacy
  // данных (transform), а не только дефолтится — секрет не переживает
  // импорт проекта и гидрацию старых снапшотов.
  googleMaps: z
    .object({
      apiKey: z.string().optional(),
      enabled: z.boolean().default(false),
    })
    .transform((v) => ({ enabled: v.enabled }))
    .default({ enabled: false }),
  yandexMaps: z
    .object({
      apiKey: z.string().optional(),
      enabled: z.boolean().default(false),
    })
    .transform((v) => ({ enabled: v.enabled }))
    .default({ enabled: false }),
  openStreetMap: z
    .object({
      enabled: z.boolean().default(false),
      // Рабочие id из TILE_PROVIDERS (esri, esri-sat, osmfr, hot, osmde, opentopomap,
      // cyclosm) + legacy ('osm', 'carto', '2gis') — normalizeTileServer() приведёт
      // неизвестное/legacy к рабочему серверу при чтении.
      tileServer: z.string().default("osm"),
    })
    .default({ enabled: false, tileServer: "osm" }),
});

export type ValidatedProject = z.infer<typeof ProjectSchema>;

/** Результат валидации: данные ИЛИ человекочитаемые причины отказа. */
export type ProjectParseResult =
  { ok: true; project: ValidatedProject } | { ok: false; errors: string[] };

/**
 * Валидация произвольного входного объекта (JSON из localStorage/.tqproj).
 * @param raw - нераспарсенное значение (unknown — приведение запрещено).
 * @returns ok:true со схемобезопасным проектом либо список ошибок для UI.
 */
export function parseProject(raw: unknown): ProjectParseResult {
  const parsed = ProjectSchema.safeParse(raw);
  if (parsed.success)
    return { ok: true, project: parsed.data satisfies ValidatedProject };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}

/**
 * Схема снапшота гео-части проекта (useMapStore.getGeoSnapshot): те же поля,
 * что ProjectSchema, но routes/importLists исключены (они в tq-mission).
 */
const GeoSnapshotSchema = ProjectSchema.omit({ routes: true }).partial({
  version: true,
});

/**
 * Best-effort санитайзер внешних данных: валидирует через Zod и ДОПОЛНЯЕТ
 * дефолтами, а не отвергает объект целиком (legacy-проекты богаты полевыми
 * расширениями, которых нет в схеме). Падает только если вход — не объект.
 * Используется на границах persist-migration и импорта .tqproj.
 */
export function sanitizeProjectData(raw: unknown): Record<string, unknown> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError(
      "sanitizeProjectData: ожидался plain-object снапшот проекта",
    );
  }
  // 1) Полная строгая схема: если прошла — берём канонизированные данные
  //    (прямоугольники→полигоны, finite-числа, bounds north>south и т.д.),
  //    но сохраняем исходные расширенные поля, которые schema бы вырезала.
  const strict = GeoSnapshotSchema.safeParse(obj);
  if (strict.success)
    return { ...obj, ...(strict.data as Record<string, unknown>) };
  // 2) Строгая схема не прошла (битые legacy-поля) — точечная починка по секциям:
  //    каждая секция валидируется отдельно; дефектная секция заменяется дефолтом,
  //    остальные данные пользователя сохраняются.
  const out: Record<string, unknown> = { ...obj };
  const fixSection = <K extends keyof ValidatedProject>(
    key: K,
    schema: z.ZodTypeAny,
  ): void => {
    const r = schema.safeParse(obj[key as string]);
    out[key as string] = r.success ? r.data : undefined; // undefined → default при {...obj} слиянии ниже
  };
  fixSection("markers", z.array(MarkerSchema));
  fixSection("restrictions", z.array(RestrictionSchema));
  fixSection("layers", z.array(LayerSchema));
  fixSection("calibration", GeoSnapshotSchema.shape.calibration);
  fixSection("map", MapDataSchema.nullable());
  fixSection("settings", GeoSnapshotSchema.shape.settings);
  for (const k of [
    "markers",
    "restrictions",
    "layers",
    "calibration",
    "map",
    "settings",
  ]) {
    if (out[k] === undefined) delete out[k]; // пусть ProjectSchema применит дефолт
  }
  return out;
}

/**
 * ФАЗА 4.2: мягкий санитайзер снапшота useMissionStore (tq-mission) для
 * границы persist-хранилища. Как sanitizeProjectData — best-effort: битые
 * секции заменяются дефолтами, приложение не падает на чужом/повреждённом
 * JSON. Строгой схемой валидируются маршруты (координаты/числа); списки
 * импорта и черновик мастера чинятся структурно.
 */
export function sanitizeMissionPersistData(
  raw: unknown,
): Record<string, unknown> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = { ...obj };
  // routes: битые элементы отбрасываются (строгая RouteSchema), невалидный
  // вход целиком → [] (пустой список — валидное состояние стора).
  if (out.routes !== undefined) {
    const r = z.array(RouteSchema).safeParse(out.routes);
    if (r.success) out.routes = r.data;
    else if (Array.isArray(out.routes)) {
      out.routes = (out.routes as unknown[]).filter(
        (el) => RouteSchema.safeParse(el).success,
      );
    } else out.routes = [];
  }
  // importLists: объект массивов строк/точек — при дефекте сброс к {}.
  if (
    out.importLists !== undefined &&
    (typeof out.importLists !== "object" ||
      out.importLists === null ||
      Array.isArray(out.importLists))
  ) {
    out.importLists = {};
  }
  // routeDraft: { geo: [], agl: {} } — жёсткая структура, чиним всегда.
  const draft = out.routeDraft as Record<string, unknown> | undefined;
  out.routeDraft = {
    geo: Array.isArray(draft?.geo)
      ? (draft?.geo as unknown[]).filter(
          (p) => PointSchema.safeParse(p).success,
        )
      : [],
    agl:
      draft?.agl && typeof draft.agl === "object" && !Array.isArray(draft.agl)
        ? draft.agl
        : {},
  };
  // Сессионные/переходные поля не переживают гидратацию (совпадает с partialize).
  out.routeWarnings = {};
  out.isProcessing = false;
  for (const k of ["sharedStartId", "sharedGoalId"] as const) {
    if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "string")
      out[k] = null;
  }
  if (out.craftType !== "drone" && out.craftType !== "uav")
    delete out.craftType;
  for (const k of ["startPointIds", "goalPointIds"] as const) {
    if (out[k] !== undefined && !Array.isArray(out[k])) delete out[k];
  }
  if (
    out.activeRouteId !== undefined &&
    out.activeRouteId !== null &&
    typeof out.activeRouteId !== "string"
  ) {
    out.activeRouteId = null;
  }
  return out;
}

/**
 * ФАЗА 4.2: мягкий санитайзер снапшота useFleetStore (tq-fleet).
 * DroneAssignment/DroneVideoState не имеют Zod-схем (исторически typed-only),
 * поэтому проверка структурная + числовая (finite координаты), как делали
 * migrate-функции до внедрения границы валидации.
 */
export function sanitizeFleetPersistData(
  raw: unknown,
): Record<string, unknown> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = { ...obj };
  const isGeo = (v: unknown): boolean => {
    if (v === null) return true; // legacy: назначение без точки допустимо
    if (!v || typeof v !== "object") return false;
    const g = v as Record<string, unknown>;
    const num = (x: unknown): boolean =>
      typeof x === "number" && Number.isFinite(x);
    return num(g.lat) && num(g.lng) && num(g.x) && num(g.y);
  };
  const fixArr = (key: string): void => {
    if (out[key] === undefined) return;
    out[key] = Array.isArray(out[key])
      ? (out[key] as unknown[]).map((el) => (isGeo(el) ? el : null))
      : [];
  };
  fixArr("droneAssignments");
  fixArr("droneStarts");
  fixArr("droneGoals");
  if (out.drones !== undefined && !Array.isArray(out.drones)) out.drones = [];
  if (
    out.selectedDroneId !== undefined &&
    out.selectedDroneId !== null &&
    typeof out.selectedDroneId !== "string"
  ) {
    out.selectedDroneId = null;
  }
  return out;
}

/** Валидация viewState из хранилища (замена ad-hoc normalizeViewState). */
export function parseViewState(raw: unknown): ViewState {
  const parsed = ViewStateSchema.catchall(z.unknown()).safeParse(raw ?? {});
  if (!parsed.success) return { offsetX: 0, offsetY: 0, scale: 1 };
  const d = parsed.data;
  return { offsetX: d.offsetX, offsetY: d.offsetY, scale: d.scale, z0: d.z0 };
}
