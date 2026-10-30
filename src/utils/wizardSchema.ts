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
 *  невалидный вход целиком → []. Возвращает новый массив (без мутации входа). */
export function filterValidItems<T>(raw: unknown, item: z.ZodTypeAny): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const el of raw) {
    const r = item.safeParse(el);
    if (r.success) out.push(r.data as T);
  }
  return out;
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

/** Схема персистимых/файловых данных мастера (совпадает с partialize стора).
 *  enum-поля защищены z.preprocess: неизвестное значение → дефолт, а не ошибка. */
/** Санация enum-секций: `undefined` (или неизвестное значение) в zod v4 НЕ
 *  активирует `.default()` — default срабатывает только на отсутствующий ключ
 *  объекта. Поэтому preprocess обязан вернуть сам дефолт, а не undefined/null. */
const enumOrDefault =
  <T extends string>(def: T, options: readonly string[]) =>
  (v: unknown): string =>
    options.includes(v as string) ? (v as string) : def;

export const WizardPersistSchema = z.object({
  currentStep: z
    .preprocess(
      enumOrDefault("map-selection", WizardStepIdSchema.options),
      WizardStepIdSchema,
    )
    .default("map-selection"),
  completedSteps: z
    .preprocess(
      (v) => filterValidItems(v, WizardStepIdSchema),
      z.array(WizardStepIdSchema),
    )
    .default([]),
  /** Тайловые стили: неизвестные значения нормализуются через normalizeTileServer
   *  (совпадение с типом стора TileServerId[]; дедупликация). */
  selectedMaps: z
    .preprocess(
      (v) =>
        Array.isArray(v)
          ? Array.from(new Set(v.map((x) => normalizeTileServer(x))))
          : [],
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
      (v) => filterValidItems(v, GeoPointSchema),
      z.array(GeoPointSchema),
    )
    .default([]),
  targetPoints: z
    .preprocess(
      (v) => filterValidItems(v, GeoPointSchema),
      z.array(GeoPointSchema),
    )
    .default([]),
  fleetGroups: z
    .preprocess(
      (v) => filterValidItems(v, FleetGroupSchema),
      z.array(FleetGroupSchema),
    )
    .default([]),
  totalCraft: finiteNumber.int().nonnegative().default(0),
  noFlyZones: z
    .preprocess(
      (v) => filterValidItems(v, NoFlyZoneSchema),
      z.array(NoFlyZoneSchema),
    )
    .default([]),
  calculatedRoutes: z
    .preprocess(
      (v) => filterValidItems(v, CalculatedRouteSchema),
      z.array(CalculatedRouteSchema),
    )
    .default([]),
  altitudeProfiles: z
    .preprocess(
      (v) => filterValidItems(v, AltitudeProfileSchema),
      z.array(AltitudeProfileSchema),
    )
    .default([]),
  exportFormat: z
    .preprocess(
      (v) =>
        (ExportFormatSchema.options as readonly string[]).includes(v as string)
          ? v
          : null,
      ExportFormatSchema.nullable(),
    )
    .default(null),
  deploymentLog: z.array(z.string()).default([]),
});

export type WizardPersistData = z.infer<typeof WizardPersistSchema>;

export interface WizardSanitizeResult {
  data: WizardPersistData;
  /** Что было починено/отброшено — публикуется как предупреждение (не throw). */
  warnings: string[];
}

/**
 * Санитайзер внешних данных мастера (persist-migration / импорт mission-файла).
 * Никогда не бросает: структура не-объект → чистое состояние + warning;
 * отдельные дефектные секции → дефолт секции + warning (остальные данные сохраняются).
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

  const strict = WizardPersistSchema.safeParse(input);
  if (strict.success) return { data: strict.data, warnings };

  // Точечная починка по секциям: дефектная секция → дефолт, остальные сохраняются.
  const out: Record<string, unknown> = { ...input };
  for (const k of knownKeys) {
    const section = (WizardPersistSchema.shape as Record<string, z.ZodTypeAny>)[
      k
    ];
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
  const fallback = WizardPersistSchema.safeParse(out);
  if (fallback.success) return { data: fallback.data, warnings };
  warnings.push("Данные мастера не восстановимы — загружено пустое состояние.");
  return { data: WizardPersistSchema.parse({}), warnings };
}

/** Валидация payload миссии из файла .tqproj (kind='mission'). */
export function validateMissionPayload(payload: unknown): WizardSanitizeResult {
  return sanitizeWizardData(payload);
}
