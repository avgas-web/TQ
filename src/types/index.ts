// Типы для TotalQuadro Coordinate Marker

export interface Point {
  x: number;
  y: number;
}

export interface Marker {
  id: string;
  name: string;
  x: number;
  y: number;
  lat: number | null;
  lon: number | null;
  type: string;
  color: string;
  comment: string;
  layer: string;
  createdAt: string;
}

export interface Restriction {
  id: string;
  type: 'rectangle' | 'polygon' | 'circle';
  points: Point[]; // For polygon/rectangle: vertices; for circle: [center, edge]
  radius?: number; // For circle
  color: string;
  name: string;
  active: boolean;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface CalibrationPoint {
  pixelX: number;
  pixelY: number;
  lat: number;
  lon: number;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export type MapProvider = 'local' | 'google' | 'yandex' | 'osm';

export interface MapData {
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  bounds?: MapBounds; // Географические границы карты
  source?: MapProvider; // Источник карты
  mapId?: string; // Стабильный ID изображения в IndexedDB (для восстановления после перезагрузки)
}

export interface Project {
  version: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  map: MapData | null;
  calibration: {
    enabled: boolean;
    points: CalibrationPoint[];
  };
  restrictions: Restriction[];
  markers: Marker[];
  routes?: Route[]; // маршруты режима действий (до MAX_ROUTES)
  importLists?: ImportLists; // импортированные списки стартов и целей
  layers: Layer[];
  settings: {
    showGrid: boolean;
    gridSize: number;
    showCoordinates: boolean;
    theme: 'dark' | 'light';
  };
  googleMaps: {
    apiKey: string;
    enabled: boolean;
  };
  yandexMaps: {
    apiKey: string;
    enabled: boolean;
  };
  openStreetMap: {
    enabled: boolean;
    tileServer: 'osm' | 'opentopomap' | 'carto';
  };
}

export type Tool = 'pan' | 'select' | 'addMarker' | 'drawRect' | 'drawPolygon' | 'drawCircle' | 'measure';

export interface ViewState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface Measurement {
  points: Point[];
  distance: number; // in pixels
}

// ─── Маршруты (режим действий) ──────────────────────────────────────────────

/** Точка маршрута: гео-координаты WGS-84 первичны, пиксели — производные */
export interface RoutePoint {
  lat: number;
  lng: number;
  x: number; // пиксель карты (пересчитывается при загрузке/изменении bounds)
  y: number;
  auto?: boolean; // точка добавлена автообходом зон (не ключевая)
}

/** Тип линии маршрута: прямая или кривая (сглаженная сплайн-ломаная) */
export type RouteShape = 'straight' | 'curve';

/** Режим ограничения маршрута по дальности */
export type RangeLimitMode = 'off' | 'max' | 'min';

export interface Route {
  id: string;
  name: string;
  color: string;
  points: RoutePoint[]; // >= 2
  active: boolean;     // активный маршрут редактируется кликами по карте
  visible: boolean;
  createdAt: string;
  shape?: RouteShape;          // линия маршрута (по умолчанию straight)
  rangeMode?: RangeLimitMode;  // ограничение по дальности (по умолчанию off)
  rangeM?: number;             // предельная дистанция в метрах
}

/** Импортные списки: стартовые позиции и цели, каждая привязана к маршруту */
export interface ImportPoint {
  id: string;
  label: string;
  lat: number;
  lng: number;
  routeId: string | null; // id маршрута, к которому привязана точка ('' / null — без привязки)
  placeName?: string;     // исходное название объекта (если точка получена геокодингом)
}

export interface ImportLists {
  starts: ImportPoint[];
  goals: ImportPoint[];
}

export const MAX_ROUTES = 10000;
