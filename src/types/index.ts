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
    // Стиль тайловой подложки: только стандартная схема OSM (режимы удалены из приложения)
    tileStyle?: 'scheme';
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
    tileServer: 'osm' | 'opentopomap' | 'carto';
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

/** Максимум дронов в парке (рой до 10 000 БПЛА). */
export const MAX_FLEET_SIZE = 10000;
/** Максимум дронов в одной группе (группа летит по одному маршруту). */
export const MAX_GROUP_SIZE = 10000;
