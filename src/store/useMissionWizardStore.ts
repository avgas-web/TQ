// ═══════════════════════════════════════════════════════════════
// useMissionWizardStore — Zustand-стор пошагового мастера миссий.
// 9 этапов с жёсткой последовательностью: переход вперёд разрешён
// только при выполнении критериев завершения текущего этапа.
// Этап 1 — выбор карт для загрузки (ТЗ: первым этапом; 2ГИС удалён).
// Автосохранение через zustand persist (localStorage) после каждого
// изменения — перезагрузка страницы восстанавливает прогресс.
// ═══════════════════════════════════════════════════════════════
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { useMapStore } from "./useMapStore";
import { createValidatedJSONStorage } from "../utils/validatedStorage";
import {
  sanitizeWizardData,
  WizardPersistSchema,
  type WizardPersistData,
} from "../utils/wizardSchema";
import { eventBus } from "../utils/eventBus";
import type { TileServerId } from "../utils/openStreetMap";
import { planPathAroundZonesResult } from "../utils/routing";
// Ф4.4 (аудит): единая валидация перед развёртыванием/экспортом.
import {
  validateMissionForDeployment,
  deploymentBlockingMessage,
} from "../utils/deploymentValidation";
import type { Restriction } from "../types";

// ─── Типы домена мастера ────────────────────────────────────────
export type WizardStep =
  | "map-selection"
  | "craft-selection"
  | "start-points"
  | "target-points"
  | "fleet-formation"
  | "nfz-and-routes"
  | "altitude-profiles"
  | "export-preparation"
  | "mission-deployment";

export const WIZARD_STEPS: WizardStep[] = [
  "map-selection",
  "craft-selection",
  "start-points",
  "target-points",
  "fleet-formation",
  "nfz-and-routes",
  "altitude-profiles",
  "export-preparation",
  "mission-deployment",
];

export const STEP_LABELS_RU: Record<WizardStep, string> = {
  "map-selection": "Выбор карт",
  "craft-selection": "Выбор типа аппарата",
  "start-points": "Точки старта",
  "target-points": "Точки целей",
  "fleet-formation": "Группировка флота",
  "nfz-and-routes": "Бесполётные зоны и маршруты",
  "altitude-profiles": "Профили высот",
  "export-preparation": "Подготовка экспорта",
  "mission-deployment": "Передача заданий",
};

export interface GeoPointData {
  id: string;
  name: string;
  comment?: string;
  lat: number;
  lon: number;
  x: number; // пиксельные координаты карты (для рендера/дрэга)
  y: number;
}
export type StartPoint = GeoPointData;
export interface TargetPoint extends GeoPointData {
  /** предупреждение о близости к старту (<50 м) */
  nearStartWarning?: boolean;
}

export interface CraftAssignment {
  startPointId: string;
  craftCount: number;
}
export interface FleetGroup {
  id: string;
  targetPointId: string;
  totalCraft: number;
  assignments: CraftAssignment[];
}

export interface NoFlyZone {
  id: string;
  name: string;
  polygon: { x: number; y: number }[];
}
export interface CalculatedRoute {
  id: string;
  groupId: string;
  startPointId: string;
  targetPointId: string;
  points: { x: number; y: number }[];
  lengthMeters: number;
  crossesNfz: boolean;
  blockedByNfz: boolean; // маршрут вообще не удалось построить в обход
  exceedsRange: boolean; // длина > дальности аппарата
  acknowledged: boolean; // пользователь подтвердил игнорирование warning
}

export interface AltitudeChangePoint {
  id: string;
  routeId: string;
  /** позиция на маршруте, доля 0..1 от начала */
  positionRatio: number;
  altitudeAgl: number; // м AGL, > 0
  climbRate?: number; // м/с, опционально
  terrainM: number | null; // высота рельефа (null — API недоступно)
  belowTerrainWarning: boolean;
}
export interface AltitudeProfile {
  routeId: string;
  points: AltitudeChangePoint[];
}

export type ExportFormat = "mavlink" | "json" | "csv" | "gpx" | "kml";

export interface WizardValidationIssue {
  step: WizardStep;
  level: "error" | "warning";
  message: string;
}

const SAFETY_MARGIN_M = 50;
const MIN_POINT_DISTANCE_M = 10; // дубликаты точек старта/целей
const MIN_START_TARGET_DIST_M = 50; // цель слишком близко к старту
export const MAX_START_POINTS = 100;
export const MAX_TARGET_POINTS = 1000;

// ─── Проекция мини-карты мастера (equirectangular, W×H px = 360°×180°) ──
export const MAP_W_PX = 640;
export const MAP_H_PX = 480;
export const pxToLon = (x: number): number => -180 + (x / MAP_W_PX) * 360;
export const pyToLat = (y: number): number => 90 - (y / MAP_H_PX) * 180;
export const lonToPx = (lon: number): number => ((lon + 180) / 360) * MAP_W_PX;
export const latToPy = (lat: number): number => ((90 - lat) / 180) * MAP_H_PX;

/** Расстояние по большой окружности (формула гаверсинуса), метры.
 *  Единственный источник истины для всех лимитов мастер-мара (дубликаты,
 *  близость цели к старту, дальность). Пиксельные метрики мини-карты в
 *  расчёт расстояний НЕ входят (см. аудит Ф1.1: Math.min(geo, pxDist)
 *  недооценивал дистанции и пропускал дубликаты точек). */
export function geoDistanceM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Ключ persist-хранилища мастера (единственный — используется resetWizard и storage). */
export const WIZARD_PERSIST_KEY = "tq-mission-wizard";
/** Версия схемы персистимых данных мастера (ФАЗА 3.3). */
export const WIZARD_PERSIST_VERSION = 2;

/** Парсер поиска Этапов 2/3: «lat, lon» или текстовый запрос (геокодер подменяется в тестах). */
export function parseCoordinateQuery(
  q: string,
): { lat: number; lon: number } | null {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return isValidLatLon(lat, lon) ? { lat, lon } : null;
}

// ─── Контракт стора ─────────────────────────────────────────────
/** Доступные для выбора карты (стили подложки) — ТЗ: пользователь выбирает из
 *  всех вариантов, кроме 2ГИС; 2ГИС УДАЛЁН ПОЛНОСТЬЮ (пункт C аудита). */
export const MAP_CHOICES: ReadonlyArray<{
  id: TileServerId;
  label: string;
  desc: string;
}> = [
  {
    id: "esri",
    label: "Esri — улицы",
    desc: "Стабильная уличная подложка (стиль по умолчанию)",
  },
  {
    id: "esri-sat",
    label: "Esri — спутник",
    desc: "Спутниковые снимки высокого разрешения",
  },
  {
    id: "osmfr",
    label: "OSM France (стандарт)",
    desc: "Классическая схема OpenStreetMap (зеркало FR)",
  },
  {
    id: "hot",
    label: "OSM France (гуманитарный)",
    desc: "HOT-стиль: детали для ЧС и картографирования",
  },
  {
    id: "osmde",
    label: "OSM Germany",
    desc: "Зеркало немецкого сообщества OSM",
  },
  {
    id: "opentopomap",
    label: "OpenTopoMap",
    desc: "Топографический стиль с рельефом",
  },
  {
    id: "cyclosm",
    label: "CyclOSM",
    desc: "Велосипедные маршруты и инфраструктура",
  },
];

export interface MissionWizardState {
  currentStep: WizardStep;
  completedSteps: WizardStep[];

  /** Этап 1 (ТЗ): выбранные пользователем карты для загрузки (мультивыбор). */
  selectedMaps: TileServerId[];
  /** Основная карта — активный стиль подложки (должна быть в selectedMaps). */
  primaryMap: TileServerId | null;

  craftType: "drone" | "uav" | null;
  startPoints: StartPoint[];
  targetPoints: TargetPoint[];
  fleetGroups: FleetGroup[];
  totalCraft: number;
  noFlyZones: NoFlyZone[];
  calculatedRoutes: CalculatedRoute[];
  altitudeProfiles: AltitudeProfile[];
  exportFormat: ExportFormat | null;
  /** ошибки/предупреждения текущих проверок (inline-валидация в UI) */
  issues: WizardValidationIssue[];
  deploymentLog: string[];

  /** Переключить карту в списке выбранных (Этап 1, мультивыбор). */
  toggleMapChoice: (id: TileServerId) => void;
  /** Назначить основную (активную) карту; автоматически добавляет в selectedMaps. */
  setPrimaryMap: (id: TileServerId) => void;
  setCraftType: (type: "drone" | "uav") => void;
  addStartPoint: (point: Omit<StartPoint, "id">) => void;
  updateStartPoint: (id: string, patch: Partial<StartPoint>) => void;
  removeStartPoint: (id: string) => void;
  addTargetPoint: (point: Omit<TargetPoint, "id">) => void;
  updateTargetPoint: (id: string, patch: Partial<TargetPoint>) => void;
  removeTargetPoint: (id: string) => void;
  setTotalCraft: (n: number) => void;
  createFleetGroup: (group: Omit<FleetGroup, "id">) => void;
  updateFleetGroup: (id: string, patch: Partial<FleetGroup>) => void;
  removeFleetGroup: (id: string) => void;
  autoFormGroups: () => void;
  addNoFlyZone: (zone: Omit<NoFlyZone, "id">) => void;
  updateNoFlyZone: (id: string, patch: Partial<NoFlyZone>) => void;
  removeNoFlyZone: (id: string) => void;
  calculateRoutes: (maxRangeMeters?: number) => Promise<void>;
  acknowledgeRouteIssues: () => void;
  setAltitudeProfile: (profile: AltitudeProfile) => void;
  addAltitudePoint: (
    p: Omit<AltitudeChangePoint, "id" | "belowTerrainWarning">,
  ) => void;
  autoAdjustAltitudes: () => void;
  removeAltitudePoint: (routeId: string, pointId: string) => void;
  setExportFormat: (format: ExportFormat) => void;
  deployMission: () => Promise<void>;
  resetWizard: () => void;
  /** Полный сброс данных мастера при смене типа аппарата (с подтверждением в UI).
   *  newType — сразу фиксирует новый выбранный тип, чтобы не требовать повторного диалога. */
  resetCraftChoice: (newType?: "drone" | "uav") => void;

  validateCurrentStep: () => WizardValidationIssue[];
  runValidationAndPublish: () => WizardValidationIssue[];
  canProceedToNextStep: () => boolean;
  goToNextStep: () => void;
  goToPreviousStep: () => void;
  goToStep: (step: WizardStep) => void;
}

const initialData = {
  currentStep: "map-selection" as WizardStep,
  completedSteps: [] as WizardStep[],
  // Этап 1 (ТЗ): карты не выбраны — валидация этапа потребует хотя бы одну;
  // основная по умолчанию Esri Streets (стиль по умолчанию аудита).
  selectedMaps: [] as TileServerId[],
  primaryMap: "esri" as TileServerId | null,
  craftType: null as "drone" | "uav" | null,
  startPoints: [] as StartPoint[],
  targetPoints: [] as TargetPoint[],
  fleetGroups: [] as FleetGroup[],
  totalCraft: 0,
  noFlyZones: [] as NoFlyZone[],
  calculatedRoutes: [] as CalculatedRoute[],
  altitudeProfiles: [] as AltitudeProfile[],
  exportFormat: null as ExportFormat | null,
  issues: [] as WizardValidationIssue[],
  deploymentLog: [] as string[],
};

export const useMissionWizardStore = create<MissionWizardState>()(
  persist(
    (set, get) => {
      // ── helpers ────────────────────────────────────────────────
      const pushIssue = (issue: WizardValidationIssue) =>
        set((s) => ({
          issues: [
            ...s.issues.filter((i) => i.message !== issue.message),
            issue,
          ],
        }));

      /** Ф1.1 (аудит): расстояние — ТОЛЬКО гео по WGS-84 (гаверсинус).
       *  Прежний `Math.min(geo, pxDist)` недооценивал дистанцию при расхождении
       *  x/y с проекцией координат: два разных объекта могли «слипаться» до
       *  нулевой дистанции (ложные дубликаты), а реальные дубликаты — проходить
       *  лимиты 10/50 м. Пиксельная мини-карта — только средство визуализации. */
      const distBetween = (a: GeoPointData, b: GeoPointData): number =>
        geoDistanceM(a.lat, a.lon, b.lat, b.lon);

      /** Дубликат (<minM метров) — предупреждаем и НЕ добавляем точку. */
      const checkDuplicates = (
        p: GeoPointData,
        list: GeoPointData[],
        minM: number,
        msg: string,
      ): boolean => {
        // сравнение с уже сохранёнными точками; id ещё не назначен → исключаем по координатам
        if (
          list.some(
            (q) =>
              !(q.id === p.id && q.x === p.x && q.y === p.y) &&
              distBetween(p, q) < minM,
          )
        ) {
          pushIssue({
            step: get().currentStep,
            level: "warning",
            message: msg,
          });
          return true;
        }
        return false;
      };

      /** Близость цели к старту (<50 м) — только warning, точка добавляется. */
      const nearStartNotice = (
        p: GeoPointData,
        starts: GeoPointData[],
      ): boolean => {
        if (starts.some((sp) => distBetween(p, sp) < MIN_START_TARGET_DIST_M)) {
          pushIssue({
            step: "target-points",
            level: "warning",
            message: "Цель слишком близко к точке старта (минимум 50 метров).",
          });
          return true;
        }
        return false;
      };

      // ── Этап 1: выбор карт для загрузки (ТЗ) ───────────────────
      /** Синхронизация картографического стора с выбором мастера:
       *  активный стиль подложки = основная карта; все выбранные включены
       *  в список доступных. Без этого «выбор карты» был бы декорацией. */
      const syncMapStoreFromChoice = () => {
        const { selectedMaps, primaryMap } = get();
        const mapStore = useMapStore.getState();
        if (primaryMap && mapStore.openStreetMap?.tileServer !== primaryMap) {
          mapStore.setOSMTileServer(primaryMap);
        }
        if (selectedMaps.length > 0 && !mapStore.openStreetMap?.enabled) {
          mapStore.toggleOpenStreetMap(true);
        }
      };

      const toggleMapChoice = (id: TileServerId) => {
        set((s) => {
          const has = s.selectedMaps.includes(id);
          const nextSelected = has
            ? s.selectedMaps.filter((m) => m !== id)
            : [...s.selectedMaps, id];
          // снимаем основную карту, если её убрали из выбора (держим инвариант)
          const nextPrimary = !has
            ? id
            : s.primaryMap === id
              ? (nextSelected[0] ?? null)
              : s.primaryMap;
          return { selectedMaps: nextSelected, primaryMap: nextPrimary };
        });
        syncMapStoreFromChoice();
      };

      const setPrimaryMap = (id: TileServerId) => {
        set((s) => ({
          primaryMap: id,
          selectedMaps: s.selectedMaps.includes(id)
            ? s.selectedMaps
            : [...s.selectedMaps, id],
        }));
        syncMapStoreFromChoice();
      };

      // ── Этап 2 ─────────────────────────────────────────────────
      const setCraftType = (type: "drone" | "uav") => {
        set({ craftType: type });
      };
      const resetCraftChoice = (newType?: "drone" | "uav") => {
        // полный сброс мастер-данных при смене типа (edge-case из ТЗ);
        // остаёмся на этапе выбора типа; если пользователь уже подтвердил
        // новый тип — фиксируем его сразу, чтобы не терять двойной диалог.
        // Карты Этапа 1 НЕ сбрасываются: выбор подложек — свойство проекта,
        // а не аппарата (иначе после смены типа возвращались бы к этапу 1).
        set({
          ...initialData,
          currentStep: "craft-selection",
          craftType: newType ?? null,
          selectedMaps: get().selectedMaps,
          primaryMap: get().primaryMap,
        });
      };

      // ── Этапы 2/3: точки ───────────────────────────────────────
      const addStartPoint = (point: Omit<StartPoint, "id">) => {
        const s = get();
        if (!isValidLatLon(point.lat, point.lon)) {
          pushIssue({
            step: "start-points",
            level: "error",
            message:
              "Невалидные координаты. Пример правильного формата: «55.7558, 37.6173» (lat ∈ [-90; 90], lon ∈ [-180; 180]).",
          });
          return;
        }
        if (!point.name.trim()) {
          pushIssue({
            step: "start-points",
            level: "error",
            message: "Название точки не может быть пустым.",
          });
          return;
        }
        if (s.startPoints.length >= MAX_START_POINTS) {
          pushIssue({
            step: "start-points",
            level: "error",
            message: `Достигнут лимит ${MAX_START_POINTS} точек старта.`,
          });
          return;
        }
        const full: StartPoint = { ...point, id: uuidv4() };
        if (
          checkDuplicates(
            full,
            s.startPoints,
            MIN_POINT_DISTANCE_M,
            "Точки слишком близко друг к другу (минимум 10 метров).",
          )
        )
          return;
        set({ startPoints: [...s.startPoints, full] });
      };

      const updateStartPoint = (id: string, patch: Partial<StartPoint>) => {
        set((s) => ({
          startPoints: s.startPoints.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }));
        // ВАЖНО: никаких изменений viewState — автофиксации карты нет.
      };
      const removeStartPoint = (id: string) =>
        set((s) => ({
          startPoints: s.startPoints.filter((p) => p.id !== id),
          fleetGroups: s.fleetGroups.map((g) => ({
            ...g,
            assignments: g.assignments.filter((a) => a.startPointId !== id),
          })),
        }));

      const addTargetPoint = (point: Omit<TargetPoint, "id">) => {
        const s = get();
        if (!isValidLatLon(point.lat, point.lon)) {
          pushIssue({
            step: "target-points",
            level: "error",
            message: "Невалидные координаты цели. Формат: «55.7558, 37.6173».",
          });
          return;
        }
        if (!point.name.trim()) {
          pushIssue({
            step: "target-points",
            level: "error",
            message: "Название цели не может быть пустым.",
          });
          return;
        }
        if (s.targetPoints.length >= MAX_TARGET_POINTS) {
          pushIssue({
            step: "target-points",
            level: "error",
            message: `Достигнут лимит ${MAX_TARGET_POINTS} точек целей.`,
          });
          return;
        }
        const full: TargetPoint = { ...point, id: uuidv4() };
        if (
          checkDuplicates(
            full,
            s.targetPoints,
            MIN_POINT_DISTANCE_M,
            "Цели слишком близко друг к другу (минимум 10 метров).",
          )
        )
          return;
        full.nearStartWarning = nearStartNotice(full, s.startPoints);
        set({ targetPoints: [...s.targetPoints, full] });
      };
      const updateTargetPoint = (id: string, patch: Partial<TargetPoint>) =>
        set((s) => ({
          targetPoints: s.targetPoints.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }));
      const removeTargetPoint = (id: string) =>
        set((s) => ({
          targetPoints: s.targetPoints.filter((p) => p.id !== id),
          fleetGroups: s.fleetGroups.filter((g) => g.targetPointId !== id),
        }));

      // ── Этап 4: группы флота ───────────────────────────────────
      const setTotalCraft = (n: number) =>
        set({ totalCraft: Math.max(0, Math.floor(n) || 0) });

      const groupSum = (g: { assignments: CraftAssignment[] }) =>
        g.assignments.reduce((acc, a) => acc + a.craftCount, 0);

      const createFleetGroup = (group: Omit<FleetGroup, "id">) => {
        const s = get();
        if (!s.targetPoints.some((t) => t.id === group.targetPointId)) {
          pushIssue({
            step: "fleet-formation",
            level: "error",
            message: "Группа должна быть назначена на существующую цель.",
          });
          return;
        }
        if (group.totalCraft <= 0) {
          pushIssue({
            step: "fleet-formation",
            level: "error",
            message: "В группе должно быть хотя бы 1 аппарат.",
          });
          return;
        }
        if (groupSum(group) !== group.totalCraft) {
          pushIssue({
            step: "fleet-formation",
            level: "error",
            message: `Распределение по стартам (${groupSum(group)}) не совпадает с размером группы (${group.totalCraft}).`,
          });
          return;
        }
        set({ fleetGroups: [...s.fleetGroups, { ...group, id: uuidv4() }] });
      };

      const updateFleetGroup = (id: string, patch: Partial<FleetGroup>) =>
        set((s) => ({
          fleetGroups: s.fleetGroups.map((g) =>
            g.id === id ? { ...g, ...patch } : g,
          ),
        }));
      const removeFleetGroup = (id: string) =>
        set((s) => ({ fleetGroups: s.fleetGroups.filter((g) => g.id !== id) }));

      /** Режим 1: автоматическое формирование — пропорциональное распределение
       *  аппаратов по целям (round-robin остатков), старт каждой группы — ближайшая точка старта. */
      const autoFormGroups = () => {
        const s = get();
        if (
          s.totalCraft <= 0 ||
          s.targetPoints.length === 0 ||
          s.startPoints.length === 0
        ) {
          pushIssue({
            step: "fleet-formation",
            level: "error",
            message:
              "Для автоформирования нужны: общее число аппаратов > 0, хотя бы одна цель и один старт.",
          });
          return;
        }
        const n = s.targetPoints.length;
        const base = Math.floor(s.totalCraft / n);
        let rem = s.totalCraft % n;
        const groups: FleetGroup[] = s.targetPoints.map((t) => {
          const cnt = base + (rem > 0 ? (rem--, 1) : 0);
          const nearest = [...s.startPoints].sort(
            (a, b) => distBetween(a, t) - distBetween(b, t),
          )[0];
          return {
            id: uuidv4(),
            targetPointId: t.id,
            totalCraft: cnt,
            assignments: [{ startPointId: nearest.id, craftCount: cnt }],
          };
        });
        set({ fleetGroups: groups });
      };

      // ── Этап 5: NFZ + маршруты ─────────────────────────────────
      const addNoFlyZone = (zone: Omit<NoFlyZone, "id">) => {
        if (zone.polygon.length < 3) {
          pushIssue({
            step: "nfz-and-routes",
            level: "error",
            message:
              "Полигон бесполётной зоны должен содержать минимум 3 вершины.",
          });
          return;
        }
        set((s) => ({
          noFlyZones: [...s.noFlyZones, { ...zone, id: uuidv4() }],
        }));
        // обязательный автоматический пересчёт маршрутов в обход новой зоны
        void get().calculateRoutes();
      };
      const updateNoFlyZone = (id: string, patch: Partial<NoFlyZone>) => {
        set((s) => ({
          noFlyZones: s.noFlyZones.map((z) =>
            z.id === id ? { ...z, ...patch } : z,
          ),
        }));
        void get().calculateRoutes();
      };
      const removeNoFlyZone = (id: string) => {
        set((s) => ({ noFlyZones: s.noFlyZones.filter((z) => z.id !== id) }));
        void get().calculateRoutes();
      };

      // ray-casting in-polygon test (метрический пиксельный контур полигона)
      const pointInPolygon = (
        px: number,
        py: number,
        poly: { x: number; y: number }[],
      ): boolean => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x,
            yi = poly[i].y,
            xj = poly[j].x,
            yj = poly[j].y;
          const intersect =
            yi > py !== yj > py &&
            px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
          if (intersect) inside = !inside;
        }
        return inside;
      };
      // Мёртвый код удалён (аудит Ф1.3): segIntersectsPolyEdge использовался только
      // локальным detourAround, заменённым на planPathAroundZonesResult из utils/routing.

      const pixelLen = (pts: { x: number; y: number }[]) => {
        let l = 0;
        for (let i = 1; i < pts.length; i++)
          l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return l;
      };

      /** Длина маршрута в метрах. Если endpoints имеют «живые» гео-координаты
       *  (реальная миссия) — гео-расстояние между ними, умноженное на фактор
       *  удлинения обходного пути (длина полилинии / прямая). Если endpoints
       *  заданы демо-числами вне проекции карты (тесты/демо) — длина считается
       *  по сегментам полилинии через equirectangular-проекцию карты мастера. */
      const routeLengthM = (
        sp: GeoPointData,
        tp: GeoPointData,
        pts: { x: number; y: number }[],
      ): number => {
        const pxDirect = Math.hypot(tp.x - sp.x, tp.y - sp.y);
        const geo = geoDistanceM(sp.lat, sp.lon, tp.lat, tp.lon);
        // endpoints согласованы с проекцией карты? (клик по карте / поиск координат)
        const consistentWithProjection =
          Math.abs(lonToPx(sp.lon) - sp.x) <= 2 &&
          Math.abs(latToPy(sp.lat) - sp.y) <= 2 &&
          Math.abs(lonToPx(tp.lon) - tp.x) <= 2 &&
          Math.abs(latToPy(tp.lat) - tp.y) <= 2;
        if (consistentWithProjection && pxDirect > 0) {
          const factor = pixelLen(pts) / pxDirect;
          return Number.isFinite(factor) ? geo * Math.max(1, factor) : geo;
        }
        // fallback: длина по сегментам пиксельной полилинии в гео-метриках карты
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
          total += geoDistanceM(
            pyToLat(pts[i - 1].y),
            pxToLon(pts[i - 1].x),
            pyToLat(pts[i].y),
            pxToLon(pts[i].x),
          );
        }
        return total;
      };

      const calculateRoutes = async (maxRangeMeters = Infinity) => {
        const s = get();
        // маршруты строим для групп (если сформированы), иначе напрямую старт→цель
        type Leg = {
          groupId: string;
          startPointId: string;
          targetPointId: string;
        };
        const legs: Leg[] =
          s.fleetGroups.length > 0
            ? s.fleetGroups.flatMap((g) =>
                g.assignments.map((a) => ({
                  groupId: g.id,
                  startPointId: a.startPointId,
                  targetPointId: g.targetPointId,
                })),
              )
            : s.targetPoints.map((t) => ({
                groupId: "",
                startPointId: s.startPoints[0]?.id ?? "",
                targetPointId: t.id,
              }));

        const routes: CalculatedRoute[] = [];
        // ЦИКЛ-ГАРД (шаг П3 ТЗ): жёсткий лимит числа обрабатываемых рёбер.
        // Даже при вырожденных данных (тысячи групп × назначений) расчёт
        // завершается за конечное число итераций с warning'ом, а не вешает поток.
        const MAX_ROUTE_LEGS = 10_000;
        if (legs.length > MAX_ROUTE_LEGS) {
          pushIssue({
            step: "nfz-and-routes",
            level: "warning",
            message: `Слишком много сегментов маршрутов (${legs.length}). Рассчитаны первые ${MAX_ROUTE_LEGS}.`,
          });
        }
        for (const leg of legs.slice(0, MAX_ROUTE_LEGS)) {
          const sp = s.startPoints.find((p) => p.id === leg.startPointId);
          const tp = s.targetPoints.find((p) => p.id === leg.targetPointId);
          if (!sp || !tp) continue;
          // hard-check: точка старта или цели внутри NFZ — обход невозможен в принципе
          const insideZone = s.noFlyZones.some(
            (z) =>
              pointInPolygon(sp.x, sp.y, z.polygon) ||
              pointInPolygon(tp.x, tp.y, z.polygon),
          );
          if (insideZone) {
            routes.push({
              id: uuidv4(),
              groupId: leg.groupId,
              startPointId: sp.id,
              targetPointId: tp.id,
              points: [
                { x: sp.x, y: sp.y },
                { x: tp.x, y: tp.y },
              ],
              lengthMeters: geoDistanceM(sp.lat, sp.lon, tp.lat, tp.lon),
              crossesNfz: true,
              blockedByNfz: true,
              exceedsRange: false,
              acknowledged: false,
            });
            continue;
          }
          // Ф1.3 (аудит): единый планнер обхода NFZ из utils/routing с точной
          // геометрией (segment×зона, без сэмплинга) и ЯВНЫМ контрактом blocked.
          // Локальный «дедовский» detourAround удалён: он перебирал лишь 12
          // кандидатов и при неудаче молча возвращал null → вызывающий код
          // рисовал прямую сквозь зону как «валидный» маршрут.
          const restrictions: Restriction[] = s.noFlyZones.map((z) => ({
            id: z.id,
            type: "polygon",
            points: z.polygon,
            color: "#ef4444",
            name: z.name,
            active: true,
          }));
          const planned = planPathAroundZonesResult(
            { x: sp.x, y: sp.y },
            { x: tp.x, y: tp.y },
            restrictions,
            MAP_W_PX,
            MAP_H_PX,
          );
          if (planned.blocked) {
            routes.push({
              id: uuidv4(),
              groupId: leg.groupId,
              startPointId: sp.id,
              targetPointId: tp.id,
              points: planned.points, // только визуальная подсказка — экспорт заблокирован валидацией
              lengthMeters: geoDistanceM(sp.lat, sp.lon, tp.lat, tp.lon),
              crossesNfz: true,
              blockedByNfz: true,
              exceedsRange: false,
              acknowledged: false,
            });
            continue;
          }
          const detour = planned.points;
          const lengthMeters = routeLengthM(sp, tp, detour);
          routes.push({
            id: uuidv4(),
            groupId: leg.groupId,
            startPointId: sp.id,
            targetPointId: tp.id,
            points: detour,
            lengthMeters,
            crossesNfz: false,
            blockedByNfz: false,
            exceedsRange: lengthMeters > maxRangeMeters,
            acknowledged: false,
          });
        }
        set({ calculatedRoutes: routes });
        // мгновенная публикация актуальных ошибок этапа в `issues`:
        // UI и тесты видят валидационные сообщения сразу после расчёта,
        // не дожидаясь асинхронного re-render подписчиков
        get().runValidationAndPublish();
      };

      const acknowledgeRouteIssues = () => {
        set((s) => ({
          calculatedRoutes: s.calculatedRoutes.map((r) =>
            r.exceedsRange && !r.blockedByNfz
              ? { ...r, acknowledged: true }
              : r,
          ),
        }));
        get().runValidationAndPublish();
      };

      // ── Этап 6: профили высот (опциональный) ──────────────────
      const setAltitudeProfile = (profile: AltitudeProfile) =>
        set((s) => ({
          altitudeProfiles: [
            ...s.altitudeProfiles.filter((p) => p.routeId !== profile.routeId),
            profile,
          ],
        }));

      const addAltitudePoint = (
        p: Omit<AltitudeChangePoint, "id" | "belowTerrainWarning">,
      ) => {
        if (!Number.isFinite(p.altitudeAgl) || p.altitudeAgl <= 0) {
          pushIssue({
            step: "altitude-profiles",
            level: "error",
            message: "Высота должна быть больше 0 м.",
          });
          return;
        }
        if (p.positionRatio < 0 || p.positionRatio > 1) {
          pushIssue({
            step: "altitude-profiles",
            level: "error",
            message: "Позиция на маршруте должна быть в диапазоне 0–100%.",
          });
          return;
        }
        // Ф1.2 (аудит): AGL — высота НАД землёй, поэтому сравнивается с рельефом
        // ТОЛЬКО как запас clearance: `altitudeAgl < SAFETY_MARGIN_M` означает
        // «дрон ниже безопасного зазора над поверхностью». Прежняя проверка
        // `altitudeAgl < terrainM + margin` смешивала AGL и абсолютные высоты
        // (MSL): на рельефе 300 м валидные 100 м AGL ложно помечались опасными,
        // а на равнине наоборот — пропускали реальные нарушения.
        const below = p.terrainM !== null && p.altitudeAgl < SAFETY_MARGIN_M;
        if (below) {
          pushIssue({
            step: "altitude-profiles",
            level: "warning",
            message: `Высота AGL ${p.altitudeAgl} м меньше безопасного запаса ${SAFETY_MARGIN_M} м над рельефом. Увеличьте высоту.`,
          });
        }
        set((s) => {
          const profiles = [...s.altitudeProfiles];
          const idx = profiles.findIndex((pr) => pr.routeId === p.routeId);
          const np: AltitudeChangePoint = {
            ...p,
            id: uuidv4(),
            belowTerrainWarning: below,
          };
          if (idx >= 0) {
            const pts = [...profiles[idx].points, np].sort(
              (a, b) => a.positionRatio - b.positionRatio,
            );
            profiles[idx] = { routeId: profiles[idx].routeId, points: pts };
          } else {
            profiles.push({ routeId: p.routeId, points: [np] });
          }
          return { altitudeProfiles: profiles };
        });
      };

      const removeAltitudePoint = (routeId: string, pointId: string) =>
        set((s) => ({
          altitudeProfiles: s.altitudeProfiles
            .map((pr) =>
              pr.routeId === routeId
                ? { ...pr, points: pr.points.filter((p) => p.id !== pointId) }
                : pr,
            )
            .filter((pr) => pr.points.length > 0),
        }));

      // Ф1.2 (аудит): автокоррекция НЕ должна прибавлять высоту рельефа к AGL.
      // было: altitudeAgl = terrainM + margin  →  на рельефе 300 м точка становилась
      // «650 м AGL», т.е. ~950 м над уровнем моря — гарантированная потеря дрона
      // по лимиту высоты / энергетике. стало: поднимаем AGL ровно до безопасного
      // зазора над поверхностью (margin), абсолютная высота = terrainM + margin.
      const autoAdjustAltitudes = () =>
        set((s) => ({
          altitudeProfiles: s.altitudeProfiles.map((pr) => ({
            ...pr,
            points: pr.points.map((p) => {
              if (p.terrainM === null) return p;
              return p.altitudeAgl < SAFETY_MARGIN_M
                ? {
                    ...p,
                    altitudeAgl: SAFETY_MARGIN_M,
                    belowTerrainWarning: false,
                  }
                : { ...p, belowTerrainWarning: false };
            }),
          })),
        }));

      // ── Этапы 7/8: экспорт и развёртывание ─────────────────────
      const setExportFormat = (format: ExportFormat) =>
        set({ exportFormat: format });

      const deployMission = async () => {
        const s = get();
        const log: string[] = [...s.deploymentLog];
        log.push(`Генерация файла формата ${s.exportFormat ?? "—"}…`);
        try {
          if (!s.exportFormat) throw new Error("Формат экспорта не выбран.");
          // Ф4.4 (аудит): единый источник истины для блокировок экспорта —
          // validateMissionForDeployment (см. utils/deploymentValidation).
          // Покрывает: отсутствие маршрутов, NFZ-блокировку (Ф1.3) и
          // неподтверждённое превышение дальности. UI-чек-лист использует ту же
          // функцию, поэтому «зелёный чек-лист» ⇔ «экспорт пройдёт».
          const validation = validateMissionForDeployment(s.calculatedRoutes);
          if (!validation.ok) {
            throw new Error(deploymentBlockingMessage(validation));
          }
          log.push(`✓ Сгенерировано маршрутов: ${s.calculatedRoutes.length}`);
          log.push("✓ Файл готов к скачиванию.");
          set({ deploymentLog: log });
        } catch (e) {
          log.push(
            `✗ Ошибка генерации: ${e instanceof Error ? e.message : String(e)}`,
          );
          set({ deploymentLog: log });
          throw e;
        }
      };

      // ВАЖНО (регрессия «мастер не загружает карту» / тесты стартовали не с
      // Этапа 1): resetWizard обязан очищать и persist-хранилище. Иначе после
      // set({...initialData}) zustand persist СРАЗУ сериализует initialData в
      // localStorage; затем следующий mount гидратирует этот снапшот — shallow
      // merge поверх дефолтов — и любое расхождение (старые ключи, порядок
      // hydration) уводит мастер не на 'map-selection'. Плюс очистка хранилища
      // даёт детерминированный чистый старт и в UI («Начать заново»), и в
      // тестах (beforeEach → resetWizard + localStorage.clear()).
      const resetWizard = () => {
        set({ ...initialData });
        // Ф3.1: persist-очистка — только собственный ключ мастера, через
        // safeRemoveItem (удаляет и spill-запись IndexedDB). Прежний прямой
        // localStorage.removeItem не чистил spill → после reset в стор могла
        // гидратироваться «мусорная» тяжёлая запись.
        void safeRemovePersistSnapshot();
      };

      /** Асинхронное удаление собственного persist-снапшота (+spill).
       *  Ошибки хранилища не роняют reset — они уходят в eventBus внутри storage. */
      const safeRemovePersistSnapshot = () => {
        try {
          const raw = useMissionWizardStore.persist;
          void Promise.resolve(raw.clearStorage()).catch(() => {
            try {
              localStorage.removeItem(WIZARD_PERSIST_KEY);
            } catch {
              /* noop */
            }
          });
        } catch {
          /* persist без getStorage (тестовые окружения) — noop */
        }
      };

      /** Валидация этапа. При вызове с `publish: true` результаты также
       *  публикуются в `issues` (для отображения в UI). По умолчанию — чистый
       *  read-only режим: подписчики (useEffect в UI) не должны провоцировать
       *  повторные рендеры через persist-set, а тесты/навигация не зависят от
       *  того, «успел ли UI опубликовать» ошибки. */
      const validateCurrentStep = (
        publish = false,
      ): WizardValidationIssue[] => {
        const s = get();
        const errs: WizardValidationIssue[] = [];
        const step = s.currentStep;
        switch (step) {
          case "map-selection":
            // ТЗ: первым этапом — выбор карт для загрузки. Без выбора дальше
            // идти нельзя (иначе мастер «молча» грузит подложку по умолчанию).
            if (s.selectedMaps.length === 0)
              errs.push({
                step,
                level: "error",
                message: "Выберите хотя бы одну карту для загрузки.",
              });
            else if (!s.primaryMap || !s.selectedMaps.includes(s.primaryMap))
              errs.push({
                step,
                level: "error",
                message: "Назначьте основную карту из выбранных.",
              });
            break;
          case "craft-selection":
            if (!s.craftType)
              errs.push({
                step,
                level: "error",
                message: "Выберите тип аппарата.",
              });
            break;
          case "start-points":
            if (s.startPoints.length === 0)
              errs.push({
                step,
                level: "error",
                message: "Добавьте хотя бы одну точку старта.",
              });
            break;
          case "target-points":
            if (s.targetPoints.length === 0)
              errs.push({
                step,
                level: "error",
                message: "Добавьте хотя бы одну точку цели.",
              });
            break;
          case "fleet-formation": {
            if (s.totalCraft <= 0)
              errs.push({
                step,
                level: "error",
                message: "Укажите общее количество аппаратов (> 0).",
              });
            const covered = new Set(s.fleetGroups.map((g) => g.targetPointId));
            for (const t of s.targetPoints) {
              if (!covered.has(t.id))
                errs.push({
                  step,
                  level: "warning",
                  message: `Цель «${t.name}» без назначенных аппаратов.`,
                });
            }
            const sum = s.fleetGroups.reduce((acc, g) => acc + g.totalCraft, 0);
            if (sum !== s.totalCraft)
              errs.push({
                step,
                level: "error",
                message: `Сумма аппаратов в группах (${sum}) ≠ общее количество (${s.totalCraft}). Расхождение: ${s.totalCraft - sum}.`,
              });
            for (const g of s.fleetGroups) {
              if (groupSum(g) !== g.totalCraft)
                errs.push({
                  step,
                  level: "error",
                  message: `В группе ${g.id}: сумма по стартам (${groupSum(g)}) ≠ размеру группы (${g.totalCraft}).`,
                });
            }
            break;
          }
          case "nfz-and-routes": {
            if (s.calculatedRoutes.length === 0)
              errs.push({
                step,
                level: "error",
                message:
                  "Маршруты не рассчитаны — нажмите «Рассчитать маршруты».",
              });
            const blocked = s.calculatedRoutes.filter((r) => r.blockedByNfz);
            if (blocked.length > 0)
              errs.push({
                step,
                level: "error",
                message: `Невозможно построить маршрут в обход зоны (${blocked.length} шт.). Удалите или переместите зону.`,
              });
            const unack = s.calculatedRoutes.filter(
              (r) => r.exceedsRange && !r.acknowledged,
            );
            // превышение дальности дрона — КРИТИЧЕСКАЯ ошибка безопасности полёта
            // (для БПЛА с запасом дальности это остаётся предупреждением ниже)
            if (unack.length > 0 && s.craftType === "drone") {
              errs.push({
                step,
                level: "error",
                message: `${unack.length} маршрут(ов) превышают дальность аппарата — подтвердите игнорирование или измените план.`,
              });
            } else if (unack.length > 0) {
              errs.push({
                step,
                level: "warning",
                message: `${unack.length} маршрут(ов) превышают дальность аппарата. Подтвердите игнорирование или измените план.`,
              });
            }
            break;
          }
          case "altitude-profiles":
            // этап опциональный: ошибок нет всегда
            break;
          case "export-preparation": {
            if (!s.exportFormat)
              errs.push({
                step,
                level: "error",
                message: "Выберите формат экспорта.",
              });
            const critical = s.calculatedRoutes.filter(
              (r) => r.blockedByNfz || (r.exceedsRange && !r.acknowledged),
            );
            if (critical.length > 0)
              errs.push({
                step,
                level: "error",
                message:
                  "Есть критические проблемы маршрутов — вернитесь на этап 5.",
              });
            break;
          }
          case "mission-deployment":
            break;
        }
        if (publish) {
          const prev = get().issues;
          // set только при реальном изменении — защита от бесконечных циклов рендера
          if (
            prev.length !== errs.length ||
            prev.some(
              (p, i) =>
                p.message !== errs[i]?.message || p.level !== errs[i]?.level,
            )
          ) {
            set({ issues: errs });
          }
        }
        return errs;
      };

      /** Валидация с публикацией результатов в `issues` (для отображения в UI). */
      const runValidationAndPublish = (): WizardValidationIssue[] =>
        validateCurrentStep(true);

      const canProceedToNextStep = (): boolean =>
        validateCurrentStep().every((i) => i.level !== "error");

      const goToNextStep = () => {
        const s = get();
        if (!canProceedToNextStep()) return;
        const idx = WIZARD_STEPS.indexOf(s.currentStep);
        if (idx < 0 || idx >= WIZARD_STEPS.length - 1) return;
        const next = WIZARD_STEPS[idx + 1];
        set({
          currentStep: next,
          completedSteps: s.completedSteps.includes(s.currentStep)
            ? s.completedSteps
            : [...s.completedSteps, s.currentStep],
        });
      };

      const goToPreviousStep = () => {
        const s = get();
        const idx = WIZARD_STEPS.indexOf(s.currentStep);
        if (idx <= 0) return;
        set({ currentStep: WIZARD_STEPS[idx - 1] });
      };

      const goToStep = (step: WizardStep) => {
        const s = get();
        // переход назад — свободный; вперёд — только на завершённый или сразу следующий после последнего завершённого
        const targetIdx = WIZARD_STEPS.indexOf(step);
        const doneIdx = Math.max(
          ...s.completedSteps.map((c) => WIZARD_STEPS.indexOf(c)),
          -1,
        );
        if (targetIdx <= doneIdx + 1) set({ currentStep: step });
        else
          pushIssue({
            step: s.currentStep,
            level: "error",
            message: "Этот этап ещё недоступен — сначала завершите предыдущие.",
          });
      };

      return {
        ...initialData,
        toggleMapChoice,
        setPrimaryMap,
        setCraftType,
        resetCraftChoice,
        addStartPoint,
        updateStartPoint,
        removeStartPoint,
        addTargetPoint,
        updateTargetPoint,
        removeTargetPoint,
        setTotalCraft,
        createFleetGroup,
        updateFleetGroup,
        removeFleetGroup,
        autoFormGroups,
        addNoFlyZone,
        updateNoFlyZone,
        removeNoFlyZone,
        calculateRoutes,
        acknowledgeRouteIssues,
        setAltitudeProfile,
        addAltitudePoint,
        autoAdjustAltitudes,
        removeAltitudePoint,
        setExportFormat,
        deployMission,
        resetWizard,
        validateCurrentStep,
        runValidationAndPublish,
        canProceedToNextStep,
        goToNextStep,
        goToPreviousStep,
        goToStep,
      };
    },
    {
      name: WIZARD_PERSIST_KEY,
      // ФАЗА 3.3 (аудит): граница приложения — любой снапшот из localStorage/
      // IndexedDB проходит Zod-схему ДО попадания в стор; запись идёт через
      // safeSetItem (quota → spill в IndexedDB, ошибки → eventBus 'storage:error').
      storage: createValidatedJSONStorage<WizardPersistData>(
        WIZARD_PERSIST_KEY,
        WizardPersistSchema,
      ),
      // Версия схемы персистимых данных. bump при изменении формы; migrate
      // вызывается zustand перед гидратацией старых снапшотов.
      version: WIZARD_PERSIST_VERSION,
      migrate: (persistedState, version) => {
        const { data, warnings } = sanitizeWizardData(persistedState);
        if (version < WIZARD_PERSIST_VERSION) {
          warnings.push(
            `Миграция сохранений v${version} → v${WIZARD_PERSIST_VERSION} выполнена.`,
          );
        }
        if (warnings.length > 0) {
          eventBus.emit("storage:error", {
            message: `Мастер миссий: ${warnings.join(" ")} Часть данных восстановлена автоматически.`,
          });
        }
        return data;
      },
      // Миграция старых сохранений (до Этапа 1 «Выбор карт»): zustand persist
      // делает shallow-merge persisted-объекта поверх дефолтов состояния,
      // поэтому достаточно включить новые поля в partialize — у старых снапшотов
      // их просто нет и останутся дефолты (primaryMap='esri', selectedMaps=[]).
      // Тип — WizardPersistData (z.infer схемы): partialize описывает ТОЛЬКО
      // персистимые данные, методы стора сюда не попадают.
      partialize: (s): WizardPersistData => ({
        currentStep: s.currentStep,
        completedSteps: s.completedSteps,
        selectedMaps: s.selectedMaps,
        primaryMap: s.primaryMap,
        craftType: s.craftType,
        startPoints: s.startPoints,
        targetPoints: s.targetPoints,
        fleetGroups: s.fleetGroups,
        totalCraft: s.totalCraft,
        noFlyZones: s.noFlyZones,
        calculatedRoutes: s.calculatedRoutes,
        altitudeProfiles: s.altitudeProfiles,
        exportFormat: s.exportFormat,
        deploymentLog: s.deploymentLog,
      }),
    },
  ),
);
