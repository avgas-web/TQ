import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Project, Marker, Restriction, Layer, Tool, ViewState, MapData, Point, CalibrationPoint, MapBounds, Route, RoutePoint } from '../types';
import { MAX_ROUTES } from '../types';
import { saveMapToIndexedDB, loadMapFromIndexedDB, deleteMapFromIndexedDB } from '../utils/storage';
import { geoToPixelFromBounds, calculateBoundsFromCenter, latToMercatorY } from '../utils/googleMaps';
import { planPathAroundZones, zonesCrossedBy, recomputeRoutePixels, pixelToGeoExact, smoothPolyline, routeLengthM } from '../utils/routing';
import type { RouteShape, RangeLimitMode, ImportPoint, ImportLists } from '../types';

const MIN_MAP_ZOOM_FLOOR = 6;

const ROUTE_COLORS = ['#00d0ff', '#ff9500', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#60a5fa'];

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
  const list = restrictions.filter(
    (r) => r.active && (r.type === 'circle' ? r.points.length >= 1 && !!r.radius : r.points.length >= 2)
  );
  zoneCacheKey = { ver: zonesVersion, n: restrictions.length };
  zoneCacheList = list;
  return list;
}

/**
 * Единый планировщик пакетной перестройки всех маршрутов. Идемпотентен:
 * повторные вызовы в пределах троттл-окна схлопываются в один прогон.
 */
export function scheduleRerouteAll() {
  if (rerouteTimer != null) clearTimeout(rerouteTimer);
  rerouteTimer = window.setTimeout(() => {
    rerouteTimer = null;
    rerouteAllRoutesNow();
  }, REROUTE_THROTTLE_MS);
}

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
    newRoutes.push({ ...route, points: pts });
  }
  set((cur) => {
    // Полная замена реестра предупреждений: старые записи для «очистившихся»
    // маршрутов раньше сливались с новыми ({...cur, ...map}) и ложные
    // предупреждения оставались навсегда.
    const nextWarnings: Record<string, string[]> = {};
    for (const [rid, w] of Object.entries(warningsMap)) {
      if (w.length > 0) nextWarnings[rid] = w;
    }
    return {
      routeWarnings: nextWarnings,
      project: { ...cur.project, routes: newRoutes, updatedAt: new Date().toISOString() },
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
  return { scale: s.viewState.scale, offsetX: s.viewState.offsetX, offsetY: s.viewState.offsetY, z0: s.viewState.z0 };
}

interface AppState {
  project: Project;
  currentTool: Tool;
  activeRestrictionId: string | null;
  selectedMarkerId: string | null;
  selectedRestrictionId: string | null;
  viewState: ViewState;
  /** monotonic counter — bump on every setViewState (see selectViewForRender) */
  viewTick: number;
  cursorPosition: Point | null;
  isDrawing: boolean;
  drawingPoints: Point[];
  measurementPoints: Point[];
  searchQuery: string;
  filterType: string;
  actionMode: boolean; // «Режим действий»: маршрут старт→цель с гео-расчётами
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
  rerouteAroundZones: (id: string) => void; // перестроить обход зон для всего маршрута
  /** Внутренний: немедленная пакетная перестройка (rerouteAllRoutes — троттлинг-обёртка) */
  __rerouteAllRoutesNow?: () => void;
  rerouteAllRoutes: () => void; // пакетная перестройка всех маршрутов после изменения зон/карты
  setRouteShape: (id: string, shape: 'straight' | 'curve') => void; // прямая или кривая
  setRouteRangeLimit: (id: string, mode: 'off' | 'max' | 'min', meters?: number) => void; // ограничение по дальности
  importLists: (starts: { label: string; lat: number; lng: number; placeName?: string }[], goals: { label: string; lat: number; lng: number; placeName?: string }[]) => number; // импорт списков + привязка к маршрутам
  clearImportLists: () => void;
  undoDrawingPoint: () => void; // undo последней точки рисования полигона
  redoDrawingPoint: () => void; // redo убранной точки
  refreshAllRoutesAfterMapChange: () => void; // пересчёт пикселей из lat/lng при загрузке новой карты
  clearRouteWarnings: (id: string) => void;
  setTool: (tool: Tool) => void;
  setActionMode: (enabled: boolean) => void;
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
      drawingPoints: [],
      measurementPoints: [],
      searchQuery: '',
      filterType: '',
      actionMode: false,
      activeRouteId: null,
      routeWarnings: {},
      redoDrawingStack: [],

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

      rerouteAllRoutes: () => {
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

      setActionMode: (enabled) => set({ actionMode: enabled }),

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

      deleteMarker: (id) => set((state) => ({
        project: {
          ...state.project,
          markers: state.project.markers.filter((m) => m.id !== id),
          updatedAt: new Date().toISOString(),
        },
        selectedMarkerId: state.selectedMarkerId === id ? null : state.selectedMarkerId,
      })),

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

      deleteRestriction: (id) => {
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
        const worldPx = 256 * Math.pow(2, z);
        const b = calculateBoundsFromCenter(center, z, worldPx, worldPx);
        const mapW = Math.round(worldPx * ((b.east - b.west) / 360));
        const topY = latToMercatorY(b.north);
        const botY = latToMercatorY(b.south);
        const mapH = Math.max(1, Math.round(worldPx * (botY - topY)));
        const mapData: MapData = {
          name: `Активная карта: ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} (z${z})`,
          width: mapW,
          height: mapH,
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
        } else if (persistedState.project?.settings && persistedState.project.settings.tilesEnabled === undefined) {
          // существующие проекты: включаем активную тайловую карту по умолчанию
          persistedState.project.settings.tilesEnabled = true;
          persistedState.project.settings.tileStyle = persistedState.project.settings.tileStyle || 'scheme';
        }
        // Миграция для старых проектов без маршрутов
        if (persistedState.project && !Array.isArray(persistedState.project.routes)) {
          persistedState.project.routes = [];
        }
        return persistedState;
      },
    }
  )
);
