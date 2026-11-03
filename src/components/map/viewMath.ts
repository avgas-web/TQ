/**
 * viewMath.ts — чистая математика вида карты (Web Mercator EPSG:3857), извлечена
 * из MapCanvas.tsx (Фаза 5.C). Никаких React-зависимостей и обращений к stores:
 * все функции детерминированы и покрыты тестами tests/mapViewMath.test.ts.
 * Инвариант привязки: worldPx = canvasHeight · 2^zoom, zoom = z0 + log2(scale).
 */
import type { Point, MapBounds, ViewState } from "../../types";
import { TILE_PROVIDERS } from "../../utils/openStreetMap";

/** Границы зума тайловой карты: minZoom 3 (вся страна/регион), maxZoom 19 (уровни OSM).
 *  Раньше нижняя граница была z10 — поэтому «большая карта» (страна/область) не
 *  загружалась целиком и не отдалялась дальше крупного города. */
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;

/** Палитра цветов маршрутов (повторяется циклически при большом числе маршрутов) */
export const ROUTE_PALETTE = [
  "#22d3ee",
  "#a78bfa",
  "#f472b6",
  "#4ade80",
  "#facc15",
  "#fb923c",
  "#38bdf8",
  "#e879f9",
];

/** Нативный max zoom рабочих тайловых серверов (выше НЕ поднимаемся — нет данных,
 *  только растяжение). Реестр по аудиту audit/index.fixed.html: tile.openstreetmap.org
 *  и Carto удалены; legacy-значения ('osm', 'carto') сохраняются как
 *  совместимость со старыми проектами. */
export const NATIVE_MAX_BY_SERVER: Record<string, number> = {
  ...(Object.fromEntries(
    Object.entries(TILE_PROVIDERS).map(([id, p]) => [id, p.maxNativeZoom]),
  ) as Record<string, number>),
  osm: 19,
  carto: 18, // legacy-алиасы (нормализуются normalizeTileServer); '2gis' УДАЛЁН ПОЛНОСТЬЮ (ТЗ)
};

/** КЛЮЧ сохранённого вида в localStorage. Раньше состояние камеры жило ТОЛЬКО в
 *  zustand-persist ('tq-map'): любое зависание гонки гидрации/сброса сторов
 *  приводило к viewState {offsetX:0, offsetY:0, scale:1} — при активной тайловой
 *  карте width=height=4·2^26 px это ~268 млн пикселей на экран, т.е. растр
 *  bounds-привязки уходил за десятки тысяч экранов и «загруженная» карта была
 *  не видна. Теперь вид дублируется здесь же, независимо от persist-стора. */
export const VIEW_STORAGE_KEY = "tq-view";

/** Санация произвольного числа в конечное (NaN/Infinity → fallback). */
export function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Нормализация произвольного объекта вида в валидный ViewState. */
export function sanitizeView(o: any): ViewState | null {
  if (!o || typeof o !== "object") return null;
  const offsetX = finiteOr(o.offsetX, NaN);
  const offsetY = finiteOr(o.offsetY, NaN);
  const scale = finiteOr(o.scale, NaN);
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !(scale > 0))
    return null;
  const z0 =
    typeof o.z0 === "number" && Number.isFinite(o.z0) ? o.z0 : undefined;
  return { offsetX, offsetY, scale, z0 };
}

/** Чтение сохранённого вида из localStorage (независимо от persist-стора). */
export function readSavedView(): ViewState | null {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeView(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Запись вида в localStorage (частые записи троттлятся rAF-скобкой в компоненте). */
export function writeSavedView(v: ViewState): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* quota/privacy mode */
  }
}

/** Дефолтный стартовый зум активной карты (как в режиме планирования). */
export const DEFAULT_TILE_MAP_ZOOM = 10;
/** Изначальная фокусировка всех окон карты — Санкт-Петербург (СПб). */
export const SPB_GEO_CONST = { lat: 59.9398, lng: 30.3146 };

/** Fallback-вид над СПб при невалидных данных (битый localStorage / гидрация).
 *  Раньше вместо него подставлялся нейтральный {offsetX:0, offsetY:0, scale:1}:
 *  при мире z10 это ~2^12 экранов от подложки — камера уходила в «бесконечность»,
 *  очередь тайлов переполнялась каждый кадр → вечный спиннер («виснет намертво»).
 *  Формула идентична инварианту вида: worldPx = vh·2^zoom, zoom = ZOOM_REF + log2(scale),
 *  центр экрана привязан к mercator-доле СПб. */
export function spbFallbackView(canvasH: number): ViewState {
  const zoom = clampZoom(DEFAULT_TILE_MAP_ZOOM);
  const worldPx = Math.max(256, canvasH * Math.pow(2, zoom));
  const fy = latToMerc(SPB_GEO_CONST.lat);
  return {
    scale: worldPx / (canvasH * Math.pow(2, ZOOM_REF)),
    offsetX: 0, // задаётся вызывающим кодом после замера ширины контейнера
    offsetY: canvasH / 2 - fy * worldPx,
    z0: ZOOM_REF,
  };
}

/** Ключ «пары карт» (источник + гео-привязка), по которому ведётся учёт
 *  стартовых фиксаций вида. Совпадает с fitKey эффекта автоподгонки. */
export function mapFitKey(
  m: { dataUrl?: string; bounds?: MapBounds } | null | undefined,
): string {
  if (!m || !m.bounds) return "";
  const b = m.bounds;
  return `${m.dataUrl ? "img" : "tiles"}|${b.north},${b.south},${b.west},${b.east}`;
}

/** Санация восстановленного из localStorage вида перед его применением.
 *  Возвращает null, если вид нельзя использовать и нужна повторная
 *  автоподгонка (стартовая фиксация над объектом загрузки / СПб):
 *   • сам вид отсутствует или невалиден (NaN/Infinity/scale<=0);
 *   • масштаб абсурден: zoom вне [MIN_ZOOM−1, MAX_ZOOM+2] — такой вид мог
 *     возникнуть только от битой формулы подгонки (например scale≈3700 ⇔
 *     z≈25.8 при мире z10) и разгоняет растровый цикл канваса до зависания;
 *   • вид сохранён для ДРУГОЙ карты (ключ пары сменился) — иначе stale-вид
 *     от предыдущей карты уводит камеру за пределы подложки («не видно»). */
export function sanitizeSavedView(
  v: ViewState | null,
  curKey: string,
  savedKey: string | null,
): ViewState | null {
  if (!v) return null;
  if (curKey && savedKey !== curKey) return null;
  const z = zoomOfView(v.scale, v.z0 ?? ZOOM_REF);
  if (!Number.isFinite(z) || z < MIN_ZOOM - 1 || z > MAX_ZOOM + 2) return null;
  return v;
}
// Параметры аккуратной очереди загрузки тайлов (как на openstreetmap.org):
// максимум параллельных загрузок и дебаунс новых волн во время жеста.
export const MAX_PARALLEL = 6;
export const TILE_DEBOUNCE_MS = 150;

/**
 * ЕДИНАЯ инвариантная привязка вида «экран ↔ география» (Web Mercator EPSG:3857).
 * ИСПРАВЛЕНИЕ КЛЮЧЕВОЙ ОШИБКИ: раньше world-size по X считался от ширины канваса
 * (canvasWidth·scale·2^z0), а по Y — от высоты растра карты (map.height·scale).
 * Эти две величины совпадали ТОЛЬКО если растр покрывал ровно весь мир — при любой
 * реальной карте (bounds уже всего мира) они расходились в разы. Следствия: тайлы
 * ехали относительно объектов, «сбивался масштаб», при загрузке большой карты
 * требовались тысячи тайлов (карта не загружалась), а привязка к координатам
 * нарушалась. Теперь размер мира в экранных px определяется ЗУМОМ и высотой
 * канваса — как во всех стандартных тайловых картах (Leaflet/MapLibre):
 *   worldPx = canvasHeight · 2^zoom,  zoom = z0 + log2(scale)  (z0 = 14 — эталон).
 * Объекты хранятся в пикселях растра map.width×map.height, покрывающего bounds;
 * растр географически корректен (Web Mercator), поэтому его пиксели переводятся
 * в world-пиксели точно: sx = map.width·(lngSpan/360), sy = map.height·(mercSpanY).
 * Всё (тайлы, сетка, линейка, зум, курсор, объекты) считается через одну формулу —
 * масштаб не может «сбиться», привязка строга на любом зуме от z3 до z19+.
 */
export const ZOOM_REF = 14; // эталонный стартовый zoom: scale=1 ⇔ мир = canvasHeight·2^14 px

/** Нейтральный фолбэк-вид: только для типового сужения nullable-viewRef.
 *  К моменту любого чтения вида компонент уже гарантированно инициализирован
 *  (ленивая ветка `if (viewRef.current === null)` выполняется до рендера),
 *  поэтому это значение фактически недостижимо — но делает все обращения к
 *  `v.offsetX/v.scale` типобезопасными без точечных guard'ов в 30+ местах. */
export const NEUTRAL_VIEW: ViewState = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  z0: ZOOM_REF,
};
export function zoomOfView(scale: number, z0?: number): number {
  return (z0 ?? ZOOM_REF) + Math.log2(Math.max(scale, 1e-12));
}
export function worldPxOf(canvasH: number, scale: number, z0?: number): number {
  return Math.max(256, canvasH * Math.pow(2, zoomOfView(scale, z0)));
}
export function zoomAtWorldPx(worldPx: number): number {
  return Math.log2(Math.max(worldPx / 256, 1e-9));
}
/** Метров на ЭКРАННЫЙ пиксель (учёт широты обязателен — иначе линейка врёт) */
export function metersPerPixelFromWorld(
  worldPx: number,
  latRef: number,
): number {
  const z = zoomAtWorldPx(worldPx);
  return (
    (156543.0339280412 / Math.pow(2, z)) * Math.cos((latRef * Math.PI) / 180)
  );
}
/** Обратное преобразование: мир в px под целевые м/пиксель */
export function worldPxForMetersPerPixel(mpp: number, latRef: number): number {
  const mppEq = mpp / Math.max(0.05, Math.cos((latRef * Math.PI) / 180));
  return (
    256 * Math.pow(2, Math.log2(156543.0339280412 / Math.max(mppEq, 1e-9)))
  );
}
/** Границы scale для minZoom..maxNativeZoom (не выше нативного уровня сервера) */
export function scaleBoundsForZooms(
  canvasH: number,
  z0: number | undefined,
  server: string,
): { min: number; max: number } {
  void canvasH; // границы задаются zoom'ом, а не размером окна — scale относительна z0=14
  const nativeMax = Math.min(
    MAX_ZOOM,
    NATIVE_MAX_BY_SERVER[server] ?? MAX_ZOOM,
  );
  return {
    min: Math.pow(2, MIN_ZOOM - (z0 ?? ZOOM_REF)),
    max: Math.pow(2, nativeMax - (z0 ?? ZOOM_REF)),
  };
}

/** Человекочитаемая подпись масштаба */
export function scaleLabel(mpp: number): string {
  if (mpp >= 1000) return `1 px ≈ ${(mpp / 1000).toFixed(1)} км`;
  if (mpp >= 1) return `1 px ≈ ${mpp.toFixed(1)} м`;
  if (mpp >= 0.01) return `1 px ≈ ${Math.round(mpp * 100)} см`;
  return `1 px ≈ ${(mpp * 1000).toFixed(1)} мм`;
}

/** Широта центра bounds — для точного расчёта метров/пиксель */
export function centerLatOf(bounds: { north: number; south: number }): number {
  return (bounds.north + bounds.south) / 2;
}

/**
 * Автоподбор вида под все объекты (маршруты, маркеры, зоны) — карта загружается
 * НЕ статичной картинкой «в размер окна», а активным видом, охватывающим данные.
 * Привязка — та же строгая формула, что и у тайлов/объектов: пиксель растра
 * переводится в world-пиксели текущего зума через mercWorldPx (мировая Mercator-
 * высота растра), поэтому fit корректен на ЛЮБОМ зуме (z3..z19+) и не «сбивает»
 * масштаб. Ограничение: целевой zoom держим в [MIN_ZOOM, MAX_ZOOM].
 */
export function fitViewToData(
  mapW: number,
  mapH: number,
  bounds: MapBounds,
  pts: Point[],
  vw: number,
  vh: number,
  z0?: number,
): { scale: number; offsetX: number; offsetY: number; z0: number } | null {
  if (pts.length === 0 || mapW <= 0 || mapH <= 0) return null;
  // Пиксели объектов -> география через точную Mercator-привязку растра к bounds
  const north = bounds.north,
    south = bounds.south;
  const east = bounds.east ?? 180;
  const west = bounds.west ?? -180;
  const topY = latToMerc(north);
  const botY = latToMerc(south);
  const mercSpanY = Math.max(1e-12, botY - topY); // высота мира (0..1) на всю карту
  const lngSpanX = Math.max(1e-12, (east - west) / 360); // ширина мира (0..1) на всю карту
  const toWorldFrac = (p: Point): [number, number] => [
    west / 360 + 0.5 + (p.x / mapW - 0.5) * lngSpanX, // долгота -> [0..1] мира
    topY + (p.y / mapH) * mercSpanY, // широта -> mercator [0..1] мира
  ];
  let minFx = Infinity,
    maxFx = -Infinity,
    minFy = Infinity,
    maxFy = -Infinity;
  for (const p of pts) {
    const [fx, fy] = toWorldFrac(p);
    if (fx < minFx) minFx = fx;
    if (fx > maxFx) maxFx = fx;
    if (fy < minFy) minFy = fy;
    if (fy > maxFy) maxFy = fy;
  }
  if (!isFinite(minFx) || !isFinite(minFy)) return null;
  const pad = 0.05;
  minFx -= (maxFx - minFx) * pad || 1e-4;
  maxFx += (maxFx - minFx) * pad || 1e-4;
  minFy -= (maxFy - minFy) * pad || 1e-4;
  maxFy += (maxFy - minFy) * pad || 1e-4;
  const wFrac = Math.max(1e-9, maxFx - minFx);
  const hFrac = Math.max(1e-9, maxFy - minFy);
  // КРИТ. ФИКС пропорций: world-px изотропны (квадратные тайлы Mercator), т.е.
  // width_px = height_px = worldPx. Поэтому целевой размер мира считаем как
  // Math.min от независимых требований ширины и высоты — иначе подбор только по
  // высоте (vh / hFrac) гарантированно НЕ вмещает bbox по ширине, и «компенсация»
  // растяжением давала бы искажение aspect ratio (сплющивание/растягивание).
  const worldTargetW = vw / wFrac;
  const worldTargetH = vh / hFrac;
  const worldTarget = Math.min(worldTargetW, worldTargetH);
  let zoom = zoomAtWorldPx(worldTarget);
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  // Ограничение зумом может оставить мир крупнее окна — тогда bbox физически не
  // влезает (ниже MIN_ZOOM опускаться нельзя): центрируем по минимуму и честно
  // показываем обрезку, вместо того чтобы искажать пропорции не-равномерным scale.
  const worldPx = Math.max(256, Math.min(worldTarget, 256 * Math.pow(2, zoom)));
  // ЕДИНАЯ инвариантная привязка вида: worldPx = vh · 2^(z0 + log2(scale)),
  // где z0 передаётся вызывающим кодом из АКТУАЛЬНОГО viewState (см. worldPxOf).
  // Раньше здесь жёстко подставлялся ZOOM_REF=14 (и тем более bounds.z0, которого
  // в MapBounds нет), из-за чего fitToAll давал scale, который render-путь
  // пересчитывал в ДРУГОЙ worldPx при z0≠14 — «компенсация» растягивала карту
  // за пределы экрана, и тайлы улетали в бесконечную перезагрузку
  // (зависание подложки при старте мастера с z0=3).
  const baseZ0 = Number.isFinite(z0) ? (z0 as number) : ZOOM_REF;
  const scale = worldPx / (vh * Math.pow(2, baseZ0)); // scale относительно z0
  // центр bbox в world-px -> смещение, чтобы центр оказался в центре экрана
  const cxW = ((minFx + maxFx) / 2) * worldPx;
  const cyW = ((minFy + maxFy) / 2) * worldPx;
  return { scale, offsetX: vw / 2 - cxW, offsetY: vh / 2 - cyW, z0: baseZ0 };
}

/** Нормализованная Mercator Y широты (0..1) */
export function latToMerc(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Обратная Mercator: нормализованная Y -> широта */
export function mercToLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ограничение зума диапазоном [MIN_ZOOM, MAX_ZOOM] — единый источник правды */
export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Подпись «1 см на экране = N м» при текущем масштабе (96 css px = 2.54 см) */
export function rulerScaleText(mpp: number): string {
  const m1cm = mpp * (2.54 / 96) * 100; // метров в 1 см экрана
  if (m1cm >= 1000)
    return `1 см ≈ ${(m1cm / 1000).toFixed(m1cm >= 10000 ? 0 : 1)} км`;
  if (m1cm >= 1) return `1 см ≈ ${m1cm.toFixed(m1cm < 10 ? 1 : 0)} м`;
  return `1 см ≈ ${(m1cm * 100).toFixed(0)} см`;
}

/**
 * Расстояние в экранных пикселях от точки до ломаной маршрута.
 * Используется для «прицела» к точкам и сегментам маршрута при редактировании.
 */
export function distPxToPolyline(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  let best = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}
