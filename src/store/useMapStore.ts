// ═══════════════════════════════════════════════════════════════
// useMapStore — доменный стор карты (Domain-Driven Split #1)
// Камера/вид, слои, геозоны (restrictions), маркеры, провайдеры
// тайлов, IndexedDB-карты, кэш активных зон, Open-Elevation настройки.
// НЕ содержит логику маршрутов (useMissionStore) и парка (useFleetStore).
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type {
  Project,
  Marker, Restriction, Layer, ViewState, MapData, Point,
  CalibrationPoint, MapBounds, Tool,
} from '../types';

/** Настройки карты/высот (подмножество Project['settings']). */
export type ProjectSettings = Project['settings'];
import { saveMapToIndexedDB, loadMapFromIndexedDB } from '../utils/storage';
import { mercatorYToLat } from '../utils/googleMaps';

const MIN_MAP_ZOOM_FLOOR = 6;

// ─── Кэш «проходимых» зон (рядом с владельцем данных — restrictions) ─────────
let zonesVersion = 0;
let zoneCacheKey: { ver: number; n: number } | null = null;
let zoneCacheList: Restriction[] | null = null;

/** Инвалидация кэша зон (вызывать при любом изменении restrictions). */
export function invalidateZoneCache(): void {
  zonesVersion++;
  zoneCacheKey = null;
  zoneCacheList = null;
}

/** Все зоны участвуют в расчётах независимо от устаревшего флага `active`
 *  (см. комментарий в types/index.ts): раньше «активная» была ровно одна, и
 *  добавление новой зоны молча снимало с расчёта все прежние. */
function drawableZones(restrictions: Restriction[]): Restriction[] {
  return restrictions.filter(
    (r) => (r.type === 'circle' ? r.points.length >= 1 && !!r.radius : r.points.length >= 2),
  );
}

/** Активные «проходимые внутри» зоны в нормализованном виде (сброс при изменении зон). */
export function getActiveZonesCached(restrictions: Restriction[]): Restriction[] {
  if (zoneCacheKey && zoneCacheKey.ver === zonesVersion && zoneCacheKey.n === restrictions.length) {
    return zoneCacheList!;
  }
  const list = drawableZones(restrictions);
  zoneCacheKey = { ver: zonesVersion, n: restrictions.length };
  zoneCacheList = list;
  return list;
}

/**
 * Нормализация viewState (используется миграцией persist). Возвращает объект
 * с гарантированно числовыми полями; отсутствующее/битое z0 принудительно
 * помечается как undefined — все потребители вида трактуют undefined z0 как
 * эталонный ZOOM_REF (`z0 ?? ZOOM_REF`).
 */
export function normalizeViewState(v: unknown): ViewState {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown, dflt: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? x : dflt;
  const z0 = typeof o.z0 === 'number' && Number.isFinite(o.z0) ? o.z0 : undefined;
  return { offsetX: num(o.offsetX, 0), offsetY: num(o.offsetY, 0), scale: num(o.scale, 1), z0 };
}

// ─── Типы стора ────────────────────────────────────────────────

export interface MapState {
  // Географическая часть проекта (персистится)
  map: MapData | null;
  markers: Marker[];
  restrictions: Restriction[];
  layers: Layer[];
  calibration: { enabled: boolean; points: CalibrationPoint[] };
  googleMaps: { apiKey: string; enabled: boolean };
  yandexMaps: { apiKey: string; enabled: boolean };
  openStreetMap: { enabled: boolean; tileServer: 'osm' | 'opentopomap' | 'carto' };
  settings: ProjectSettings;
  _currentMapId?: string; // ID текущей карты в IndexedDB
  // UI-состояние карты
  currentTool: Tool;
  viewState: ViewState;
  /** monotonic counter — bump on every setViewState (see selectViewForRender) */
  viewTick: number;
  cursorPosition: Point | null;
  isDrawing: boolean;
  drawingPoints: Point[];
  redoDrawingStack: Point[];
  measurementPoints: Point[];
  searchQuery: string;
  filterType: string;
  selectedMarkerId: string | null;
  selectedRestrictionId: string | null;
  activeRestrictionId: string | null;
}

export interface MapActions {
  setTool: (tool: Tool) => void;
  setViewState: (viewState: Partial<ViewState>) => void;
  setCursorPosition: (pos: Point | null) => void;
  setDrawing: (isDrawing: boolean) => void;
  addDrawingPoint: (point: Point) => void;
  undoDrawingPoint: () => void;
  redoDrawingPoint: () => void;
  clearDrawingPoints: () => void;
  setMeasurementPoints: (points: Point[]) => void;
  setSearchQuery: (query: string) => void;
  setFilterType: (type: string) => void;
  selectMarker: (id: string | null) => void;
  selectRestriction: (id: string | null) => void;
  setActiveRestriction: (id: string | null) => void;
  addMarker: (marker: Partial<Marker>) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  deleteMarker: (id: string) => void;
  addRestriction: (restriction: Partial<Restriction>) => void;
  updateRestriction: (id: string, updates: Partial<Restriction>) => void;
  deleteRestriction: (id: string) => void;
  addLayer: (name: string) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  deleteLayer: (id: string) => void;
  addCalibrationPoint: (point: CalibrationPoint) => void;
  removeCalibrationPoint: (index: number) => void;
  toggleCalibration: (enabled: boolean) => void;
  updateSettings: (settings: Partial<ProjectSettings>) => void;
  setGoogleMapsApiKey: (apiKey: string) => void;
  toggleGoogleMaps: (enabled: boolean) => void;
  setYandexMapsApiKey: (apiKey: string) => void;
  toggleYandexMaps: (enabled: boolean) => void;
  toggleOpenStreetMap: (enabled: boolean) => void;
  setOSMTileServer: (server: 'osm' | 'opentopomap' | 'carto') => void;
  setMapBounds: (bounds: MapBounds) => void;
  loadMap: (mapData: MapData) => void;
  loadMapWithStorage: (mapData: MapData) => Promise<void>;
  /** Активная тайловая карта без снимка: центр (lat/lng) + зум 6..19 */
  loadActiveTileMap: (center: { lat: number; lng: number }, zoom: number) => void;
  restoreMapFromStorage: () => Promise<void>;
  resetMapUi: () => void;
}

export type MapStore = MapState & MapActions;

export const defaultMapSettings: ProjectSettings = {
  showGrid: true,
  gridSize: 0,
  showCoordinates: true,
  theme: 'dark',
  tilesEnabled: true,
  tileStyle: 'scheme',
  elevationAuto: true,
  altitudeClearanceM: 50,
};

const initialMapState: MapState = {
  map: null,
  markers: [],
  restrictions: [],
  layers: [{ id: 'default', name: 'Основной', visible: true, locked: false }],
  calibration: { enabled: false, points: [] },
  googleMaps: { apiKey: '', enabled: false },
  yandexMaps: { apiKey: '', enabled: false },
  openStreetMap: { enabled: false, tileServer: 'osm' },
  settings: { ...defaultMapSettings },
  currentTool: 'pan',
  viewState: { offsetX: 0, offsetY: 0, scale: 1 },
  viewTick: 0,
  cursorPosition: null,
  isDrawing: false,
  drawingPoints: [],
  redoDrawingStack: [],
  measurementPoints: [],
  searchQuery: '',
  filterType: '',
  selectedMarkerId: null,
  selectedRestrictionId: null,
  activeRestrictionId: null,
};

// ─── Реализация экшенов ────────────────────────────────────────

const createMapActions: StateCreator<MapStore, [], [], MapActions> = (set, get) => ({
  setTool: (tool) => set({ currentTool: tool, isDrawing: false, drawingPoints: [] }),

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

  clearDrawingPoints: () => set({ drawingPoints: [], isDrawing: false, redoDrawingStack: [] }),
  setMeasurementPoints: (points) => set({ measurementPoints: points }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterType: (type) => set({ filterType: type }),
  selectMarker: (id) => set({ selectedMarkerId: id, selectedRestrictionId: null }),
  selectRestriction: (id) => set({ selectedRestrictionId: id, selectedMarkerId: null }),

  setActiveRestriction: (id) => {
    invalidateZoneCache();
    set((state) => ({
      activeRestrictionId: id,
      restrictions: state.restrictions.map((r) => ({ ...r, active: r.id === id })),
    }));
    // Перестройку маршрутов выполняет ЕДИНСТВЕННЫЙ троттлинговый подписчик
    // на изменения restrictions (useAppInitialization). Синхронный вызов
    // создавал двойной запуск пакетной перестройки.
  },

  addMarker: (markerData) => set((state) => {
    const id = uuidv4();
    const markerCount = state.markers.length + 1;
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
    return { markers: [...state.markers, marker], selectedMarkerId: id };
  }),

  updateMarker: (id, updates) => set((state) => ({
    markers: state.markers.map((m) => (m.id === id ? { ...m, ...updates } : m)),
  })),

  deleteMarker: (id) => {
    // Тип точки нужен ДО удаления — по нему решаем, каскадировать ли маршруты.
    const kind = (() => {
      const mk = get().markers.find((m) => m.id === id);
      return mk?.type === 'start' || mk?.type === 'goal' ? mk.type : null;
    })();
    set((state) => ({
      markers: state.markers.filter((m) => m.id !== id),
      selectedMarkerId: state.selectedMarkerId === id ? null : state.selectedMarkerId,
    }));
    // Каскад старта/цели: при удалении точки start/goal удаляем привязанные
    // маршруты и чистим назначения дронов (иначе остаются «висячие» ссылки —
    // точки на нижней карте исчезают, а маршрут/назначение продолжает жить).
    // Маршруты живут в mission-сторе, назначения — во fleet-сторе: обращение
    // через динамический import разрывает потенциальный цикл map↔mission↔fleet.
    if (kind) void cascadeRemoveStartGoal(id, kind === 'start' ? 'start' : 'goal');
  },

  addRestriction: (restrictionData) => {
    invalidateZoneCache();
    set((state) => {
      const id = uuidv4();
      const restriction: Restriction = {
        id,
        type: restrictionData.type || 'polygon',
        points: restrictionData.points || [],
        radius: restrictionData.radius,
        color: restrictionData.color || '#ff000080',
        name: restrictionData.name || `Ограничение ${state.restrictions.length + 1}`,
        active: restrictionData.active !== undefined ? restrictionData.active : true,
        minHeightAGL: restrictionData.minHeightAGL ?? null,
        maxHeightAGL: restrictionData.maxHeightAGL ?? null,
      };
      // ВАЖНО: НЕ вызываем reroute синхронно здесь — добавление зоны
      // происходит из обработчика клика; перестройку выполняет троттлинговый
      // подписчик на изменения restrictions (useAppInitialization).
      return {
        restrictions: [...state.restrictions, restriction],
        activeRestrictionId: id,
      };
    });
  },

  updateRestriction: (id, updates) => {
    invalidateZoneCache(); // геометрия/лимиты зоны изменились — кэш недействителен
    set((state) => ({
      restrictions: state.restrictions.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    // Перестройку выполняет единственный троттлинговый подписчик.
  },

  deleteRestriction: (id) => {
    invalidateZoneCache();
    set((state) => ({
      restrictions: state.restrictions.filter((r) => r.id !== id),
      activeRestrictionId: state.activeRestrictionId === id ? null : state.activeRestrictionId,
      selectedRestrictionId: state.selectedRestrictionId === id ? null : state.selectedRestrictionId,
    }));
  },

  addLayer: (name) => set((state) => {
    const id = uuidv4();
    return { layers: [...state.layers, { id, name, visible: true, locked: false }] };
  }),

  updateLayer: (id, updates) => set((state) => ({
    layers: state.layers.map((l) => (l.id === id ? { ...l, ...updates } : l)),
  })),

  deleteLayer: (id) => set((state) => ({
    layers: state.layers.filter((l) => l.id !== id),
  })),

  addCalibrationPoint: (point) => set((state) => ({
    calibration: { ...state.calibration, points: [...state.calibration.points, point] },
  })),

  removeCalibrationPoint: (index) => set((state) => ({
    calibration: { ...state.calibration, points: state.calibration.points.filter((_, i) => i !== index) },
  })),

  toggleCalibration: (enabled) => set((state) => ({
    calibration: { ...state.calibration, enabled },
  })),

  updateSettings: (settings) => set((state) => ({
    settings: { ...state.settings, ...settings },
  })),

  setGoogleMapsApiKey: (apiKey) => set((state) => ({ googleMaps: { ...state.googleMaps, apiKey } })),
  toggleGoogleMaps: (enabled) => set((state) => ({ googleMaps: { ...state.googleMaps, enabled } })),
  setYandexMapsApiKey: (apiKey) => set((state) => ({ yandexMaps: { ...state.yandexMaps, apiKey } })),
  toggleYandexMaps: (enabled) => set((state) => ({ yandexMaps: { ...state.yandexMaps, enabled } })),
  toggleOpenStreetMap: (enabled) => set((state) => ({ openStreetMap: { ...state.openStreetMap, enabled } })),
  setOSMTileServer: (server) => set((state) => ({ openStreetMap: { ...state.openStreetMap, tileServer: server } })),

  setMapBounds: (bounds) => set((state) => ({
    map: state.map ? { ...state.map, bounds } : null,
  })),

  loadMap: (mapData) => set({ map: mapData }),

  loadMapWithStorage: async (mapData) => {
    // Сохраняем карту в IndexedDB под стабильным ID — старые карты не затираются
    const mapId = uuidv4();
    await saveMapToIndexedDB(mapId, mapData.dataUrl);
    // dataUrl остаётся в памяти для немедленного отображения;
    // в localStorage он не сохраняется (см. partialize) и восстанавливается из IndexedDB
    set({ map: { ...mapData, mapId }, _currentMapId: mapId });
    // Маршруты строго привязаны к географии: пересчёт пикселей под новые границы
    // выполняет mission-стор (динамический import — циклической зависимости нет).
    void import('./useMissionStore').then((m) => m.useMissionStore.getState().refreshAllRoutesAfterMapChange());
  },

  /**
   * Активная тайловая карта без растрового снимка: «виртуальная» карта с точной
   * Mercator-привязкой (bounds → world px уровня z), чтобы все режимы работали
   * от реальных координат. Растр = полный мир уровня z (256·2^z), pixel ⇔ tile.
   */
  loadActiveTileMap: (center, zoom) => {
    const z = Math.max(MIN_MAP_ZOOM_FLOOR, Math.min(19, Math.round(zoom)));
    const worldPx = 256 * Math.pow(2, z);
    const mapData: MapData = {
      name: `Активная карта: ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} (z${z})`,
      width: worldPx,
      height: worldPx,
      dataUrl: '', // без фотографии — подложка грузится тайлами динамически
      bounds: { west: -180, east: 180, north: mercatorYToLat(0), south: mercatorYToLat(1) },
      source: 'osm',
    };
    set((state) => ({
      map: mapData,
      settings: { ...state.settings, tilesEnabled: true },
    }));
    void import('./useMissionStore').then((m) => m.useMissionStore.getState().refreshAllRoutesAfterMapChange());
  },

  restoreMapFromStorage: async () => {
    const state = get();
    const map = state.map;
    if (!map || map.dataUrl) return; // изображение уже в памяти
    // Стабильный ID хранится в самой карте; _currentMapId — обратная совместимость
    const mapId = map.mapId || state._currentMapId;
    if (!mapId) return;
    const dataUrl = await loadMapFromIndexedDB(mapId);
    if (dataUrl) {
      set((cur) => ({ map: cur.map ? { ...cur.map, dataUrl } : cur.map }));
      // Пиксели маршрутов были рассчитаны по старому/пустому растру — после
      // восстановления изображения mission-стор пересчитывает их из lat/lng.
      void import('./useMissionStore').then((m) => m.useMissionStore.getState().refreshAllRoutesAfterMapChange());
    }
  },

  resetMapUi: () => set({
    currentTool: 'pan',
    activeRestrictionId: null,
    selectedMarkerId: null,
    selectedRestrictionId: null,
    cursorPosition: null,
    isDrawing: false,
    drawingPoints: [],
    redoDrawingStack: [],
    measurementPoints: [],
  }),
});

// ─── Стор + persist (миграция из legacy totalquadro-storage) ────────────────

export const useMapStore = create<MapStore>()(
  persist(
    (...a) => ({ ...initialMapState, ...createMapActions(...a) }),
    {
      name: 'tq-map',
      version: 3,
      // Явная JSON-гидрация из localStorage. Важно: при default storage persist
      // записывает восстановленные поля через Object.assign (in-place мутация до
      // первого notify) — компонент мог отрендериться с частично гидрированным
      // viewState («viewState is not defined»). viewTick форсирует notify.
      storage: createJSONStorage(() => localStorage),
      partialize: (s): MapState => ({
        // Не сохраняем map.dataUrl в localStorage — он слишком большой
        map: s.map ? { ...s.map, dataUrl: '' } : null,
        markers: s.markers,
        restrictions: s.restrictions,
        layers: s.layers,
        calibration: s.calibration,
        googleMaps: s.googleMaps,
        yandexMaps: s.yandexMaps,
        openStreetMap: s.openStreetMap,
        settings: s.settings,
        _currentMapId: s._currentMapId,
        currentTool: s.currentTool,
        viewState: s.viewState,
        viewTick: s.viewTick,
        cursorPosition: null,
        isDrawing: false,
        drawingPoints: [],
        redoDrawingStack: [],
        measurementPoints: [],
        searchQuery: s.searchQuery,
        filterType: s.filterType,
        selectedMarkerId: null,
        selectedRestrictionId: null,
        activeRestrictionId: s.activeRestrictionId,
      }),
      migrate: (persistedState: unknown, version: number) => {
        const p = persistedState as Record<string, unknown>;
        // Миграция из legacy 'totalquadro-storage' v2: project → гео-поля
        const proj = (p.project ?? p) as Partial<{
          map: MapData | null; markers: Marker[]; restrictions: Restriction[];
          layers: Layer[]; calibration: MapState['calibration'];
          googleMaps: MapState['googleMaps']; yandexMaps: MapState['yandexMaps'];
          openStreetMap: MapState['openStreetMap']; settings: ProjectSettings;
          currentTool: Tool; viewState: ViewState;
        }>;
        if (proj.map !== undefined) p.map = proj.map ?? null;
        if (proj.markers) p.markers = proj.markers;
        if (proj.restrictions) p.restrictions = proj.restrictions;
        if (proj.layers?.length) p.layers = proj.layers;
        if (proj.calibration) p.calibration = proj.calibration;
        else if (!p.calibration) p.calibration = { enabled: false, points: [] };
        if (proj.googleMaps) p.googleMaps = proj.googleMaps;
        else if (!p.googleMaps) p.googleMaps = { apiKey: '', enabled: false };
        if (proj.yandexMaps) p.yandexMaps = proj.yandexMaps;
        else if (!p.yandexMaps) p.yandexMaps = { apiKey: '', enabled: false };
        if (proj.openStreetMap) p.openStreetMap = proj.openStreetMap;
        else if (!p.openStreetMap) p.openStreetMap = { enabled: false, tileServer: 'osm' };
        const st = (p.settings ?? {}) as Partial<ProjectSettings>;
        p.settings = {
          ...defaultMapSettings,
          ...st,
          // Режимы «спутник/гибрид» и внешние Overpass-слои удалены из приложения:
          tileStyle: 'scheme',
        };
        if (version < 3) delete p.project;
        // Нормализация viewState: старые версии могли записать вид без z0 или
        // с «грязным» значением null/строка/NaN.
        if (p.viewState !== undefined) p.viewState = normalizeViewState(p.viewState);
        return p as unknown as MapState;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) console.warn('[tq-map persist] rehydration failed:', error);
        // Принудительный set() после гидрации: гарантирует новый ссылочный ярлык
        // viewTick и уведомление всех подписчиков — компоненты перерисуются уже
        // с полностью восстановленным состоянием.
        try {
          useMapStore.setState((s) => ({ viewTick: s.viewTick + 1 }));
        } catch { /* стор ещё не создан (первичная синхронная гидрация) — не страшно */ }
        invalidateZoneCache();
      },
    },
  ),
);

/**
 * Каскад удаления точки старта/цели (map → mission → fleet, без циклов:
 * dynamic import — миссия/флот не импортируют map-стор на уровне модуля).
 * При удалении маркера type='start'|'goal':
 *  1) чистим sharedStartId/sharedGoalId, если они указывали на этот id;
 *  2) удаляем маршруты, привязанные к точке (route.points[].binding.pointId);
 *  3) снимаем назначения дронов (startId/goalId/routeId) с удалёнными ссылками.
 * Иначе остаются «висячие» ссылки: точки на карте исчезают, а маршрут и
 * назначение продолжают жить (прежний баг исчезновения точек).
 */
export async function cascadeRemoveStartGoal(
  markerId: string,
  kind: 'start' | 'goal',
): Promise<void> {
  const [{ useMissionStore }, { useFleetStore }] = await Promise.all([
    import('./useMissionStore'),
    import('./useFleetStore'),
  ]);
  const mission = useMissionStore.getState();

  // 1) общие точки старта/цели (store-first зеркала в importLists)
  if (kind === 'start' && mission.sharedStartId === markerId) {
    useMissionStore.setState({ sharedStartId: null });
  } else if (kind === 'goal' && mission.sharedGoalId === markerId) {
    useMissionStore.setState({ sharedGoalId: null });
  }

  // 2) маршруты, узлы которых привязаны к удалённой точке
  const deadRouteIds = mission.routes
    .filter((r) => r.points.some((p) => p.binding && p.binding.kind === kind && p.binding.pointId === markerId))
    .map((r) => r.id);
  for (const rid of deadRouteIds) mission.deleteRoute(rid);

  // 3) назначения дронов: отвязываем удалённую точку и съевшиеся маршруты
  const fleet = useFleetStore.getState();
  for (const a of fleet.droneAssignments) {
    let changed = false;
    const patch: Partial<typeof a> = {};
    if (kind === 'start' && a.startId === markerId) { patch.startId = null; changed = true; }
    if (kind === 'goal' && a.goalId === markerId) { patch.goalId = null; changed = true; }
    if (a.routeId && deadRouteIds.includes(a.routeId)) { patch.routeId = null; changed = true; }
    if (changed) fleet.setDroneAssignment(a.droneId, patch);
  }
}

/**
 * Селектор вида для React-компонентов. Возвращает НОВЫЙ объект только когда
 * реально изменились поля, видимые в UI (scale/offsetX/offsetY/z0) либо viewTick.
 * Без ключа-tick селектор «зависал» на старом значении после in-place гидрации
 * persist; с новым объектом на каждый emit — infinite loop (React #185).
 */
export function selectViewForRender(s: MapStore): ViewState {
  const v = s.viewState;
  const t = s.viewTick;
  const last = lastViewSel;
  if (last && last.t === t && last.v === v) return last.out;
  const out: ViewState = { scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY, z0: v.z0 };
  lastViewSel = { t, v, out };
  return out;
}
let lastViewSel: { t: number; v: ViewState; out: ViewState } | null = null;
