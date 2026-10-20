import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Project, Marker, Restriction, Layer, Tool, ViewState, MapData, Point, CalibrationPoint, MapBounds, Route, RoutePoint, DroneAssignment } from '../types';
import { MAX_ROUTES } from '../types';
import type { WaypointParamsLite, MissionMetaLite } from '../types';
import {
  sanitizeWaypointParams,
  createMissionMeta,
  optimizeRoute,
  generateScanLawnmower,
  ValidationError,
  type WaypointParams,
  type OptimizeAlgorithm,
} from '../utils/mission';
import { saveMapToIndexedDB, loadMapFromIndexedDB, deleteMapFromIndexedDB } from '../utils/storage';
import { geoToPixelFromBounds, calculateBoundsFromCenter, latToMercatorY, mercatorYToLat } from '../utils/googleMaps';
import { planPathAroundZones, zonesCrossedBy, recomputeRoutePixels, pixelToGeoExact, geoToPixelExact, smoothPolyline, routeLengthM, requiredAbsFromZones } from '../utils/routing';
import { fetchElevations, computeRouteAltitude } from '../utils/elevation';
import type { ElevationPoint } from '../utils/elevation';
import { parseViewState } from '../utils/projectSchema';
import { makeStoreShim } from '../hooks/useStoreShim';
import type { RouteShape, RangeLimitMode, ImportPoint, ImportLists } from '../types';

const MIN_MAP_ZOOM_FLOOR = 6;

const ROUTE_COLORS = ['#00d0ff', '#ff9500', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#60a5fa'];

// ─── Высоты полёта (Open-Elevation) и вертикальные ограничения ──────────────

/** Ссылка на последний незавершённый прогон updateRouteAltitudes — повторный
 *  вызов отменяет предыдущий запрос (drag точки маршрута не должен копить
 *  обращения к медленному публичному API). */
let altitudeRunId = 0;
/** Активный AbortController последнего прогона высот — для отмены сетевых
 *  запросов устаревшего прогона при запуске нового. */
let lastAltitudeController: AbortController | null = null;

/** Все зоны участвуют в расчётах независимо от устаревшего флага `active`
 *  (см. комментарий в types/index.ts): раньше «активная» была ровно одна, и
 *  добавление/утверждение новой зоны молча снимало с расчёта все прежние —
 *  «при утверждении маршрута пропадают ограничения». */
function drawableZones(restrictions: Restriction[]): Restriction[] {
  return restrictions.filter(
    (r) => r.type === 'circle' ? r.points.length >= 1 && !!r.radius : r.points.length >= 2,
  );
}

/**
 * Автокоррекция ВЕРТИКАЛЬНЫХ ограничений: для каждой точки маршрута считаем
 * требуемую ABS-высоту (над уровнем моря):
 *   required = max( terrain + clearance,                — не ниже рельефа
 *                   zoneFloor = terrain + minHeightAGL, — выше «пола» зоны
 *                   zoneCeiling = terrain + maxHeightAGL ) — «потолок» зоны
 * Пол/потолок применяются только там, где footprint зоны реально накрывает
 * точку маршрута — лимиты не должны стоять НА пути маршрута. При конфликте
 * floor > ceiling приоритет отдаётся полу (безопасность превыше потолка),
 * это помечается предупреждением. Рельеф (terrainM) берётся из кэса/ответа
 * Open-Elevation; если он недоступен, коррекция выполняется в AGL-модели
 * относительно нуля (эквивалентно «земля = 0 м»).
 */
function applyVerticalLimits(pts: RoutePoint[], restrictions: Restriction[], clearance: number): string[] {
  const warns: string[] = [];
  let conflictRaised = 0;
  for (const p of pts) {
    const terr = typeof p.terrainM === 'number' && Number.isFinite(p.terrainM) ? p.terrainM : null;
    // Ручная регулировка высоты этапа (AGL на промежуточной точке): если
    // пользователь задал altitudeAGL, базовая требуемая ABS считается от неё
    // (рельеф под точкой + AGL); лимиты зон при этом остаются жёсткими.
    const manualAgl = typeof p.altitudeAGL === 'number' && Number.isFinite(p.altitudeAGL) && p.altitudeAGL >= 0
      ? p.altitudeAGL : null;
    // базовое требование: не ниже рельефа + запас (или ручной AGL поверх рельефа)
    let need: number | null = manualAgl !== null
      ? (terr !== null ? terr + manualAgl : manualAgl)
      : (terr !== null ? terr + clearance : null);
    const { floor, ceiling } = requiredAbsFromZones({ x: p.x, y: p.y }, restrictions, terr);
    if (floor !== null) need = need === null ? floor : Math.max(need, floor);
    if (ceiling !== null) {
      if (floor !== null && ceiling < floor - 1e-9) {
        // конфликт полов/потолков разных зон на одном footprint — поднимаем над потолком
        conflictRaised++;
        need = need === null ? ceiling : Math.max(need, ceiling);
      } else if (need !== null && need > ceiling) {
        // маршрут «ныряет» под потолок зоны — опускаем ровно до потолка
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
  return null;
}

/** Строгая привязка пикселя к WGS-84 (обратная Mercator-проекция) */
function pixelToGeoStrict(p: Point, bounds: MapBounds, mapW: number, mapH: number) {
  return pixelToGeoExact(p, bounds, mapW, mapH);
}

// ─── Служебное состояние вне стейта zustand ─────────────────────────────────
// Троттлер пакетной перестройки маршрутов. Ссылку на таймер НЕЛЬЗЯ хранить в
// объекте стейта: запись в get() напрямую (вне set()) нарушает иммутабельность
// zustand и теряется при HMR/ре-гидратации persist-стора — из-за этого
// плановая перестройка маршрутов могла молча не выполняться.
const REROUTE_THROTTLE_MS = 250;
let rerouteTimer: number | null = null;

// Кэш «грязевых» предикатов для planPathAroundZones. Сегмент прям тогда, когда
// он не задевает буферную полосу НИ ОДНОЙ активной зоны — это проверяется
// дешёвым тестом отрезок↔зона (zonesCrossedBy) без построения препятствий.
// buildObstacles+segmentBlocked+граф видимости выполняются только для сегментов,
// реально задетых зонами. Кэш сбрасывается при любом изменении restrictions
// (см. setRestrictions/updateRestriction/deleteRestriction/setActiveRestriction).
let zoneCacheKey: { ver: number; n: number } | null = null;
let zoneCacheList: Restriction[] | null = null;
let zonesVersion = 0;

/** Инвалидация кэша зон (вызывать при любом изменении project.restrictions). */
export function invalidateZoneCache() {
  zonesVersion++;
  zoneCacheKey = null;
  zoneCacheList = null;
}

/** Активные «проходимые внутри» зоны в нормализованном виде (сброс при изменении зон). */
export function getActiveZonesCached(restrictions: Restriction[]): Restriction[] {
  if (zoneCacheKey && zoneCacheKey.ver === zonesVersion && zoneCacheKey.n === restrictions.length) {
    return zoneCacheList!;
  }
  // ВСЕ зоны с корректной геометрией (флаг active больше не фильтрует — см. drawableZones)
  const list = drawableZones(restrictions);
  zoneCacheKey = { ver: zonesVersion, n: restrictions.length };
  zoneCacheList = list;
  return list;
}

/** Отменить отложенную пакетную перестройку (для немедленных действий — autoFixRoute) */
function rerouteTimerCleanup() {
  if (rerouteTimer != null) { clearTimeout(rerouteTimer); rerouteTimer = null; }
}

/**
 * Единый планировщик пакетной перестройки всех маршрутов. Идемпотентен:
 * повторные вызовы в пределах троттл-окна схлопываются в один прогон.
 */
export function scheduleRerouteAll() {
  rerouteTimerCleanup();
  rerouteTimer = window.setTimeout(() => {
    rerouteTimer = null;
    // Защита от самоподдерживающегося каскада: пакетная перестройка делает set()
    // с новым массивом routes; если подписчики снова планируют scheduleRerouteAll,
    // цепочка прогонов без пользовательского действия растёт бесконечно и
    // блокирует поток (React error #185 «Maximum update depth exceeded»).
    // Счётчик сбрасывается в публичной обёртке rerouteAllRoutes (пользовательское
    // действие) — лимит касается только автогенерируемой цепочки.
    if (++rerouteChainCount > MAX_REROUTE_CHAIN) {
      console.warn('[reroute] цепочка авто-перестроек превысила лимит — остановлено.');
      return;
    }
    rerouteAllRoutesNow();
  }, REROUTE_THROTTLE_MS);
}

/**
 * Лимит подряд идущих авто-перестроек маршрутов без пользовательского
 * действия (см. защиту от каскада в scheduleRerouteAll).
 */
let rerouteChainCount = 0;
const MAX_REROUTE_CHAIN = 20;

/** Немедленная пакетная перестройка всех маршрутов (вызывается троттлером). */
function rerouteAllRoutesNow() {
  const state = useStore.getState();
  const set = useStore.setState;
  const map = state.project.map;
  const routes = state.project.routes || [];
  if (!map || routes.length === 0) return;
  // Все активные зоны участвуют в расчёте: круг задаётся ОДНОЙ точкой + radius,
  // старый фильтр points.length >= 2 полностью игнорировал круговые зоны.
  const activeZones = getActiveZonesCached(state.project.restrictions);
  const newRoutes: Route[] = [];
  const warningsMap: Record<string, string[]> = {};
  // Фиксированная точка отсчёта updatedAt на весь прогон: set() с новым
  // Date() каждый раз делает project «изменившимся» — это подпитывало
  // каскад перестроек (React #185). Если маршруты не поменялись, и updatedAt
  // остаётся прежним.
  let changed = false;
  for (const route of routes) {
    if (route.points.length < 2) { newRoutes.push(route); continue; }
    // Ключевые точки берём по stable-признаку auto. Если после импорта/старых
    // версий все точки помечены auto (ключевых < 2), принудительно считаем
    // ключевыми первую и последнюю — иначе маршрут навсегда останется
    // «замороженным» с авто-точками предыдущего прогона.
    let ki: number[] = [];
    for (let i = 0; i < route.points.length; i++) if (!route.points[i].auto) ki.push(i);
    if (ki.length < 2) ki = [0, route.points.length - 1];
    const pts: RoutePoint[] = [];
    for (let k = 0; k < ki.length - 1; k++) {
      const a = route.points[ki[k]];
      const b = route.points[ki[k + 1]];
      pts.push({ ...a, auto: undefined as any });
      const path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, activeZones, map.width, map.height);
      for (let i = 1; i < path.length - 1; i++) {
        const px = path[i];
        const geo = map.bounds ? pixelToGeoStrict(px, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
        pts.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
      }
    }
    pts.push({ ...route.points[ki[ki.length - 1]] });
    // Кривая: сглаживание ОБХОДНОЙ ЛОМАНОЙ поверх ключевых точек.
    // ВАЖНО: сглаживаем всегда от ключевых точек, а не от текущего массива
    // points: раньше smooth применялся к уже сглаженному результату, и каждая
    // перестройка умножала число точек (~×6) — экспоненциальный рост данных.
    if (route.shape === 'curve') {
      const base: RoutePoint[] = [];
      for (let k = 0; k < ki.length - 1; k++) {
        const a = route.points[ki[k]];
        const b = route.points[ki[k + 1]];
        base.push({ ...a, auto: undefined as any });
        const path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, activeZones, map.width, map.height);
        for (let i = 1; i < path.length - 1; i++) {
          const px = path[i];
          const geo = map.bounds ? pixelToGeoStrict(px, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
          base.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
        }
      }
      base.push({ ...route.points[ki[ki.length - 1]] });
      const smooth = smoothPolyline(base.map((p) => ({ x: p.x, y: p.y })), 6);
      const merged: RoutePoint[] = [];
      for (const sp of smooth) {
        const near = base.find((p) => Math.hypot(p.x - sp.x, p.y - sp.y) < 1.5);
        if (near) { merged.push(near); continue; }
        const geo = map.bounds ? pixelToGeoStrict(sp, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
        merged.push({ x: sp.x, y: sp.y, lat: geo.lat, lng: geo.lng, auto: true });
      }
      pts.length = 0;
      pts.push(...merged);
    }
    const crossed = zonesCrossedBy(pts.map((p) => ({ x: p.x, y: p.y })), activeZones);
    const warns = crossed.map((z) => `Пересекает зону «${z.name}»`);
    const limitWarn = rangeLimitWarning(route, pts);
    if (limitWarn) warns.push(limitWarn);
    if (warns.length > 0) warningsMap[route.id] = warns;
    // Идемпотентность: если геометрия маршрута не изменилась (те же точки,
    // тот же порядок), сохраняем ПРЕЖНИЙ объект route — без нового set()
    // каскад перестроек затухает сам (см. защиту от React #185).
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
  set((cur) => {
    // Полная замена реестра предупреждений: старые записи для «очистившихся»
    // маршрутов раньше сливались с новыми ({...cur, ...map}) и ложные
    // предупреждения оставались навсегда.
    const nextWarnings: Record<string, string[]> = {};
    for (const [rid, w] of Object.entries(warningsMap)) {
      if (w.length > 0) nextWarnings[rid] = w;
    }
    const sameWarnings =
      Object.keys(nextWarnings).length === Object.keys(cur.routeWarnings).length &&
      Object.keys(nextWarnings).every((k) => cur.routeWarnings[k]?.join('\n') === nextWarnings[k].join('\n'));
    // Ничего не изменилось — не пишем в стор вообще (не трогаем updatedAt/ссылки):
    // это обрывает любые попытки каскадной перестройки на корню.
    if (!changed && sameWarnings && cur.project.routes === routes) return {};
    return {
      routeWarnings: sameWarnings ? cur.routeWarnings : nextWarnings,
      project: { ...cur.project, routes: changed ? newRoutes : routes, updatedAt: changed ? new Date().toISOString() : cur.project.updatedAt },
    };
  });
}

/**
 * Селектор вида для React-компонентов. Возвращает НОВЫЙ объект только когда
 * реально изменились поля, видимые в UI (scale/offsetX/offsetY).
 * Зачем: zustand persist при ре-гидрации записывает в стор viewState из
 * localStorage через Object.assign на объекте стейта (мутация in-place —
 * ссылка не меняется, подписчики не уведомляются). Из-за этого компонент,
 * читающий state.viewState напрямую, мог отрендериться ДО восстановления
 * persisted-вида и получить undefined-поле (краш «viewState is not defined»
 * / «Cannot read properties of undefined»). viewTick инкрементируется при
 * каждой setViewState, поэтому селектор пересчитывается после гидрации и
 * возвращает актуальный вид.
 */
export function selectViewForRender(s: AppState): ViewState {
  // viewTick в ключе: подписка пересчитывается при каждом изменении вида.
  // Примитивные поля (scale/offsetX/...) сравниваются Object.is — возвращаем
  // ту же ссылку, если вид не менялся; иначе — новый объект. Без tick в
  // ключе селектор бы молча «зависал» на старом значении; с новым объектом
  // на каждый emit стора — infinite re-render loop (React error #185).
  const v = s.viewState;
  const t = s.viewTick;
  const last = lastViewSel;
  if (last && last.t === t && last.v === v) return last.out;
  const out: ViewState = { scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY, z0: v.z0 };
  lastViewSel = { t, v, out };
  return out;
}
let lastViewSel: { t: number; v: AppState['viewState']; out: ViewState } | null = null;

/**
 * Нормализация viewState (используется миграцией persist v2). Возвращает объект
 * с гарантированно числовыми полями; отсутствующее/битое z0 принудительно
 * помечается как undefined — все потребители вида трактуют undefined z0 как
 * эталонный ZOOM_REF (`z0 ?? ZOOM_REF`), поэтому явная запись undefined
 * семантически эквивалентна отсутствию поля и защищает от «грязных» значений
 * (null/string/NaN) из старых версий хранилища.
 */
export function normalizeViewState(v: unknown): ViewState {
  // Единая точка нормализации вида — строгая реализация в projectSchema
  // (parseViewState никогда не бросает и возвращает только конечные числа).
  return parseViewState(v);
}

interface AppState {
  project: Project;
  /** Назначения дронам/группам: старт, цель, маршрут (персистится в project-агностичном ключе). */
  droneAssignments: DroneAssignment[];
  setDroneAssignment: (droneId: string, patch: Partial<Omit<DroneAssignment, 'droneId'>>) => void;
  removeDroneAssignment: (droneId: string) => void;
  currentTool: Tool;
  activeRestrictionId: string | null;
  selectedMarkerId: string | null;
  selectedRestrictionId: string | null;
  viewState: ViewState;
  /** monotonic counter — bump on every setViewState (see selectViewForRender) */
  viewTick: number;
  cursorPosition: Point | null;
  isDrawing: boolean;
  /** Флаг «тяжёлой» операции (загрузка миссии в дроны / пакетный пересчёт).
   *  Пока true — мутации стейта через makeGuarded-обёртки блокируются, а
   *  кнопки удаления зон / оптимизации / пересчёта высот disabled в DOM. */
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;
  /** Обёртка мутатора: пока isProcessing === true, вызов — no-op. */
  makeGuarded: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R | undefined;
  drawingPoints: Point[];
  measurementPoints: Point[];
  searchQuery: string;
  filterType: string;
  activeRouteId: string | null; // активный маршрут для редактирования кликами
  routeWarnings: Record<string, string[]>; // id маршрута -> предупреждения о пересечении зон (в сессии)
  redoDrawingStack: Point[]; // redo-стек для рисования полигонов
  _currentMapId?: string; // ID текущей карты в IndexedDB

  // Actions — маршруты
  addRoute: (points: RoutePoint[], name?: string, color?: string) => string | null;
  deleteRoute: (id: string) => void;
  renameRoute: (id: string, name: string) => void;
  setRouteColor: (id: string, color: string) => void;
  toggleRouteVisible: (id: string) => void;
  setActiveRoute: (id: string | null) => void;
  appendRoutePoint: (id: string, p: Point) => void; // клик по карте: точка вставляется/добавляется + автообход зон
  insertRoutePointAt: (id: string, index: number, p: Point) => void;
  moveRoutePoint: (id: string, index: number, p: Point) => void;
  removeRoutePoint: (id: string, index: number) => void;
  /** Ручная регулировка высоты этапа: AGL-высота задаётся на промежуточной
   *  (управляющей) точке маршрута и определяет высоту участка до следующей
   *  точки. Требуемая ABS = рельеф под точкой + AGL (или просто AGL, если
   *  рельеф ещё не определён). */
  setRoutePointAltitude: (id: string, index: number, aglM: number | null) => void;
  /** Параметры путевой точки (задержка/угол камеры/скорость/радиус принятия). */
  setWaypointParams: (routeId: string, index: number, params: Partial<WaypointParams>) => void;
  /** Метаданные миссии маршрута (create_mission: автор + дата). */
  setMissionMeta: (routeId: string, author: string) => void;
  /** Оптимизация порядка точек маршрута; возвращает % сокращения пути. */
  optimizeRouteOrder: (routeId: string, algorithm: OptimizeAlgorithm) => number | null;
  /** Генерация «змейки» по полигону области (px-координаты) как нового маршрута. */
  generateScanRoute: (polygonPx: Point[], spacingPx: number) => string | null;
  /** Ручная высота этапа на ЧЕРНОВИКЕ маршрута (до «Утвердить»): шаг AGL ±stepM
   *  на i-й точке черновика. При задании высоты черновик автоматически
   *  утверждается как маршрут проекта (если точек >= 2). */
  setDraftPointAltitude: (i: number, stepM: number) => void;
  /** Черновик маршрута мастера (гео-точки + ручные AGL-высоты этапов по
   *  индексу точки); null = черновика нет. Пишется MapCanvas при редактиро-
   *  вании, читается approveTripleStep / setDraftPointAltitude. */
  routeDraft: { geo: { lat: number; lng: number }[]; agl: Record<number, number>; routeId?: string | null };
  /** Утвердить черновик маршрута как маршрут проекта (общий код мастера:
   *  перенос ручных высот этапов, обход зон, пересчёт высот). idToReplace —
   *  существующий маршрут дрона (редактирование), иначе создаётся новый. */
  commitRouteDraft: (opts: { idToReplace?: string | null; name?: string; color?: string }) => string | null;
  /** Кнопка «Автокоррекция маршрута»: немедленный обход всех ограничений
   *  (геометрия — planPathAroundZones по всем зонам + вертикальные лимиты).
   *  id omitted/null — все маршруты. */
  autoFixRoute: (id?: string | null) => void;
  rerouteAroundZones: (id: string) => void; // перестроить обход зон для всего маршрута
  /** Определение высот полёта по рельефу (Open-Elevation) + автокоррекция
   *  вертикальных ограничений. routeId — один маршрут; undefined/'' — все. */
  updateRouteAltitudes: (routeId?: string | null) => Promise<void>;
  /** Внутренний: немедленная пакетная перестройка (rerouteAllRoutes — троттлинг-обёртка) */
  __rerouteAllRoutesNow?: () => void;
  rerouteAllRoutes: () => void; // пакетная перестройка всех маршрутов после изменения зон/карты
  /** Немедленно исполнить отложенную пакетную перестройку (без ожидания троттлинга) */
  flushReroute: () => void;
  setRouteShape: (id: string, shape: 'straight' | 'curve') => void; // прямая или кривая
  setRouteRangeLimit: (id: string, mode: 'off' | 'max' | 'min', meters?: number) => void; // ограничение по дальности
  importLists: (starts: { label: string; lat: number; lng: number; placeName?: string }[], goals: { label: string; lat: number; lng: number; placeName?: string }[]) => number; // импорт списков + привязка к маршрутам
  clearImportLists: () => void;
  undoDrawingPoint: () => void; // undo последней точки рисования полигона
  redoDrawingPoint: () => void; // redo убранной точки
  refreshAllRoutesAfterMapChange: () => void; // пересчёт пикселей из lat/lng при загрузке новой карты
  clearRouteWarnings: (id: string) => void;
  setTool: (tool: Tool) => void;
  loadMap: (mapData: MapData) => void;
  addMarker: (marker: Partial<Marker>) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  deleteMarker: (id: string) => void;
  selectMarker: (id: string | null) => void;
  addRestriction: (restriction: Partial<Restriction>) => void;
  updateRestriction: (id: string, updates: Partial<Restriction>) => void;
  deleteRestriction: (id: string) => void;
  selectRestriction: (id: string | null) => void;
  setActiveRestriction: (id: string | null) => void;
  addLayer: (name: string) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  deleteLayer: (id: string) => void;
  setViewState: (viewState: Partial<ViewState>) => void;
  setCursorPosition: (pos: Point | null) => void;
  setDrawing: (isDrawing: boolean) => void;
  addDrawingPoint: (point: Point) => void;
  clearDrawingPoints: () => void;
  setMeasurementPoints: (points: Point[]) => void;
  setSearchQuery: (query: string) => void;
  setFilterType: (type: string) => void;
  importProject: (project: Project) => void;
  setProjectName: (name: string) => void;
  exportProject: () => Project;
  resetProject: () => void;
  addCalibrationPoint: (point: CalibrationPoint) => void;
  removeCalibrationPoint: (index: number) => void;
  toggleCalibration: (enabled: boolean) => void;
  updateSettings: (settings: Partial<Project['settings']>) => void;
  setGoogleMapsApiKey: (apiKey: string) => void;
  toggleGoogleMaps: (enabled: boolean) => void;
  setMapBounds: (bounds: MapBounds) => void;
  setYandexMapsApiKey: (apiKey: string) => void;
  toggleYandexMaps: (enabled: boolean) => void;
  toggleOpenStreetMap: (enabled: boolean) => void;
  setOSMTileServer: (server: 'osm' | 'opentopomap' | 'carto') => void;
  loadMapWithStorage: (mapData: MapData) => Promise<void>;
  /** Активная тайловая карта без снимка: центр (lat/lng) + зум 10..19 */
  loadActiveTileMap: (center: { lat: number; lng: number }, zoom: number) => void;
  restoreMapFromStorage: () => Promise<void>;
}

const defaultProject: Project = {
  version: '1.1',
  projectName: 'Новый проект',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  map: null,
  calibration: {
    enabled: false,
    points: [],
  },
  restrictions: [],
  markers: [],
  routes: [],
  layers: [
    { id: 'default', name: 'Основной', visible: true, locked: false },
  ],
  settings: {
    showGrid: true,
    gridSize: 0,
    showCoordinates: true,
    theme: 'dark',
    // Карта активная по умолчанию: тайловая подложка (не фотография), зум/pan/линейка.
    tilesEnabled: true,
    tileStyle: 'scheme',
    // Высоты полёта: автозапрос рельефа (Open-Elevation) включён по умолчанию,
    // запас над землёй 50 м (стандарт для БПЛА-планирования).
    elevationAuto: true,
    altitudeClearanceM: 50,
  },
  googleMaps: {
    apiKey: '',
    enabled: false,
  },
  yandexMaps: {
    apiKey: '',
    enabled: false,
  },
  openStreetMap: {
    enabled: false,
    tileServer: 'osm',
  },
};

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      project: { ...defaultProject },
      currentTool: 'pan',
      activeRestrictionId: null,
      selectedMarkerId: null,
      selectedRestrictionId: null,
      viewState: { offsetX: 0, offsetY: 0, scale: 1 },
      viewTick: 0,
      cursorPosition: null,
      isDrawing: false,
      isProcessing: false,
      setProcessing: (v) => set({ isProcessing: v === true }),
      // NOTE: the inner closure is typed with `unknown[]`/`unknown` and cast to
      // the generic signature once — casting the spread call site directly would
      // hit TS's "A is not assignable to A" variance error for generic tuples.
      makeGuarded: (<A extends unknown[], R>(fn: (...args: A) => R) =>
        ((...args: unknown[]) => {
          if (get().isProcessing) return undefined;
          return fn(...(args as A));
        }) as ((...args: A) => R | undefined)) as AppState['makeGuarded'],
      drawingPoints: [],
      measurementPoints: [],
      searchQuery: '',
      filterType: '',
      activeRouteId: null,
      routeWarnings: {},
      redoDrawingStack: [],
      routeDraft: { geo: [], agl: {} },
      droneAssignments: [],

      setDroneAssignment: (droneId, patch) =>
        set((state) => {
          const idx = state.droneAssignments.findIndex((d) => d.droneId === droneId);
          const next = [...state.droneAssignments];
          if (idx >= 0) next[idx] = { ...next[idx], ...patch };
          else next.push({ droneId, startId: null, goalId: null, routeId: null, ...patch });
          return { droneAssignments: next };
        }),

      removeDroneAssignment: (droneId) =>
        set((state) => ({ droneAssignments: state.droneAssignments.filter((d) => d.droneId !== droneId) })),

      commitRouteDraft: ({ idToReplace, name, color }) => {
        // Общий код мастера этапов: зафиксировать черновик маршрута как маршрут
        // проекта. Ручные высоты этапов (agl по индексу точки) переносятся в
        // altitudeAGL соответствующих RoutePoint; затем — немедленный обход
        // ограничений и пересчёт высот (terrain + запас / полом-потолок зон).
        const st = get();
        const map = st.project.map;
        const draft = st.routeDraft;
        if (!map?.bounds || map.width <= 0 || map.height <= 0) return null;
        if (draft.geo.length < 2) return null;
        const pts: RoutePoint[] = draft.geo.map((g, i) => ({
          ...geoToPixelExact(g.lat, g.lng, map.bounds!, map.width, map.height),
          lat: g.lat, lng: g.lng,
          altitudeAGL: draft.agl[i] !== undefined ? draft.agl[i] : null,
        }));
        let targetId = idToReplace ?? null;
        if (targetId && !(st.project.routes || []).some((r) => r.id === targetId)) targetId = null;
        if (targetId) {
          set((cur) => ({
            project: {
              ...cur.project,
              routes: (cur.project.routes || []).map((r) => (r.id === targetId ? { ...r, points: pts } : r)),
              updatedAt: new Date().toISOString(),
            },
          }));
        } else {
          const created = st.addRoute(pts, name, color);
          if (!created) return null;
          targetId = created;
        }
        // Автокоррекция: обход всех ограничений + определение высот по рельефу
        get().autoFixRoute(targetId);
        return targetId;
      },

      setDraftPointAltitude: (i, stepM) => {
        // Регулировка высоты ЭТАПА на промежуточной точке ещё не утверждённого
        // черновика: шаг ±stepM метров AGL. Черновик хранится в routeDraft;
        // если он уже перенесён в проект — высота применяется к маршруту с
        // ТОЧНОЙ привязкой по id (routeId из мастера), без эвристики «первый
        // маршрут с таким же набором координат» (могла применить высоту к
        // чужому маршруту роя с идентичными точками).
        const st = get();
        const draft = st.routeDraft;
        if (i < 0 || i >= draft.geo.length) return;
        const cur = draft.agl[i] ?? (st.project.settings.altitudeClearanceM ?? 50);
        const next = Math.max(0, Math.round((cur + stepM) * 10) / 10);
        const agl = { ...draft.agl, [i]: next };
        set({ routeDraft: { ...draft, agl } });
        const rid = draft.routeId;
        if (rid && (st.project.routes || []).some((r) => r.id === rid)) {
          get().setRoutePointAltitude(rid, i, next);
        }
      },

      // ─── Маршруты (режим действий) ────────────────────────────────────────

      addRoute: (points, name, color) => {
        const state = get();
        const routes = state.project.routes || [];
        if (routes.length >= MAX_ROUTES) {
          alert(`⚠️ Достигнут максимум маршрутов в сессии: ${MAX_ROUTES}. Удалите ненужные.`);
          return null;
        }
        if (!state.project.map) {
          alert('⚠️ Сначала загрузите карту — точки маршрута привязываются к её координатам.');
          return null;
        }
        const id = uuidv4();
        const route: Route = {
          id,
          name: name || `Маршрут ${routes.length + 1}`,
          color: color || ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
          points,
          active: true,
          visible: true,
          createdAt: new Date().toISOString(),
        };
        set((cur) => ({
          project: { ...cur.project, routes: [...(cur.project.routes || []), route], updatedAt: new Date().toISOString() },
          activeRouteId: id,
        }));
        get().rerouteAroundZones(id);
        return id;
      },

      deleteRoute: (id) => set((state) => ({
        project: {
          ...state.project,
          routes: (state.project.routes || []).filter((r) => r.id !== id),
          updatedAt: new Date().toISOString(),
        },
        activeRouteId: state.activeRouteId === id ? null : state.activeRouteId,
      })),

      renameRoute: (id, name) => set((state) => ({
        project: {
          ...state.project,
          routes: (state.project.routes || []).map((r) => (r.id === id ? { ...r, name } : r)),
          updatedAt: new Date().toISOString(),
        },
      })),

      setRouteColor: (id, color) => set((state) => ({
        project: {
          ...state.project,
          routes: (state.project.routes || []).map((r) => (r.id === id ? { ...r, color } : r)),
          updatedAt: new Date().toISOString(),
        },
      })),

      toggleRouteVisible: (id) => set((state) => ({
        project: {
          ...state.project,
          routes: (state.project.routes || []).map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)),
        },
      })),

      setActiveRoute: (id) => set((state) => ({
        activeRouteId: id,
        project: {
          ...state.project,
          routes: (state.project.routes || []).map((r) => ({ ...r, active: r.id === id })),
        },
      })),

      appendRoutePoint: (id, p) => {
        const state = get();
        const route = (state.project.routes || []).find((r) => r.id === id);
        const map = state.project.map;
        if (!route || !map) return;
        // Вставляем точку в ближайшее место ломаной (если клик не «за концом») —
        // так можно править середину существующего маршрута.
        let insertAt = route.points.length;
        if (route.points.length >= 2) {
          let bestD = Infinity;
          for (let i = 0; i < route.points.length - 1; i++) {
            const a = route.points[i], b = route.points[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy || 1e-9;
            let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
            if (d < bestD) { bestD = d; insertAt = i + 1; }
          }
          const lastA = route.points[route.points.length - 2];
          const lastB = route.points[route.points.length - 1];
          const endDist = Math.hypot(p.x - lastB.x, p.y - lastB.y);
          const midDist = Math.hypot(p.x - (lastA.x + lastB.x) / 2, p.y - (lastA.y + lastB.y) / 2);
          if (endDist <= midDist) insertAt = route.points.length; // продолжение в конец
        }
        get().insertRoutePointAt(id, insertAt, p);
      },

      insertRoutePointAt: (id, index, p) => {
        const state = get();
        const map = state.project.map;
        if (!map) return;
        const geo = map.bounds
          ? pixelToGeoStrict(p, map.bounds, map.width, map.height)
          : { lat: null as unknown as number, lng: null as unknown as number };
        const rp: RoutePoint = { x: p.x, y: p.y, lat: geo.lat, lng: geo.lng };
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => {
              if (r.id !== id) return r;
              const pts = [...r.points];
              pts.splice(index, 0, rp);
              return { ...r, points: pts };
            }),
            updatedAt: new Date().toISOString(),
          },
        }));
        get().rerouteAroundZones(id);
      },

      moveRoutePoint: (id, index, p) => {
        const state = get();
        const map = state.project.map;
        if (!map) return;
        const geo = map.bounds ? pixelToGeoStrict(p, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => {
              if (r.id !== id) return r;
              const pts = r.points.map((pt, i) =>
                i === index ? { ...pt, x: p.x, y: p.y, ...(Number.isFinite(geo.lat) ? { lat: geo.lat, lng: geo.lng } : {}) } : pt
              );
              return { ...r, points: pts };
            }),
            updatedAt: new Date().toISOString(),
          },
        }));
        get().rerouteAroundZones(id);
      },

      removeRoutePoint: (id, index) => {
        set((state) => ({
          project: {
            ...state.project,
            routes: (state.project.routes || [])
              .map((r) => (r.id === id ? { ...r, points: r.points.filter((_, i) => i !== index) } : r))
              .filter((r) => r.points.length >= 2),
            updatedAt: new Date().toISOString(),
          },
        }));
        const still = get().project.routes?.find((r) => r.id === id);
        if (still) get().rerouteAroundZones(id);
        else set({ activeRouteId: null });
      },

      setRoutePointAltitude: (id, index, aglM) => {
        // Ручная регулировка высоты этапа на промежуточной точке маршрута.
        // Значение AGL сохраняется в точку; требуемая ABS пересчитывается
        // applyVerticalLimits (terrain + AGL, с учётом полом/потолком зон).
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => {
              if (r.id !== id) return r;
              const pts = r.points.map((pt, i) =>
                i === index
                  ? {
                      ...pt,
                      altitudeAGL: aglM === null || !Number.isFinite(aglM) ? null : Math.max(0, aglM),
                    }
                  : pt
              );
              return { ...r, points: pts };
            }),
            updatedAt: new Date().toISOString(),
          },
        }));
        // Пересчёт высот по новой конфигурации (кэш Open-Elevation делает
        // повторный прогон дешёвым; при недоступном API terrainM остаётся
        // прежним и коррекция выполняется локально).
        void get().updateRouteAltitudes(id);
      },

      setWaypointParams: (routeId, index, params) => {
        // add_waypoint(lat, lon, alt, params): задержка/угол камеры/скорость/
        // радиус принятия хранятся по индексу точки маршрута. Некорректные
        // значения санитизируются (clamp), а не бросают исключение — UI может
        // передавать промежуточные состояния полей ввода.
        const clean = sanitizeWaypointParams(params);
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => {
              if (r.id !== routeId) return r;
              const wp: Record<number, WaypointParamsLite> = { ...(r.waypointParams || {}), [index]: clean };
              return { ...r, waypointParams: wp };
            }),
            updatedAt: new Date().toISOString(),
          },
        }));
      },

      setMissionMeta: (routeId, author) => {
        // create_mission(): метаданные миссии (ID/название уже есть у Route).
        const st = get();
        const route = (st.project.routes || []).find((r) => r.id === routeId);
        if (!route) return;
        let meta: MissionMetaLite;
        try {
          const m = createMissionMeta(routeId, route.name, author);
          meta = { author: m.author, createdAt: m.createdAt };
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          meta = { author: author.trim() || '—', createdAt: new Date().toISOString() };
        }
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => (r.id === routeId ? { ...r, missionMeta: meta } : r)),
            updatedAt: new Date().toISOString(),
          },
        }));
      },

      optimizeRouteOrder: (routeId, algorithm) => {
        if (get().isProcessing) return null; // UI-защита: мутация запрещена во время аплоада
        // optimize_route(waypoints, algorithm): перестановка путевых точек
        // (первая — старт — фиксирована). Параметры точек переносятся вместе
        // с точками. Возвращает % сокращения пути или null. После перестановки
        // — обход зон и пересчёт высот.
        const st = get();
        const route = (st.project.routes || []).find((r) => r.id === routeId);
        if (!route || route.points.length < 3) return null;
        // optimizeRoute работает в плоскости lat/lon: карта индексов + прокси-точки.
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
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) =>
              r.id === routeId ? { ...r, points: newPoints, waypointParams: newWp } : r
            ),
            updatedAt: new Date().toISOString(),
          },
        }));
        get().rerouteAroundZones(routeId);
        void get().updateRouteAltitudes(routeId);
        return res.improvementPct;
      },

      generateScanRoute: (polygonPx, spacingPx) => {
        if (get().isProcessing) return null; // UI-защита: мутация запрещена во время аплоада
        // scan_area(polygon, altitude, overlap_front, overlap_side): «змейка»
        // для сплошного сканирования полигона. Шаг змейки считается из
        // перекрытий вызывающей стороной; сюда приходит готовый spacing в px.
        const st = get();
        const map = st.project.map;
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
        return get().addRoute(pts, `Сканирование ${(st.project.routes || []).length + 1}`);
      },

      autoFixRoute: (id) => {
        // Кнопка «Автокоррекция маршрута»: немедленный обход ВСЕХ ограничений
        // без ожидания троттлинга подписчика.
        rerouteTimerCleanup();
        rerouteChainCount = 0;
        if (id) {
          get().rerouteAroundZones(id);
          void get().updateRouteAltitudes(id);
        } else {
          rerouteAllRoutesNow();
          void get().updateRouteAltitudes();
        }
      },

      rerouteAroundZones: (id) => {
        const state = get();
        const map = state.project.map;
        const route = (state.project.routes || []).find((r) => r.id === id);
        if (!map || !route || route.points.length < 2) return;
        // Активные зоны — из кэша (сбрасывается при изменении restrictions).
        // planPathAroundZones раньше получал ВСЕ restrictions и на КАЖДЫЙ
        // сегмент перестраивал препятствия (buildObstacles) — O(N×зон) на
        // каждый клик/движение точки. Плюс быстрый «грязевой» тест: если
        // отрезок не задевает ни одну активную зону, обходной движок вообще
        // не вызывается.
        const activeZones = getActiveZonesCached(state.project.restrictions);
        // Пользовательские точки (ключевые): пересчитываем обходные сегменты между соседними ключевыми.
        const keyIdx: number[] = [];
        for (let i = 0; i < route.points.length; i++) {
          if (!route.points[i].auto) keyIdx.push(i);
        }
        if (keyIdx.length < 2) keyIdx.push(route.points.length - 1);
        const newPts: RoutePoint[] = [];
        for (let k = 0; k < keyIdx.length - 1; k++) {
          const a = route.points[keyIdx[k]];
          const b = route.points[keyIdx[k + 1]];
          newPts.push({ ...a, auto: undefined as any });
          let path: Point[];
          if (activeZones.length === 0 || zonesCrossedBy([a, b], activeZones).length === 0) {
            path = [a, b]; // сегмент чист — дешёвый путь без построения препятствий
          } else {
            path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, activeZones, map.width, map.height);
          }
          for (let i = 1; i < path.length - 1; i++) {
            const px = path[i];
            const geo = map.bounds ? pixelToGeoStrict(px, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
            newPts.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
          }
        }
        newPts.push({ ...route.points[keyIdx[keyIdx.length - 1]] });
        // Кривая: сглаживаем обходную ломаную (ключевые точки остаются на месте)
        if (route.shape === 'curve') {
          const smooth = smoothPolyline(newPts.map((p) => ({ x: p.x, y: p.y })), 6);
          const bounds2 = map.bounds;
          const merged: RoutePoint[] = [];
          for (let i = 0; i < smooth.length; i++) {
            const sp = smooth[i];
            const near = newPts.find((p) => Math.hypot(p.x - sp.x, p.y - sp.y) < 1.5);
            if (near) { merged.push(near); continue; }
            const geo = bounds2 ? pixelToGeoStrict(sp, bounds2, map.width, map.height) : { lat: NaN, lng: NaN };
            merged.push({ x: sp.x, y: sp.y, lat: geo.lat, lng: geo.lng, auto: true });
          }
          newPts.length = 0;
          newPts.push(...merged);
        }
        // Предупреждения о зонах, через которые всё же проходит маршрут.
        // ВАЖНО: набор предупреждений ПОЛНОСТЬЮ заменяется для маршрута
        // (пустой массив удаляет запись), иначе «застывшие» ложные
        // предупреждения оставались бы навсегда после обхода зоны.
        const crossed = zonesCrossedBy(newPts.map((p) => ({ x: p.x, y: p.y })), activeZones);
        const warnings = crossed.map((z) => `Пересекает зону «${z.name}»`);
        // Проверка ограничения по дальности
        const limitWarn = rangeLimitWarning(route, newPts);
        if (limitWarn) warnings.push(limitWarn);
        set((cur) => {
          const rw = { ...cur.routeWarnings };
          if (warnings.length > 0) rw[id] = warnings;
          else delete rw[id];
          return {
            routeWarnings: rw,
            project: {
              ...cur.project,
              routes: (cur.project.routes || []).map((r) => (r.id === id ? { ...r, points: newPts } : r)),
              updatedAt: new Date().toISOString(),
            },
          };
        });
      },

      updateRouteAltitudes: async (routeId) => {
        // ВАЖНО (race guard): все синхронные мутации — ДО первого await.
        // Если отменять предыдущий контроллер после await, два быстрых
        // последовательных вызова создали бы по контроллеру и ни один не
        // был бы помечен aborted до старта сети (drag точек копил бы
        // обращения к троттлящемуся публичному API).
        const runId = ++altitudeRunId;
        const stale = lastAltitudeController;
        const controller = new AbortController();
        lastAltitudeController = controller;
        try { stale?.abort(); } catch { /* noop */ }
        const st = get();
        const map = st.project.map;
        // ВАЖНО: при досрочном выходе сбрасываем счётчик прогона, иначе
        // «мёртвый» runId останется текущим и завершающийся более старый
        // прогон не сможет быть им отменён (его routeWarnings перезапишут
        // состояние после отмены).
        if (!map?.bounds) {
          if (runId === altitudeRunId && lastAltitudeController === controller) {
            altitudeRunId--;
            lastAltitudeController = null;
          }
          return;
        }
        const clearance = Number.isFinite(st.project.settings.altitudeClearanceM as number)
          ? (st.project.settings.altitudeClearanceM as number) : 50;
        const routes = (st.project.routes || []).filter((r) => r.points.length >= 2);
        const targets = routeId ? routes.filter((r) => r.id === routeId) : routes;
        if (targets.length === 0) {
          // Досрочный выход без сетевой фазы: не оставляем «мёртвый» runId и
          // контроллер, иначе следующий прогон не отменит корректно состояние.
          if (runId === altitudeRunId && lastAltitudeController === controller) {
            altitudeRunId--;
            lastAltitudeController = null;
          }
          return;
        }

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
        if (keySet.size === 0) {
          if (runId === altitudeRunId && lastAltitudeController === controller) {
            altitudeRunId--;
            lastAltitudeController = null;
          }
          return;
        }
        const uniqPts = Array.from(keySet.values());
        const elevs = await fetchElevations(uniqPts, controller.signal);
        if (runId !== altitudeRunId) return; // более новый прогон отменил этот
        const elevByKey = new Map<string, number | null>();
        uniqPts.forEach((p, i) => elevByKey.set(`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, elevs[i]));

        // Фиксация снапшота сигнала ДО микрозадач computeRouteAltitude: если
        // прогон отменят во время set(), ни один «хвост» не должен попасть в
        // routeWarnings (иначе отменённый запрос перезапишет предупреждения).
        const tailAborted = (): boolean => controller.signal.aborted || runId !== altitudeRunId;
        set((cur) => {
          const rw: Record<string, string[]> = { ...cur.routeWarnings };
          const updatedRoutes = (cur.project.routes || []).map((r) => {
            if (!targets.some((t) => t.id === r.id)) return r;
            const pts: RoutePoint[] = r.points.map((p) => {
              const terr = elevByKey.get(`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`) ?? null;
              return { ...p, terrainM: terr };
            });
            // Автокоррекция вертикальных ограничений (пол/потолок AGL зон)
            // + базовое требование «рельеф + запас» → required ABS.
            const vWarns = applyVerticalLimits(pts, cur.project.restrictions, clearance);
            const merged = [...(rw[r.id] || [])].filter((w) => !w.startsWith('Высота') && !w.startsWith('Конфликт высотных'));
            for (const w of vWarns) if (!merged.includes(w)) merged.push(w);
            // Проверка профиля между узлами: computeRouteAltitude интерполирует
            // рельеф по Open-Elevation и ловит «нырки» маршрута ниже земли.
            // Запускается асинхронно ПОСЛЕ применения состояния (set ещё не
            // закоммичен — синхронный вызов устаревшим снапшотом перезаписал
            // бы только что проставленные terrainM/altitudeAbs).
            void Promise.resolve().then(() => computeRouteAltitude(pts.map((p) => ({ lat: p.lat, lng: p.lng })), { clearanceM: clearance }, controller.signal))
              .then((info) => {
                if (tailAborted()) return;
                useStore.setState((s2) => {
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
              })
              .catch(() => { /* сервис недоступен — мягкая деградация */ });
            if (merged.length > 0) rw[r.id] = merged; else delete rw[r.id];
            return { ...r, points: pts };
          });
          return {
            routeWarnings: rw,
            project: { ...cur.project, routes: updatedRoutes, updatedAt: new Date().toISOString() },
          };
        });
      },

      rerouteAllRoutes: () => {
        // Пользовательское действие (изменение зон/карты через API стора) —
        // обнуляем счётчик авто-цепочки, лимит в scheduleRerouteAll касается
        // только самогенерируемых каскадов.
        rerouteChainCount = 0;
        // ТРОТТЛИНГ: пакетная перестройка ВСЕХ маршрутов — дорогая операция
        // (обход зон для каждого). Без троттлинга каждое движение мыши / зум
        // вызывали полный пересчёт -> вкладка «виснет» намертво.
        // ВАЖНО: ссылка таймера хранится В МОДУЛЬНОЙ ЗАМЫКАНИИ, а не в объекте
        // стейта. Запись напрямую в стейт через (get() as any) нарушала
        // иммутабельность zustand и терялась при HMR/ре-гидратации — из-за
        // этого пакетная перестройка могла молча не выполняться.
        if (rerouteTimer != null) clearTimeout(rerouteTimer);
        rerouteTimer = window.setTimeout(() => {
          rerouteTimer = null;
          rerouteAllRoutesNow();
        }, REROUTE_THROTTLE_MS);
      },

      __rerouteAllRoutesNow: () => rerouteAllRoutesNow(),

      flushReroute: () => {
        if (rerouteTimer != null) { clearTimeout(rerouteTimer); rerouteTimer = null; }
        rerouteChainCount = 0;
        rerouteAllRoutesNow();
      },

      refreshAllRoutesAfterMapChange: () => {
        const state = get();
        const map = state.project.map;
        if (!map?.bounds) return;
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => recomputeRoutePixels(r, map.bounds!, map.width, map.height)),
          },
        }));
        get().rerouteAllRoutes(); // новые границы карты — пересобираем обходы зон
      },

      clearRouteWarnings: (id) => set((state) => {
        const copy = { ...state.routeWarnings };
        delete copy[id];
        return { routeWarnings: copy };
      }),

      setRouteShape: (id, shape) => {
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => (r.id === id ? { ...r, shape } : r)),
            updatedAt: new Date().toISOString(),
          },
        }));
        get().rerouteAroundZones(id); // перестраиваем сглаживание/ломаную
      },

      setRouteRangeLimit: (id, mode, meters) => {
        set((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) =>
              r.id === id ? { ...r, rangeMode: mode, rangeM: mode === 'off' ? undefined : meters ?? r.rangeM } : r
            ),
            updatedAt: new Date().toISOString(),
          },
        }));
        get().rerouteAroundZones(id); // пересчитать предупреждения по дальности
      },

      importLists: (starts, goals) => {
        const state = get();
        const map = state.project.map;
        if (!map) { alert('⚠️ Сначала загрузите карту — точки привязываются к её координатам.'); return 0; }
        const existing = state.project.routes || [];
        const freeSlots = Math.max(0, MAX_ROUTES - existing.length);
        const n = Math.min(Math.max(starts.length, goals.length), freeSlots);
        if (n === 0) {
          alert(`⚠️ Достигнут максимум маршрутов в сессии: ${MAX_ROUTES}.`);
          return 0;
        }
        const toRoutePoint = (pt: { lat: number; lng: number }): RoutePoint => {
          const px = map.bounds
            ? geoToPixelFromBounds({ lat: pt.lat, lng: pt.lng }, map.bounds, map.width, map.height)
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
          const prevLists = cur.project.importLists;
          const lists: ImportLists = {
            starts: [...(prevLists?.starts || []), ...impStarts],
            goals: [...(prevLists?.goals || []), ...impGoals],
          };
          return {
            project: {
              ...cur.project,
              routes: [...(cur.project.routes || []), ...newRoutes],
              importLists: lists,
              updatedAt: new Date().toISOString(),
            },
          };
        });
        get().rerouteAllRoutes(); // автообход зон для новых маршрутов
        return n;
      },

      clearImportLists: () => set((cur) => ({
        project: { ...cur.project, importLists: undefined, updatedAt: new Date().toISOString() },
      })),

      setTool: (tool) => set({ currentTool: tool, isDrawing: false, drawingPoints: [] }),

      loadMap: (mapData) => set((state) => ({
        project: {
          ...state.project,
          map: mapData,
          updatedAt: new Date().toISOString(),
        },
      })),

      addMarker: (markerData) => set((state) => {
        const id = uuidv4();
        const markerCount = state.project.markers.length + 1;
        const marker: Marker = {
          id,
          name: markerData.name || `Точка ${markerCount}`,
          x: markerData.x || 0,
          y: markerData.y || 0,
          lat: markerData.lat || null,
          lon: markerData.lon || null,
          type: markerData.type || 'default',
          color: markerData.color || '#00ff00',
          comment: markerData.comment || '',
          layer: markerData.layer || 'default',
          createdAt: new Date().toISOString(),
          terrainM: markerData.terrainM ?? null,
        };
        return {
          project: {
            ...state.project,
            markers: [...state.project.markers, marker],
            updatedAt: new Date().toISOString(),
          },
          selectedMarkerId: id,
        };
      }),

      updateMarker: (id, updates) => set((state) => ({
        project: {
          ...state.project,
          markers: state.project.markers.map((m) =>
            m.id === id ? { ...m, ...updates } : m
          ),
          updatedAt: new Date().toISOString(),
        },
      })),

      deleteMarker: (id) => {
        if (get().isProcessing) return; // UI-защита от мутаций во время аплоада
        set((state) => ({
        project: {
          ...state.project,
          markers: state.project.markers.filter((m) => m.id !== id),
          updatedAt: new Date().toISOString(),
        },
        selectedMarkerId: state.selectedMarkerId === id ? null : state.selectedMarkerId,
      }));
      },

      selectMarker: (id) => set({ selectedMarkerId: id, selectedRestrictionId: null }),

      addRestriction: (restrictionData) => {
        invalidateZoneCache();
        return set((state) => {
        const id = uuidv4();
        const restriction: Restriction = {
          id,
          type: restrictionData.type || 'polygon',
          points: restrictionData.points || [],
          radius: restrictionData.radius,
          color: restrictionData.color || '#ff000080',
          name: restrictionData.name || `Ограничение ${state.project.restrictions.length + 1}`,
          active: restrictionData.active !== undefined ? restrictionData.active : true,
          minHeightAGL: restrictionData.minHeightAGL ?? null,
          maxHeightAGL: restrictionData.maxHeightAGL ?? null,
        };
        // ВАЖНО: НЕ вызываем rerouteAllRoutes() синхронно здесь — добавление зоны
        // происходит из обработчика клика/двойного клика; перестройку выполняет
        // троттлинговый подписчик на изменения restrictions (см. useEffect в MapCanvas).
        return {
          project: {
            ...state.project,
            restrictions: [...state.project.restrictions, restriction],
            updatedAt: new Date().toISOString(),
          },
          activeRestrictionId: restriction.id,
        };
        });
      },

      // undo/redo для рисования полигонов (и любых точек рисования)
      undoDrawingPoint: () => set((state) => {
        if (state.drawingPoints.length === 0) return {};
        const removed = state.drawingPoints[state.drawingPoints.length - 1];
        const pts = state.drawingPoints.slice(0, -1);
        return {
          drawingPoints: pts,
          isDrawing: pts.length > 0 && state.isDrawing,
          redoDrawingStack: [...state.redoDrawingStack, removed],
        };
      }),

      redoDrawingPoint: () => set((state) => {
        const stack = state.redoDrawingStack;
        if (stack.length === 0) return {};
        const last = stack[stack.length - 1];
        return {
          drawingPoints: [...state.drawingPoints, last],
          isDrawing: true,
          redoDrawingStack: stack.slice(0, -1),
        };
      }),

      updateRestriction: (id, updates) => {
        invalidateZoneCache(); // геометрия/флаг зоны изменились — кэш активных зон недействителен
        set((state) => ({
          project: {
            ...state.project,
            restrictions: state.project.restrictions.map((r) =>
              r.id === id ? { ...r, ...updates } : r
            ),
            updatedAt: new Date().toISOString(),
          },
        }));
        // Перестройку выполняет единственный троттлинговый подписчик на
        // изменения restrictions (MapCanvas). Синхронный вызов отсюда создавал
        // двойной запуск пакетной перестройки на каждое изменение зон.
      },

      // ВАЖНО: deleteRestriction объявлена ДО makeGuarded, поэтому ссылка на
      // get() внутри — «поздняя» (lazy), вызывается только при клике.
      deleteRestriction: (id) => {
        if (get().isProcessing) return; // UI-защита от мутаций во время аплоада
        invalidateZoneCache();
        set((state) => ({
          project: {
            ...state.project,
            restrictions: state.project.restrictions.filter((r) => r.id !== id),
            updatedAt: new Date().toISOString(),
          },
          activeRestrictionId: state.activeRestrictionId === id ? null : state.activeRestrictionId,
          selectedRestrictionId: state.selectedRestrictionId === id ? null : state.selectedRestrictionId,
        }));
        // reroute — через троттлинговый подписчик на restrictions (см. MapCanvas)
      },

      selectRestriction: (id) => set({ selectedRestrictionId: id, selectedMarkerId: null }),

      setActiveRestriction: (id) => {
        invalidateZoneCache();
        set((state) => ({
          activeRestrictionId: id,
          project: {
            ...state.project,
            restrictions: state.project.restrictions.map((r) => ({
              ...r,
              active: r.id === id,
            })),
            updatedAt: new Date().toISOString(),
          },
        }));
        // set-active меняет набор активных зон → маршруты должны перестроиться.
        // Перестройку выполняет ЕДИНСТВЕННЫЙ троттлинговый подписчик на изменения
        // restrictions (MapCanvas). Синхронный вызов отсюда создавал двойной
        // запуск пакетной перестройки (п.2) и обходил схему «одного владельца».
      },

      addLayer: (name) => set((state) => {
        const id = uuidv4();
        return {
          project: {
            ...state.project,
            layers: [...state.project.layers, { id, name, visible: true, locked: false }],
            updatedAt: new Date().toISOString(),
          },
        };
      }),

      updateLayer: (id, updates) => set((state) => ({
        project: {
          ...state.project,
          layers: state.project.layers.map((l) =>
            l.id === id ? { ...l, ...updates } : l
          ),
          updatedAt: new Date().toISOString(),
        },
      })),

      deleteLayer: (id) => set((state) => ({
        project: {
          ...state.project,
          layers: state.project.layers.filter((l) => l.id !== id),
          updatedAt: new Date().toISOString(),
        },
      })),

      setViewState: (viewState) => set((state) => ({
        viewState: { ...state.viewState, ...viewState },
        // счётчик вида: селекторы компонентов (selectViewForRender) пересчитываются
        // при каждом изменении вида; без него re-render мог видеть устаревший/не
        // гидрированный viewState (краш «viewState is not defined» на проде)
        viewTick: state.viewTick + 1,
      })),

      setCursorPosition: (pos) => set({ cursorPosition: pos }),

      setDrawing: (isDrawing) => set({ isDrawing }),

      addDrawingPoint: (point) => set((state) => ({
        drawingPoints: [...state.drawingPoints, point],
        redoDrawingStack: [], // новое действие очищает redo-стек
      })),

      clearDrawingPoints: () => set({ drawingPoints: [], isDrawing: false, redoDrawingStack: [] }),

      setMeasurementPoints: (points) => set({ measurementPoints: points }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setFilterType: (type) => set({ filterType: type }),

      importProject: (project) => {
        invalidateZoneCache(); // набор зон заменён целиком — кэш недействителен
        return set({
          project,
          selectedMarkerId: null,
          selectedRestrictionId: null,
          viewState: { offsetX: 0, offsetY: 0, scale: 1 },
        });
      },

      exportProject: () => get().project,

      setProjectName: (name) => set((state) => ({
        project: { ...state.project, projectName: name, updatedAt: new Date().toISOString() },
      })),

      resetProject: () => set({
        project: { ...defaultProject, routes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        currentTool: 'pan',
        activeRestrictionId: null,
        selectedMarkerId: null,
        selectedRestrictionId: null,
        activeRouteId: null,
        routeWarnings: {},
        viewState: { offsetX: 0, offsetY: 0, scale: 1 },
        cursorPosition: null,
        isDrawing: false,
        drawingPoints: [],
        measurementPoints: [],
      }),

      addCalibrationPoint: (point) => set((state) => ({
        project: {
          ...state.project,
          calibration: {
            ...state.project.calibration,
            points: [...(state.project.calibration?.points || []), point],
          },
          updatedAt: new Date().toISOString(),
        },
      })),

      removeCalibrationPoint: (index) => set((state) => ({
        project: {
          ...state.project,
          calibration: {
            ...state.project.calibration,
            points: (state.project.calibration?.points || []).filter((_, i) => i !== index),
          },
          updatedAt: new Date().toISOString(),
        },
      })),

      toggleCalibration: (enabled) => set((state) => ({
        project: {
          ...state.project,
          calibration: { ...state.project.calibration, enabled },
          updatedAt: new Date().toISOString(),
        },
      })),

      updateSettings: (settings) => set((state) => ({
        project: {
          ...state.project,
          settings: { ...state.project.settings, ...settings },
          updatedAt: new Date().toISOString(),
        },
      })),

      setGoogleMapsApiKey: (apiKey) => set((state) => ({
        project: {
          ...state.project,
          googleMaps: { ...state.project.googleMaps, apiKey },
          updatedAt: new Date().toISOString(),
        },
      })),

      toggleGoogleMaps: (enabled) => set((state) => ({
        project: {
          ...state.project,
          googleMaps: { ...state.project.googleMaps, enabled },
          updatedAt: new Date().toISOString(),
        },
      })),

      setMapBounds: (bounds) => set((state) => ({
        project: {
          ...state.project,
          map: state.project.map ? { ...state.project.map, bounds } : null,
          updatedAt: new Date().toISOString(),
        },
      })),

      setYandexMapsApiKey: (apiKey) => set((state) => ({
        project: {
          ...state.project,
          yandexMaps: { ...state.project.yandexMaps, apiKey },
          updatedAt: new Date().toISOString(),
        },
      })),

      toggleYandexMaps: (enabled) => set((state) => ({
        project: {
          ...state.project,
          yandexMaps: { ...state.project.yandexMaps, enabled },
          updatedAt: new Date().toISOString(),
        },
      })),

      toggleOpenStreetMap: (enabled) => set((state) => ({
        project: {
          ...state.project,
          openStreetMap: { ...state.project.openStreetMap, enabled },
          updatedAt: new Date().toISOString(),
        },
      })),

      setOSMTileServer: (server) => set((state) => ({
        project: {
          ...state.project,
          openStreetMap: { ...state.project.openStreetMap, tileServer: server },
          updatedAt: new Date().toISOString(),
        },
      })),

      loadMapWithStorage: async (mapData) => {
        // Сохраняем карту в IndexedDB под стабильным ID — старые карты не затираются
        const mapId = uuidv4();
        await saveMapToIndexedDB(mapId, mapData.dataUrl);

        // dataUrl остаётся в памяти для немедленного отображения;
        // в localStorage он не сохраняется (см. partialize) и восстанавливается из IndexedDB
        set((state) => ({
          project: {
            ...state.project,
            map: { ...mapData, mapId },
            updatedAt: new Date().toISOString(),
          },
          _currentMapId: mapId,
        }));
        // Маршруты строго привязаны к географии: пересчитываем их пиксели под новые границы карты
        get().refreshAllRoutesAfterMapChange();
      },

      /**
       * Активная тайловая карта без растрового снимка: создаёт «виртуальную» карту
       * с точной Mercator-привязкой (bounds → world px z19), чтобы все режимы
       * (маршруты, зоны, сетка, клик по карте) работали от реальных координат,
       * а подложка масштабировалась интерактивно до 1 см ≈ 100 м и ближе.
       */
      loadActiveTileMap: (center, zoom) => {
        const z = Math.max(MIN_MAP_ZOOM_FLOOR, Math.min(19, Math.round(zoom)));
        // ── Эталонная привязка «как на openstreetmap.org» ─────────────────────
        // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ («карта грузится, но не видна»): раньше bounds
        // строились как ОДНО ОКНО размером 256·2^z вокруг центра, а виртуальный
        // раст — как ПОЛНЫЙ меркаторов мир уровня z (width = height = 256·2^z).
        // Из-за этого bounds покрывали весь мир (west ≈ −142°, east > 180°,
        // north ≈ 88°), а auto-fit при открытии считал из них зум ≈ 23 и уводил
        // камеру в космос: тайловый слой получал transform вроде
        // translate(-1.57e7px, -1.24e7px) — подложка «загружалась», но была
        // полностью вне экрана. Теперь это согласованная пара:
        //   растр = полный мир уровня z (256·2^z), pixel(x,y) ⇔ tile(x/256, y/256);
        //   bounds = РОВНО тот же полный мир (−180..180, ±merc-пределы).
        // Привязка пикселей растра к географии становится тождественной
        // (pixel ⇔ tile), любой пиксель карты имеет однозначную гео-привязку
        // при любом панорамировании, а стартовый вид = запрошенный зум z.
        const worldPx = 256 * Math.pow(2, z);
        const b: MapBounds = {
          west: -180,
          east: 180,
          north: mercatorYToLat(0),
          south: mercatorYToLat(1),
        };
        const mapData: MapData = {
          name: `Активная карта: ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} (z${z})`,
          width: worldPx,   // full-меркаторов мир уровня z — строгая привязка координат
          height: worldPx,
          dataUrl: '', // без фотографии — подложка грузится тайлами динамически
          bounds: b,
          source: 'osm',
        };
        set((state) => ({
          project: {
            ...state.project,
            map: mapData,
            settings: { ...state.project.settings, tilesEnabled: true },
            updatedAt: new Date().toISOString(),
          },
        }));
        get().refreshAllRoutesAfterMapChange();
      },

      restoreMapFromStorage: async () => {
        const state = get();
        const map = state.project.map;
        if (!map || map.dataUrl) return; // изображение уже в памяти

        // Стабильный ID хранится в самой карте; _currentMapId — обратная совместимость со старыми проектами
        const mapId = map.mapId || state._currentMapId;
        if (!mapId) return;

        const dataUrl = await loadMapFromIndexedDB(mapId);
        if (dataUrl) {
          set((cur) => ({
            project: {
              ...cur.project,
              map: cur.project.map ? { ...cur.project.map, dataUrl } : cur.project.map,
            },
          }));
          // Пиксели маршрутов были рассчитаны по старому/пустому растру — после
          // восстановления изображения пересчитываем их из lat/lng, иначе точки
          // маршрутов остаются «привязанными» к несуществующим пикселям.
          get().refreshAllRoutesAfterMapChange();
        }
      },
    }),
    {
      name: 'totalquadro-storage',
      version: 2,
      // Явная JSON-гидрация из localStorage. Важно: при default storage persist
      // записывает восстановленные поля в объект стейта через Object.assign
      // (in-place мутация до первого notify). Если компонент успевает отрендериться
      // в этом окне, он читает частично гидрированный viewState и падает с
      // ReferenceError/TypeError («viewState is not defined» на проде).
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        project: {
          ...state.project,
          // Не сохраняем map.dataUrl в localStorage - он слишком большой
          map: state.project.map ? {
            ...state.project.map,
            dataUrl: '', // Очищаем dataUrl перед сохранением
          } : null,
        },
        _currentMapId: state._currentMapId, // Сохраняем ID карты для восстановления
        droneAssignments: state.droneAssignments, // старт/цель/маршрут каждого дрона
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) console.warn('[persist] rehydration failed:', error);
        // Принудительный set() после гидрации: гарантирует новый ссылочный ярлык
        // viewTick и уведомление всех подписчиков — компоненты гарантированно
        // перерисуются уже с полностью восстановленным состоянием.
        try {
          useStore.setState((s) => ({ viewTick: s.viewTick + 1 }));
        } catch { /* стор ещё не создан (первичная синхронная гидрация) — не страшно */ }
      },
      migrate: (persistedState: any, version: number) => {
        // Миграция для старых проектов без googleMaps
        if (persistedState.project && !persistedState.project.googleMaps) {
          persistedState.project.googleMaps = {
            apiKey: '',
            enabled: false,
          };
        }
        // Миграция для старых проектов без yandexMaps
        if (persistedState.project && !persistedState.project.yandexMaps) {
          persistedState.project.yandexMaps = {
            apiKey: '',
            enabled: false,
          };
        }
        // Миграция для старых проектов без openStreetMap
        if (persistedState.project && !persistedState.project.openStreetMap) {
          persistedState.project.openStreetMap = {
            enabled: false,
            tileServer: 'osm',
          };
        }
        // Миграция для старых проектов без calibration
        if (persistedState.project && !persistedState.project.calibration) {
          persistedState.project.calibration = {
            enabled: false,
            points: [],
          };
        }
        // Миграция для старых проектов без settings
        if (persistedState.project && !persistedState.project.settings) {
          persistedState.project.settings = {
            showGrid: false,
            gridSize: 0,
            showCoordinates: true,
            theme: 'dark',
            tilesEnabled: true,
            tileStyle: 'scheme',
          };
        } else if (persistedState.project?.settings) {
          // существующие проекты: включаем активную тайловую карту по умолчанию
          if (persistedState.project.settings.tilesEnabled === undefined) persistedState.project.settings.tilesEnabled = true;
          // Режимы «спутник/гибрид» и внешние Overpass-слои удалены из приложения:
          // нормализуем сохранённые настройки к стандартной схеме.
          persistedState.project.settings.tileStyle = 'scheme';
          delete (persistedState.project.settings as any).airportsLayer;
          delete (persistedState.project.settings as any).geozonesLayer;
          delete (persistedState.project.settings as any).notamLayer;
        }
        // Миграция для старых проектов без маршрутов
        if (persistedState.project && !Array.isArray(persistedState.project.routes)) {
          persistedState.project.routes = [];
        }
        // Нормализация viewState: старые версии хранилища могли записать вид без
        // поля z0 (или с «грязным» значением null/строкой). Все потребители вида
        // защищаются через `z0 ?? ZOOM_REF`, но миграция гарантирует корректные
        // числовые offset/scale уже на входе — без NaN в координатах канваса.
        if (persistedState.viewState !== undefined) {
          persistedState.viewState = normalizeViewState(persistedState.viewState);
        }
        return persistedState;
      },
    }
  )
);

/** Безопасный доступ к состоянию стора из раннего контекста (до гидрации persist). */
export const getAppStateSafe = makeStoreShim(useStore);
