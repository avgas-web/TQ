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
  /** Высота ландшафта в точке (м, Open-Elevation), проставляется автоматически */
  terrainM?: number | null;
}

export interface Restriction {
  id: string;
  type: 'rectangle' | 'polygon' | 'circle';
  points: Point[]; // For polygon/rectangle: vertices; for circle: [center, edge]
  radius?: number; // For circle
  color: string;
  name: string;
  /** Устаревшее поле прежних версий: активна ровно одна зона. БОЛЬШЕ НЕ
   * используется для фильтрации — все зоны участвуют в обходе и отрисовке
   * (иначе «утверждение» новой зоны молча снимало с карты все прежние).
   * Поле оставлено для совместимости старых сохранённых проектов. */
  active: boolean;
  /** Минимальная разрешённая высота полёта над землёй (AGL, м). Маршрут поднимается выше. */
  minHeightAGL?: number | null;
  /** Максимальная разрешённая высота полёта над землёй (AGL, м). Маршрут опускается ниже. */
  maxHeightAGL?: number | null;
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

// ─── Пользовательские тактические карты (дополнительные слои поверх подложки) ─

/** Формат источника пользовательского слоя */
export type UserMapFormat = 'geojson' | 'kml' | 'kmz' | 'geotiff' | 'mbtiles' | 'image';

/** Тип геометрии слоя: вектор (полигоны/линии/точки) либо растр (оверлей) */
export type UserMapKind = 'vector' | 'raster';

/** Привязка растра к географии: границы в WGS-84 (lat/lng) */
export interface RasterCalibration {
  bounds: MapBounds;
}

/** Геометрия элемента слоя — координаты ВСЕГДА в WGS-84 (lat/lng).
 *  rings: [внешний, дырка1, ...] для Polygon; для MultiPolygon — массив колец
 *  всех полигонов (индексы дырок задаются holes). */
export interface UserMapFeatureGeometry {
  kind: 'polygon' | 'line' | 'point';
  /** [lat, lng][] — кольца полигона / вершины линии */
  rings: [number, number][][];
  /** Индексы колец, являющихся дырками (для polygon) */
  holes?: number[];
  /** Точки (kind === 'point') */
  points?: [number, number][];
}

/** Элемент пользовательской тактической карты (полигон зоны, линия курса, точка) */
export interface UserMapFeature {
  id: string;
  geometry: UserMapFeatureGeometry;
  name?: string;
  color?: string;
  fillOpacity?: number;
}

/** Метаданные слоя (название, дата загрузки, автор) */
export interface UserMapMeta {
  name: string;
  loadedAt: string; // ISO 8601
  author: string;
  fileName: string;
  fileSize: number;
  sourceFormat: UserMapFormat;
}

/** Пользовательский тактический слой поверх базовой подложки */
export interface UserMapLayer {
  id: string;
  kind: UserMapKind;
  format: UserMapFormat;
  meta: UserMapMeta;
  /** Bounding box слоя в WGS-84 */
  bbox: MapBounds;
  /** Проекция исходника: EPSG:4326 / EPSG:3857 (растровые форматы) */
  projection: 'EPSG:4326' | 'EPSG:3857';
  visible: boolean;
  /** Прозрачность 0..1 */
  opacity: number;
  /** Векторная геометрия (kind === 'vector') */
  features?: UserMapFeature[];
  /** Растровые пиксели (kind === 'raster'): data URL PNG/JPEG.
   *  В zustand-сторе и persist не хранится — тяжёлый payload живёт только в
   *  IndexedDB и подгружается лениво при первой отрисовке слоя. */
  imageDataUrl?: string;
  /** Пиксельные размеры растра */
  imageWidth?: number;
  imageHeight?: number;
  /** Привязка растра (bounds + способ) */
  calibration?: RasterCalibration & { method?: 'geotransform' | 'tiepoints' | 'manual' | 'metadata' };
  /** Параметры тайловой схемы MBTiles (для доменной отрисовки) */
  tileInfo?: { minZoom: number; maxZoom: number; format: string };
  /** Исходный бинарник MBTiles (SQLite). В persist не попадает — живёт в IndexedDB,
   *  восстанавливается лениво при первой отрисовке слоя. */
  sourceBlob?: ArrayBuffer;
}

/** Минимальный набор, сохраняемый в localStorage (сами данные — в IndexedDB) */
export interface UserMapLayerRecord {
  layer: UserMapLayer;
  /** Признак наличия бинарных данных (blob/dataUrl) в IndexedDB */
  hasBlob: boolean;
  bytes: number;
}

export interface Project {
  version: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  map: MapData | null;
  /** Пользовательские тактические карты (GeoJSON/KML/KMZ/GeoTIFF/MBTiles/PNG-JPG) */
  userLayers?: UserMapLayer[];
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
    // Стиль тайловой подложки: схема либо спутник/гибрид (Esri World Imagery)
    tileStyle?: 'scheme' | 'satellite' | 'hybrid';
    tilesEnabled?: boolean;
    /** Автозапрос высот ландшафта (Open-Elevation) для точек маршрутов/маркеров */
    elevationAuto?: boolean;
    /** Запас высоты полёта над рельефом, м (для определения АГЛ-высоты маршрута) */
    altitudeClearanceM?: number;
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
    /** Провайдер тайлов. Legacy-значения ('osm', 'carto') читаются из старых
     *  проектов и нормализуются в normalizeTileServer (openStreetMap.ts). */
    tileServer: 'osm' | 'opentopomap' | 'carto' | 'esri' | 'esri-sat';
  };
}

export type Tool = 'pan' | 'select' | 'addMarker' | 'drawRect' | 'drawPolygon' | 'drawCircle' | 'measure';

export interface ViewState {
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Стартовый zoom (z0) тайловой привязки: мир = canvasWidth·2^z0 px при scale=1.
   *  Фиксируется при загрузке карты — масштаб больше не «сбивается» при ресайзе окна. */
  z0?: number;
}

export interface Measurement {
  points: Point[];
  distance: number; // in pixels
}

// ─── Маршруты (режим действий) ──────────────────────────────────────────────

/** Узел боевого курса: гео-координаты WGS-84 первичны, пиксели — производные */
export interface RoutePoint {
  lat: number;
  lng: number;
  x: number; // пиксель карты (пересчитывается при загрузке/изменении bounds)
  y: number;
  auto?: boolean; // точка добавлена автообходом зон (не ключевая)
  /** Высота ландшафта в точке (м, Open-Elevation), проставляется автоматически */
  terrainM?: number | null;
  /** Требуемая высота полёта ABS (над уровнем моря, м): рельеф + запас / лимиты */
  altitudeAbs?: number | null;
  /** Ручная регулировка высоты этапа на ЭТОЙ точке маршрута (AGL, м).
   *  Задаётся перетаскиванием точки вверх/вниз (или вводом числа); определяет
   *  высоту всего участка до следующей управляющей точки. */
  altitudeAGL?: number | null;
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
  /** Метаданные миссии (create_mission): автор/название/дата */
  missionMeta?: MissionMetaLite;
  /** Параметры узлов боевого курса по индексам (add_tactical_node params) */
  tacticalNodeParams?: Record<number, TacticalNodeParamsLite>;
}

/** Метаданные миссии (минимальная версия для сериализации проекта). */
export interface MissionMetaLite {
  author: string;
  createdAt: string; // ISO 8601
}

/** Параметры узла боевого курса: задержка, угол камеры, скорость, радиус принятия. */
export interface TacticalNodeParamsLite {
  holdSec: number;
  cameraAngleDeg: number;
  speedMs: number;
  acceptanceRadiusM: number;
}

/** Назначение боевому аппарату/группе: старт, цель, маршрут (Блок 5 + ТЗ пользователя). */
export interface CombatAssetAssignment {
  assetId: string;
  startId?: string | null;  // id из importLists.starts
  goalId?: string | null;   // id из importLists.goals
  routeId?: string | null;
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
