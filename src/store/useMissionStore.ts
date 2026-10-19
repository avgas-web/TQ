// ═══════════════════════════════════════════════════════════════
// useMissionStore — доменный стор миссий (Domain-Driven Split #2)
// Маршруты/waypoints, черновик мастера, предупреждения, оптимизация,
// «змейка», обход ограничений (A*/видимый граф), высоты по рельефу
// (Open-Elevation). Данные карты читаются ЧЕРЕЗ useMapStore.getState()
// (направление зависимостей: mission → map; обратного импорта нет —
// map вызывает mission только динамическим import() в async-экшенах).
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type {
  Route, RoutePoint, Point, RouteShape, RangeLimitMode, ImportPoint, ImportLists,
  WaypointParamsLite, MissionMetaLite, WaypointBinding, Restriction,
} from '../types';
import { MAX_ROUTES } from '../types';
import {
  sanitizeWaypointParams,
  createMissionMeta,
  optimizeRoute,
  generateScanLawnmower,
  ValidationError,
  type WaypointParams,
  type OptimizeAlgorithm,
} from '../utils/mission';
import {
  planPathAroundZones, zonesCrossedBy, recomputeRoutePixels, pixelToGeoExact,
  geoToPixelExact, smoothPolyline, routeLengthM, requiredAbsFromZones,
} from '../utils/routing';
import { fetchElevations, computeRouteAltitude } from '../utils/elevation';
import type { ElevationPoint } from '../utils/elevation';
import { useMapStore, getActiveZonesCached } from './useMapStore';
import { registerRoutesForFleet } from './useFleetStore';
import { validateRouteForMode, type DroneMode, type DroneClass } from '../utils/droneProfiles';

const ROUTE_COLORS = ['#00d0ff', '#ff9500', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#60a5fa'];
const REROUTE_THROTTLE_MS = 250;
const MAX_REROUTE_CHAIN = 20;

// ─── Служебное состояние вне стейта zustand (модульные замыкания) ────────────
// Троттлер пакетной перестройки маршрутов. Ссылку на таймер НЕЛЬЗЯ хранить в
// объекте стейта: запись в get() напрямую нарушает иммутабельность zustand и
// теряется при HMR/ре-гидратации persist — из-за этого плановая перестройка
// могла молча не выполняться.
let rerouteTimer: number | null = null;
let rerouteChainCount = 0;
/** Ссылка на последний незавершённый прогон updateRouteAltitudes — повторный
 *  вызов отменяет предыдущий запрос (drag точек не должен копить обращения к
 *  троттлящемуся публичному API). */
let altitudeRunId = 0;
let lastAltitudeController: AbortController | null = null;
/** Per-route «занятость» прогонов updateRouteAltitudes(null). Раньше один
 *  глобальный runId приводил к взаимной отмене параллельных вызовов: ручная
 *  кнопка «Пересчитать высоты» (routeId=null) отменяла начатый drag-прогон по
 *  конкретной точке и наоборот — heights «не пересчитывались». Теперь прогон
 *  над всеми маршрутами не блокируется и не отменяет прогоны по отдельным
 *  маршрутам, а одноимённые целевые прогоны корректно отменяют друг друга. */
const activeAltitudeRuns = new Map<string, number>();

// ─── Web Worker для тяжёлой геометрии роутинга (A*/граф видимости) ───────────
// Тяжёлые сегменты (нужен обход зон) считаются ВНЕ Main Thread. Прямые сегменты
// (чистый cheap test) не гоняем через postMessage — это дороже расчёта.
type WorkerPathResult = { path: Point[] } | { error: string };
let routingWorker: Worker | null = null;
let routingWorkerBroken = false;
let workerTaskSeq = 0;
const workerPending = new Map<number, (r: WorkerPathResult) => void>();

function getRoutingWorker(): Worker | null {
  if (routingWorkerBroken) return null;
  if (routingWorker) return routingWorker;
  try {
    const w = new Worker(new URL('../workers/routing.worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (e: MessageEvent<{ taskId: number; ok: boolean; path?: Point[]; error?: string }>) => {
      const res = e.data;
      if (!res || typeof res.taskId !== 'number') return;
      const cb = workerPending.get(res.taskId);
      if (!cb) return; // устаревшая задача — игнор (race guard)
      workerPending.delete(res.taskId);
      if (res.ok && Array.isArray(res.path)) cb({ path: res.path });
      else cb({ error: res.error ?? 'worker returned no path' });
    });
    w.addEventListener('error', () => {
      routingWorkerBroken = true;
      for (const [, cb] of workerPending) cb({ error: 'routing worker crashed' });
      workerPending.clear();
      try { w.terminate(); } catch { /* noop */ }
      if (routingWorker === w) routingWorker = null;
    });
    routingWorker = w;
    return w;
  } catch {
    routingWorkerBroken = true; // окружение без Workers (SSR/тесты) — синхронный фолбэк
    return null;
  }
}

/** Проложить сегмент в воркере; null = воркер недоступен/ошибка ( caller применит синхронный план). */
function planSegmentViaWorker(
  start: Point, goal: Point, restrictions: Restriction[], mapW: number, mapH: number,
): Promise<Point[] | null> {
  const w = getRoutingWorker();
  if (!w) return Promise.resolve(null);
  const taskId = ++workerTaskSeq;
  return new Promise<Point[] | null>((resolve) => {
    const timer = setTimeout(() => {
      if (workerPending.delete(taskId)) resolve(null); // завис — синхронный фолбэк
    }, 15_000);
    workerPending.set(taskId, (r) => {
      clearTimeout(timer);
      resolve('path' in r ? r.path : null);
    });
    w.postMessage({ taskId, kind: 'plan-segment', start, goal, restrictions, mapWidth: mapW, mapHeight: mapH });
  });
}

// ─── Типы стора ────────────────────────────────────────────────

export interface MissionState {
  routes: Route[];
  importLists?: ImportLists; // импортированные списки стартов и целей
  activeRouteId: string | null; // активный маршрут для редактирования кликами
  routeWarnings: Record<string, string[]>; // id маршрута -> предупреждения (в сессии)
  /** Черновик маршрута мастера (гео-точки + ручные AGL-высоты этапов по
   *  индексу точки); пустой = черновика нет. Пишется MapCanvas при
   *  редактировании, читается approveTripleStep / setDraftPointAltitude. */
  routeDraft: { geo: { lat: number; lng: number }[]; agl: Record<number, number>; routeId?: string | null };
  /** Глобальный флаг «идёт тяжёлая/сетевая операция» (upload миссии, пересчёт
   *  высот). UI блокирует mutate-кнопки, пока true — защита от гонок состояний. */
  isProcessing: boolean;
  /** ID общей точки старта из importLists.starts (null = не задана).
   *  Единый источник истины для MapCanvas: локальный useState только зеркалит. */
  sharedStartId: string | null;
  /** ID общей точки цели из importLists.goals. */
  sharedGoalId: string | null;
  /** Тип воздушного судна (шаг 1 мастера): 'drone' — дрон до 100 км,
   *  'uav' — БПЛА до 100 000 км. Влияет на лимиты валидации маршрутов. */
  craftType: CraftType;
  /** Множественные общие точки старта/цели (по id из importLists). */
  startPointIds: string[];
  goalPointIds: string[];
}

/** Тип ВС: дрон (короткие дистанции) или дальнобойный БПЛА. */
export type CraftType = 'drone' | 'uav';

/** Максимальная дальность миссии по типу ВС, м (ТЗ: дрон ≤100 км, БПЛА ≤100 000 км). */
export const CRAFT_MAX_RANGE_M: Record<CraftType, number> = {
  drone: 100_000,
  uav: 100_000_000,
};

export interface MissionActions {
  addRoute: (points: RoutePoint[], name?: string, color?: string) => string | null;
  deleteRoute: (id: string) => void;
  renameRoute: (id: string, name: string) => void;
  setRouteColor: (id: string, color: string) => void;
  toggleRouteVisible: (id: string) => void;
  setActiveRoute: (id: string | null) => void;
  appendRoutePoint: (id: string, p: Point) => void;
  insertRoutePointAt: (id: string, index: number, p: Point) => void;
  moveRoutePoint: (id: string, index: number, p: Point) => void;
  removeRoutePoint: (id: string, index: number) => void;
  /** Ручная регулировка высоты этапа: AGL задаётся на промежуточной точке;
   *  требуемая ABS = рельеф под точкой + AGL (с учётом полом/потолком зон). */
  setRoutePointAltitude: (id: string, index: number, aglM: number | null) => void;
  /** Параметры путевой точки (задержка/угол камеры/скорость/радиус принятия). */
  setWaypointParams: (routeId: string, index: number, params: Partial<WaypointParams>) => void;
  /** Метаданные миссии маршрута (create_mission: автор + дата). */
  setMissionMeta: (routeId: string, author: string) => void;
  /** Режим работы миссии: короткие дистанции (агродроны) / дальнобойные до 50 000 км.
   *  Валидирует длину и высоты маршрута против лимитов профиля; предупреждения —
   *  в routeWarnings[routeId]. Возвращает список предупреждений либо null, если
   *  режим недопустим для этого маршрута (ValidationError перехвачен в warning). */
  setMissionMode: (routeId: string, mode: DroneMode, droneClass?: DroneClass) => string[] | null;
  /** Оптимизация порядка точек маршрута; возвращает % сокращения пути. */
  optimizeRouteOrder: (routeId: string, algorithm: OptimizeAlgorithm) => number | null;
  /** Генерация «змейки» по полигону области (px-координаты) как нового маршрута. */
  generateScanRoute: (polygonPx: Point[], spacingPx: number) => string | null;
  setDraftPointAltitude: (i: number, stepM: number) => void;
  commitRouteDraft: (opts: { idToReplace?: string | null; name?: string; color?: string }) => string | null;
  /** Кнопка «Автокоррекция маршрута»: немедленный обход всех ограничений. */
  autoFixRoute: (id?: string | null) => void;
  rerouteAroundZones: (id: string) => void;
  /** Определение высот полёта по рельефу (Open-Elevation) + автокоррекция
   *  вертикальных ограничений. routeId — один маршрут; undefined/null — все. */
  updateRouteAltitudes: (routeId?: string | null) => Promise<void>;
  rerouteAllRoutes: () => void;
  flushReroute: () => void;
  setRouteShape: (id: string, shape: RouteShape) => void;
  setRouteRangeLimit: (id: string, mode: RangeLimitMode, meters?: number) => void;
  importRoutes: (starts: ImportInput[], goals: ImportInput[]) => number;
  clearImportLists: () => void;
  /** Точечное добавление точки старта/цели (множественные старты/цели). */
  addStartPoint: (p: { lat: number; lng: number; label?: string }) => string;
  addGoalPoint: (p: { lat: number; lng: number; label?: string }) => string;
  updateImportPoint: (id: string, patch: Partial<Pick<ImportPoint, 'lat' | 'lng' | 'label' | 'routeId'>>) => void;
  removeImportPoint: (kind: 'start' | 'goal', id: string) => void;
  /** Привязка узла маршрута к точке списка старта/цели. */
  bindRoutePoint: (routeId: string, index: number, binding: WaypointBinding | null) => void;
  /** Полная привязка маршрута к стартовой и целевой точкам списков. */
  bindRouteToPoints: (routeId: string, startId: string | null, goalId: string | null) => void;
  /** Перенос точки списка (старт/цель): обновляет координату, все привязанные
   *  узлы маршрутов и автоматически перестраивает эти маршруты вокруг зон. */
  moveImportPointAndRebuild: (kind: 'start' | 'goal', id: string, geo: { lat: number; lng: number }) => void;
  /** Установка общей точки старта: upsert записи с label 'СТАРТ' в importLists.starts
   *  и сохранение её id в sharedStartId (store-first, переживает unmount MapCanvas). */
  setSharedStartPoint: (geo: { lat: number; lng: number } | null) => void;
  /** Установка общей точки цели (аналогично, sharedGoalId / importLists.goals). */
  setSharedGoalPoint: (geo: { lat: number; lng: number } | null) => void;
  /** Добавить точку старта (множественные старты): upsert в importLists.starts,
   *  id — в startPointIds. При наличии целей автоматически прокладывает маршруты. */
  addStartPointAt: (geo: { lat: number; lng: number }) => string;
  /** Добавить точку цели (множественные цели); автопрокладка маршрутов старт→цель. */
  addGoalPointAt: (geo: { lat: number; lng: number }) => string;
  /** Удалить точку старта/цели из множественного набора (+каскад маршрутов). */
  removeStartPoint: (id: string) => void;
  removeGoalPoint: (id: string) => void;
  /** Выбор типа ВС (шаг 0 мастера): 'drone' ≤100 км / 'uav' ≤100 000 км. */
  setCraftType: (t: CraftType) => void;
  /** Автопрокладка: маршруты старт→цель (пары по индексу) с облётом зон. */
  autoPlanRoutes: () => number;
  refreshAllRoutesAfterMapChange: () => void;
  clearRouteWarnings: (id: string) => void;
  resetMissions: () => void;
  /** Блокировка UI на время сетевой/тяжёлой операции (см. isProcessing).
   *  Вызовы идемпотентны по счётчику: begin N раз, end N раз — флаг снимается
   *  только когда всех операций больше нет. */
  beginProcessing: () => void;
  endProcessing: () => void;
  /** Отменить незавершённый фоновый прогон пересчёта высот (полный сброс). */
  cancelAltitudeRun: () => void;
}

interface ImportInput { label: string; lat: number; lng: number; placeName?: string }

export type MissionStore = MissionState & MissionActions;

// ─── Чистые вспомогательные функции (без state) ────────────────

/** Строгая привязка пикселя к WGS-84 (обратная Mercator-проекция) */
function pixelToGeoStrict(p: Point, bounds: NonNullable<ReturnType<typeof useMapStore.getState>['map']>['bounds'], mapW: number, mapH: number) {
  return pixelToGeoExact(p, bounds!, mapW, mapH);
}

/**
 * Автокоррекция ВЕРТИКАЛЬНЫХ ограничений: для каждой точки маршрута считаем
 * требуемую ABS-высоту: max(terrain + запас, terrain + ручной AGL, floor зоны),
 * ограниченную сверху ceiling зоны. Пол/потолок применяются только там, где
 * footprint зоны реально накрывает точку. При конфликте floor > ceiling
 * приоритет отдаётся полу (безопасность превыше потолка) с предупреждением.
 */
function applyVerticalLimits(pts: RoutePoint[], restrictions: Parameters<typeof requiredAbsFromZones>[1], clearance: number): string[] {
  const warns: string[] = [];
  let conflictRaised = 0;
  for (const p of pts) {
    const terr = typeof p.terrainM === 'number' && Number.isFinite(p.terrainM) ? p.terrainM : null;
    const manualAgl = typeof p.altitudeAGL === 'number' && Number.isFinite(p.altitudeAGL) && p.altitudeAGL >= 0
      ? p.altitudeAGL : null;
    let need: number | null = manualAgl !== null
      ? (terr !== null ? terr + manualAgl : manualAgl)
      : (terr !== null ? terr + clearance : null);
    const { floor, ceiling } = requiredAbsFromZones({ x: p.x, y: p.y }, restrictions, terr);
    if (floor !== null) need = need === null ? floor : Math.max(need, floor);
    if (ceiling !== null) {
      if (floor !== null && ceiling < floor - 1e-9) {
        conflictRaised++;
        need = need === null ? ceiling : Math.max(need, ceiling);
      } else if (need !== null && need > ceiling) {
        need = ceiling;
      }
    }
    if (need !== null) p.altitudeAbs = Math.round(need * 10) / 10;
  }
  if (conflictRaised > 0) {
    warns.push(`Конфликт высотных лимитов зон: маршрут поднят над потолком в ${conflictRaised} т.`);
  }
  return warns;
}

/** Предупреждение о нарушении ограничения маршрута по дальности */
function rangeLimitWarning(route: Route, pts: RoutePoint[]): string | null {
  if (!route.rangeMode || route.rangeMode === 'off' || !route.rangeM || route.rangeM <= 0) return null;
  const len = routeLengthM(pts.map((p) => ({ lat: p.lat, lng: p.lng })));
  if (route.rangeMode === 'max' && len > route.rangeM) {
    return `Дальность ${Math.round(len)} м превышает лимит ${Math.round(route.rangeM)} м`;
  }
  if (route.rangeMode === 'min' && len < route.rangeM) {
    return `Дальность ${Math.round(len)} м меньше минимума ${Math.round(route.rangeM)} м`;
  }
  // Глобальный лимит по типу ВС (ТЗ: дрон ≤100 км, БПЛА ≤100 000 км) — всегда.
  const craftCap = CRAFT_MAX_RANGE_M[useMissionStore.getState().craftType];
  if (len > craftCap) {
    return `Дальность ${Math.round(len / 1000)} км превышает лимит ${useMissionStore.getState().craftType === 'drone' ? 'дрона' : 'БПЛА'} (${Math.round(craftCap / 1000)} км)`;
  }
  return null;
}

/** Единый планировщик пакетной перестройки всех маршрутов. Идемпотентен:
 *  повторные вызовы в пределах троттл-окна схлопываются в один прогон.
 *  Защита от самоподдерживающегося каскада (React #185): счётчик цепочки
 *  сбрасывается только пользовательскими действиями. */
export function scheduleRerouteAll(): void {
  if (rerouteTimer != null) clearTimeout(rerouteTimer);
  rerouteTimer = window.setTimeout(() => {
    rerouteTimer = null;
    if (++rerouteChainCount > MAX_REROUTE_CHAIN) {
      console.warn('[reroute] цепочка авто-перестроек превысила лимит — остановлено.');
      return;
    }
    rerouteAllRoutesNow();
  }, REROUTE_THROTTLE_MS);
}

function rerouteTimerCleanup(): void {
  if (rerouteTimer != null) { clearTimeout(rerouteTimer); rerouteTimer = null; }
}

/** Немедленная пакетная перестройка всех маршрутов (троттлер / __rerouteAllNow). */
function rerouteAllRoutesNow(): void {
  const state = useMissionStore.getState();
  const map = useMapStore.getState().map;
  const routes = state.routes;
  if (!map?.bounds || routes.length === 0) return;
  const activeZones = getActiveZonesCached(useMapStore.getState().restrictions);
  // Тяжёлые сегменты (нужен обход) — в Web Worker; чистые — прямые на месте.
  const heavy: { routeId: string; segIdx: number; start: Point; goal: Point }[] = [];
  for (const route of routes) {
    if (route.points.length < 2) continue;
    let ki: number[] = [];
    for (let i = 0; i < route.points.length; i++) if (!route.points[i].auto) ki.push(i);
    if (ki.length < 2) ki = [0, route.points.length - 1];
    for (let k = 0; k < ki.length - 1; k++) {
      const a = route.points[ki[k]];
      const b = route.points[ki[k + 1]];
      if (activeZones.length > 0 && zonesCrossedBy([a, b], activeZones).length > 0) {
        heavy.push({ routeId: route.id, segIdx: k, start: { x: a.x, y: a.y }, goal: { x: b.x, y: b.y } });
      }
    }
  }
  if (heavy.length > 0) {
    // Асинхронный маршрут через воркер: синхронный прогон здесь же даёт
    // мгновенный результат (не блокируем UI ожиданием), а ответы воркера
    // точечно заменяют тяжёлые сегменты и запускают финальный идемпотентный проход.
    const w = getRoutingWorker();
    if (w) {
      let pending = heavy.length;
      let anyOk = false;
      for (const h of heavy) {
        void planSegmentViaWorker(h.start, h.goal, activeZones, map.width, map.height).then((path) => {
          if (path && path.length >= 2) {
            anyOk = true;
            useMissionStore.setState((cur) => ({
              routes: cur.routes.map((r) => {
                if (r.id !== h.routeId) return r;
                let kk: number[] = [];
                for (let i = 0; i < r.points.length; i++) if (!r.points[i].auto) kk.push(i);
                if (kk.length < 2) kk = [0, r.points.length - 1];
                const ka = r.points[kk[h.segIdx]];
                const kb = r.points[kk[h.segIdx + 1]];
                if (!ka || !kb) return r;
                const mid: RoutePoint[] = [];
                for (let i = 1; i < path.length - 1; i++) {
                  const px = path[i];
                  const geo = pixelToGeoStrict(px, map.bounds!, map.width, map.height);
                  mid.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
                }
                const pts = [...r.points];
                const ia = kk[h.segIdx];
                const ib = kk[h.segIdx + 1];
                pts.splice(ia + 1, ib - ia - 1, ...mid);
                pts[ia] = { ...pts[ia], auto: undefined };
                return { ...r, points: pts };
              }),
            }));
          }
          if (--pending === 0 && anyOk) rerouteAllRoutesNow(); // финальная сверка/warnings
        });
      }
      // не возвращаемся: синхронный pass ниже всё равно нужен (warnings/идемпотентность)
    }
  }
  const newRoutes: Route[] = [];
  const warningsMap: Record<string, string[]> = {};
  let changed = false;
  for (const route of routes) {
    if (route.points.length < 2) { newRoutes.push(route); continue; }
    let ki: number[] = [];
    for (let i = 0; i < route.points.length; i++) if (!route.points[i].auto) ki.push(i);
    if (ki.length < 2) ki = [0, route.points.length - 1];
    const segBuild = (): RoutePoint[] => {
      const out: RoutePoint[] = [];
      for (let k = 0; k < ki.length - 1; k++) {
        const a = route.points[ki[k]];
        const b = route.points[ki[k + 1]];
        out.push({ ...a, auto: undefined });
        const path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, activeZones, map.width, map.height);
        for (let i = 1; i < path.length - 1; i++) {
          const px = path[i];
          const geo = pixelToGeoStrict(px, map.bounds, map.width, map.height);
          out.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
        }
      }
      out.push({ ...route.points[ki[ki.length - 1]] });
      return out;
    };
    // Кривая: сглаживаем ОБХОДНУЮ ЛОМАНУЮ всегда от ключевых точек (не от
    // уже сглаженного результата — иначе число точек росло экспоненциально).
    let pts = segBuild();
    if (route.shape === 'curve') {
      const smooth = smoothPolyline(pts.map((p) => ({ x: p.x, y: p.y })), 6);
      const merged: RoutePoint[] = [];
      for (const sp of smooth) {
        const near = pts.find((p) => Math.hypot(p.x - sp.x, p.y - sp.y) < 1.5);
        if (near) { merged.push(near); continue; }
        const geo = pixelToGeoStrict(sp, map.bounds, map.width, map.height);
        merged.push({ x: sp.x, y: sp.y, lat: geo.lat, lng: geo.lng, auto: true });
      }
      pts = merged;
    }
    const crossed = zonesCrossedBy(pts.map((p) => ({ x: p.x, y: p.y })), activeZones);
    const warns = crossed.map((z) => `Пересекает зону «${z.name}»`);
    const limitWarn = rangeLimitWarning(route, pts);
    if (limitWarn) warns.push(limitWarn);
    if (warns.length > 0) warningsMap[route.id] = warns;
    // Идемпотентность: геометрия не изменилась — сохраняем ПРЕЖНИЙ объект route
    // (без нового set() каскад перестроек затухает сам).
    if (pts.length === route.points.length && pts.every((p, i) => {
      const q = route.points[i];
      return p.x === q.x && p.y === q.y && p.auto === q.auto;
    })) {
      newRoutes.push(route);
    } else {
      changed = true;
      newRoutes.push({ ...route, points: pts });
    }
  }
  useMissionStore.setState((cur) => {
    // Полная замена реестра предупреждений: старые записи для «очистившихся»
    // маршрутов раньше сливались с новыми и ложные предупреждения оставались навсегда.
    const nextWarnings: Record<string, string[]> = {};
    for (const [rid, w] of Object.entries(warningsMap)) if (w.length > 0) nextWarnings[rid] = w;
    const sameWarnings =
      Object.keys(nextWarnings).length === Object.keys(cur.routeWarnings).length &&
      Object.keys(nextWarnings).every((k) => cur.routeWarnings[k]?.join('\n') === nextWarnings[k].join('\n'));
    if (!changed && sameWarnings && cur.routes === routes) return {};
    return {
      routeWarnings: sameWarnings ? cur.routeWarnings : nextWarnings,
      routes: changed ? newRoutes : routes,
    };
  });
}

// ─── Реализация экшенов ────────────────────────────────────────

const initialMissionState: MissionState = {
  routes: [],
  importLists: undefined,
  activeRouteId: null,
  routeWarnings: {},
  routeDraft: { geo: [], agl: {} },
  /** Глобальный флаг «идёт тяжёлая/сетевая операция» (upload миссии, пересчёт
   *  высот). UI блокирует mutate-кнопки, пока true — защита от гонок состояний. */
  isProcessing: false,
  sharedStartId: null,
  sharedGoalId: null,
  craftType: 'drone',
  startPointIds: [],
  goalPointIds: [],
};

type SetFn = (partial: Partial<MissionStore> | ((s: MissionStore) => Partial<MissionStore>)) => void;
type GetFn = () => MissionStore;

const createMissionActions: StateCreator<MissionStore, [], [], MissionActions> = (rawSet, rawGet) => {
  const set = rawSet as SetFn;
  const get = rawGet as GetFn;
  // Ссылка на target-объект экшенов (присваивается ниже). Нужна, чтобы при
  // ПОВТОРНОМ вызове инициализатора (persist rehydrate в zustand v5 может
  // вызвать его ещё раз) не создавать новый замкнутый набор функций: тогда
  // useMissionStore.getState().x() остаётся === getState().x() до и после
  // гидрации — селекторы компонентов не «переподписываются» и не ререндерят.
  let targetRef: MissionActions | null = null;

  /** Тело пересчёта высот — вынесено из метода, чтобы обёртка updateRouteAltitudes
   *  оставалась тонкой (SOLID/SRP): отмена/блокировка UI отдельно, вычисления отдельно. */
  const altitudeBody = async (routeId: string | null | undefined, runKey: string, runId: number, controller: AbortController): Promise<void> => {
    const st = get();
    const mapState = useMapStore.getState();
    const clearance = Number.isFinite(mapState.settings.altitudeClearanceM as number)
      ? (mapState.settings.altitudeClearanceM as number) : 50;
    const routes = st.routes.filter((r) => r.points.length >= 2);
    const targets = routeId ? routes.filter((r) => r.id === routeId) : routes;
    if (targets.length === 0) return;

    // Собираем УНИКАЛЬНЫЕ гео-точки всех целевых маршрутов — один батч
    // к Open-Elevation вместо N запросов (публичный API троттлится).
    const keySet = new Map<string, ElevationPoint>();
    for (const r of targets) {
      for (const p of r.points) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
        if (!keySet.has(k)) keySet.set(k, { lat: p.lat, lng: p.lng });
      }
    }
    if (keySet.size === 0) return;
    const uniqPts = Array.from(keySet.values());
    let elevs: (number | null)[];
    try {
      elevs = await fetchElevations(uniqPts, controller.signal);
    } catch (err) {
      // Явная отмена более новым прогоном — тихо выходим; сетевые ошибки
      // fetchElevationsBatch гасит сам (мягкая деградация в null).
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.warn('[elevation] сервис недоступен:', (err as Error)?.message);
      elevs = uniqPts.map(() => null);
    }
    if (activeAltitudeRuns.get(runKey) !== runId) return; // более новый прогон этого же ключа отменил этот
    const elevByKey = new Map<string, number | null>();
    uniqPts.forEach((p, i) => elevByKey.set(`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, elevs[i]));

    set((cur) => {
      const rw: Record<string, string[]> = { ...cur.routeWarnings };
      const updatedRoutes = cur.routes.map((r) => {
        if (!targets.some((t) => t.id === r.id)) return r;
        const pts: RoutePoint[] = r.points.map((p) => {
          const terr = elevByKey.get(`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`) ?? null;
          return { ...p, terrainM: terr };
        });
        const vWarns = applyVerticalLimits(pts, useMapStore.getState().restrictions, clearance);
        const merged = [...(rw[r.id] || [])].filter((w) => !w.startsWith('Высота') && !w.startsWith('Конфликт высотных'));
        for (const w of vWarns) if (!merged.includes(w)) merged.push(w);
        // Проверка профиля между узлами: интерполяция рельефа ловит «нырки»
        // маршрута ниже земли. Запускается асинхронно ПОСЛЕ применения
        // состояния (set ещё не закоммичен — синхронный вызов устаревшим
        // снапшотом перезаписал бы только что проставленные terrainM).
        void Promise.resolve().then(() =>
          computeRouteAltitude(pts.map((p) => ({ lat: p.lat, lng: p.lng })), { clearanceM: clearance }, controller.signal),
        ).then((info) => {
          if (activeAltitudeRuns.get(runKey) !== runId) return; // защита: профиль отменённого прогона не пишет
          useMissionStore.setState((s2) => {
            const w2 = { ...s2.routeWarnings };
            const base = [...(w2[r.id] || [])].filter((x) => !x.startsWith('Высота'));
            if (info.terrainConflict) {
              base.push(`Высота: участок ниже рельефа (мин. АГЛ ${info.minAglM} м) — требуется подъём`);
            } else if (info.maxTerrainM !== null) {
              base.push(`Высота: пик рельефа на маршруте ${Math.round(info.maxTerrainM)} м, требуемая ABS ${Math.round(Math.max(...info.absM.filter((v): v is number => v !== null), 0))} м`);
            }
            if (base.length > 0) w2[r.id] = base; else delete w2[r.id];
            return { routeWarnings: w2 };
          });
        }).catch(() => { /* сервис недоступен / отмена — мягкая деградация */ });
        if (merged.length > 0) rw[r.id] = merged; else delete rw[r.id];
        return { ...r, points: pts };
      });
      return { routeWarnings: rw, routes: updatedRoutes };
    });
  };

  // Экшены обращаются друг к другу через `actions.x()`; при патчинге state
  // (guard-обёртки шима) мост get().x === actions.x гарантирует, что ВНУТРЕННИЕ
  // вызовы идут в тот же объект и не обходят блокировку по isProcessing.
  // При повторном вызове инициализатора переиспользуем target первой сборки:
  // экшены остаются стабильными по ссылке (Object.assign обновит замыкания
  // set/get на актуальные — семантика store та же).
  const target = (targetRef ??= {} as MissionActions);
  // ВАЖНО: в zustand v5 persist middleware обращается к api.getState() ЕЩЁ ДО
  // инициализации базового стора (например, при вычислении options.name /
  // partialize на первом прогоне) — в этот момент get() возвращает undefined,
  // и обращение вида get()[k] падало с «Cannot read properties of undefined
  // (reading 'addRoute')» прямо на старте приложения. Резолв защищён: при
  // пустом сторе берём только собственные поля target (patched-обёрток шима
  // на этом этапе ещё не существует).
  const actions = new Proxy(target, {
    get(t, k: string | symbol): unknown {
      if (k === '__target') return t;
      let cur: Record<string | symbol, unknown> | undefined;
      try {
        cur = get() as unknown as Record<string | symbol, unknown>;
      } catch {
        cur = undefined; // стор ещё не создан — фолбэк на target
      }
      const patched = cur?.[k];
      if (typeof patched === 'function' && patched !== (t as unknown as Record<string | symbol, unknown>)[k]) return patched;
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  });

  const targetActions: MissionActions = {
    addRoute: (points, name, color) => {
      const state = get();
      const map = useMapStore.getState().map;
      if (state.routes.length >= MAX_ROUTES) {
        set((cur) => ({ routeWarnings: { ...cur.routeWarnings, __limit: [`Достигнут максимум маршрутов в сессии: ${MAX_ROUTES}. Удалите ненужные.`] } }));
        return null;
      }
      if (!map) {
        set((cur) => ({ routeWarnings: { ...cur.routeWarnings, __limit: ['Сначала загрузите карту — точки маршрута привязываются к её координатам.'] } }));
        return null;
      }
      const id = uuidv4();
      const route: Route = {
        id,
        name: name || `Маршрут ${state.routes.length + 1}`,
        color: color || ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length],
        points,
        active: true,
        visible: true,
        createdAt: new Date().toISOString(),
      };
      set((cur) => ({ routes: [...cur.routes, route], activeRouteId: id }));
      actions.rerouteAroundZones(id);
      return id;
    },

    deleteRoute: (id) => set((state) => ({
      routes: state.routes.filter((r) => r.id !== id),
      activeRouteId: state.activeRouteId === id ? null : state.activeRouteId,
    })),

    renameRoute: (id, name) => set((state) => ({
      routes: state.routes.map((r) => (r.id === id ? { ...r, name } : r)),
    })),

    setRouteColor: (id, color) => set((state) => ({
      routes: state.routes.map((r) => (r.id === id ? { ...r, color } : r)),
    })),

    toggleRouteVisible: (id) => set((state) => ({
      routes: state.routes.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)),
    })),

    setActiveRoute: (id) => set((state) => ({
      activeRouteId: id,
      routes: state.routes.map((r) => ({ ...r, active: r.id === id })),
    })),

    appendRoutePoint: (id, p) => {
      const state = get();
      const route = state.routes.find((r) => r.id === id);
      if (!route || !useMapStore.getState().map) return;
      // Вставляем точку в ближайшее место ломаной (если клик не «за концом») —
      // так можно править середину существующего маршрута.
      let insertAt = route.points.length;
      if (route.points.length >= 2) {
        let bestD = Infinity;
        for (let i = 0; i < route.points.length - 1; i++) {
          const a = route.points[i], b = route.points[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const len2 = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
          const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
          if (d < bestD) { bestD = d; insertAt = i + 1; }
        }
        const lastA = route.points[route.points.length - 2];
        const lastB = route.points[route.points.length - 1];
        const endDist = Math.hypot(p.x - lastB.x, p.y - lastB.y);
        const midDist = Math.hypot(p.x - (lastA.x + lastB.x) / 2, p.y - (lastA.y + lastB.y) / 2);
        if (endDist <= midDist) insertAt = route.points.length; // продолжение в конец
      }
      actions.insertRoutePointAt(id, insertAt, p);
    },

    insertRoutePointAt: (id, index, p) => {
      const map = useMapStore.getState().map;
      if (!map) return;
      const geo = map.bounds
        ? pixelToGeoStrict(p, map.bounds, map.width, map.height)
        : { lat: NaN, lng: NaN };
      const rp: RoutePoint = { x: p.x, y: p.y, lat: geo.lat, lng: geo.lng };
      set((cur) => ({
        routes: cur.routes.map((r) => {
          if (r.id !== id) return r;
          const pts = [...r.points];
          pts.splice(index, 0, rp);
          return { ...r, points: pts };
        }),
      }));
      actions.rerouteAroundZones(id);
    },

    moveRoutePoint: (id, index, p) => {
      const map = useMapStore.getState().map;
      if (!map) return;
      const geo = map.bounds ? pixelToGeoStrict(p, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
      set((cur) => ({
        routes: cur.routes.map((r) => {
          if (r.id !== id) return r;
          const pts = r.points.map((pt, i) =>
            i === index ? { ...pt, x: p.x, y: p.y, ...(Number.isFinite(geo.lat) ? { lat: geo.lat, lng: geo.lng } : {}) } : pt
          );
          return { ...r, points: pts };
        }),
      }));
      actions.rerouteAroundZones(id);
    },

    removeRoutePoint: (id, index) => {
      set((state) => ({
        routes: state.routes
          .map((r) => (r.id === id ? { ...r, points: r.points.filter((_, i) => i !== index) } : r))
          .filter((r) => r.points.length >= 2),
      }));
      const still = get().routes.find((r) => r.id === id);
      if (still) actions.rerouteAroundZones(id);
      else set({ activeRouteId: null });
    },

    setRoutePointAltitude: (id, index, aglM) => {
      // Ручная регулировка высоты этапа на промежуточной точке маршрута.
      // Значение AGL сохраняется в точку; требуемая ABS пересчитывается
      // applyVerticalLimits (terrain + AGL, с учётом полом/потолком зон).
      set((cur) => ({
        routes: cur.routes.map((r) => {
          if (r.id !== id) return r;
          const pts = r.points.map((pt, i) =>
            i === index
              ? { ...pt, altitudeAGL: aglM === null || !Number.isFinite(aglM) ? null : Math.max(0, aglM) }
              : pt
          );
          return { ...r, points: pts };
        }),
      }));
      // Пересчёт высот по новой конфигурации (кэш Open-Elevation делает
      // повторный прогон дешёвым).
      void actions.updateRouteAltitudes(id);
    },

    setWaypointParams: (routeId, index, params) => {
      // add_waypoint(lat, lon, alt, params): задержка/угол камеры/скорость/
      // радиус принятия хранятся по индексу точки маршрута. Некорректные
      // значения санитизируются (clamp), а не бросают исключение — UI может
      // передавать промежуточные состояния полей ввода.
      const clean = sanitizeWaypointParams(params);
      set((cur) => ({
        routes: cur.routes.map((r) => {
          if (r.id !== routeId) return r;
          const wp: Record<number, WaypointParamsLite> = { ...(r.waypointParams || {}), [index]: clean };
          return { ...r, waypointParams: wp };
        }),
      }));
    },

    setMissionMeta: (routeId, author) => {
      // create_mission(): метаданные миссии (ID/название уже есть у Route).
      const route = get().routes.find((r) => r.id === routeId);
      if (!route) return;
      let meta: MissionMetaLite;
      try {
        const m = createMissionMeta(routeId, route.name, author);
        meta = { author: m.author, createdAt: m.createdAt, mode: route.missionMeta?.mode, droneClass: route.missionMeta?.droneClass };
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        meta = { author: author.trim() || '—', createdAt: new Date().toISOString(), mode: route.missionMeta?.mode, droneClass: route.missionMeta?.droneClass };
      }
      set((cur) => ({
        routes: cur.routes.map((r) => (r.id === routeId ? { ...r, missionMeta: meta } : r)),
      }));
    },

    setMissionMode: (routeId, mode, droneClass) => {
      // Выбор режима работы для миссии маршрута + валидация против профиля.
      const st = get();
      const route = st.routes.find((r) => r.id === routeId);
      if (!route) return null;
      const lengthM = routeLengthM(route.points.map((p) => ({ lat: p.lat, lng: p.lng })));
      const agls = route.points
        .map((p) => p.altitudeAGL)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      const maxAgl = agls.length > 0 ? Math.max(...agls) : null;
      let warns: string[];
      try {
        warns = validateRouteForMode(lengthM, maxAgl, mode);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        // Жёсткое нарушение лимита профиля — не применяем режим, отдаём warning.
        const msg = (e as Error).message;
        set((cur) => ({
          routeWarnings: { ...cur.routeWarnings, [routeId]: [...(cur.routeWarnings[routeId] || []), `Режим: ${msg}`] },
        }));
        return null;
      }
      set((cur) => ({
        routes: cur.routes.map((r) => (r.id === routeId
          ? {
              ...r,
              missionMeta: {
                author: r.missionMeta?.author || 'Оператор GCS',
                createdAt: r.missionMeta?.createdAt || new Date().toISOString(),
                mode,
                droneClass: droneClass ?? r.missionMeta?.droneClass ?? 'standard',
              },
            }
          : r)),
        routeWarnings: (() => {
          const w = { ...cur.routeWarnings };
          const base = (w[routeId] || []).filter((x) => !x.startsWith('Режим:') && !x.startsWith('Профиль:'));
          const next = [...base, ...warns.map((x) => `Профиль: ${x}`)];
          if (next.length > 0) w[routeId] = next; else delete w[routeId];
          return w;
        })(),
      }));
      return warns;
    },

    optimizeRouteOrder: (routeId, algorithm) => {
      // optimize_route(waypoints, algorithm): перестановка путевых точек
      // (первая — старт — фиксирована). Параметры точек переносятся вместе
      // с точками. Возвращает % сокращения пути или null.
      const route = get().routes.find((r) => r.id === routeId);
      if (!route || route.points.length < 3) return null;
      const indexed = route.points.map((p, i) => ({ lat: p.lat, lon: p.lng, __i: i }));
      const res = optimizeRoute(indexed, algorithm);
      const newPoints: RoutePoint[] = [];
      const newWp: Record<number, WaypointParamsLite> = {};
      res.waypoints.forEach((p, newIndex) => {
        newPoints.push(route.points[p.__i]);
        const old = route.waypointParams?.[p.__i];
        if (old) newWp[newIndex] = old;
      });
      set((cur) => ({
        routes: cur.routes.map((r) => (r.id === routeId ? { ...r, points: newPoints, waypointParams: newWp } : r)),
      }));
      actions.rerouteAroundZones(routeId);
      void actions.updateRouteAltitudes(routeId);
      return res.improvementPct;
    },

    generateScanRoute: (polygonPx, spacingPx) => {
      // scan_area(polygon, altitude, overlap_front, overlap_side): «змейка»
      // для сплошного сканирования полигона. Шаг змейки считается из
      // перекрытий вызывающей стороной; сюда приходит готовый spacing в px.
      const map = useMapStore.getState().map;
      if (!map?.bounds || polygonPx.length < 3) return null;
      let lawn: Point[];
      try {
        lawn = generateScanLawnmower(polygonPx, spacingPx);
      } catch (e) {
        if (e instanceof ValidationError) {
          set((cur) => ({ routeWarnings: { ...cur.routeWarnings, __scan: [(e as Error).message] } }));
        }
        return null;
      }
      if (lawn.length < 2) return null;
      const pts: RoutePoint[] = lawn.map((p) => {
        const g = pixelToGeoExact(p, map.bounds!, map.width, map.height);
        return { lat: g.lat, lng: g.lng, x: p.x, y: p.y };
      });
      return actions.addRoute(pts, `Сканирование ${get().routes.length + 1}`);
    },

    setDraftPointAltitude: (i, stepM) => {
      // Регулировка высоты ЭТАПА на промежуточной точке ещё не утверждённого
      // черновика: шаг ±stepM метров AGL. Привязка к маршруту проекта — по
      // ТОЧНОМУ id (routeId из мастера), без эвристики «первый маршрут с
      // таким же набором координат» (могла применить высоту к чужому маршруту).
      const st = get();
      const draft = st.routeDraft;
      if (i < 0 || i >= draft.geo.length) return;
      const clearance = useMapStore.getState().settings.altitudeClearanceM ?? 50;
      const cur = draft.agl[i] ?? clearance;
      const next = Math.max(0, Math.round((cur + stepM) * 10) / 10);
      const agl = { ...draft.agl, [i]: next };
      set({ routeDraft: { ...draft, agl } });
      const rid = draft.routeId;
      if (rid && st.routes.some((r) => r.id === rid)) {
        actions.setRoutePointAltitude(rid, i, next);
      }
    },

    commitRouteDraft: ({ idToReplace, name, color }) => {
      // Общий код мастера этапов: зафиксировать черновик маршрута как маршрут
      // проекта. Ручные высоты этапов (agl по индексу точки) переносятся в
      // altitudeAGL соответствующих RoutePoint; затем — немедленный обход
      // ограничений и пересчёт высот (terrain + запас / полом-потолок зон).
      const st = get();
      const map = useMapStore.getState().map;
      const draft = st.routeDraft;
      if (!map?.bounds || map.width <= 0 || map.height <= 0) return null;
      if (draft.geo.length < 2) return null;
      const pts: RoutePoint[] = draft.geo.map((g, i) => ({
        ...geoToPixelExact(g.lat, g.lng, map.bounds!, map.width, map.height),
        lat: g.lat, lng: g.lng,
        altitudeAGL: draft.agl[i] !== undefined ? draft.agl[i] : null,
      }));
      let targetId = idToReplace ?? null;
      if (targetId && !st.routes.some((r) => r.id === targetId)) targetId = null;
      if (targetId) {
        set((cur) => ({
          routes: cur.routes.map((r) => (r.id === targetId ? { ...r, points: pts } : r)),
        }));
      } else {
        const created = actions.addRoute(pts, name, color);
        if (!created) return null;
        targetId = created;
      }
      actions.autoFixRoute(targetId);
      return targetId;
    },

    autoFixRoute: (id) => {
      // Кнопка «Автокоррекция маршрута»: немедленный обход ВСЕХ ограничений
      // без ожидания троттлинга подписчика.
      rerouteTimerCleanup();
      rerouteChainCount = 0;
      if (id) {
        actions.rerouteAroundZones(id);
        void actions.updateRouteAltitudes(id);
      } else {
        rerouteAllRoutesNow();
        void actions.updateRouteAltitudes();
      }
    },

    rerouteAroundZones: (id) => {
      const state = get();
      const map = useMapStore.getState().map;
      const route = state.routes.find((r) => r.id === id);
      if (!map?.bounds || !route || route.points.length < 2) return;
      // Активные зоны — из кэша (сбрасывается при изменении restrictions).
      // Дешёвый «грязевой» тест: если отрезок не задевает ни одну зону,
      // обходной движок (buildObstacles + граф видимости) не вызывается.
      const activeZones = getActiveZonesCached(useMapStore.getState().restrictions);
      const keyIdx: number[] = [];
      for (let i = 0; i < route.points.length; i++) {
        if (!route.points[i].auto) keyIdx.push(i);
      }
      if (keyIdx.length < 2) keyIdx.push(route.points.length - 1);
      const newPts: RoutePoint[] = [];
      for (let k = 0; k < keyIdx.length - 1; k++) {
        const a = route.points[keyIdx[k]];
        const b = route.points[keyIdx[k + 1]];
        newPts.push({ ...a, auto: undefined });
        let path: Point[];
        if (activeZones.length === 0 || zonesCrossedBy([a, b], activeZones).length === 0) {
          path = [a, b]; // сегмент чист — прямой путь
        } else {
          path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, activeZones, map.width, map.height);
        }
        for (let i = 1; i < path.length - 1; i++) {
          const px = path[i];
          const geo = pixelToGeoStrict(px, map.bounds, map.width, map.height);
          newPts.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
        }
      }
      newPts.push({ ...route.points[keyIdx[keyIdx.length - 1]] });
      if (route.shape === 'curve') {
        const smooth = smoothPolyline(newPts.map((p) => ({ x: p.x, y: p.y })), 6);
        const merged: RoutePoint[] = [];
        for (const sp of smooth) {
          const near = newPts.find((p) => Math.hypot(p.x - sp.x, p.y - sp.y) < 1.5);
          if (near) { merged.push(near); continue; }
          const geo = pixelToGeoStrict(sp, map.bounds, map.width, map.height);
          merged.push({ x: sp.x, y: sp.y, lat: geo.lat, lng: geo.lng, auto: true });
        }
        newPts.length = 0;
        newPts.push(...merged);
      }
      // Набор предупреждений ПОЛНОСТЬЮ заменяется для маршрута (пустой массив
      // удаляет запись) — иначе «застывшие» ложные предупреждения оставались бы навсегда.
      const crossed = zonesCrossedBy(newPts.map((p) => ({ x: p.x, y: p.y })), activeZones);
      const warnings = crossed.map((z) => `Пересекает зону «${z.name}»`);
      const limitWarn = rangeLimitWarning(route, newPts);
      if (limitWarn) warnings.push(limitWarn);
      set((cur) => {
        const rw = { ...cur.routeWarnings };
        if (warnings.length > 0) rw[id] = warnings;
        else delete rw[id];
        return {
          routeWarnings: rw,
          routes: cur.routes.map((r) => (r.id === id ? { ...r, points: newPts } : r)),
        };
      });
    },

    updateRouteAltitudes: async (routeId) => {
      const runKey = routeId ?? '__all__';
      const runId = ++altitudeRunId;
      // Отменяем сетевые запросы предыдущего прогона ТОГО ЖЕ ключа (drag точек
      // не должен копить обращения к троттлящемуся публичному API). Прогоны по
      // разным ключам (например, ручной «Пересчитать все» и автоматический по
      // изменённой точке) больше НЕ отменяют друг друга — раньше из-за одного
      // глобального runId параллельные вызовы взаимно убивали друг друга и
      // пересчёт высот молча не применялся.
      const prev = lastAltitudeController;
      const controller = new AbortController();
      lastAltitudeController = controller;
      activeAltitudeRuns.set(runKey, runId);
      if (prev && runKey === '__all__') { try { prev.abort(); } catch { /* noop */ } }
      const mapState = useMapStore.getState();
      if (!mapState.map?.bounds) { activeAltitudeRuns.delete(runKey); return; }
      // Флаг elevationAuto живёт в настройках карты (территория) — уважаем его
      // для АВТОМАТИЧЕСКИХ прогонов (routeId=null): без флага автопересчёт не
      // запускается. Ручной запуск (конкретный маршрут / кнопка) работает всегда.
      if (!routeId && !mapState.settings.elevationAuto) { activeAltitudeRuns.delete(runKey); return; }
      actions.beginProcessing();
      try {
        await altitudeBody(routeId, runKey, runId, controller);
      } finally {
        if (activeAltitudeRuns.get(runKey) === runId) activeAltitudeRuns.delete(runKey);
        // Снимаем блокировку только если этот прогон всё ещё актуален:
        // более новый вызов уже сам выставил флаг и продлит блокировку.
        if (runId === altitudeRunId) actions.endProcessing();
      }
    },

    rerouteAllRoutes: () => {
      // Пользовательское действие (изменение зон/карты через API стора) —
      // обнуляем счётчик авто-цепочки, лимит в scheduleRerouteAll касается
      // только самогенерируемых каскадов.
      rerouteChainCount = 0;
      scheduleRerouteAll();
    },

    flushReroute: () => {
      rerouteTimerCleanup();
      rerouteChainCount = 0;
      rerouteAllRoutesNow();
    },

    setRouteShape: (id, shape) => {
      set((cur) => ({
        routes: cur.routes.map((r) => (r.id === id ? { ...r, shape } : r)),
      }));
      actions.rerouteAroundZones(id); // перестраиваем сглаживание/ломаную
    },

    setRouteRangeLimit: (id, mode, meters) => {
      set((cur) => ({
        routes: cur.routes.map((r) =>
          r.id === id ? { ...r, rangeMode: mode, rangeM: mode === 'off' ? undefined : meters ?? r.rangeM } : r
        ),
      }));
      actions.rerouteAroundZones(id); // пересчитать предупреждения по дальности
    },

    importRoutes: (starts, goals) => {
      const state = get();
      const map = useMapStore.getState().map;
      if (!map) {
        set((cur) => ({ routeWarnings: { ...cur.routeWarnings, __import: ['Сначала загрузите карту — точки привязываются к её координатам.'] } }));
        return 0;
      }
      const existing = state.routes;
      const freeSlots = Math.max(0, MAX_ROUTES - existing.length);
      const n = Math.min(Math.max(starts.length, goals.length), freeSlots);
      if (n === 0) {
        set((cur) => ({ routeWarnings: { ...cur.routeWarnings, __import: [`Достигнут максимум маршрутов в сессии: ${MAX_ROUTES}.`] } }));
        return 0;
      }
      const toRoutePoint = (pt: { lat: number; lng: number }): RoutePoint => {
        const px = map.bounds
          ? geoToPixelExact(pt.lat, pt.lng, map.bounds, map.width, map.height)
          : { x: 0, y: 0 };
        return { lat: pt.lat, lng: pt.lng, x: px.x, y: px.y };
      };
      const newRoutes: Route[] = [];
      const impStarts: ImportPoint[] = [];
      const impGoals: ImportPoint[] = [];
      for (let i = 0; i < n; i++) {
        const s = starts[Math.min(i, starts.length - 1)];
        const g = goals[Math.min(i, goals.length - 1)];
        const id = uuidv4();
        newRoutes.push({
          id,
          name: `${s.label || `Старт ${i + 1}`} → ${g.label || `Цель ${i + 1}`}`,
          color: ROUTE_COLORS[(existing.length + i) % ROUTE_COLORS.length],
          points: [toRoutePoint(s), toRoutePoint(g)],
          active: false,
          visible: true,
          createdAt: new Date().toISOString(),
          shape: 'straight',
        });
        impStarts.push({ id: uuidv4(), label: s.label || `Старт ${i + 1}`, lat: s.lat, lng: s.lng, routeId: id, placeName: s.placeName });
        impGoals.push({ id: uuidv4(), label: g.label || `Цель ${i + 1}`, lat: g.lat, lng: g.lng, routeId: id, placeName: g.placeName });
      }
      set((cur) => {
        const prevLists = cur.importLists as ImportLists | undefined;
        const lists: ImportLists = {
          starts: [...(prevLists?.starts || []), ...impStarts],
          goals: [...(prevLists?.goals || []), ...impGoals],
        };
        return { routes: [...cur.routes, ...newRoutes], importLists: lists };
      });
      actions.rerouteAllRoutes(); // автообход зон для новых маршрутов
      return n;
    },

    clearImportLists: () => set({ importLists: undefined }),

    addStartPoint: (p) => {
      const id = uuidv4();
      set((cur) => {
        const lists: ImportLists = cur.importLists ?? { starts: [], goals: [] };
        const n = lists.starts.length + 1;
        return { importLists: { ...lists, starts: [...lists.starts, { id, label: p.label || `Старт ${n}`, lat: p.lat, lng: p.lng, routeId: null }] } };
      });
      return id;
    },

    addGoalPoint: (p) => {
      const id = uuidv4();
      set((cur) => {
        const lists: ImportLists = cur.importLists ?? { starts: [], goals: [] };
        const n = lists.goals.length + 1;
        return { importLists: { ...lists, goals: [...lists.goals, { id, label: p.label || `Цель ${n}`, lat: p.lat, lng: p.lng, routeId: null }] } };
      });
      return id;
    },

    updateImportPoint: (id, patch) => set((cur) => {
      const lists = cur.importLists;
      if (!lists) return {};
      const upd = (arr: ImportPoint[]) => arr.map((pt) => (pt.id === id ? { ...pt, ...patch } : pt));
      return { importLists: { starts: upd(lists.starts), goals: upd(lists.goals) } };
    }),

    removeImportPoint: (kind, id) => set((cur) => {
      const lists = cur.importLists;
      if (!lists) return {};
      const next: ImportLists = kind === 'start'
        ? { starts: lists.starts.filter((p) => p.id !== id), goals: lists.goals }
        : { starts: lists.starts, goals: lists.goals.filter((p) => p.id !== id) };
      // отвязываем узлы маршрутов от удалённой точки
      const routes = cur.routes.map((r) => ({
        ...r,
        points: r.points.map((p) => (p.binding && p.binding.pointId === id ? { ...p, binding: undefined } : p)),
      }));
      return { importLists: next, routes };
    }),

    bindRoutePoint: (routeId, index, binding) => set((cur) => ({
      routes: cur.routes.map((r) => (r.id !== routeId ? r : {
        ...r,
        points: r.points.map((p, i) => (i === index ? { ...p, binding: binding ?? undefined } : p)),
      })),
    })),

    bindRouteToPoints: (routeId, startId, goalId) => set((cur) => ({
      routes: cur.routes.map((r) => {
        if (r.id !== routeId) return r;
        const pts = r.points.map((p, i) => {
          if (i === 0 && startId) return { ...p, binding: { kind: 'start' as const, pointId: startId } };
          if (i === r.points.length - 1 && goalId) return { ...p, binding: { kind: 'goal' as const, pointId: goalId } };
          return p;
        });
        return { ...r, points: pts };
      }),
    })),

    moveImportPointAndRebuild: (kind, id, geo) => {
      const touched: string[] = [];
      set((cur) => {
        const lists = cur.importLists;
        if (!lists) return {};
        const upd = (arr: ImportPoint[]) => arr.map((pt) => (pt.id === id ? { ...pt, lat: geo.lat, lng: geo.lng } : pt));
        const next: ImportLists = kind === 'start'
          ? { starts: upd(lists.starts), goals: lists.goals }
          : { starts: lists.starts, goals: upd(lists.goals) };
        const map = useMapStore.getState().map;
        if (!map?.bounds || map.width <= 0 || map.height <= 0) return { importLists: next };
        // переносим ВСЕ узлы всех маршрутов, привязанные к этой точке,
        // и запоминаем маршруты для автоматической перестройки вокруг зон
        const routes = cur.routes.map((r) => {
          let changed = false;
          const pts = r.points.map((p) => {
            if (p.binding && p.binding.kind === kind && p.binding.pointId === id) {
              changed = true;
              return { ...p, ...geoToPixelExact(geo.lat, geo.lng, map.bounds!, map.width, map.height), lat: geo.lat, lng: geo.lng };
            }
            return p;
          });
          if (changed) touched.push(r.id);
          return changed ? { ...r, points: pts } : r;
        });
        return { importLists: next, routes };
      });
      for (const rid of touched) actions.rerouteAroundZones(rid);
      if (touched.length > 0) void get().updateRouteAltitudes(null);
    },

    setSharedStartPoint: (geo) => {
      if (geo === null) {
        const id = get().sharedStartId;
        if (id) actions.removeImportPoint('start', id);
        set({ sharedStartId: null });
        return;
      }
      const cur = get();
      const lists: ImportLists = cur.importLists ?? { starts: [], goals: [] };
      const existing = cur.sharedStartId ? lists.starts.find((p) => p.id === cur.sharedStartId) : undefined;
      if (existing) {
        actions.updateImportPoint(existing.id, { lat: geo.lat, lng: geo.lng });
        // координата общей точки старта изменилась — перестраиваем привязанные маршруты
        actions.moveImportPointAndRebuild('start', existing.id, geo);
        return;
      }
      const id = actions.addStartPoint({ ...geo, label: 'СТАРТ' });
      set({ sharedStartId: id });
    },

    setSharedGoalPoint: (geo) => {
      if (geo === null) {
        const id = get().sharedGoalId;
        if (id) actions.removeImportPoint('goal', id);
        set({ sharedGoalId: null });
        return;
      }
      const cur = get();
      const lists: ImportLists = cur.importLists ?? { starts: [], goals: [] };
      const existing = cur.sharedGoalId ? lists.goals.find((p) => p.id === cur.sharedGoalId) : undefined;
      if (existing) {
        actions.updateImportPoint(existing.id, { lat: geo.lat, lng: geo.lng });
        actions.moveImportPointAndRebuild('goal', existing.id, geo);
        return;
      }
      const id = actions.addGoalPoint({ ...geo, label: 'ЦЕЛЬ' });
      set({ sharedGoalId: id });
    },

    // ─── Множественные точки старта/цели + автопрокладка (рабочий процесс ТЗ) ──

    addStartPointAt: (geo) => {
      // Дедупликация по координате: вызывающий код уже проверяет «близкую»
      // точку, но проверка асинхронна относительно состояния — при быстрых
      // кликах дубликаты всё же возможны. Дубликат даёт лишнюю пару в
      // autoPlanRoutes → лишний маршрут из той же точки («разъезжающиеся»
      // точки). Возвращаем id существующей точки вместо создания новой.
      const lists0 = get().importLists;
      const dup = lists0?.starts.find((p) => Math.hypot(p.lat - geo.lat, p.lng - geo.lng) < 1e-7);
      if (dup && get().startPointIds.includes(dup.id)) return dup.id;
      const n = get().startPointIds.length + 1;
      const id = actions.addStartPoint({ lat: geo.lat, lng: geo.lng, label: `СТАРТ ${n}` });
      set((cur) => ({ startPointIds: [...cur.startPointIds, id], sharedStartId: cur.sharedStartId ?? id }));
      void Promise.resolve().then(() => actions.autoPlanRoutes());
      return id;
    },

    addGoalPointAt: (geo) => {
      const lists0 = get().importLists;
      const dup = lists0?.goals.find((p) => Math.hypot(p.lat - geo.lat, p.lng - geo.lng) < 1e-7);
      if (dup && get().goalPointIds.includes(dup.id)) return dup.id;
      const n = get().goalPointIds.length + 1;
      const id = actions.addGoalPoint({ lat: geo.lat, lng: geo.lng, label: `ЦЕЛЬ ${n}` });
      set((cur) => ({ goalPointIds: [...cur.goalPointIds, id], sharedGoalId: cur.sharedGoalId ?? id }));
      void Promise.resolve().then(() => actions.autoPlanRoutes());
      return id;
    },

    removeStartPoint: (id) => {
      set((cur) => ({
        startPointIds: cur.startPointIds.filter((x) => x !== id),
        sharedStartId: cur.sharedStartId === id ? null : cur.sharedStartId,
      }));
      actions.removeImportPoint('start', id);
      void Promise.resolve().then(() => actions.autoPlanRoutes());
    },

    removeGoalPoint: (id) => {
      set((cur) => ({
        goalPointIds: cur.goalPointIds.filter((x) => x !== id),
        sharedGoalId: cur.sharedGoalId === id ? null : cur.sharedGoalId,
      }));
      actions.removeImportPoint('goal', id);
      void Promise.resolve().then(() => actions.autoPlanRoutes());
    },

    setCraftType: (t) => {
      set({ craftType: t });
      // Смена типа ВС меняет лимит дальности миссии — перепроверяем маршруты.
      // При сужении профиля (uav→drone) превышения всплывут в routeWarnings;
      // при расширении — предупреждения устаревают и снимаются reroute-прогоном.
      actions.flushReroute();
    },

    autoPlanRoutes: () => {
      // Точки старта/цели хранятся в гео-координатах, а маршруты — в пикселях.
      // Если у узлов нет корректных пиксельных координат (карта ещё не была
      // загружена в момент постановки точки — узел создаётся с x:0,y:0), они
      // «уходят в угол карты». Перед прокладкой пересчитываем пиксели всех
      // существующих маршрутов по актуальным границам растра.
      const mapPre = useMapStore.getState().map;
      if (mapPre?.bounds && mapPre.width > 0 && mapPre.height > 0) {
        set((s) => ({
          routes: s.routes.map((r) => recomputeRoutePixels(r, mapPre.bounds!, mapPre.width, mapPre.height)),
        }));
      }
      const cur = get();
      const lists = cur.importLists;
      if (!lists) return 0;
      const starts = cur.startPointIds.map((id) => lists.starts.find((p) => p.id === id)).filter((p): p is ImportPoint => !!p);
      const goals = cur.goalPointIds.map((id) => lists.goals.find((p) => p.id === id)).filter((p): p is ImportPoint => !!p);
      if (starts.length === 0 || goals.length === 0) return 0;
      // Автопрокладка только для точек без привязанного маршрута; существующие
      // отредактированные пользователем маршруты не перетираются.
      // Точка считается занятой, если хоть один маршрут содержит её в binding
      // ЛЮБОГО узла (стартовый, целевой или пользовательский waypoint-якорь).
      const boundPointIds = new Set<string>();
      for (const r of cur.routes) for (const p of r.points) if (p.binding?.pointId) boundPointIds.add(p.binding.pointId);
      const freeStarts = starts.filter((s) => !boundPointIds.has(s.id));
      const freeGoals = goals.filter((g) => !boundPointIds.has(g.id));
      const pairs = Math.min(freeStarts.length, freeGoals.length);
      let created = 0;
      // Пиксели узлов считаем СРАЗУ из актуального растра. Если оставить
      // x:0,y:0 в надежде на пересчёт внутри reroute — при отсутствии зон
      // прокладка не трогает координаты, и узлы «уходят в угол карты» (0,0).
      const mapG = useMapStore.getState().map;
      const canProject = !!mapG?.bounds && mapG.width > 0 && mapG.height > 0;
      for (let i = 0; i < pairs && cur.routes.length + created < MAX_ROUTES; i++) {
        const s = freeStarts[i];
        const g = freeGoals[i];
        const sPx = canProject ? geoToPixelExact(s.lat, s.lng, mapG!.bounds!, mapG!.width, mapG!.height) : { x: 0, y: 0 };
        const gPx = canProject ? geoToPixelExact(g.lat, g.lng, mapG!.bounds!, mapG!.width, mapG!.height) : { x: 0, y: 0 };
        const rid = actions.addRoute(
          [
            { lat: s.lat, lng: s.lng, x: sPx.x, y: sPx.y, binding: { kind: 'start', pointId: s.id } },
            { lat: g.lat, lng: g.lng, x: gPx.x, y: gPx.y, binding: { kind: 'goal', pointId: g.id } },
          ],
          `${s.label} → ${g.label}`,
        );
        if (rid) created++;
      }
      if (created > 0) {
        // немедленная перестройка с облётом бесполетных зон + валидация дальности
        actions.flushReroute();
        void get().updateRouteAltitudes(null);
      }
      return created;
    },

    refreshAllRoutesAfterMapChange: () => {
      const map = useMapStore.getState().map;
      if (!map?.bounds) return;
      set((cur) => ({
        routes: cur.routes.map((r) => recomputeRoutePixels(r, map.bounds!, map.width, map.height)),
      }));
      actions.rerouteAllRoutes(); // новые границы карты — пересобираем обходы зон
    },

    clearRouteWarnings: (id) => set((state) => {
      const copy = { ...state.routeWarnings };
      delete copy[id];
      return { routeWarnings: copy };
    }),

    resetMissions: () => set({
      routes: [], activeRouteId: null, routeWarnings: {}, routeDraft: { geo: [], agl: {} }, importLists: undefined,
      sharedStartId: null, sharedGoalId: null, startPointIds: [], goalPointIds: [],
    }),

    beginProcessing: () => set((s) => (s.isProcessing ? {} : { isProcessing: true })),
    endProcessing: () => set((s) => (s.isProcessing ? { isProcessing: false } : {})),

    /** Отменить незавершённый фоновый прогон высот (используется полным
     *  сбросом проекта, чтобы отменённый прогон не дописал данные в стор). */
    cancelAltitudeRun: () => {
      altitudeRunId++; // все ожидающие continue-проверки runId станут устаревшими
      activeAltitudeRuns.clear(); // per-route прогоны тоже объявляются устаревшими
      try { lastAltitudeController?.abort(); } catch { /* noop */ }
      lastAltitudeController = null;
    },
  };
  Object.assign(target, targetActions);
  return actions;
};

// ─── Стор + persist ────────────────────────────────────────────

export const useMissionStore = create<MissionStore>()(
  persist(
    (...a) => ({ ...initialMissionState, ...createMissionActions(...a) }),
    {
      name: 'tq-mission',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        routes: s.routes,
        importLists: s.importLists,
        activeRouteId: s.activeRouteId,
        routeWarnings: {},           // сессионные предупреждения не персистим
        routeDraft: { geo: [], agl: {} }, // черновик мастера — только на сессию
        isProcessing: false,         // тяжёлые операции не переживают перезагрузку
        sharedStartId: s.sharedStartId,
        sharedGoalId: s.sharedGoalId,
        craftType: s.craftType,
        startPointIds: s.startPointIds,
        goalPointIds: s.goalPointIds,
      }) as MissionState,
      migrate: (persistedState: unknown) => {
        const p = persistedState as Partial<MissionState>;
        if (!Array.isArray(p.routes)) p.routes = [];
        if (!p.routeDraft) p.routeDraft = { geo: [], agl: {} };
        if (!p.routeWarnings) p.routeWarnings = {};
        if (p.activeRouteId === undefined) p.activeRouteId = null;
        if (p.sharedStartId === undefined) p.sharedStartId = null;
        if (p.sharedGoalId === undefined) p.sharedGoalId = null;
        if (p.craftType !== 'drone' && p.craftType !== 'uav') p.craftType = 'drone';
        // Множественные точки: миграция v1 — одна общая точка → массив id
        if (!Array.isArray(p.startPointIds)) p.startPointIds = p.sharedStartId ? [p.sharedStartId] : [];
        if (!Array.isArray(p.goalPointIds)) p.goalPointIds = p.sharedGoalId ? [p.sharedGoalId] : [];
        return p as MissionState;
      },
    },
  ),
);

/** Внутренний хук для совместимости со старым API (`__rerouteAllRoutesNow`). */
export function rerouteAllNow(): void {
  rerouteTimerCleanup();
  rerouteAllRoutesNow();
}

// Синхронизация реестра маршрутов для fleet-стора (жёсткая блокировка смены
// режима по профилю; без цикла модулей — fleet не импортирует mission).
registerRoutesForFleet(useMissionStore.getState().routes);
useMissionStore.subscribe((s, prev) => {
  if (s.routes !== prev.routes) registerRoutesForFleet(s.routes);
});
