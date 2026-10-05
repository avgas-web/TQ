import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Project, Marker, Restriction, Layer, Tool, ViewState, MapData, Point, CalibrationPoint, MapBounds, Route, RoutePoint } from '../types';
import { MAX_ROUTES } from '../types';
import { saveMapToIndexedDB, loadMapFromIndexedDB, deleteMapFromIndexedDB } from '../utils/storage';
import { geoToPixelFromBounds } from '../utils/googleMaps';
import { planPathAroundZones, zonesCrossedBy, recomputeRoutePixels, pixelToGeoExact } from '../utils/routing';

const ROUTE_COLORS = ['#00d0ff', '#ff9500', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#60a5fa'];

/** Строгая привязка пикселя к WGS-84 (обратная Mercator-проекция) */
function pixelToGeoStrict(p: Point, bounds: MapBounds, mapW: number, mapH: number) {
  return pixelToGeoExact(p, bounds, mapW, mapH);
}

interface AppState {
  project: Project;
  currentTool: Tool;
  activeRestrictionId: string | null;
  selectedMarkerId: string | null;
  selectedRestrictionId: string | null;
  viewState: ViewState;
  cursorPosition: Point | null;
  isDrawing: boolean;
  drawingPoints: Point[];
  measurementPoints: Point[];
  searchQuery: string;
  filterType: string;
  actionMode: boolean; // «Режим действий»: маршрут старт→цель с гео-расчётами
  activeRouteId: string | null; // активный маршрут для редактирования кликами
  routeWarnings: Record<string, string[]>; // id маршрута -> предупреждения о пересечении зон (в сессии)
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
    showGrid: false,
    gridSize: 100,
    showCoordinates: true,
    theme: 'dark',
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
      cursorPosition: null,
      isDrawing: false,
      drawingPoints: [],
      measurementPoints: [],
      searchQuery: '',
      filterType: '',
      actionMode: false,
      activeRouteId: null,
      routeWarnings: {},

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
          const path = planPathAroundZones({ x: a.x, y: a.y }, { x: b.x, y: b.y }, state.project.restrictions, map.width, map.height);
          for (let i = 1; i < path.length - 1; i++) {
            const px = path[i];
            const geo = map.bounds ? pixelToGeoStrict(px, map.bounds, map.width, map.height) : { lat: NaN, lng: NaN };
            newPts.push({ x: px.x, y: px.y, lat: geo.lat, lng: geo.lng, auto: true });
          }
        }
        newPts.push({ ...route.points[keyIdx[keyIdx.length - 1]] });
        // Предупреждения о зонах, через которые всё же проходит маршрут
        const crossed = zonesCrossedBy(newPts.map((p) => ({ x: p.x, y: p.y })), state.project.restrictions);
        const warnings = crossed.map((z) => `Пересекает зону «${z.name}»`);
        set((cur) => ({
          routeWarnings: { ...cur.routeWarnings, [id]: warnings },
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => (r.id === id ? { ...r, points: newPts } : r)),
            updatedAt: new Date().toISOString(),
          },
        }));
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
      },

      clearRouteWarnings: (id) => set((state) => {
        const copy = { ...state.routeWarnings };
        delete copy[id];
        return { routeWarnings: copy };
      }),

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

      addRestriction: (restrictionData) => set((state) => {
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
        return {
          project: {
            ...state.project,
            restrictions: [...state.project.restrictions, restriction],
            updatedAt: new Date().toISOString(),
          },
          activeRestrictionId: restriction.id,
        };
      }),

      updateRestriction: (id, updates) => set((state) => ({
        project: {
          ...state.project,
          restrictions: state.project.restrictions.map((r) =>
            r.id === id ? { ...r, ...updates } : r
          ),
          updatedAt: new Date().toISOString(),
        },
      })),

      deleteRestriction: (id) => set((state) => ({
        project: {
          ...state.project,
          restrictions: state.project.restrictions.filter((r) => r.id !== id),
          updatedAt: new Date().toISOString(),
        },
        activeRestrictionId: state.activeRestrictionId === id ? null : state.activeRestrictionId,
        selectedRestrictionId: state.selectedRestrictionId === id ? null : state.selectedRestrictionId,
      })),

      selectRestriction: (id) => set({ selectedRestrictionId: id, selectedMarkerId: null }),

      setActiveRestriction: (id) => set((state) => ({
        activeRestrictionId: id,
        project: {
          ...state.project,
          restrictions: state.project.restrictions.map((r) => ({
            ...r,
            active: r.id === id,
          })),
          updatedAt: new Date().toISOString(),
        },
      })),

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
      })),

      setCursorPosition: (pos) => set({ cursorPosition: pos }),

      setDrawing: (isDrawing) => set({ isDrawing }),

      addDrawingPoint: (point) => set((state) => ({
        drawingPoints: [...state.drawingPoints, point],
      })),

      clearDrawingPoints: () => set({ drawingPoints: [], isDrawing: false }),

      setMeasurementPoints: (points) => set({ measurementPoints: points }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setFilterType: (type) => set({ filterType: type }),

      importProject: (project) => set({
        project,
        selectedMarkerId: null,
        selectedRestrictionId: null,
        viewState: { offsetX: 0, offsetY: 0, scale: 1 },
      }),

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
        }
      },
    }),
    {
      name: 'totalquadro-storage',
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
            gridSize: 100,
            showCoordinates: true,
            theme: 'dark',
          };
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
