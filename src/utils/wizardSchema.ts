// ═══════════════════════════════════════════════════════════════
// wizardSchema — Zod-схема данных мастера миссий (ФАЗА 3.3)
//
// Единый источник истины для трёх границ:
//  1) persist `migrate`/гидрация стора (защита от битых снапшотов localStorage);
//  2) импорт .tqproj kind='mission' (файл может быть чужим/повреждённым);
//  3) экспорт миссии (перед записью файла).
//
// Принципы:
//  • unknown на входе, строго типизированный объект на выходе;
//  • элементы с невалидными id/name/координатами ОТБРАСЫВАЮТСЯ (zod v4:
//    z.preprocess + safeParse возвращают данные без ключа при ошибке →
//    дефолт []), а не роняют стор/приложение;
//  • функции стора в схему не входят — partialize/migrate живут только над данными.
// ═══════════════════════════════════════════════════════════════
import { z } from "zod";
import type { TileServerId } from "./openStreetMap";
import { normalizeTileServer } from "./openStreetMap";

const finiteNumber = z.number().finite();
const latSchema = finiteNumber.refine(
  (v) => v >= -90 && v <= 90,
  "Широта вне [-90; 90]",
);
const lonSchema = finiteNumber.refine(
  (v) => v >= -180 && v <= 180,
  "Долгота вне [-180; 180]",
);
const idSchema = z.string().min(1);

/** Валидация массива элементов схемой item: битые элементы отбрасываются,
 *  невалидный вход целиком → []. Возвращает новый массив (без мутации входа).
 *  countDropped — сколько элементов НЕ прошло схему (для warnings санитайзера). */
export function filterValidItems<T>(
  raw: unknown,
  item: z.ZodTypeAny,
  countDropped?: { value: number },
): T[] {
  if (!Array.isArray(raw)) {
    if (countDropped && raw !== undefined && raw !== null)
      countDropped.value += 1;
    return [];
  }
  const out: T[] = [];
  for (const el of raw) {
    const r = item.safeParse(el);
    if (r.success) out.push(r.data as T);
    else if (countDropped) countDropped.value += 1;
  }
  return out;
}

/** Счётчик отброшенных элементов секции: preprocess заполняет его во время
 *  WizardPersistSchema.safeParse, санитайзер читает после — warnings без
 *  двойного прогона схем и без мусорных ключей в данных. */
type DropCounters = Partial<Record<ArraySectionKey, number>>;

function makeFilter(
  item: z.ZodTypeAny,
  sectionKey: ArraySectionKey,
  counters?: DropCounters,
) {
  return (v: unknown): unknown[] => {
    const counter = { value: 0 };
    const arr = filterValidItems(v, item, counter);
    if (counters && counter.value > 0) {
      counters[sectionKey] = (counters[sectionKey] ?? 0) + counter.value;
    }
    return arr;
  };
}

export const GeoPointSchema = z.object({
  id: idSchema,
  name: z.string(),
  comment: z.string().optional(),
  lat: latSchema,
  lon: lonSchema,
  x: finiteNumber,
  y: finiteNumber,
  nearStartWarning: z.boolean().optional(),
});

export const CraftAssignmentSchema = z.object({
  startPointId: idSchema,
  craftCount: finiteNumber.int().nonnegative(),
});

export const FleetGroupSchema = z.object({
  id: idSchema,
  targetPointId: idSchema,
  totalCraft: finiteNumber.int().nonnegative(),
  assignments: z.preprocess(
    (v) => filterValidItems(v, CraftAssignmentSchema),
    z.array(CraftAssignmentSchema),
  ),
});

export const NoFlyZoneSchema = z.object({
  id: idSchema,
  name: z.string(),
  polygon: z.array(z.object({ x: finiteNumber, y: finiteNumber })).default([]),
});

export const CalculatedRouteSchema = z.object({
  id: idSchema,
  groupId: z.string(),
  startPointId: z.string(),
  targetPointId: z.string(),
  points: z.array(z.object({ x: finiteNumber, y: finiteNumber })).default([]),
  lengthMeters: finiteNumber.nonnegative(),
  crossesNfz: z.boolean(),
  blockedByNfz: z.boolean().default(false),
  exceedsRange: z.boolean().default(false),
  acknowledged: z.boolean().default(false),
});

export const AltitudeChangePointSchema = z.object({
  id: idSchema,
  routeId: idSchema,
  positionRatio: finiteNumber.min(0).max(1),
  altitudeAgl: finiteNumber.positive(),
  climbRate: finiteNumber.optional(),
  terrainM: finiteNumber.nullable(),
  belowTerrainWarning: z.boolean(),
});

export const AltitudeProfileSchema = z.object({
  routeId: idSchema,
  points: z.preprocess(
    (v) => filterValidItems(v, AltitudeChangePointSchema),
    z.array(AltitudeChangePointSchema),
  ),
});

export const WizardStepIdSchema = z.enum([
  "map-selection",
  "craft-selection",
  "start-points",
  "target-points",
  "fleet-formation",
  "nfz-and-routes",
  "altitude-profiles",
  "export-preparation",
  "mission-deployment",
]);

export const ExportFormatSchema = z.enum([
  "mavlink",
  "json",
  "csv",
  "gpx",
  "kml",
]);

/** Санация enum-секций: `undefined` (или неизвестное значение) в zod v4 НЕ
 *  активирует `.default()` — default срабатывает только на отсутствующий ключ
 *  объекта. Поэтому preprocess обязан вернуть сам дефолт, а не undefined/null. */
const enumOrDefault =
  <T extends string>(def: T, options: readonly string[]) =>
  (v: unknown): string =>
    options.includes(v as string) ? (v as string) : def;

/** Схема персистимых/файловых данных мастера (совпадает с partialize стора).
 *  enum-поля защищены z.preprocess: неизвестное значение → дефолт, а не ошибка.
 *  Счётчик dropCounters заполняется во время parse/preprocess и используется
 *  санитайзером для формирования warnings об отброшенных элементах. */
const ARRAY_SECTION_KEYS = [
  "completedSteps",
  "selectedMaps",
  "startPoints",
  "targetPoints",
  "fleetGroups",
  "noFlyZones",
  "calculatedRoutes",
  "altitudeProfiles",
] as const;
type ArraySectionKey = (typeof ARRAY_SECTION_KEYS)[number];

export interface WizardParseOptions {
  /** Опциональный выход: сколько битых элементов отброшено по каждой секции. */
  dropCounters?: DropCounters;
}

/** Тайловые стили: неизвестные значения нормализуются через normalizeTileServer
 *  (совпадение с типом стора TileServerId[]; дедупликация). */
function buildWizardPersistSchema(counters?: DropCounters) {
  return z.object({
    currentStep: z
      .preprocess(
        enumOrDefault("map-selection", WizardStepIdSchema.options),
        WizardStepIdSchema,
      )
      .default("map-selection"),
    completedSteps: z
      .preprocess(
        makeFilter(WizardStepIdSchema, "completedSteps", counters),
        z.array(WizardStepIdSchema),
      )
      .default([]),
    selectedMaps: z
      .preprocess(
        (v) => {
          const arr = Array.isArray(v)
            ? Array.from(new Set(v.map((x) => normalizeTileServer(x))))
            : [];
          if (counters && !Array.isArray(v) && v !== undefined && v !== null) {
            counters.selectedMaps = (counters.selectedMaps ?? 0) + 1;
          }
          return arr;
        },
        z.array(
          z.custom<TileServerId>((x) => typeof x === "string", "TileServerId"),
        ),
      )
      .default([]),
    primaryMap: z
      .preprocess(
        (v) => (v == null ? null : normalizeTileServer(v)),
        z
          .custom<TileServerId>((x) => typeof x === "string", "TileServerId")
          .nullable(),
      )
      .default(null),
    craftType: z
      .preprocess(
        (v) => (v === "drone" || v === "uav" ? v : null),
        z.enum(["drone", "uav"]).nullable(),
      )
      .default(null),
    startPoints: z
      .preprocess(
        makeFilter(GeoPointSchema, "startPoints", counters),
        z.array(GeoPointSchema),
      )
      .default([]),
    targetPoints: z
      .preprocess(
        makeFilter(GeoPointSchema, "targetPoints", counters),
        z.array(GeoPointSchema),
      )
      .default([]),
    fleetGroups: z
      .preprocess(
        makeFilter(FleetGroupSchema, "fleetGroups", counters),
        z.array(FleetGroupSchema),
      )
      .default([]),
    totalCraft: finiteNumber.int().nonnegative().default(0),
    noFlyZones: z
      .preprocess(
        makeFilter(NoFlyZoneSchema, "noFlyZones", counters),
        z.array(NoFlyZoneSchema),
      )
      .default([]),
    calculatedRoutes: z
      .preprocess(
        makeFilter(CalculatedRouteSchema, "calculatedRoutes", counters),
        z.array(CalculatedRouteSchema),
      )
      .default([]),
    altitudeProfiles: z
      .preprocess(
        makeFilter(AltitudeProfileSchema, "altitudeProfiles", counters),
        z.array(AltitudeProfileSchema),
      )
      .default([]),
    exportFormat: z
      .preprocess(
        (v) =>
          (ExportFormatSchema.options as readonly string[]).includes(
            v as string,
          )
            ? v
            : null,
        ExportFormatSchema.nullable(),
      )
      .default(null),
    deploymentLog: z.array(z.string()).default([]),
  });
}

/** Схема без счётчиков — публичный контракт (используется в persist/экспорте). */
export const WizardPersistSchema = buildWizardPersistSchema();

export type WizardPersistData = z.infer<typeof WizardPersistSchema>;

export interface WizardSanitizeResult {
  data: WizardPersistData;
  /** Что было починено/отброшено — публикуется как предупреждение (не throw). */
  warnings: string[];
}

/**
 * Строгая проверка входных данных (граница импорта файла / persist-гидрации).
 * В отличие от мягкого фильтра sanitize-схемы, здесь битые ЭЛЕМЕНТЫ массивов
 * (координаты вне [-90;90]/[-180;180], NaN, отсутствующие id) — ошибка, а не
 * молчаливое отбрасывание: импорт чужого/повреждённого файла должен быть
 * явен. Для автовосстановления повреждённого снапшота используйте
 * sanitizeWizardData (мягкий режим).
 */
export function validateWizardInput(
  raw: unknown,
  options?: WizardParseOptions,
): { success: boolean; data?: WizardPersistData; error?: z.ZodError } {
  const schema = buildWizardPersistSchema(options?.dropCounters);
  const r = schema.safeParse(raw);
  if (!r.success) return { success: false, error: r.error };
  // Строгий второй проход по СЫРЫМ элементам: preprocess уже отбросил мусор,
  // поэтому сравниваем количество принятых элементов с количеством входе.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const strictItemSchemas: Partial<Record<ArraySectionKey, z.ZodTypeAny>> = {
      completedSteps: WizardStepIdSchema,
      startPoints: GeoPointSchema,
      targetPoints: GeoPointSchema,
      fleetGroups: FleetGroupSchema,
      noFlyZones: NoFlyZoneSchema,
      calculatedRoutes: CalculatedRouteSchema,
      altitudeProfiles: AltitudeProfileSchema,
    };
    for (const [key, itemSchema] of Object.entries(strictItemSchemas)) {
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      let bad = 0;
      for (const el of arr) if (!itemSchema.safeParse(el).success) bad += 1;
      if (bad > 0) {
        const err = new z.ZodError([
          {
            code: "custom",
            message: `Секция «${key}» содержит ${bad} невалидных элемент(ов)`,
            path: [key],
          } as unknown as z.ZodIssue,
        ]);
        return { success: false, error: err };
      }
    }
  }
  return { success: true, data: r.data };
}

/** Ключи enum-секций, которые не должны молча подменяться дефолтом без warning. */
const ENUM_SECTION_KEYS = ["currentStep", "craftType", "exportFormat"] as const;

/**
 * Санитайзер внешних данных мастера (persist-migration / импорт mission-файла).
 * Никогда не бросает: структура не-объект → чистое состояние + warning;
 * битые элементы секций → отбрасываются + warning с количеством;
 * дефектная секция целиком → дефолт секции + warning (остальные данные сохраняются).
 */
export function sanitizeWizardData(raw: unknown): WizardSanitizeResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(
      "Сохранённые данные мастера повреждены — загружено пустое состояние.",
    );
    const empty = WizardPersistSchema.parse({});
    return { data: empty, warnings };
  }
  const obj = raw as Record<string, unknown>;
  // Известные секции данных (функции стора и посторонние поля вырезаются схемой)
  const knownKeys = [
    "currentStep",
    "completedSteps",
    "selectedMaps",
    "primaryMap",
    "craftType",
    "startPoints",
    "targetPoints",
    "fleetGroups",
    "totalCraft",
    "noFlyZones",
    "calculatedRoutes",
    "altitudeProfiles",
    "exportFormat",
    "deploymentLog",
  ] as const;
  const input: Record<string, unknown> = {};
  for (const k of knownKeys) if (obj[k] !== undefined) input[k] = obj[k];

  // 1) Мягкий parse со счётчиками отброшенных элементов.
  const counters: DropCounters = {};
  const schema = buildWizardPersistSchema(counters);
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    for (const [k, n] of Object.entries(counters)) {
      if (n && n > 0) {
        warnings.push(
          `Секция «${k}»: отброшено невалидных элемент(ов) — ${n}.`,
        );
      }
    }
    // 2) Enum-секции: preprocess молча подменяет мусор дефолтом — фиксируем.
    for (const k of ENUM_SECTION_KEYS) {
      const v = obj[k];
      if (v === undefined) continue;
      const finalVal = (parsed.data as Record<string, unknown>)[k];
      if (v !== finalVal) {
        warnings.push(
          `Поле «${k}» содержало неизвестное значение — сброшено к «${String(finalVal)}».`,
        );
      }
    }
    // 3) deploymentLog/selectedMaps: массивы строк без drop-счётчика — сверка длин.
    if (Array.isArray(obj.deploymentLog)) {
      const kept = parsed.data.deploymentLog.length;
      const total = obj.deploymentLog.length;
      if (kept < total) {
        warnings.push(
          `Секция «deploymentLog»: отброшено элемент(ов) — ${total - kept}.`,
        );
      }
    }
    return { data: parsed.data, warnings };
  }

  // Точечная починка по секциям: дефектная секция → дефолт, остальные сохраняются.
  const out: Record<string, unknown> = { ...input };
  for (const k of knownKeys) {
    const section = (schema.shape as Record<string, z.ZodTypeAny>)[k];
    if (!section) continue;
    const r = section.safeParse(out[k]);
    if (r.success) out[k] = r.data;
    else {
      warnings.push(
        `Секция «${k}» повреждена — сброшена к значению по умолчанию.`,
      );
      delete out[k];
    }
  }
  const fallback = schema.safeParse(out);
  if (fallback.success) return { data: fallback.data, warnings };
  warnings.push("Данные мастера не восстановимы — загружено пустое состояние.");
  return { data: WizardPersistSchema.parse({}), warnings };
}

/** Валидация payload миссии из файла .tqproj (kind='mission'). */
export function validateMissionPayload(payload: unknown): WizardSanitizeResult {
  return sanitizeWizardData(payload);
}
