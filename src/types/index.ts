// Типы для TotalQuadro Coordinate Marker

export interface Point {
  x: number;
  y: number;
}

/**
 * Единый стандарт гео-координат приложения (аудит 1.2): WGS-84, поля { lat, lng }.
 * Все модули клика по карте, рельефа (elevation), маршрутизации и геокодинга
 * оперируют этим типом; поле `lon` допускается ТОЛЬКО в легаси-интерфейсах
 * (Marker, DroneAssignment) и нормализуется через mapGeoPick.normalizeGeoPick.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Маркер = Точка Боевого Применения (Target Designator). Терминология T3. */
export type TargetDesignator = Marker;

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

/** Провайдеры карт. «2gis» УДАЛЁН ПОЛНОСТЬЮ (ТЗ: выбор карт без 2ГИС):
 *  публичный тайловый сервис закрыт (tile-b01.2gis.com не резолвится). */
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
  /** Импортированные пользовательские тактические карты (Задача 2).
   *  Метаданные + векторы — здесь; растровые бинарники — в IndexedDB. */
  tacticalOverlays?: TacticalOverlayLayer[];
  /** Пользовательские тактические карты (ЭТАП 2: GeoJSON/KML/KMZ/GeoTIFF/MBTiles/PNG-JPG) */
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
    // Стиль тайловой подложки: только стандартная схема OSM (режимы удалены из приложения)
    tileStyle?: 'scheme' | 'satellite' | 'hybrid';
    tilesEnabled?: boolean;
    /** Автозапрос высот ландшафта (Open-Elevation) для точек маршрутов/маркеров */
    elevationAuto?: boolean;
    /** Запас высоты полёта над рельефом, м (для определения АГЛ-высоты маршрута) */
    altitudeClearanceM?: number;
  };
  googleMaps: {
    /** ЭТАП 1.2: всегда '' в персисте — ключ живёт только в памяти сессии */
    apiKey: string;
    enabled: boolean;
    /** Флаг «ключ введён в текущей сессии» (реактивность UI без значения) */
    hasKey?: boolean;
  };
  yandexMaps: {
    apiKey: string;
    enabled: boolean;
    hasKey?: boolean;
  };
  openStreetMap: {
    enabled: boolean;
    /** Рабочие тайловые серверы без API-ключей (см. TILE_PROVIDERS в utils/openStreetMap.ts).
     *  Значения legacy ('osm', 'carto') нормализуются normalizeTileServer()
     *  при чтении — тип остаётся строкой для совместимости со старыми проектами. */
    tileServer?: string;
  };
}

// Ограничения — только бесполетные зоны произвольной геометрии (полигон):
// инструменты drawRect/drawCircle удалены из рабочего процесса.
export type Tool = 'pan' | 'select' | 'addMarker' | 'drawPolygon' | 'measure';

export interface ViewState {
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Стартовый zoom (z0) тайловой привязки: мир = canvasWidth·2^z0 px при scale=1.
   *  Фиксируется при загрузке карты — масштаб больше не «сбивается» при ресайзе окна. */
  z0?: number;
  /** Фактическая ширина канваса в CSS-px на момент записи вида в зеркало
   *  'tq-view'. Нужна конвертеру кликов режима мастера (screenToGeo): без базы
   *  размеров точка клика не может быть строго привязана к подложке. */
  width?: number;
  /** Фактическая высота канваса в CSS-px (см. width). */
  height?: number;
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
  /** Высота ландшафта в точке (м, Open-Elevation), проставляется автоматически */
  terrainM?: number | null;
  /** Требуемая высота полёта ABS (над уровнем моря, м): рельеф + запас / лимиты */
  altitudeAbs?: number | null;
  /** Ручная регулировка высоты этапа на ЭТОЙ точке маршрута (AGL, м).
   *  Задаётся перетаскиванием точки вверх/вниз (или вводом числа); определяет
   *  высоту всего участка до следующей управляющей точки. */
  altitudeAGL?: number | null;
  /** Привязка узла к точке списка старта/цели: при переносе такой точки
   *  маршрут автоматически перестраивается (routeId хранится в ImportPoint). */
  binding?: WaypointBinding;
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
  /** Параметры путевых точек по индексам (add_waypoint params) */
  waypointParams?: Record<number, WaypointParamsLite>;
}

/** Привязка путевой точки к списку старта/цели (importLists) — узел, а не весь маршрут. */
export interface WaypointBinding {
  kind: 'start' | 'goal';
  /** id из importLists.starts / importLists.goals */
  pointId: string;
}

/** Метаданные миссии (минимальная версия для сериализации проекта). */
export interface MissionMetaLite {
  author: string;
  createdAt: string; // ISO 8601
  /** Режим работы дрона для этой миссии (профиль парка). */
  mode?: 'short_range' | 'long_range';
  /** Класс применения: обычный / агродрон. */
  droneClass?: 'standard' | 'agri';
}

/** Параметры путевой точки: задержка, угол камеры, скорость, радиус принятия. */
export interface WaypointParamsLite {
  holdSec: number;
  cameraAngleDeg: number;
  speedMs: number;
  acceptanceRadiusM: number;
}

/** Назначение дрону/группе: старт, цель, маршрут (Блок 5 + ТЗ пользователя). */
export interface DroneAssignment {
  droneId: string;
  startId?: string | null;  // id из importLists.starts
  goalId?: string | null;   // id из importLists.goals
  routeId?: string | null;
  /** Имена дронов группы (роль в группе — leader и т.п.). Пусто = соло-дрон. */
  groupMembers?: string[];
}

/** Группа дронов на один общий маршрут (до MAX_GROUP_SIZE штук). */
export interface DroneGroup {
  id: string;
  name: string;
  memberIds: string[];
  routeId: string | null;
  formation?: 'line' | 'v-shape' | 'grid';
}

/** Видеоканал дрона → GCS (симуляция стрима в браузере). */
export interface DroneVideoState {
  streaming: boolean;
  /** Запрошен ли поток (кнопка «видео»). */
  requested: boolean;
  note: string;
  ok: boolean;
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

// ─── ЗАГРУЗЧИК ПОЛЬЗОВАТЕЛЬСКИХ ТАКТИЧЕСКИХ КАРТ (Задача 2) ─────────────────
// Импортированные пользователем карты в геодезических форматах с ЖЁСТКИМ
// сохранением координатной привязки (georeferencing). Метаданные хранятся в
// Zustand-сторе (project.tacticalOverlays, персистится), бинарные данные —
// в IndexedDB (store 'tactical-overlays', см. utils/storage.ts).

/** Поддерживаемые форматы пользовательских тактических карт */
export type TacticalOverlayFormat = 'geotiff' | 'kml' | 'kmz' | 'geojson' | 'mbtiles' | 'image';

/** Кодировка растра после декодирования (PNG — канонический внутренний формат) */
export type TacticalOverlayEncoding = 'png' | 'jpeg' | 'webp';

/** EPSG-код projection: только Web Mercator и гео-координаты WGS-84 */
export type TacticalOverlayProjection = 'EPSG:4326' | 'EPSG:3857';

/** Границы слоя: ЗОНАЛЬНО-УГЛОВОЙ порядок [west, south, east, north] (GeoJSON/KML/GDAL convention) */
export type BBox4 = [number, number, number, number];

/** Привязка растрового слоя к географии (Web Mercator, та же математика что у тайлов OSM) */
export interface TacticalOverlayGeoref {
  /** bounding box слоя в EPSG:4326 (lon/lat, градусы) */
  boundsWgs84: MapBounds;
  /** родная проекция исходного файла */
  projection: TacticalOverlayProjection;
  /** размер растра в пикселях */
  widthPx: number;
  heightPx: number;
}

/** Полигон/линия из KML/GeoJSON как оверлей-вектор поверх подложки */
export interface TacticalOverlayVector {
  kind: 'polygon' | 'line';
  name: string;
  color: string;
  /** замкнутый полигон или разомкнутая линия, { lat, lng } (стандарт аудита 1.2) */
  ring: GeoPoint[];
}

/** Метаданные импортированного слоя (бинарник — по layerId в IndexedDB) */
export interface TacticalOverlayLayer {
  id: string;
  /** layerId в IndexedDB store 'tactical-overlays' */
  blobKey: string;
  name: string;
  format: TacticalOverlayFormat;
  encoding: TacticalOverlayEncoding;
  visible: boolean;
  opacity: number; // 0..1
  georef: TacticalOverlayGeoref;
  vectors?: TacticalOverlayVector[];
  /** TileMatrixSetLinks для MBTiles (zoom range) */
  zoomRange?: { min: number; max: number };
  importedAt: string; // ISO
  sizeBytes: number;
}

/** Максимум боевых аппаратов в парке (групповой удар до 10 000 БПЛА). */
export const MAX_FLEET_SIZE = 10000;
/** Максимум боевых аппаратов в одной группе (группа летит по одному боевому курсу). */
export const MAX_GROUP_SIZE = 10000;
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

