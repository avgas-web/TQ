import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Project, Marker, Restriction, Layer, Tool, ViewState, MapData, Point, CalibrationPoint, MapBounds } from '../types';

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

  // Actions
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
  exportProject: () => Project;
  resetProject: () => void;
  addCalibrationPoint: (point: CalibrationPoint) => void;
  removeCalibrationPoint: (index: number) => void;
  toggleCalibration: (enabled: boolean) => void;
  updateSettings: (settings: Partial<Project['settings']>) => void;
  setGoogleMapsApiKey: (apiKey: string) => void;
  toggleGoogleMaps: (enabled: boolean) => void;
  setMapBounds: (bounds: MapBounds) => void;
}

const defaultProject: Project = {
  version: '1.0',
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

      resetProject: () => set({
        project: { ...defaultProject, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        currentTool: 'pan',
        activeRestrictionId: null,
        selectedMarkerId: null,
        selectedRestrictionId: null,
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
            points: [...state.project.calibration.points, point],
          },
          updatedAt: new Date().toISOString(),
        },
      })),

      removeCalibrationPoint: (index) => set((state) => ({
        project: {
          ...state.project,
          calibration: {
            ...state.project.calibration,
            points: state.project.calibration.points.filter((_, i) => i !== index),
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
    }),
    {
      name: 'totalquadro-storage',
      partialize: (state) => ({
        project: state.project,
      }),
    }
  )
);
