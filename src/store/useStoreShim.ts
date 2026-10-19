// ═══════════════════════════════════════════════════════════════
// useStore — фасад совместимости поверх трёх доменных сторов
// (map / mission / fleet). Позволяет существующим компонентам работать
// без правок: useStore(selector), useStore(), useStore.getState(),
// useStore.setState(), useStore.subscribe().
// Внутри — единый снапшот-агрегат, синхронизируемый подписками на сторы;
// все мутации проходят через экшены доменных сторов, поэтому агрегат
// всегда иммутабелен и React-безопасен (useSyncExternalStore + кэш
// результата селектора по Object.is — как в zustand).
// Новый код должен импортировать useMapStore/useMissionStore/useFleetStore напрямую.
// ═══════════════════════════════════════════════════════════════
import { useSyncExternalStore } from 'react';
import type { Project, Tool, ViewState, Point } from '../types';
import { useMapStore, invalidateZoneCache as invalidateZoneCacheLocal, selectViewForRender as selectMapView } from './useMapStore';
import { useMissionStore, rerouteAllNow } from './useMissionStore';
import { useFleetStore } from './useFleetStore';
import { clearAllStoredMaps } from '../utils/storage';

// Реэкспорт публичных утилит старого модуля — компоненты/тесты импортируют их из './useStore'
export { getActiveZonesCached, invalidateZoneCache, normalizeViewState, selectViewForRender } from './useMapStore';
export { scheduleRerouteAll } from './useMissionStore';

type MapS = ReturnType<typeof useMapStore.getState>;
type MisS = ReturnType<typeof useMissionStore.getState>;
type FltS = ReturnType<typeof useFleetStore.getState>;

/** Агрегат = прежний AppState проекта + UI-состояние (для selector-совместимости). */
export interface LegacySnapshot {
  project: Project;
  droneAssignments: FltS['droneAssignments'];
  currentTool: Tool;
  activeRestrictionId: string | null;
  selectedMarkerId: string | null;
  selectedRestrictionId: string | null;
  viewState: ViewState;
  viewTick: number;
  cursorPosition: Point | null;
  isDrawing: boolean;
  drawingPoints: Point[];
  measurementPoints: Point[];
  searchQuery: string;
  filterType: string;
  activeRouteId: string | null;
  routeWarnings: Record<string, string[]>;
  redoDrawingStack: Point[];
  _currentMapId?: string;
  routeDraft: MisS['routeDraft'];
  /** Глобальный флаг «идёт тяжёлая/сетевая операция» (upload миссии, пересчёт
   *  высот) — проксируется из useMissionStore для UI-блокировок. */
  isProcessing: boolean;
}

const projectNameRef = { value: 'Новый проект', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

function buildSnapshot(): LegacySnapshot {
  const m = useMapStore.getState();
  const mi = useMissionStore.getState();
  const f = useFleetStore.getState();
  const project: Project = {
    version: '1.1',
    projectName: projectNameRef.value,
    createdAt: projectNameRef.createdAt,
    updatedAt: projectNameRef.updatedAt,
    map: m.map,
    calibration: m.calibration,
    restrictions: m.restrictions,
    markers: m.markers,
    routes: mi.routes,
    importLists: mi.importLists,
    layers: m.layers,
    settings: m.settings,
    googleMaps: m.googleMaps,
    yandexMaps: m.yandexMaps,
    openStreetMap: m.openStreetMap,
  };
  return {
    project,
    droneAssignments: f.droneAssignments,
    currentTool: m.currentTool,
    activeRestrictionId: m.activeRestrictionId,
    selectedMarkerId: m.selectedMarkerId,
    selectedRestrictionId: m.selectedRestrictionId,
    viewState: m.viewState,
    viewTick: m.viewTick,
    cursorPosition: m.cursorPosition,
    isDrawing: m.isDrawing,
    drawingPoints: m.drawingPoints,
    measurementPoints: m.measurementPoints,
    searchQuery: m.searchQuery,
    filterType: m.filterType,
    activeRouteId: mi.activeRouteId,
    routeWarnings: mi.routeWarnings,
    redoDrawingStack: m.redoDrawingStack,
    _currentMapId: m._currentMapId,
    routeDraft: mi.routeDraft,
    isProcessing: mi.isProcessing,
  };
}

let snapshot: LegacySnapshot = buildSnapshot();
const listeners = new Set<() => void>();

useMapStore.subscribe(() => emit());
useMissionStore.subscribe(() => emit());
useFleetStore.subscribe(() => emit());

// ─── Миграция legacy persist (totalquadro-storage v2 → tq-map/tq-mission/tq-fleet) ──
// Выполняется ОДИН раз при старте приложения (см. App.tsx): если новые ключи
// пусты, а старый есть — разбираем старый project по доменам и удаляем legacy.
export function migrateLegacyStorage(): void {
  try {
    if (localStorage.getItem('tq-map')) return; // уже мигрировано
    const raw = localStorage.getItem('totalquadro-storage');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, any>; version?: number };
    const st = parsed.state ?? {};
    const p = (st.project ?? {}) as Partial<Project>;
    const geo = {
      map: p.map ?? null,
      markers: p.markers ?? [],
      restrictions: p.restrictions ?? [],
      layers: p.layers?.length ? p.layers : [{ id: 'default', name: 'Основной', visible: true, locked: false }],
      calibration: p.calibration ?? { enabled: false, points: [] },
      googleMaps: p.googleMaps ?? { apiKey: '', enabled: false },
      yandexMaps: p.yandexMaps ?? { apiKey: '', enabled: false },
      openStreetMap: p.openStreetMap ?? { enabled: false, tileServer: 'osm' as const },
      settings: p.settings ?? undefined,
      _currentMapId: st._currentMapId,
      currentTool: st.currentTool ?? 'pan',
      viewState: st.viewState ?? { offsetX: 0, offsetY: 0, scale: 1 },
      activeRestrictionId: st.activeRestrictionId ?? null,
      searchQuery: st.searchQuery ?? '',
      filterType: st.filterType ?? '',
    };
    useMapStore.setState(geo as never);
    projectNameRef.value = p.projectName ?? 'Новый проект';
    projectNameRef.createdAt = p.createdAt ?? projectNameRef.createdAt;
    useMissionStore.setState({
      routes: p.routes ?? [],
      importLists: p.importLists,
      activeRouteId: st.activeRouteId ?? null,
    });
    if (Array.isArray(st.droneAssignments)) {
      useFleetStore.setState({ droneAssignments: st.droneAssignments });
    }
    localStorage.removeItem('totalquadro-storage');
    emit();
  } catch (e) {
    console.warn('[useStore shim] legacy migration failed:', e);
  }
}

// ─── setState-маршрутизация (обратная совместимость прямых setState из компонентов) ──
type SetArg = Partial<LegacySnapshot> | ((s: LegacySnapshot) => Partial<LegacySnapshot>);

function applyPatch(patch: Partial<LegacySnapshot>): void {
  const m: Record<string, unknown> = {};
  const mi: Record<string, unknown> = {};
  const f: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'project': {
        const proj = v as Project;
        if (proj.projectName !== undefined) projectNameRef.value = proj.projectName;
        if (proj.createdAt) projectNameRef.createdAt = proj.createdAt;
        if (proj.updatedAt) projectNameRef.updatedAt = proj.updatedAt;
        m.map = proj.map; m.markers = proj.markers; m.restrictions = proj.restrictions;
        m.layers = proj.layers; m.calibration = proj.calibration; m.googleMaps = proj.googleMaps;
        m.yandexMaps = proj.yandexMaps; m.openStreetMap = proj.openStreetMap; m.settings = proj.settings;
        mi.routes = proj.routes ?? []; mi.importLists = proj.importLists;
        break;
      }
      case 'droneAssignments': f.droneAssignments = v; break;
      case 'routes': mi.routes = v; break;
      case 'activeRouteId': mi.activeRouteId = v; break;
      case 'routeWarnings': mi.routeWarnings = v; break;
      case 'routeDraft': mi.routeDraft = v; break;
      case 'importLists': mi.importLists = v; break;
      case 'currentTool': m.currentTool = v; break;
      case 'viewState': m.viewState = v; break;
      case 'viewTick': m.viewTick = v; break;
      case 'cursorPosition': m.cursorPosition = v; break;
      case 'isDrawing': m.isDrawing = v; break;
      case 'drawingPoints': m.drawingPoints = v; break;
      case 'redoDrawingStack': m.redoDrawingStack = v; break;
      case 'measurementPoints': m.measurementPoints = v; break;
      case 'searchQuery': m.searchQuery = v; break;
      case 'filterType': m.filterType = v; break;
      case 'selectedMarkerId': m.selectedMarkerId = v; break;
      case 'selectedRestrictionId': m.selectedRestrictionId = v; break;
      case 'activeRestrictionId': m.activeRestrictionId = v; break;
      case '_currentMapId': m._currentMapId = v; break;
      default: break; // неизвестные поля игнорируются (как раньше — zustand merge их не ждал)
    }
  }
  if (Object.keys(m).length) useMapStore.setState(m as never);
  if (Object.keys(mi).length) useMissionStore.setState(mi as never);
  if (Object.keys(f).length) useFleetStore.setState(f as never);
}

// ─── Публичный API шима ────────────────────────────────────────

/** Тип аргумента экшена/селектора: снапшот + все экшены доменных сторов. */
export type StoreView = LegacySnapshot & MapS & MisS & FltS & {
  // Проектные экшены верхнего уровня (навешиваются на useStore ниже)
  setProjectName: (name: string) => void;
  exportProject: () => Project;
  importProject: (project: Project) => void;
  resetProject: () => void;
  __rerouteAllRoutesNow: () => void;
};

interface UseStoreShim {
  <T>(selector: (s: StoreView) => T): T;
  (): StoreView;
  getState(): StoreView;
  setState: (arg: SetArg) => void;
  subscribe: (listener: (s: LegacySnapshot, prev: LegacySnapshot) => void) => () => void;
}

function buildMerged(): StoreView {
  // Экшены доменных сторов доступны через spread getState(); порядок важен:
  // project/UI-поля снапшота перекрывают одноимённые «сырые» поля сторов.
  return {
    ...useMapStore.getState(),
    ...useMissionStore.getState(),
    ...useFleetStore.getState(),
    ...snapshot,
  } as StoreView;
}

let mergedCache: StoreView | null = null;
function getMerged(): StoreView {
  if (!mergedCache) mergedCache = buildMerged();
  return mergedCache;
}

/** Атомарная инвалидация снапшота + кэша агрегата и оповещение подписчиков. */
function emit(): void {
  snapshot = buildSnapshot();
  mergedCache = null; // инвалидация кэша агрегата — перестроится при следующем чтении
  listeners.forEach((l) => l());
}

const subscribeImpl = (listener: (s: LegacySnapshot, prev: LegacySnapshot) => void) => {
  let prev = snapshot;
  const wrapped = () => {
    const cur = snapshot;
    listener(cur, prev);
    prev = cur;
  };
  listeners.add(wrapped);
  return () => { listeners.delete(wrapped); };
};

const subscribePlain = (cb: () => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

// Кэш результата селектора по Object.is (как equality-fn в zustand): без него
// useSyncExternalStore зацикливает рендер при inline-селекторах, возвращающих
// новые объекты на каждый вызов (React error #185).
let lastSel: ((s: StoreView) => unknown) | null = null;
let lastSnapRef: unknown = null;
let lastResult: unknown = undefined;
let hasLast = false;

function readSelected<T>(selector?: (s: StoreView) => T): T | StoreView {
  const snap = getMerged();
  if (!selector) return snap as unknown as T | StoreView;
  if (hasLast && snap === lastSnapRef && selector === lastSel) return lastResult as T;
  const res = selector(snap);
  lastSel = selector; lastSnapRef = snap; lastResult = res; hasLast = true;
  return res;
}

function useStoreHook<T>(selector?: (s: StoreView) => T): T | StoreView {
  return useSyncExternalStore(
    subscribePlain,
    () => readSelected(selector),
    () => readSelected(selector),
  );
}

export const useStore = (useStoreHook as unknown) as UseStoreShim;

(useStore as any).getState = getMerged;
(useStore as any).setState = (arg: SetArg) => {
  const patch = typeof arg === 'function' ? arg(snapshot) : arg;
  applyPatch(patch);
};
(useStore as any).subscribe = subscribeImpl;

// ─── Проектные экшены верхнего уровня (имена/поведение прежнего API) ────────
// Терра-кодирование: project — агрегированный вид, данные живут в доменах.

const shimActions = useStore as any;

shimActions.setProjectName = (name: string) => {
  projectNameRef.value = name;
  projectNameRef.updatedAt = new Date().toISOString();
  emit();
};

shimActions.exportProject = (): Project => snapshot.project;

shimActions.importProject = (project: Project) => {
  invalidateZoneCacheLocal(); // набор зон заменён целиком — кэш недействителен
  projectNameRef.value = project.projectName ?? 'Новый проект';
  projectNameRef.createdAt = project.createdAt ?? projectNameRef.createdAt;
  projectNameRef.updatedAt = project.updatedAt ?? new Date().toISOString();
  useMapStore.setState({
    map: project.map ?? null,
    markers: project.markers ?? [],
    restrictions: project.restrictions ?? [],
    layers: project.layers?.length ? project.layers : [{ id: 'default', name: 'Основной', visible: true, locked: false }],
    calibration: project.calibration ?? { enabled: false, points: [] },
    googleMaps: project.googleMaps ?? { apiKey: '', enabled: false },
    yandexMaps: project.yandexMaps ?? { apiKey: '', enabled: false },
    openStreetMap: project.openStreetMap ?? { enabled: false, tileServer: 'osm' },
    settings: project.settings ?? useMapStore.getState().settings,
    viewState: { offsetX: 0, offsetY: 0, scale: 1 },
    selectedMarkerId: null,
    selectedRestrictionId: null,
  });
  useMissionStore.setState({ routes: project.routes ?? [], importLists: project.importLists });
};

shimActions.resetProject = () => {
  // Сброс — аварийная кнопка: он работает ВСЕГДА, даже если идёт тяжёлая
  // операция (пересчёт высот / загрузка миссии). Снимаем флаг и отменяем
  // фоновые прогоны высот, чтобы они не дописали данные после очистки.
  useMissionStore.setState({ isProcessing: false });
  try { useMissionStore.getState().cancelAltitudeRun(); } catch { /* noop */ }
  invalidateZoneCacheLocal();
  projectNameRef.value = 'Новый проект';
  projectNameRef.createdAt = new Date().toISOString();
  projectNameRef.updatedAt = projectNameRef.createdAt;
  useMapStore.setState({
    map: null,
    markers: [],
    restrictions: [],
    layers: [{ id: 'default', name: 'Основной', visible: true, locked: false }],
    calibration: { enabled: false, points: [] },
    settings: { ...useMapStore.getState().settings },
    currentTool: 'pan',
    activeRestrictionId: null,
    selectedMarkerId: null,
    selectedRestrictionId: null,
    viewState: { offsetX: 0, offsetY: 0, scale: 1 },
    cursorPosition: null,
    isDrawing: false,
    drawingPoints: [],
    redoDrawingStack: [],
    measurementPoints: [],
    // Сброс должен сбрасывать ВСЁ — включая ссылку на растр карты в
    // IndexedDB: иначе после перезагрузки автовосстановление возвращает
    // старую карту («карта не сбросилась»).
    _currentMapId: undefined,
  });
  useMissionStore.getState().resetMissions();
  // Полный сброс: парк дронов (назначения, регистрация, индивидуальные
  // старты/цели) тоже очищается — иначе после «Сброса» остаются привязки
  // к удалённым маршрутам и точкам.
  useFleetStore.getState().resetFleet();
  // Удаляем изображения карт из IndexedDB (несинхронно, best-effort).
  void clearAllStoredMaps();
};

/** Сброс троттлера + немедленная пакетная перестройка (прежний внутренний хук). */
shimActions.__rerouteAllRoutesNow = () => rerouteAllNow();

// ─── Защита от гонок состояний: mutate-экшены отклоняются, пока isProcessing ──
// setRoutePointAltitude НЕ блокируется: ручная регулировка высоты этапа должна
// оставаться доступной всегда (она сама запускает пересчёт через очередь).
const MUTATE_GUARD_MS = 120_000; // страховка: зависший прогон не должен «заморозить» UI навсегда
const BLOCKED_MUTATORS: Array<keyof MisS> = [
  'addRoute', 'deleteRoute', 'appendRoutePoint', 'insertRoutePointAt',
  'removeRoutePoint', 'commitRouteDraft', 'generateScanRoute', 'optimizeRouteOrder',
  'autoFixRoute', 'importRoutes', 'resetMissions', 'setMissionMode',
  'addStartPointAt', 'addGoalPointAt', 'removeStartPoint', 'removeGoalPoint', 'autoPlanRoutes',
];
/** Синхронные mutate-экшены карты: во время тяжёлой операции тоже блокируются. */
const BLOCKED_MAP_MUTATORS: Array<keyof MapS> = ['deleteRestriction'];
let lastGuardPassTs = Date.now();
const guardWrapped = new Map<string, (...a: unknown[]) => unknown>();

// ИСПРАВЛЕНИЕ краша «Cannot read properties of undefined (reading 'addRoute')»:
// раньше обёртки isProcessing-гарда записывались ПРЯМО в доменные сторы через
// setState. Это ломало работу в двух случаях:
//  1) любой setState/persist-rehydrate, вычисляющий следующий стейт из
//     предыдущего (spread/getState()), мог потерять либо удвоить обёртку —
//     пока обёртка не читалась из стора же, её «оригинал» становился undefined
//     и первый же вызов st.addRoute(...) падал внутри Object.get;
//  2) внутренние вызовы самого стора (rerouteAllRoutesNow -> addRoute и т.п.)
//     начинали проходить через гард и молча отклоняться во время isProcessing.
// Теперь оригиналы захватываются один раз при загрузке модуля (до любых
// setState), а обёртки существуют ТОЛЬКО в shimActions — фасадном объекте
// legacy-совместимости. Доменные сторы остаются нетронутыми.
const missionOriginals: Record<string, ((...a: unknown[]) => unknown) | undefined> = {};
for (const key of BLOCKED_MUTATORS) {
  const v = (useMissionStore.getState() as unknown as Record<string, unknown>)[key];
  if (typeof v === 'function') missionOriginals[key] = v as (...a: unknown[]) => unknown;
}
const mapOriginals: Record<string, ((...a: unknown[]) => unknown) | undefined> = {};
for (const key of BLOCKED_MAP_MUTATORS) {
  const v = (useMapStore.getState() as unknown as Record<string, unknown>)[key];
  if (typeof v === 'function') mapOriginals[key] = v as (...a: unknown[]) => unknown;
}

function makeGuarded(key: string, domain: 'mission' | 'map'): (...a: unknown[]) => unknown {
  const cacheKey = `${key}@${domain}`;
  const cached = guardWrapped.get(cacheKey);
  if (cached) return cached;
  const orig = domain === 'mission' ? missionOriginals[key] : mapOriginals[key];
  // Если метод вдруг отсутствует в снимке — фолбэк всегда резолвится через
  // ЖИВОЙ getState(), так что undefined/рекурсия невозможны.
  const fallback = (store: { getState(): object }): ((...a: unknown[]) => unknown) | undefined =>
    (store.getState() as unknown as Record<string, unknown>)[key] as ((...a: unknown[]) => unknown) | undefined;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const st = useMissionStore.getState();
    if (st.isProcessing && Date.now() - lastGuardPassTs < MUTATE_GUARD_MS) {
      console.warn(`[mission] экшен «${String(key)}» отклонён: идёт тяжёлая операция (пересчёт высот / загрузка миссии)`);
      return null;
    }
    lastGuardPassTs = Date.now();
    const fn = typeof orig === 'function' ? orig : fallback(domain === 'mission' ? useMissionStore : useMapStore);
    if (typeof fn !== 'function') return null;
    return fn.apply(this, args);
  };
  guardWrapped.set(cacheKey, wrapped);
  return wrapped;
}

/**
 * Регистрирует guarded-обёртки mutate-экшенов в facade-объекте shimActions
 * (только для legacy API useStore). Идемпотентно: повторные вызовы возвращают
 * те же обёртки из кэша guardWrapped. Доменные сторы НЕ мутируются.
 */
export function installMissionGuards(): void {
  for (const key of BLOCKED_MUTATORS) {
    (shimActions as Record<string, unknown>)[key] = makeGuarded(key as string, 'mission');
  }
  for (const key of BLOCKED_MAP_MUTATORS) {
    (shimActions as Record<string, unknown>)[key] = makeGuarded(key as string, 'map');
  }
}
installMissionGuards();


/** Селектор вида для React-компонентов (прежний API, делегирует map-стор). */
export { selectMapView };
