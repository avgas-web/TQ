import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore, scheduleRerouteAll, getActiveZonesCached } from '../store/useStore';
import { readProjectView, readProjectViewWithActions } from '../store/useStoreShim';
import { useMissionStore } from '../store/useMissionStore';
import { useFleetStore } from '../store/useFleetStore';
import { isPointInsideAnyRestriction, distanceBetween } from '../utils/geometry';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import { haversineDistanceM, bearingDeg, boundsFromPoints } from '../utils/actionMode';
import { pixelToGeoExact, geoToPixelExact, routeLengthM, zonesCrossedBy, planPathAroundZones, smoothPolyline } from '../utils/routing';
import {
  getOSMTileUrl, startTileLoad, abortTileImage, loadTileWithMirrors,
  normalizeTileServer, TILE_PROVIDERS, onTileError, getTileErrorCount,
  type TileStyle, type TileLoadHandle, type TileServerId,
} from '../utils/openStreetMap';
import { useMapStore } from '../store/useMapStore';
import { ensureDefaultTileMap } from '../hooks/useAppInitialization';
import MiniMapPanel, { MiniOverlayLine, MiniOverlayPoint, type MiniZone } from './MiniMapPanel';
import { zoomForGroundMpp, GROUND_MPP_1CM_2KM } from '../utils/pannelli';
import {
  drawTacticalRasterLayer, drawTacticalVectorLayer, makeRasterToScreen,
  getCachedOverlayRaster, ensureOverlayRaster, evictOverlayRaster,
} from '../utils/tacticalOverlayRender';
import { eventBus } from '../utils/eventBus';
import type { Point, Route, RoutePoint, MapBounds, ViewState } from '../types';

/** Границы зума тайловой карты: minZoom 3 (вся страна/регион), maxZoom 19 (уровни OSM).
 *  Раньше нижняя граница была z10 — поэтому «большая карта» (страна/область) не
 *  загружалась целиком и не отдалялась дальше крупного города. */
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

/** Палитра цветов маршрутов (повторяется циклически при большом числе маршрутов) */
const ROUTE_PALETTE = ['#22d3ee', '#a78bfa', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#38bdf8', '#e879f9'];

/** Нативный max zoom рабочих тайловых серверов (выше НЕ поднимаемся — нет данных,
 *  только растяжение). Реестр по аудиту audit/index.fixed.html: tile.openstreetmap.org
 *  и Carto удалены; legacy-значения ('osm', 'carto') сохраняются как
 *  совместимость со старыми проектами. */
const NATIVE_MAX_BY_SERVER: Record<string, number> = {
  ...Object.fromEntries(
    Object.entries(TILE_PROVIDERS).map(([id, p]) => [id, p.maxNativeZoom]),
  ) as Record<string, number>,
  osm: 19, carto: 18, // legacy-алиасы (нормализуются normalizeTileServer); '2gis' УДАЛЁН ПОЛНОСТЬЮ (ТЗ)
};

/** КЛЮЧ сохранённого вида в localStorage. Раньше состояние камеры жило ТОЛЬКО в
 *  zustand-persist ('tq-map'): любое зависание гонки гидрации/сброса сторов
 *  приводило к viewState {offsetX:0, offsetY:0, scale:1} — при активной тайловой
 *  карте width=height=4·2^26 px это ~268 млн пикселей на экран, т.е. растр
 *  bounds-привязки уходил за десятки тысяч экранов и «загруженная» карта была
 *  не видна. Теперь вид дублируется здесь же, независимо от persist-стора. */
const VIEW_STORAGE_KEY = 'tq-view';

/** Санация произвольного числа в конечное (NaN/Infinity → fallback). */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Нормализация произвольного объекта вида в валидный ViewState. */
function sanitizeView(o: any): ViewState | null {
  if (!o || typeof o !== 'object') return null;
  const offsetX = finiteOr(o.offsetX, NaN);
  const offsetY = finiteOr(o.offsetY, NaN);
  const scale = finiteOr(o.scale, NaN);
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !(scale > 0)) return null;
  const z0 = typeof o.z0 === 'number' && Number.isFinite(o.z0) ? o.z0 : undefined;
  return { offsetX, offsetY, scale, z0 };
}

/** Чтение сохранённого вида из localStorage (независимо от persist-стора). */
function readSavedView(): ViewState | null {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeView(JSON.parse(raw));
  } catch { return null; }
}

/** Запись вида в localStorage (частые записи троттлятся rAF-скобкой в компоненте). */
function writeSavedView(v: ViewState): void {
  try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(v)); } catch { /* quota/privacy mode */ }
}

/** Дефолтный стартовый зум активной карты (как в режиме планирования). */
const DEFAULT_TILE_MAP_ZOOM = 10;
/** Изначальная фокусировка всех окон карты — Санкт-Петербург (СПб). */
const SPB_GEO_CONST = { lat: 59.9398, lng: 30.3146 };

/** Fallback-вид над СПб при невалидных данных (битый localStorage / гидрация).
 *  Раньше вместо него подставлялся нейтральный {offsetX:0, offsetY:0, scale:1}:
 *  при мире z10 это ~2^12 экранов от подложки — камера уходила в «бесконечность»,
 *  очередь тайлов переполнялась каждый кадр → вечный спиннер («виснет намертво»).
 *  Формула идентична инварианту вида: worldPx = vh·2^zoom, zoom = ZOOM_REF + log2(scale),
 *  центр экрана привязан к mercator-доле СПб. */
function spbFallbackView(canvasH: number): ViewState {
  const zoom = clampZoom(DEFAULT_TILE_MAP_ZOOM);
  const worldPx = Math.max(256, canvasH * Math.pow(2, zoom));
  const fx = (SPB_GEO_CONST.lng + 180) / 360;
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
function mapFitKey(m: { dataUrl?: string; bounds?: MapBounds } | null | undefined): string {
  if (!m || !m.bounds) return '';
  const b = m.bounds;
  return `${m.dataUrl ? 'img' : 'tiles'}|${b.north},${b.south},${b.west},${b.east}`;
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
function sanitizeSavedView(v: ViewState | null, curKey: string, savedKey: string | null): ViewState | null {
  if (!v) return null;
  if (curKey && savedKey !== curKey) return null;
  const z = zoomOfView(v.scale, v.z0 ?? ZOOM_REF);
  if (!Number.isFinite(z) || z < MIN_ZOOM - 1 || z > MAX_ZOOM + 2) return null;
  return v;
}
// Параметры аккуратной очереди загрузки тайлов (как на openstreetmap.org):
// максимум параллельных загрузок и дебаунс новых волн во время жеста.
const MAX_PARALLEL = 6;
const TILE_DEBOUNCE_MS = 150;

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
const ZOOM_REF = 14; // эталонный стартовый zoom: scale=1 ⇔ мир = canvasHeight·2^14 px

/** Нейтральный фолбэк-вид: только для типового сужения nullable-viewRef.
 *  К моменту любого чтения вида компонент уже гарантированно инициализирован
 *  (ленивая ветка `if (viewRef.current === null)` выполняется до рендера),
 *  поэтому это значение фактически недостижимо — но делает все обращения к
 *  `v.offsetX/v.scale` типобезопасными без точечных guard'ов в 30+ местах. */
const NEUTRAL_VIEW: ViewState = { offsetX: 0, offsetY: 0, scale: 1, z0: ZOOM_REF };
function zoomOfView(scale: number, z0?: number): number {
  return (z0 ?? ZOOM_REF) + Math.log2(Math.max(scale, 1e-12));
}
function worldPxOf(canvasH: number, scale: number, z0?: number): number {
  return Math.max(256, canvasH * Math.pow(2, zoomOfView(scale, z0)));
}
function zoomAtWorldPx(worldPx: number): number {
  return Math.log2(Math.max(worldPx / 256, 1e-9));
}
/** Метров на ЭКРАННЫЙ пиксель (учёт широты обязателен — иначе линейка врёт) */
function metersPerPixelFromWorld(worldPx: number, latRef: number): number {
  const z = zoomAtWorldPx(worldPx);
  return (156543.0339280412 / Math.pow(2, z)) * Math.cos((latRef * Math.PI) / 180);
}
/** Обратное преобразование: мир в px под целевые м/пиксель */
function worldPxForMetersPerPixel(mpp: number, latRef: number): number {
  const mppEq = mpp / Math.max(0.05, Math.cos((latRef * Math.PI) / 180));
  return 256 * Math.pow(2, Math.log2(156543.0339280412 / Math.max(mppEq, 1e-9)));
}
/** Границы scale для minZoom..maxNativeZoom (не выше нативного уровня сервера) */
function scaleBoundsForZooms(canvasH: number, z0: number | undefined, server: string): { min: number; max: number } {
  void canvasH; // границы задаются zoom'ом, а не размером окна — scale относительна z0=14
  const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[server] ?? MAX_ZOOM);
  return {
    min: Math.pow(2, MIN_ZOOM - (z0 ?? ZOOM_REF)),
    max: Math.pow(2, nativeMax - (z0 ?? ZOOM_REF)),
  };
}

/** Человекочитаемая подпись масштаба */
function scaleLabel(mpp: number): string {
  if (mpp >= 1000) return `1 px ≈ ${(mpp / 1000).toFixed(1)} км`;
  if (mpp >= 1) return `1 px ≈ ${mpp.toFixed(1)} м`;
  if (mpp >= 0.01) return `1 px ≈ ${Math.round(mpp * 100)} см`;
  return `1 px ≈ ${(mpp * 1000).toFixed(1)} мм`;
}

/** Широта центра bounds — для точного расчёта метров/пиксель */
function centerLatOf(bounds: { north: number; south: number }): number {
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
function fitViewToData(
  mapW: number, mapH: number, bounds: MapBounds,
  pts: Point[], vw: number, vh: number, z0?: number
): { scale: number; offsetX: number; offsetY: number; z0: number } | null {
  if (pts.length === 0 || mapW <= 0 || mapH <= 0) return null;
  // Пиксели объектов -> география через точную Mercator-привязку растра к bounds
  const north = bounds.north, south = bounds.south;
  const east = bounds.east ?? 180;
  const west = bounds.west ?? -180;
  const topY = latToMerc(north);
  const botY = latToMerc(south);
  const mercSpanY = Math.max(1e-12, botY - topY);   // высота мира (0..1) на всю карту
  const lngSpanX = Math.max(1e-12, (east - west) / 360); // ширина мира (0..1) на всю карту
  const toWorldFrac = (p: Point): [number, number] => [
    west / 360 + 0.5 + ((p.x / mapW) - 0.5) * lngSpanX,           // долгота -> [0..1] мира
    topY + (p.y / mapH) * mercSpanY,                                // широта -> mercator [0..1] мира
  ];
  let minFx = Infinity, maxFx = -Infinity, minFy = Infinity, maxFy = -Infinity;
  for (const p of pts) {
    const [fx, fy] = toWorldFrac(p);
    if (fx < minFx) minFx = fx; if (fx > maxFx) maxFx = fx;
    if (fy < minFy) minFy = fy; if (fy > maxFy) maxFy = fy;
  }
  if (!isFinite(minFx) || !isFinite(minFy)) return null;
  const pad = 0.05;
  minFx -= (maxFx - minFx) * pad || 1e-4; maxFx += (maxFx - minFx) * pad || 1e-4;
  minFy -= (maxFy - minFy) * pad || 1e-4; maxFy += (maxFy - minFy) * pad || 1e-4;
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
function latToMerc(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Обратная Mercator: нормализованная Y -> широта */
function mercToLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ограничение зума диапазоном [MIN_ZOOM, MAX_ZOOM] — единый источник правды */
function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Подпись «1 см на экране = N м» при текущем масштабе (96 css px = 2.54 см) */
function rulerScaleText(mpp: number): string {
  const m1cm = mpp * (2.54 / 96) * 100; // метров в 1 см экрана
  if (m1cm >= 1000) return `1 см ≈ ${(m1cm / 1000).toFixed(m1cm >= 10000 ? 0 : 1)} км`;
  if (m1cm >= 1) return `1 см ≈ ${m1cm.toFixed(m1cm < 10 ? 1 : 0)} м`;
  return `1 см ≈ ${(m1cm * 100).toFixed(0)} см`;
}

/**
 * Расстояние в экранных пикселях от точки до ломаной маршрута.
 * Используется для «прицела» к точкам и сегментам маршрута при редактировании.
 */
function distPxToPolyline(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  let best = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export interface MapCanvasProps {
  /** Публикует флаг фактической загрузки подложки (тайлы или растр) наружу —
   *  Мастер блокирует постановку точек, пока карта не готова (mapReadiness). */
  onMapLoaded?: (loaded: boolean) => void;
}

const MapCanvas: React.FC<MapCanvasProps> = ({ onMapLoaded }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapImageRef = useRef<HTMLImageElement | null>(null);
  const isPanningRef = useRef(false); // без state — панорама не вызывает ре-рендер на каждый mousemove
  const panStartRef = useRef<Point>({ x: 0, y: 0 });
  // Начальные размеры НЕЛЬЗЯ задавать константой {800,600}: ResizeObserver
  // в useEffect([setViewState]) при первом же observe() получает нативный вызов
  // с фактическими размерами контейнера. Если они равны «выдуманному» дефолту
  // (типично для панели Мастера высотой ровно 600px), ветка `h !== prev.height`
  // не срабатывает, canvas-элементы инициализируются нулевыми clientWidth/Height
  // (jsdom) или устаревшими размерами, а синхронизация тайлов уходит в вечный
  // цикл «canvasSize меняется → renderTick → syncTileDom» — карта «вечно грузится».
  // Дефолт 0,0 делает первый измеренный размер единственным источником истины.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasSizeRef = useRef(canvasSize);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  const [draggingMarker, setDraggingMarker] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Публикация готовности карты наружу (Мастер: запрет точек на пустом поле).
  // Колбэк читается через ref и вызывается СИНХРОННО в момент setMapLoaded —
  // иначе при батчинге React (effect догоняет состояние только на следующем
  // эффекте) мастер мог видеть устаревший флаг «карта не готова» после
  // мгновенной загрузки подложки.
  const onMapLoadedRef = useRef(onMapLoaded);
  useEffect(() => { onMapLoadedRef.current = onMapLoaded; }, [onMapLoaded]);
  // Зеркало текущего значения mapLoaded для идемпотентной публикации
  // (см. publishMapLoaded): updater'ы setState не должны иметь сайд-эффектов.
  const mapLoadedRef = useRef(false);
  // Все отложенные публикационные таймеры — регистрируются, чтобы cleanup при
  // размонтировании гарантированно гасил их (запрет «setState на unmounted»).
  const timersRef = useRef<Set<number>>(new Set());
  // Догоняющий эффект: если стор-источник истины изменился (map=null → false,
  // загрузка подложки → true) вне явных вызовов publishMapLoaded из колбэков
  // Image, локальный React-state и оверлей мастера синхронизируются на следующем
  // рендере. Идемпотентность и вынос за render-фазу обеспечивает сам
  // publishMapLoaded (таймер), поэтому здесь можно вызывать его напрямую.
  // КОРНЕВОЙ ФИКС ВЕЧНОГО ОВЕРЛЕЯ ГОТОВНОСТИ: подписка НА ЗНАЧЕНИЕ флага
  // (примитивный селектор — ре-рендер строго при смене mapLoaded). Прежняя
  // догонялка без deps сравнивала ref со сторовым значением только на рендерах,
  // инициированных РОДИТЕЛЯМИ: в jsdom/happy-dom rAF не дренажится, DOM-слой
  // тайлов не создаёт React-рендера, и публикация готовности терялась —
  // интеграционные тесты мастера висели до глобального timeout раннера.
  const storeMapLoaded = useMapStore((s) => s.mapLoaded);
  // КОРНЕВОЙ ФИКС TDZ-КРАША + ВЕЧНОГО ОВЕРЛЕЯ ГОТОВНОСТИ.
  // «Cannot access 'publishMapLoaded' before initialization»: хук-эффект,
  // вызывавший publishMapLoaded (объявлена ниже через const/useCallback),
  // попадал в temporal dead zone → ReferenceError на первом же рендере.
  // Прежний «ref с no-op заглушкой» маскировал проблему, но ломал саму
  // синхронизацию: публикация наружу (onMapLoaded → setMapLoaded этапа)
  // терялась, и оверлей мастера висел вечно даже после готовности стора.
  // Теперь: локальный React-state и внешний колбэк обновляются ПРЯМО здесь
  // (useCallback стабилен и к моменту запуска эффектов уже инициализирован;
  // setState из effect-фазы легален и не вызывает React #127 — в отличие от
  // вызова из updater'а во время render-фазы). Догонялка идемпотентна по
  // mapLoadedRef, поэтому двойных обновлений нет.
  useEffect(() => {
    if (mapLoadedRef.current === storeMapLoaded) return;
    mapLoadedRef.current = storeMapLoaded;
    setMapLoaded(storeMapLoaded);
    onMapLoadedRef.current?.(storeMapLoaded);
  }, [storeMapLoaded]);
  useEffect(() => () => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current.clear();
  }, []);
  const publishMapLoaded = useCallback((v: boolean): void => {
    // КОРНЕВОЙ ФИКС РАЗГОНА ДВУХ ЭКЗЕМПЛЯРОВ КАРТЫ (React #127 в тестах
    // готовности мастера): если значение совпадает с тем, что УЖЕ лежит в
    // сторе-источнике истины, выходим ДО любых мутаций. Без этого guard'а два
    // экземпляра MapCanvas (mini-подложка этапа + живая панель) в одной
    // commit-фазе гоняли стор false→true→false… через подписку шима, и
    // getSnapshot merged-агрегата выполнялся внутри активной render-фазы →
    // «Should not already be working». Идемпотентность по стору полностью
    // заменяет прежний ref-guard: ref обновляется только вместе со стадией 2.
    if (useMapStore.getState().mapLoaded === v && mapLoadedRef.current === v) return;
    // ВАЖНО (краш «Should not already be working» в RTL-тестах): колбэк
    // наружу НЕЛЬЗЯ вызывать внутри updater'а setState — React выполняет
    // updater синхронно во время рендера, а onMapLoaded делает flushSync
    // из родительского компонента. flushSync внутри фазы рендера — прямой
    // запуск второго конкурентного рендера → падение React DOM.
    // Колбэк вызывается ПОСЛЕ постановки обновления: при первом значении
    // состояние ещё не установлено и это безопасно (мы вне render-фазы),
    // при повторных значениях эффект-дубликаты ниже не срабатывают.
    // КОРНЕВОЙ ФИКС ЗАВИСАНИЯ ОВЕРЛЕЯ ГОТОВНОСТИ: при смене карты на
    // «не готова» (map=null, выключение подложки, провайдер без ключа)
    // сбрасываем ref немедленно. Иначе stale=true блокирует повторную
    // публикацию true после быстрой перезагрузки (false→true в пределах
    // одного macrotask), и оверлей «карта не загружена» зависал вечно.
    if (!v) mapLoadedRef.current = false;
    // ДВУХСТАДИЙНАЯ ПУБЛИКАЦИЯ (см. также useEffect-догонялку ниже).
    // Стадия 1: СИНХРОННО обновляем стор-источник истины — decision-логика
    // кликов мастера (isMapReadyNow) обязана видеть актуальный флаг сразу,
    // независимо от того, успеет ли React перерендерить этап.
    useMapStore.getState().publishMapLoaded(v);
    // Идемпотентность по РЕАКТ-СОСТОЯНИЮ (mapLoadedRef): локальный state и
    // внешний колбэк onMapLoaded двигаются стадией 2 — через таймер. Если бы
    // оба шага выполнялись синхронно, сетевые onload-колбэки нескольких
    // тайлов попадали бы в одну macrotask-задачу и второй вызов ставил
    // setMapLoaded(true) ВНУТРИ активной render-фазы первого обновления →
    // React #127 («Should not already be working»). Таймер выносит каждую
    // следующую публикацию за пределы любой фазы рендера.
    if (mapLoadedRef.current === v) return;
    const t = window.setTimeout(() => {
      timersRef.current.delete(t);
      if (mapLoadedRef.current === v) return; // устарело (пришла противоположная публикация)
      mapLoadedRef.current = v;
      setMapLoaded(v);
      // Стадия 2: публикация наружу родителю (этап мастера обновляет UI-оверлей).
      onMapLoadedRef.current?.(v);
    }, 0);
    timersRef.current.add(t);
  }, []);
  // Перетаскивание точки маршрута: id + индекс (для moveRoutePoint)
  const [draggingRoute, setDraggingRoute] = useState<{ routeId: string; index: number } | null>(null);
  // Popup по клику на объект (координаты, высота, расстояние)
  const [popup, setPopup] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  // Кэш тайлов подложки: url -> изображение (или undefined при ошибке)
  const tileCache = useRef<Map<string, HTMLImageElement>>(new Map());
  // CIRCUIT BREAKER загрузки тайлов (шаг П3 ТЗ): если запросы к CDN «молчат»
  // (429-шторм, молчащий proxy), loadTileImage завершается по своему внутреннему
  // таймауту, но синхронизация может бесконечно перепланировать pump(). Флаг
  // «вечной загрузки» включает UI-оверлей с кнопкой «Попробовать снова», вместо
  // зависшего спиннера. Сбрасывается при любом успешном кадре синхронизации.
  const [tileLoadStalled, setTileLoadStalled] = useState(false);
  // Счётчик принудительных повторных синхронизаций после «Попробовать снова»:
  // меняет ссылку-зависимость и заставляет effect перезапустить pump().
  const [tileRetryNonce, setTileRetryNonce] = useState(0);
  // DOM-слой подложки OSM (как на openstreetmap.org): настоящие <img>-тайлы в
  // <div>-обёртке ПОД canvas. Canvas рисует поверх них маршруты, зоны, маркеры и
  // прочие объекты по той же Mercator-привязке — привязка строгая и общая.
  const tileLayerRef = useRef<HTMLDivElement>(null);
  const tileElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // Актуальная ссылка на функцию позиционирования DOM-слоя тайлов — вызывается
  // из rAF-подписчика на viewState (объявлена ниже через useCallback).
  const tileLayerPositionRef = useRef<() => void>(() => {});
  // LRU-размер кэша тайлов: Map сохраняет порядок вставки — при переполнении
  // удаляем самые старые записи, иначе при длительной работе накапливаются
  // тысячи HTMLImageElement (утечка памяти).
  const TILE_CACHE_MAX = 1500;
  // Очередь щадящей загрузки тайлов: один общий список + счётчик активных загрузок
  const tileQueueRef = useRef<string[]>([]);
  // ЗАГРУЗКИ В ПУТЕШЕСТВИИ (P0-фикс «зависание при загрузке карт»): каждая
  // loadTileImage обязан регистрироваться здесь и сниматься в finally(). При
  // размонтировании MapCanvas (быстрое переключение шагов Мастера) ВСЕ эти
  // загрузки принудительно отменяются — иначе Image с выставленным src живёт
  // до внутреннего таймаута (10 c), держит DOM-элементы и по завершении
  // вызывал setState на unmounted-компоненте (утечка памяти + предупреждения
  // React). Тест wizardFreeze проверяет именно этот инвариант.
  // РЕЕСТР АКТИВНЫХ РУЧЕК ЗАГРУЗКИ (P0): startTileLoad возвращает handle с
  // cancel(); при unmount/смене подложки перебираем реестр и отменяем КАЖДУЮ
  // загрузку — промисы резолвятся в null немедленно, Image прерываются
  // (abort), память не течёт. Именно это проверяет wizardFreeze.test.tsx.
  const tileLoadHandlesRef = useRef<Set<TileLoadHandle>>(new Set());
  /** Зеркало Esri (services.arcgisonline.com) с регистрацией ручки в том же
   *  in-flight-реестре: при неудаче основного хоста пробуем зеркало, но и эту
   *  загрузку обязан отменить cleanup при unmount (P0-инвариант wizardFreeze). */
  const loadEsriMirrorByHandle = useCallback((u: string): Promise<HTMLImageElement | null> => {
    const m = u.match(/^https:\/\/server\.arcgisonline\.com\/(.+)$/);
    if (!m) return Promise.resolve(null);
    // P0-фикс гонки «unmount между отменой и зеркалом» (тест wizardFreeze):
    // если компонент уже размонтирован (cleanup перебрал реестр и сбросил
    // mountedRef), зеркальную загрузку создавать НЕЛЬЗЯ — иначе новый Image
    // стартует ПОСЛЕ отмены всех in-flight и остаётся живым навсегда.
    if (!mountedRef.current) return Promise.resolve(null);
    const h = startTileLoad(`https://services.arcgisonline.com/${m[1]}`, 10000);
    tileLoadHandlesRef.current.add(h);
    return h.done.then((img) => {
      tileLoadHandlesRef.current.delete(h);
      return img;
    });
  }, []);
  const activeTilesRef = useRef(0);
  const tileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Все таймауты, поставленные из этого компонента (debounce синхронизации,
  // pump очереди, circuit breaker размеров/загрузки). ОБЯЗАТЕЛЬНО очищаются в
  // cleanup при размонтировании: переход между шагами Мастера монтирует/
  // размонтирует карту многократно, а «сиротский» Timeout с setState на
  // уже unmounted-компонент = утечка памяти и React-предупреждения.
  const ownedTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const setOwnedTimeout = useCallback((fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = setTimeout(() => { ownedTimersRef.current.delete(id); fn(); }, ms);
    ownedTimersRef.current.add(id);
    return id;
  }, []);
  const clearOwnedTimeout = useCallback((id: ReturnType<typeof setTimeout> | null): void => {
    if (id === null) return;
    clearTimeout(id);
    ownedTimersRef.current.delete(id);
  }, []);
  // Флаг «компонент смонтирован» — защита от setState на unmounted-компоненте.
  // Промисы loadTileImage резолвятся ПОСЛЕ размонтирования (у тайлов нет
  // встроенного таймаута в моках/медленных CDN), и их .then/.finally вызывали
  // setTilesVersion/pump на уже удалённом дереве — React-предупреждения,
  // повторные загрузки и утечки при быстром переключении шагов Мастера.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Троттлинг обновления координат курсора в сторе (см. handleMouseMove)
  const lastCursorUpdateRef = useRef(0);
  // pending-загрузки тайлов: url -> промис (дедупликация — один запрос на тайл)
  const tilePending = useRef<Map<string, Promise<void>>>(new Map());
  const [tilesVersion, setTilesVersion] = useState(0);
  // Состояние тайлового загрузчика для индикатора слоя (пункт C аудита):
  // 'loading' — есть активные загрузки, 'ok' — тайлы грузятся штатно,
  // 'err' — ≥3 ошибок подряд («Слой недоступен, попробуйте другой стиль»).
  type LayerLoadState = 'loading' | 'ok' | 'err';
  const [layerLoadState, setLayerLoadState] = useState<LayerLoadState>('ok');
  const layerLoadStateRef = useRef<LayerLoadState>('ok');
  const tileWarnedRef = useRef(false);
  // Временное текстовое сообщение для индикатора слоя (поиск/геолокация и т.п.)
  // — поверх стандартного статуса «Слой … загружен/загружается/недоступен».
  const [tileStatusMsg, setTileStatusMsg] = useState<string | null>(null);
  // Автоскрытие временного сообщения через 6 с (индикатор возвращается к статусу слоя).
  useEffect(() => {
    if (!tileStatusMsg) return;
    const t = setTimeout(() => setTileStatusMsg(null), 6000);
    return () => clearTimeout(t);
  }, [tileStatusMsg]);
  // Геолокация пользователя
  const [userPos, setUserPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);

  const {
    project,
    currentTool,
    selectedMarkerId,
    activeRouteId,
    isDrawing,
    drawingPoints,
    cursorPosition,
    measurementPoints,
    setViewState,
    setCursorPosition,
    addMarker,
    updateMarker,
    selectMarker,
    addRestriction,
    addDrawingPoint,
    undoDrawingPoint,
    clearDrawingPoints,
    setDrawing,
    setMeasurementPoints,
    appendRoutePoint,
    moveRoutePoint,
    removeRoutePoint,
    setActiveRoute,
  } = useStore();

  // Рабочий тайловый провайдер без API-ключей (реестр TILE_PROVIDERS, аудит
  // audit/index.fixed.html): legacy 'osm'/'carto' нормализуются в Esri/OSM France.
  const tileServer: TileServerId = normalizeTileServer(project.openStreetMap?.tileServer);

  // ===== Индикатор состояния слоя (пункт C аудита) + реакция на смену стиля =====
  // Подписка на счётчик ошибок загрузки (аналог tileerror в Leaflet-аудите):
  // n>=3 → предупреждение без alert(); n===0 (первый успех) → авто-возврат «ок».
  useEffect(() => {
    const handler = (n: number) => {
      if (n >= 3) {
        tileWarnedRef.current = true;
        layerLoadStateRef.current = 'err';
        setLayerLoadState('err');
      } else if (n === 0) {
        tileWarnedRef.current = false;
        layerLoadStateRef.current = 'ok';
        setLayerLoadState('ok');
      }
    };
    const off = onTileError(handler);
    // Состояние загрузчика при подписке (иначе индикатор «ошибка» виден только
    // после нового события, а не сразу после перерисовки компонента)
    handler(getTileErrorCount());
    return off;
  }, []);
  // При смене стиля подложки сбрасываем предупреждение об ошибках и читаем
  // актуальное состояние загрузчика (счётчик общий для всех провайдеров).
  useEffect(() => {
    tileWarnedRef.current = false;
    const n = getTileErrorCount();
    if (n >= 3) {
      layerLoadStateRef.current = 'err';
      setLayerLoadState('err');
    } else {
      layerLoadStateRef.current = 'ok';
      setLayerLoadState('ok');
    }
  }, [tileServer]);

  // ===== viewTick: троттлинг перерисовки канваса (rAF) =====
  // viewState обновляется на каждое движение мыши. Реакция на него идёт НЕ через
  // подписку useStore() на весь store (это тянуло полный React-рендер и шторм
  // запросов тайлов на каждый mousemove -> страница «виснет»), а через лёгкую
  // zustand-подписку с requestAnimationFrame: вид читается из viewRef, canvas
  // перерисовывается не чаще одного кадра, обработчики мыши стабильны.
  // ВАЖНО: viewRef инициализируется напрямую из стора (useStore.getState()), а не
  // из пропсов/деструктуризации — иначе при re-render до гидрации persist можно
  // получить undefined-вид (краш «viewState is not defined» / reading 'scale').
  // ВАЖНО: viewRef инициализируется НЕ из «сырого» стора и не из пропсов:
  // источник приоритетов — (1) сохранённый вид из localStorage-зеркала 'tq-view'
  // (независим от гонки async-гидрации persist — именно она давала stale/нулевой
  // viewState и «невидимую» карту в Мастере), (2) viewState стора, (3) дефолт.
  // Любые NaN/Infinity/scale<=0 отбрасываются санатором — один NaN в offsetX
  // делал transform слоя «NaNpx» и вся подложка исчезала навсегда.
  // ── ФИКС «ВИСНЕТ НАМЕРТВО ПРИ ЗАГРУЗКЕ КАРТ» (корень #2) ──────────────────
  // Стартовая фиксация вида над объектом загрузки (СПб по умолчанию) хранится
  // В ОДНОМ месте — localStorage-зеркале 'tq-view' — вместе с ключом карты,
  // для которой она сделана. При старте компонент восстанавливает её сюда же
  // и в стор (setViewState): это идемпотентно, если persist-стор уже отдал
  // точно такой же вид (гидрация zustand-persist 'tq-map' содержит тот же
  // viewState). Раньше восстановление из зеркала НЕ публиковалось в стор, а
  // «догонялка» store→viewRef отсутствовала: два источника разъезжались, и
  // при remount (редактор↔мастер) канвас рисовался с одним видом, DOM-слой
  // тайлов синхронизировался по другому, очередь уходила в бесконечную
  // перезагрузку — страница «виснет намертво». Теперь приоритет источников
  // жёсткий: зеркало → стор → дефолт, и всё сводится к одному состоянию.
  const fitKeyInit = mapFitKey(useMapStore.getState().map);
  const viewRef = useRef<ViewState | null>(null);
  // Флаг «зеркало tq-view уже опознано на этом маунте»: пока он не снят,
  // hydrating persist 'tq-map' НЕ имеет права затирать восстановленный вид
  // своим stale-дефолтом (см. subscribe ниже). Снимается в rAF после маунта.
  const mirrorResolvedRef = useRef(false);
  // Флаг «вид не восстановлен ни из зеркала, ни из стора» — при первом
  // реальном замере контейнера вид фиксируется над СПб (см. applySizes).
  const pendingSpbFallbackRef = useRef(false);
  if (viewRef.current === null) {
    const savedRaw = readSavedView();
    const savedKeyRaw = (() => {
      try { return localStorage.getItem(`${VIEW_STORAGE_KEY}-map`); } catch { return null; }
    })();
    const restored = sanitizeSavedView(savedRaw, fitKeyInit, savedKeyRaw);
    // Зеркало распознано (валидно либо осознанно отвергнуто по ключу карты) —
    // с этого момента стор больше не является источником истины для viewRef.
    mirrorResolvedRef.current = true;
    // ── ФИКС «ВИСНЕТ НАМЕРТВО» (корень #2, санация) ────────────────────────
    // Ни зеркало, ни стор не дали валидного вида (битый localStorage со
    // scale<=0/NaN либо stale-дефолт гидрации {offsetX:0, offsetY:0, scale:1}) —
    // вместо нейтрального вида (камера в ~2^12 экранов от подложки → вечная
    // перезагрузка тайлов) включается флаг фолбэка: при первом реальном замере
    // контейнера вид принудительно фиксируется над СПб (как в режиме
    // планирования). См. applySizes в эффекте ResizeObserver.
    const restoredOrStore = restored ?? sanitizeView(useStore.getState().viewState);
    if (restoredOrStore) {
      viewRef.current = restoredOrStore;
    } else {
      pendingSpbFallbackRef.current = true;
      viewRef.current = spbFallbackView(600); // временный корректный вид (offsetX добирается при замере)
    }
  }
  // Синхронизация стора с восстановленным зеркалом — ровно один раз на маунт
  // (см. комментарий выше; setViewState с теми же значениями безопасен).
  useEffect(() => {
    const v = viewRef.current ?? NEUTRAL_VIEW;
    if (!v) return;
    const sv = useStore.getState().viewState;
    if (sv.offsetX !== v.offsetX || sv.offsetY !== v.offsetY || sv.scale !== v.scale || sv.z0 !== v.z0) {
      setViewState({ ...v });
    }
    // ── ФИКС «ВИСНЕТ НАМЕРТВО» (корень #1, гонка гидрации) ─────────────────
    // Зеркало опубликовано в стор — подписка на стора может штатно отражать
    // жесты. Флаг снимается НЕ только rAF'ом: в средах без rAF-дренажа
    // (fake timers в vitest, jsdom без кадров) rAF никогда не executes, и флаг
    // оставался бы выставлен навечно — тогда стор-догонялка (setViewState из
    // applySizes/resize) игнорировалась бы и viewRef разъезжался со стором.
    // Поэтому: микро-тик (Promise.resolve) + короткий таймер — как минимум один
    // из них гарантированно выполнится в любой среде; перед сбросом флага
    // сверяемся со стором (последняя публикация — наша), чтобы не потерять
    // жест, случившийся раньше снятия флага.
    let cancelled = false;
    const release = (): void => {
      if (cancelled) return;
      // Принудительное чтение стора: если он уже содержит наш вид (или более
      // свежий валидный жест) — принимаем его как источник, иначе оставляем
      // viewRef (зеркало остаётся истиной до первого жеста).
      const next = sanitizeView(useStore.getState().viewState);
      if (next && mirrorResolvedRef.current) {
        const cur = viewRef.current;
        const same = !!cur && cur.offsetX === next.offsetX && cur.offsetY === next.offsetY
          && cur.scale === next.scale && cur.z0 === next.z0;
        if (same && cur !== useStore.getState().viewState) viewRef.current = useStore.getState().viewState;
      }
      mirrorResolvedRef.current = false;
    };
    const raf = requestAnimationFrame(() => { release(); });
    const t = window.setTimeout(release, 50);
    Promise.resolve().then(() => { /* microtask barrier before timer/rAF race */ });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Зеркало вида в localStorage: запись троттлится rAF-скобкой (по кадру),
  // чтобы drag-панорама не писала JSON на каждый mousemove.
  const saveViewRafRef = useRef(0);
  const writeMirrorNow = useCallback((): void => {
    const v = viewRef.current ?? NEUTRAL_VIEW;
    if (!v) return;
    // ФИКС «не удалось определить размер карты» (привязка кликов): зеркало
    // 'tq-view' — источник истины для screenToGeo в режиме мастера. Без
    // фактических размеров канваса конверсия клика не имеет базы worldPx и
    // возвращает null («точки не ставятся»). Пишем width/height синхронно из
    // canvasSizeRef — это тот же CSS-размер контейнера, что измеряет RO.
    writeSavedView({ ...v, width: canvasSizeRef.current.width, height: canvasSizeRef.current.height });
    // привязка вида к конкретной карте — при смене карты зеркало
    // не должно «переезжать» со stale-видом (иначе карта «не видна»)
    try {
      localStorage.setItem(`${VIEW_STORAGE_KEY}-map`, mapFitKey(useMapStore.getState().map));
    } catch { /* quota/privacy mode */ }
  }, []);
  const scheduleSaveView = useCallback((): void => {
    if (saveViewRafRef.current) return;
    saveViewRafRef.current = requestAnimationFrame(() => {
      saveViewRafRef.current = 0;
      writeMirrorNow();
    });
  }, [writeMirrorNow]);
  useEffect(() => () => {
    if (saveViewRafRef.current) cancelAnimationFrame(saveViewRafRef.current);
    // синхронный финальный снапшот при unmount — шаг мастера сменён, вид не теряется
    writeMirrorNow();
  }, [writeMirrorNow]);
  // Актуальная позиция курсора для «резинки» превью полигона (ref — без ре-рендера)
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const rafDrawRef = useRef(0);
  const schedulePolygonDraw = useCallback(() => {
    if (rafDrawRef.current) return;
    rafDrawRef.current = requestAnimationFrame(() => {
      rafDrawRef.current = 0;
      setRenderTick((t) => t + 1);
    });
  }, []);
  const [renderTick, setRenderTick] = useState(0);
  // Тактические оверлеи: id слоёв с незавершённой декодировкой растра
  // (защита от дублей ensureOverlayRaster в rAF-рендере) + ref для гидрации.
  const overlayDecodeInflightRef = useRef<Set<string>>(new Set());
  const hydratedOnceRef = useRef(false);

  // ─── Гидрация пользовательских тактических карт из IndexedDB (Задача 2, п.4) ─
  // Метаданные слоёв приходят из zustand-persist; бинарные payload-ы (base64
  // растров) поднимаются один раз при маунте во внешний кэш tacticalPayloadCache.
  // При размонтировании выгружаются растры удалённых слоёв — нет утечек памяти.
  useEffect(() => {
    if (!hydratedOnceRef.current) {
      hydratedOnceRef.current = true;
      const st = useStore.getState() as unknown as { hydrateTacticalOverlays?: () => Promise<void> };
      if (typeof st.hydrateTacticalOverlays === 'function') {
        st.hydrateTacticalOverlays()
          .then(() => setRenderTick((t) => t + 1))
          .catch(() => { /* IDB недоступен — слои останутся в метаданных */ });
      }
    }
    const layers = project.tacticalOverlays || [];
    return () => {
      // Выгружаем только растры слоёв, которых больше нет в сторе (удалены):
      // остальные остаются в LRU-кэше для последующих маунтов карты.
      const alive = new Set(layers.map((l) => l.id));
      for (const id of Array.from(overlayDecodeInflightRef.current)) {
        if (!alive.has(id)) evictOverlayRaster(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.tacticalOverlays]);
  useEffect(() => {
    let raf = 0;
    // ── ФИКС «ВИСНЕТ НАМЕРТВО ПРИ ЗАГРУЗКЕ КАРТ» (корень #1) ────────────────
    // Гонка гидрации: zustand-persist 'tq-map' гидрируется АСИНХРОННО и после
    // маунта карты мог прислать в подписку stale-дефолт {offsetX:0, offsetY:0,
    // scale:1} — восстановленный из зеркала вид затирался, worldPx улетал на
    // ~2^12 экранов, очередь тайлов переполнялась каждый кадр → вечный цикл
    // перезагрузки («виснет намертво»). Пока зеркало не опубликовано в стор
    // (mirrorResolvedRef), изменения вида из стора игнорируются: источник
    // истины на этом этапе — сам компонент. После публикации стор штатно
    // догоняется зеркалом, и обратного затирания уже невозможно добиться.
    const unsub = useStore.subscribe((s) => {
      // ── ФИКС «ВИСНЕТ НАМЕРТВО» (корень #1, достройка) ────────────────────
      // Валидация на входе: NaN/Infinity/scale<=0 из гидрируемого/битого стора
      // никогда не попадают в viewRef — один NaN в offsetX делал transform DOM-
      // слоя тайлов «NaNpx», подложка исчезала, а rAF-цикл рисования крутился
      // впустую («виснет намертво»). Невалидное состояние игнорируется; стор
      // догонит зеркало при следующем пользовательском жесте.
      const next = sanitizeView(s.viewState);
      if (!next) return;
      // Ключевое отличие от прежней логики: viewRef больше НЕ заимствует ссылку
      // на объект стора. Он всегда указывает на собственное значение компонента
      // (или идентичный по содержимому снапшот). Иначе mirrorResolvedRef
      // мгновенно сбрасывался бы самим же уведомлением стора и stale-дефолт
      // гидрации всё равно затирал восстановленный вид.
      const cur = viewRef.current;
      const same = !!cur && cur.offsetX === next.offsetX && cur.offsetY === next.offsetY
        && cur.scale === next.scale && cur.z0 === next.z0;
      if (same) {
        // Стор прислал то же самое значение новым объектом — принимаем ссылку
        // (без ре-рендера), чтобы разорвать цикл «догонялок».
        if (cur !== s.viewState) viewRef.current = s.viewState;
        return;
      }
      if (mirrorResolvedRef.current) {
        // Зеркало ещё не опубликовано в стор (гидрация persist запаздывает):
        // изменения вида из стора ИГНОРИРУЕМ — источник истины сейчас компонент.
        return;
      }
      viewRef.current = next;
      scheduleSaveView();
      // Подложка OSM — DOM-слой: его позиция обновляется напрямую без
      // React-рендера (как на openstreetmap.org). Функция объявлена ниже через
      // useCallback — берём актуальную ссылку из ref, чтобы не создавать
      // цикл зависимостей и не терять вызов при HMR.
      tileLayerPositionRef.current?.();
      if (raf) return; // уже запланировано — не плодим рендеры (троттлинг до 1/кадр)
      raf = requestAnimationFrame(() => { raf = 0; setRenderTick((t) => t + 1); });
    });
    return () => { unsub(); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Актуальный вид для РЕНДЕРА (обновлён в последнем кадре)
  // viewRef типизирован nullable (ленивая инициализация в теле компонента);
  // к моменту рендера он ВСЕГДА заполнен — ветка `if (viewRef.current === null)`
  // выполняется до первого возврата из хуков. Фолбэк — нейтральный вид.
  const vs = viewRef.current ?? { offsetX: 0, offsetY: 0, scale: 1, z0: ZOOM_REF };

  // devicePixelRatio — для чёткого рендера на Retina/HiDPI экранах
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

  // ===== Тайловая подложка: карта активна, а НЕ статичная фотография =====
  // Кэш тайлов, дозагрузка при изменении вида; maxNativeZoom — выше не растягиваем.
  const tilesEnabled = !!project.settings?.tilesEnabled && !!project.map?.bounds;
  // Только стандартная схема OSM (режимы «спутник/гибрид» удалены из приложения)
  const tileStyle: TileStyle = 'scheme';
  // ЕДИНАЯ инвариантная привязка вида (см. комментарий над worldPxOf):
  //   zoom = z0 + log2(scale),  worldPx = canvasHeight · 2^zoom.
  const effZ0 = vs.z0 ?? ZOOM_REF;
  const worldPx = worldPxOf(canvasSize.height, vs.scale, effZ0);
  // НЕПРЕРЫВНЫЙ зум как на openstreetmap.org: тайлы берутся с целочисленного
  // уровня round(zoom), но рисуются в масштабе 2^(zoom-level) — плавное
  // масштабирование без «прыжков» между уровнями.
  const contZoom = clampZoom(zoomAtWorldPx(worldPx));


  const boundsRef = project.map?.bounds;

  // ─── DOM-слой подложки OSM («как на openstreetmap.org») ────────────────────
  // Подложка — настоящие <img>-тайлы внутри абсолютно спозиционированного div
  // ПОД canvas. Позиция слоя обновляется напрямую через transform в rAF
  // (без React-рендера и без перерисовки тысяч тайлов на канвасе). Объекты
  // (маршруты, зоны, маркеры) рисуются canvas-слоем поверх по ТОЙ ЖЕ формуле
  // привязки worldPx = offsetY + lngFrac·worldPx — поэтому они жёстко
  // «приклеены» к географическим координатам подложки.
  const positionTileLayer = useCallback(() => {
    const el = tileLayerRef.current;
    if (!el) return;
    const v = viewRef.current ?? NEUTRAL_VIEW;
    const cs = canvasSizeRef.current;
    // rAF/DOM-колбэк: читаем project безопасным читателем — сборка merged
    // агрегата шима здесь вызывала бы getSnapshot в фазе рендера (React #127).
    const st = readProjectView();
    const mapBounds = st.map?.bounds;
    const tilesOn = !!st.settings?.tilesEnabled && !!mapBounds;
    if (!tilesOn || !mapBounds || cs.height <= 0) { el.style.display = 'none'; return; }
    const wp = worldPxOf(cs.height, v.scale, v.z0 ?? ZOOM_REF);
    const zoom = clampZoom(zoomAtWorldPx(wp));
    const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[normalizeTileServer(st.openStreetMap?.tileServer)] ?? MAX_ZOOM);
    const level = Math.max(MIN_ZOOM, Math.min(nativeMax, Math.round(zoom)));
    const n = Math.pow(2, level);
    // ── СТРОГАЯ привязка DOM-слоя к инварианту вида ───────────────────────────
    // ИСПРАВЛЕНИЕ «карта грузится, но не видна»: раньше transform слоя был
    // translate(offsetX, offsetY)·scale(tileCss/256), т.е. тайл (0,0) всегда
    // попадал в точку offsets вида — а это world-пиксель нуля ТОГО зума, из
    // которого взяты offsets (стартовый z карты). После любого зума/панорамы
    // слой уезжал на десятки тысяч пикселей за экран (transform вида
    // translate(-1.57e7px, -1.24e7px)) — подложка формально «грузилась», но
    // была полностью невидима. Теперь позиция выводится из единой формулы
    // экрана: screen = rasterPx·sPerPx + offset (то же affine-преобразование,
    // что использует канвас для объектов; см. geoToRaster/toScreen ниже).
    const map = st.map!;
    const lngSpan = Math.abs(mapBounds.east - mapBounds.west);
    const mercSpanY = Math.max(1e-12, latToMerc(mapBounds.south) - latToMerc(mapBounds.north));
    // Экранных px на один пиксель растра карты (привязка строго через bounds):
    const sPerPxX = (wp * (lngSpan / 360)) / Math.max(1, map.width);
    const sPerPxY = (wp * mercSpanY) / Math.max(1, map.height);
    // CSS-размер одного тайла на экране (2^(zoom-level) — плавный непрерывный зум)
    const tileCss = wp / n;
    // Позиция тайла (0,0) = растровый пиксель (westFrac·map.width, northFrac·map.height),
    // где westFrac/northFrac — mercator-доля мира левого-верхнего угла bounds.
    const westFrac = (mapBounds.west + 180) / 360;
    const northFrac = latToMerc(mapBounds.north);
    const baseX = westFrac * map.width * sPerPxX + v.offsetX;
    const baseY = northFrac * map.height * sPerPxY + v.offsetY;
    el.style.display = '';
    el.style.width = `${cs.width}px`;
    el.style.height = `${cs.height}px`;
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${baseX}px, ${baseY}px) scale(${tileCss / 256})`;
  }, []);
  // Обновляем ссылку для rAF-подписчика на viewState (см. useEffect выше)
  useEffect(() => { tileLayerPositionRef.current = positionTileLayer; }, [positionTileLayer]);

  /** Синхронизация набора <img> в DOM-слое с видимой областью текущего вида.
   *  Загрузка — аккуратной очередью (дедупликация pending, лимит параллельных,
   *  приоритет тайлов от центра экрана, дебаунс во время жеста), как на osm.org. */
  const syncTileDom = useCallback(() => {
    const el = tileLayerRef.current;
    if (!el) return;
    // syncTileDom вызывается из rAF-колбэков — merged-агрегат шима здесь опасен.
    const proj = readProjectView();
    const mapBounds = proj.map?.bounds;
    const tilesOn = !!proj.settings?.tilesEnabled && !!mapBounds;
    if (!tilesOn || !mapBounds) {
      for (const img of tileElsRef.current.values()) img.remove();
      tileElsRef.current.clear();
      return;
    }
    const v = viewRef.current ?? NEUTRAL_VIEW;
    const cs = canvasSizeRef.current;
    if (!Number.isFinite(cs.width) || !Number.isFinite(cs.height) || cs.width <= 0 || cs.height <= 0) return;
    const wp = worldPxOf(cs.height, v.scale, v.z0 ?? ZOOM_REF);
    const zoom = clampZoom(zoomAtWorldPx(wp));
    // Рабочий провайдер из стора (Esri по умолчанию; legacy 'osm'/'carto' нормализуются)
    const server: TileServerId = normalizeTileServer(proj.openStreetMap?.tileServer);
    const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[server] ?? MAX_ZOOM);
    const level = Math.max(MIN_ZOOM, Math.min(nativeMax, Math.round(zoom)));
    const n = Math.pow(2, level);
    // World-пиксели ВЫБРАННОГО уровня: та же формула привязки, что у объектов
    const wpz = cs.height * Math.pow(2, level);
    const fx0 = (0 - v.offsetX) / wpz, fx1 = (cs.width - v.offsetX) / wpz;
    const fy0 = (0 - v.offsetY) / wpz, fy1 = (cs.height - v.offsetY) / wpz;
    const txMin = Math.floor(fx0), txMax = Math.floor(fx1);
    const tyMin = Math.floor(Math.max(0, fy0)), tyMax = Math.floor(Math.min(n - 1, fy1));
    const keep = new Set<string>();
    const urls: string[] = [];
    let budget = 900; // защита от аномальных видов
    for (let tx = txMin; tx <= txMax && budget > 0; tx++) {
      for (let ty = tyMin; ty <= tyMax && budget > 0; ty++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        budget--;
        const url = getOSMTileUrl(level, tx, ty, server, 'scheme');
        keep.add(url);
        if (tileElsRef.current.has(url)) continue;
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        img.style.position = 'absolute';
        // Слой масштабируется scale(tileCss/256), поэтому дети позиционируются в
        // координатах «мировых пикселей уровня»: x = tx·256, y = ty·256.
        img.style.left = `${tx * 256}px`;
        img.style.top = `${ty * 256}px`;
        img.style.width = '256px';
        img.style.height = '256px';
        // Позиция известна сразу — запоминаем её на элементе для очереди загрузки
        (img as any).__tilePos = true;
        el.appendChild(img);
        tileElsRef.current.set(url, img);
        if (!tilePending.current.has(url) && !tileCache.current.has(url)) urls.push(url);
      }
    }
    // Удаляем тайлы вне видимой области (экономим DOM и память)
    for (const [url, img] of tileElsRef.current) {
      if (!keep.has(url)) { img.remove(); tileElsRef.current.delete(url); }
    }
    positionTileLayer();

    // ── Очередь загрузки недостающих <img> ──
    if (urls.length > 0) {
      // Приоритет ближних к центру экрана — карта «проявляется» из центра, как на osm.org
      const cxw = (cs.width / 2 - v.offsetX) / wpz, cyw = (cs.height / 2 - v.offsetY) / wpz;
      const distOf = (u: string): number => {
        const img = tileElsRef.current.get(u);
        if (!img) return 0;
        const x = parseFloat(img.style.left) / 256, y = parseFloat(img.style.top) / 256;
        return (x - cxw) ** 2 + (y - cyw) ** 2;
      };
      urls.sort((a, b) => distOf(a) - distOf(b));
      for (const u of urls) tileQueueRef.current.push(u);
      const pump = (): void => {
        while (activeTilesRef.current < MAX_PARALLEL && tileQueueRef.current.length > 0) {
          const u = tileQueueRef.current.shift()!;
          const imgEl = tileElsRef.current.get(u);
          // Тайл больше не виден (ушёл с экрана) или уже загружен — пропускаем без запроса
          if (!imgEl || tilePending.current.has(u) || tileCache.current.has(u)) continue;
          activeTilesRef.current++;
          // P0-фикс «зависание/утечка при загрузке карт»: загрузка регистрируется
          // в реестре in-flight (tileLoadHandlesRef) и ПРИНУДИТЕЛЬНО отменяется
          // через handle.cancel() при unmount / смене подложки. Раньше промис
          // доживал до внутреннего 10-секундного таймаута, держал DOM-элементы
          // размонтированного слоя и резолвился setState на unmounted-компоненте.
          // Зеркала Esri + учёт ошибок (аналог tileerror из аудита) — внутри
          // loadTileImage/startTileLoad (noteTileError/noteTileSuccess).
          const handle: TileLoadHandle = startTileLoad(u, 10000); // таймаут: зависший тайл не блокирует очередь
          tileLoadHandlesRef.current.add(handle);
          const p = handle.done
            .then((loaded0) => loaded0 ? loaded0 : loadEsriMirrorByHandle(u))
            .then((loaded) => {
              if (!mountedRef.current) return; // unmount — результат не нужен (см. cleanup)
              if (loaded) {
                tileCache.current.set(u, loaded);
                if (tileCache.current.size > TILE_CACHE_MAX) {
                  const firstKey = tileCache.current.keys().next().value as string | undefined;
                  if (firstKey !== undefined) tileCache.current.delete(firstKey);
                }
                if (tileElsRef.current.get(u) === imgEl) imgEl.src = u;
              } else {
                // ИСПРАВЛЕНИЕ «краш/зависание при загрузке карт»: раньше в кэш
                // писался undefined-запись, и DOM <img> получал src на тайл,
                // который НЕ загрузился (битый CDN/429). Браузер оставлял
                // незавершённую загрузку на элементе подложки — слой гасил
                // canvas-оверлей и страница «висела». Теперь неудачные тайлы
                // в кэш НЕ попадают: при следующем проходе синхронизации они
                // будут перезапрошены (с дебаунсом), а на экране останется
                // пустой slot без битого запроса.
                tileCache.current.delete(u);
                if (tileElsRef.current.get(u) === imgEl) {
                  abortTileImage(imgEl);
                  tileElsRef.current.delete(u);
                  imgEl.remove();
                }
              }
            })
            .finally(() => {
              tileLoadHandlesRef.current.delete(handle);
              if (!mountedRef.current) return; // cleanup уже сбросил очередь/pending
              tilePending.current.delete(u);
              activeTilesRef.current--;
              // Индикатор слоя (пункт C): «загружается», пока очередь не пуста;
              // «ошибка» имеет приоритет; иначе — «загружен».
              const stillBusy = activeTilesRef.current > 0 || tileQueueRef.current.length > 0 || tilePending.current.size > 0;
              const next: LayerLoadState = tileWarnedRef.current ? 'err' : stillBusy ? 'loading' : 'ok';
              if (layerLoadStateRef.current !== next) {
                layerLoadStateRef.current = next;
                setLayerLoadState(next);
              }
              setTilesVersion((t2) => t2 + 1);
              pump();
            });
          tilePending.current.set(u, p);
        }
      };
      if (tileDebounceRef.current) clearTimeout(tileDebounceRef.current);
      // Первая загрузка (покой) — старт немедленно; во время жеста — дебаунс,
      // чтобы быстро сменяемый вид не плодил лишних запросов к серверу.
      const idle = activeTilesRef.current === 0 && tilePending.current.size === 0;
      tileDebounceRef.current = setOwnedTimeout(pump, idle ? 0 : TILE_DEBOUNCE_MS);
    } else if (tilePending.current.size === 0 && activeTilesRef.current === 0) {
      // Нечего докачивать и nothing in-flight — подложка синхронна: «зависшая
      // загрузка» сброшена (идемпотентно для React: false → false не ре-рендерит).
      setTileLoadStalled(false);
    }
  }, [positionTileLayer]);

  // CIRCUIT BREAKER «вечного спиннера»: если есть незавершённые загрузки тайлов
  // дольше 5 секунд — это зависание CDN/очереди, а не нормальная работа. Лоадер
  // принудительно снимается, показывается ошибка с кнопкой повтора (шаг П3 ТЗ).
  useEffect(() => {
    if (!tilesEnabled) return;
    if (tilePending.current.size === 0 && activeTilesRef.current === 0) return;
    const t = window.setTimeout(() => setTileLoadStalled(true), 5000);
    return () => window.clearTimeout(t);
  }, [tilesEnabled, tilesVersion, tileRetryNonce, canvasSize.width, canvasSize.height]);

  // Принудительная перезагрузка подложки после circuit breaker («Попробовать
  // снова»): сбрасываем залипшие pending-промисы и планируем новый pump().
  useEffect(() => {
    if (tileRetryNonce === 0) return;
    tilePending.current.clear();
    syncTileDom();
  }, [tileRetryNonce, syncTileDom]);

  // Пересинхронизация DOM-слоя при смене вида (rAF-троттлинг), карты и настроек
  useEffect(() => {
    syncTileDom();
  }, [renderTick, tilesEnabled, tileServer, project.map?.bounds, canvasSize, syncTileDom]);

  // Геолокация пользователя (по требованию — кнопка 📍).
  // По аудиту GitHub Pages (audit/index.fixed.html, пункты F/G):
  // - проверяется наличие API и защищённый контекст (Pages отдаёт HTTPS, но на
  //   file:// или http-зеркалах geolocation недоступен);
  // - коды ошибок 1/2/3 переводятся в понятные сообщения;
  // - никаких alert(): статус идёт в текстовый индикатор подложки (tileStatusMsg),
  //   отказ в доступе не блокирует UI.
  const locateUser = useCallback(() => {
    const showStatus = (msg: string) => setTileStatusMsg(msg);
    if (!('geolocation' in navigator)) { showStatus('⚠ Браузер не поддерживает геолокацию'); return; }
    if (!window.isSecureContext) { showStatus('⚠ Геолокация доступна только по HTTPS (или localhost)'); return; }
    showStatus('Определение местоположения…');
    let settled = false;
    // Страховочный дубль-таймер: getCurrentPosition иногда «вешает» callback в
    // WebView/блокировщиках — через 12 с показываем статус и разблокируем кнопку.
    const guard = setTimeout(() => {
      if (!settled) showStatus('⚠ Не удалось получить позицию (время вышло)');
    }, 12000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        settled = true; clearTimeout(guard);
        setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
        showStatus(`✓ Позиция определена (±${Math.round(pos.coords.accuracy)} м)`);
      },
      (err) => {
        settled = true; clearTimeout(guard);
        const msg = err.code === err.PERMISSION_DENIED ? 'Доступ к геолокации запрещён — разрешите его в настройках браузера.'
          : err.code === err.POSITION_UNAVAILABLE ? 'Позиция недоступна (нет GPS-сигнала / сети).'
          : err.code === err.TIMEOUT ? 'Превышено время ожидания геолокации.'
          : 'Не удалось определить местоположение.';
        showStatus('⚠ ' + msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, [setTileStatusMsg]);

  // ─── ЕДИНСТВЕННЫЙ режим карты: три окна СТАРТ / МАРШРУТ / ЦЕЛЬ ──────────────
  // Приложение всегда работает в режиме трёх окон: МАРШРУТ занимает место
  // большой карты (верх), СТАРТ и ЦЕЛЬ — внизу. Каждое окно — автономная карта
  // со строгой Mercator-привязкой, полным зумом/панорамой, редактированием
  // (точки старта/цели, маршрут, зоны ограничений) и удалением объектов кликом.
  // Все функции доступны ВО ВСЕХ ТРЁХ ОКНАХ. После ЗАПУСКА миссия передаётся
  // в дроны, и кнопка «🆕 Новая миссия» очищает данные для следующего полёта.
  // Рой дронов: у всех дронов один старт; общая цель ИЛИ индивидуальные цели.
  // P0-фикс «зависание при загрузке карт»: в режиме МАСТЕРА миссий трёхоконный
  // legacy-оверлей (три MiniMapPanel поверх основной карты) скрывается. Каждый
  // MiniMapPanel независимо качает до 24 тайла через loadTileWithMirrors — это
  // ~72 параллельных загрузки на экран, которые дублируют работу основной
  // подложки MapCanvas. В Мастере они не нужны (там своя панель WizardMapPanel),
  // а их фоновые загрузки вызывали краш/зависание при переключении шагов.
  // Единственный источник истины о режиме UI — localStorage-ключ 'tq-ui-mode'
  // (пишет App.tsx при переключении «Мастер миссий / Редактор»). Значение по
  // умолчанию — мастер (всё, кроме явного 'legacy').
  // ФИКС: слушаем смену ключа ('storage' — другие вкладки; own-событие от
  // App.tsx — то же окно). Раньше значение читалось ОДИН раз при монтировании
  // useState-инициализатором: MapCanvas не remount'ится при переключении
  // «Мастер ↔ Редактор» (App рендерит его условно, но хук жил бы stale при
  // любом другом пути), из-за чего legacy-оверлей трёх окон мог не появляться/
  // не скрываться, а стартовый fit основной карты работал на неверном layout.
  const [wizardActive, setWizardActive] = useState<boolean>(
    () => { try { return localStorage.getItem('tq-ui-mode') !== 'legacy'; } catch { return true; } },
  );
  useEffect(() => {
    const sync = () => {
      try { setWizardActive(localStorage.getItem('tq-ui-mode') !== 'legacy'); } catch { /* ignore */ }
    };
    window.addEventListener('storage', sync);
    window.addEventListener('tq-ui-mode-changed', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('tq-ui-mode-changed', sync);
    };
  }, []);
  const tripleMode = !wizardActive;
  // ─── Режимы работы с окнами (отдельные пункты меню):
  //  'restrictions' — Установка ограничений (клик по ЛЮБОЙ карте ставит зону);
  //  'route'        — Редактирование маршрута (добавление/перенос/удаление точек).
  type TripleMode = 'restrictions' | 'route';
  const [tripleWorkMode, setTripleWorkMode] = useState<TripleMode>('route');
  const workModeRef = useRef(tripleWorkMode);
  useEffect(() => { workModeRef.current = tripleWorkMode; }, [tripleWorkMode]);
  const [droneCount, setDroneCount] = useState(4);
  const [sharedGoal, setSharedGoal] = useState(true);
  // Общий старт для всего роя (по умолчанию) — либо индивидуальные старты дронов
  const [sharedStart, setSharedStart] = useState(true);
  const [activeUav, setActiveUav] = useState(0);
  const [startGeo, setStartGeo] = useState<{ lat: number; lng: number } | null>(null);
  // ── Персистентные точки старта/цели (store-first) ──────────────────────────
  // Единый источник истины для общих точек: useMissionStore.importLists.
  // Локальные startGeo/goalGeo остаются быстрым UI-зеркалом, но ИНИЦИАЛИЗИРУЮТСЯ
  // из стора и ПИШУТСЯ в стор — после unmount/remount MapCanvas (смена карты,
  // переключение панели) точки больше не «исчезают».
  const sharedStartId = useMissionStore((s) => s.sharedStartId);
  const sharedGoalId = useMissionStore((s) => s.sharedGoalId);
  const importStarts = useMissionStore((s) => s.importLists?.starts);
  const importGoals = useMissionStore((s) => s.importLists?.goals);
  const droneStartsPersisted = useFleetStore((s) => s.droneStarts);
  const droneGoalsPersisted = useFleetStore((s) => s.droneGoals);
  const setSharedStartPoint = useMissionStore((s) => s.setSharedStartPoint);
  const setSharedGoalPoint = useMissionStore((s) => s.setSharedGoalPoint);
  const setDroneStartAt = useFleetStore((s) => s.setDroneStartAt);
  const setDroneGoalAt = useFleetStore((s) => s.setDroneGoalAt);
  const [goalGeo, setGoalGeo] = useState<{ lat: number; lng: number } | null>(null);
  // Индивидуальные старты дронов (при выключенном «общем старте»): индекс → гео.
  // Маршрут i-го дрона начинается в startForUav(i) — так же, как цель берётся
  // из последней точки его маршрута (goalForUav).
  const [droneStarts, setDroneStarts] = useState<( { lat: number; lng: number } | null )[]>([]);
  // Индивидуальная цель текущего дрона при «индивидуальных целях»: клик по
  // окну «Цель» задаёт её; переносится на последнюю точку маршрута этого дрона.
  const [droneGoals, setDroneGoals] = useState<( { lat: number; lng: number } | null )[]>([]);

  // ── Гидрация store-first точек (исправление бага «точки исчезают») ─────────
  // При монтировании MapCanvas (смена карты/панели/unmount→remount) восстанавливаем
  // UI-зеркала из сторов: общая точка старта/цели — из importLists по shared*Id,
  // индивидуальные старты/цели дронов — из useFleetStore.droneStarts/droneGoals.
  useEffect(() => {
    if (sharedStartId && importStarts) {
      const p = importStarts.find((x) => x.id === sharedStartId);
      if (p) setStartGeo({ lat: p.lat, lng: p.lng });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- гидрация только при смене id/списка
  }, [sharedStartId, importStarts]);
  useEffect(() => {
    if (sharedGoalId && importGoals) {
      const p = importGoals.find((x) => x.id === sharedGoalId);
      if (p) setGoalGeo({ lat: p.lat, lng: p.lng });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- гидрация только при смене id/списка
  }, [sharedGoalId, importGoals]);
  useEffect(() => {
    if (droneStartsPersisted.length > 0) setDroneStarts([...droneStartsPersisted]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- зеркало при изменении persisted-массива
  }, [droneStartsPersisted]);
  useEffect(() => {
    if (droneGoalsPersisted.length > 0) setDroneGoals([...droneGoalsPersisted]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- зеркало при изменении persisted-массива
  }, [droneGoalsPersisted]);
  // ── Множественные точки старта/цели (store-first) + тип ВС (ТЗ: шаг 0 — выбор типа) ──
  const craftType = useMissionStore((s) => s.craftType);
  const setCraftType = useMissionStore((s) => s.setCraftType);
  const startPointIds = useMissionStore((s) => s.startPointIds);
  const goalPointIds = useMissionStore((s) => s.goalPointIds);
  const addStartPointAt = useMissionStore((s) => s.addStartPointAt);
  const addGoalPointAt = useMissionStore((s) => s.addGoalPointAt);
  const removeStartPoint = useMissionStore((s) => s.removeStartPoint);
  const removeGoalPoint = useMissionStore((s) => s.removeGoalPoint);
  /** UI-зеркала множественных точек (id → гео), гидрируются из importLists стора. */
  const [multiStarts, setMultiStarts] = useState<{ id: string; lat: number; lng: number }[]>([]);
  const [multiGoals, setMultiGoals] = useState<{ id: string; lat: number; lng: number }[]>([]);
  useEffect(() => {
    const list = (ids: string[], src: { id: string; lat: number; lng: number }[] | undefined) =>
      ids.map((id) => src?.find((p) => p.id === id)).filter((p): p is { id: string; lat: number; lng: number } => !!p);
    setMultiStarts(list(startPointIds, importStarts));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- зеркало при изменении набора id
  }, [startPointIds, importStarts]);
  useEffect(() => {
    const list = (ids: string[], src: { id: string; lat: number; lng: number }[] | undefined) =>
      ids.map((id) => src?.find((p) => p.id === id)).filter((p): p is { id: string; lat: number; lng: number } => !!p);
    setMultiGoals(list(goalPointIds, importGoals));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- зеркало при изменении набора id
  }, [goalPointIds, importGoals]);

  const [pickWhat, setPickWhat] = useState<'none' | 'start' | 'goal'>('none');
  const pickWhatRef = useRef(pickWhat);
  useEffect(() => { pickWhatRef.current = pickWhat; }, [pickWhat]);
  // Автозапуск мастера: как только данные этапа заданы — этап утверждается сам,
  // фокус автоматически переходит к следующему окну (редактирование доступно и
  // вручную через кнопки этапов / перенос окна наверх).
  const autoApproveTimerRef = useRef<number | null>(null);

  const uavColors = ['#22d3ee', '#a78bfa', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#38bdf8', '#e879f9'];
  // Гео-данные проекта (из пикселей текущего виртуального растра) — источник
  // точек для панелей «весь маршрут» и целей дронов
  const tripleRoutes = React.useMemo(() => {
    if (!tripleMode) return [] as { id: string; name: string; color: string; geo: { lat: number; lng: number }[] }[];
    const map = project.map;
    if (!map?.bounds || map.width <= 0 || map.height <= 0) return [];
    return (project.routes || [])
      .filter((r) => r.visible !== false && r.points.length >= 2)
      .map((r) => ({
        id: r.id, name: r.name, color: r.color || '#22d3ee',
        geo: r.points.map((p) => pixelToGeoExact({ x: p.x, y: p.y }, map.bounds!, map.width, map.height)),
      }));
  }, [tripleMode, project.routes, project.map]);

  // Все гео-точки миссии (маршруты проекта + старт + цель) — для PNG-экспорта
  const tripleAllGeoPts = React.useMemo(() => {
    const out: { lat: number; lng: number }[] = [];
    for (const r of tripleRoutes) out.push(...r.geo);
    if (startGeo) out.push(startGeo);
    if (goalGeo) out.push(goalGeo);
    return out;
  }, [tripleRoutes, startGeo, goalGeo]);

  // ─── Пошаговый мастер: старт → маршрут → цель → ЗАПУСК ──────────────────────
  // step: 0 = выбор старта (панель СТАРТ сфокусирована), 1 = редактирование
  // маршрута (панель ВЕСЬ МАРШРУТ), 2 = выбор цели (панель ЦЕЛЬ),
  // 3 = всё утверждено — активна кнопка «🚀 ЗАПУСК».
  type TripleStep = 0 | 1 | 2 | 3;
  const [tripleStep, setTripleStep] = useState<TripleStep>(0);
  const [approvedSteps, setApprovedSteps] = useState<boolean[]>([false, false, false]);
  const [launchState, setLaunchState] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [draftRoutePts, setDraftRoutePts] = useState<{ lat: number; lng: number }[] | null>(null);
  const [routeShape, setRouteShape] = useState<'straight' | 'curve'>('straight');
  const routeShapeRef = useRef(routeShape);
  useEffect(() => { routeShapeRef.current = routeShape; }, [routeShape]);
  // Зоны-кандидаты (ставятся на ЛЮБОЙ из трёх карт; uid — для удаления кликом)
  // Кандидаты зон ограничения — ПОЛИГОНЫ по точкам (ТЗ: ставятся точками,
  // беспилотная зона внутри замкнутой границы). Клики в режиме «Установка
  // ограничений» добавляют вершину текущего полигона; двойной клик замыкает
  // зону и создаёт новый candidate.
  const [pendingZones, setPendingZones] = useState<{ uid: number; pts: { lat: number; lng: number }[] }[]>([]);
  const pendingZoneUidRef = useRef(1);

  // «Кривая» маршрут: сглаживание ломаной (Catmull-Rom): ключевые точки остаются
  // на месте, между ними добавляются промежуточные — линия выглядит как кривая.
  const curveGeo = (pts: { lat: number; lng: number }[]) => {
    if (routeShape !== 'curve' || pts.length < 3) return pts;
    const sm = smoothPolyline(pts.map((g) => ({ x: g.lat, y: g.lng })), 8);
    return sm.map((q) => ({ lat: q.x, lng: q.y }));
  };
  const addRoute = useStore((s) => s.addRoute);
  const mapBounds = project.map?.bounds;

  // Черновик маршрута из реальных маршрутов проекта при входе в шаг 1
  useEffect(() => {
    if (tripleStep === 1 && draftRoutePts === null) {
      const r = tripleRoutes[Math.min(activeUav, Math.max(0, tripleRoutes.length - 1))];
      setDraftRoutePts(r ? r.geo : (startGeo && goalGeo ? [startGeo, goalGeo] : []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripleStep, approvedSteps]);

  const focusPanelIdx = tripleStep === 3 ? -1 : tripleStep;
  // Зоны ограничения, поставленные на ЛЮБОЙ из трёх карт (в т.ч. неактивной),
  // ждут утверждения — рисуем кандидатов-полигоны во всех окнах с id для удаления.
  const pendingZoneMini = pendingZones.map((pz) => ({
    id: `pendingZone:${pz.uid}`, pts: pz.pts, color: '#fb923c',
  }));
  const canApproveStep = (st: TripleStep): boolean => {
    if (st === 0) return sharedStart ? !!startGeo : droneStarts.some((s) => !!s) || !!startGeo;
    if (st === 1) return (draftRoutePts?.length ?? 0) >= 2 || tripleRoutes.length > 0;
    if (st === 2) return !!goalGeo || !sharedGoal; // зоны-кандидаты утверждаются автоматически при переходе к следующему этапу
    return false;
  };

  // Утвердить все ожидающие зоны как ограничения проекта (зоны можно ставить
  // на любой карте и утверждать на любом этапе). Кандидат — полигон по гео-
  // точкам; пиксели вычисляются через точную гео-привязку текущего растра.
  const commitPendingZones = useCallback((zones: { pts: { lat: number; lng: number }[] }[]): boolean => {
    if (zones.length === 0) return false;
    const map = project.map;
    if (!map?.bounds || map.width <= 0 || map.height <= 0) return false;
    for (const pz of zones) {
      if (pz.pts.length < 3) continue; // полигон без замкнутой границы не создаём
      const pxPts = pz.pts.map((g) => geoToPixelExact(g.lat, g.lng, map.bounds!, map.width, map.height));
      useStore.getState().addRestriction({
        type: 'polygon', points: pxPts,
        color: '#ff000080', active: true,
      });
    }
    // немедленная перестройка маршрутов вокруг новых зон (без троттлинга)
    useStore.getState().flushReroute();
    return true;
  }, [project.map]);

  const approveTripleStep = useCallback(() => {
    if (tripleStep === 1 && draftRoutePts && draftRoutePts.length >= 2 && mapBounds && project.map) {
      // зафиксировать отредактированный маршрут в проект (пиксели — из точной гео-привязки).
      // ВАЖНО: черновик НЕ сбрасываем сразу — он участвует в fitPoints окна МАРШРУТ;
      // после записи маршрута в проект тройные данные обновятся атомарно, и окно
      // не «прыгнет» на СПб. Сброс — только при смене активного этапа.
      let keyGeo = curveGeo(draftRoutePts);
      // Индивидуальный старт дрона: первый ключевой узел маршрута привязываем
      // к старту этого дрона (при индивидуальных стартах роя).
      const myStart = sharedStart ? startGeo : (droneStarts[activeUav] ?? startGeo);
      if (myStart) keyGeo = [{ lat: myStart.lat, lng: myStart.lng }, ...keyGeo.filter((g) => Math.hypot(g.lat - myStart.lat, g.lng - myStart.lng) > 1e-7)];
      const pts: RoutePoint[] = keyGeo.map((g) => ({ ...geoToPixelExact(g.lat, g.lng, mapBounds, project.map!.width, project.map!.height), lat: g.lat, lng: g.lng }));
      const existing = tripleRoutes[Math.min(activeUav, tripleRoutes.length - 1)];
      if (existing) {
        useStore.setState((cur) => ({
          project: {
            ...cur.project,
            routes: (cur.project.routes || []).map((r) => (r.id === existing.id ? { ...r, points: pts } : r)),
            updatedAt: new Date().toISOString(),
          },
        }));
        // обход ограничений + высоты для этого маршрута (async)
        void useStore.getState().updateRouteAltitudes(existing.id);
      } else {
        addRoute(pts, `Маршрут дрона ${activeUav + 1}`, uavColors[activeUav % uavColors.length]);
      }
    }
    // Ограничения утверждаются на ЛЮБОМ этапе (зоны ставятся на любой карте).
    commitPendingZones(pendingZones);
    setPendingZones([]);
    setApprovedSteps((a) => { const n = [...a]; n[tripleStep] = true; return n; });
    if (tripleStep < 2) setTripleStep((tripleStep + 1) as TripleStep);
    else setTripleStep(3);
  }, [tripleStep, draftRoutePts, mapBounds, project.map, tripleRoutes, activeUav, addRoute, pendingZones, commitPendingZones, sharedStart, startGeo, droneStarts]);

  // Безопасный сброс черновика маршрута: если маршрут уже записан в проект
  // (третий источник данных — tripleRoutes), черновик убираем только когда
  // его точки совпадают с данными проекта — иначе fit-вид окна не изменится.
  useEffect(() => {
    if (tripleStep !== 1 && draftRoutePts !== null) {
      setDraftRoutePts(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripleStep]);

  // ─── Авто-утверждение этапов: данные заданы → этап утверждается сам, фокус
  // переходит к следующему окну. При этом любое окно остаётся редактируемым:
  // клик по окну / кнопка этапа возвращает фокус и снимает утверждение шага.
  useEffect(() => {
    if (launchState !== 'idle') return;
    if (tripleStep > 2 || approvedSteps[tripleStep]) return;
    if (!canApproveStep(tripleStep as 0 | 1 | 2)) return;
    if (autoApproveTimerRef.current) window.clearTimeout(autoApproveTimerRef.current);
    autoApproveTimerRef.current = window.setTimeout(() => approveTripleStep(), 700);
    return () => { if (autoApproveTimerRef.current) window.clearTimeout(autoApproveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripleStep, approvedSteps, startGeo, goalGeo, draftRoutePts, tripleRoutes.length, launchState]);

  // Снятие утверждения при возврате к этапу (перенос окна наверх в режиме правки)
  const reopenStepForEdit = useCallback((idx: number) => {
    setTripleStep((cur) => {
      if (cur === 3 && idx <= 2) setApprovedSteps((a) => [a[0], a[1], idx > 2 ? a[2] : false]);
      else if (idx < cur) setApprovedSteps((a) => { const n = [...a]; for (let i = idx; i < 3; i++) n[i] = false; return n; });
      return idx as TripleStep;
    });
  }, []);

  const backTripleStep = useCallback(() => {
    setDraftRoutePts(null); setPendingZones([]);
    if (tripleStep === 3) { setTripleStep(2); setApprovedSteps((a) => [a[0], a[1], false]); }
    else if (tripleStep > 0) {
      setTripleStep((tripleStep - 1) as TripleStep);
      setApprovedSteps((a) => { const n = [...a]; n[tripleStep - 1] = false; n[tripleStep] = false; return n; });
    }
  }, [tripleStep]);

  // Клик по карте ПАНЕЛИ: все функции доступны во всех трёх окнах одновременно —
  // любое окно ставит/переносит старт, цель и путевые точки маршрута; зоны
  // ограничения ставятся на ЛЮБОЙ карте без переноса окон и без сбивания фокуса.
  const handlePanelMapClick = useCallback((geo: { lat: number; lng: number; panelIdx?: number }) => {
    if (launchStateRef.current !== 'idle') return;
    const panelIdx = geo.panelIdx ?? tripleStepRef.current;
    // Режим «Установка ограничений»: клик по ЛЮБОЙ из трёх карт добавляет
    // ВЕРШИНУ полигона NFZ (ТЗ: зона ставится точками, внутри замкнутой
    // границы). Двойной клик по карте замыкает текущий полигон (≥3 вершин).
    if (workModeRef.current === 'restrictions') {
      setPendingZones((prev) => {
        const n = [...prev];
        const last = n[n.length - 1];
        if (last && last.pts.length > 0) {
          // не дублируем практически совпадающие вершины
          const lp = last.pts[last.pts.length - 1];
          if (Math.hypot(lp.lat - geo.lat, lp.lng - geo.lng) < 1e-9) return prev;
          n[n.length - 1] = { ...last, pts: [...last.pts, { lat: geo.lat, lng: geo.lng }] };
        } else {
          n.push({ uid: pendingZoneUidRef.current++, pts: [{ lat: geo.lat, lng: geo.lng }] });
        }
        return n;
      });
      return;
    }
    // Режим «Редактирование маршрута»: точки старта/цели/маршрута — во всех окнах.
    if (panelIdx === 0) {
      const g = { lat: geo.lat, lng: geo.lng };
      if (!sharedStart) {
        // Индивидуальные старты: клик по окну «Старт» задаёт старт ВЫБРАННОГО дрона
        setDroneStarts((prev) => { const n = [...prev]; n[activeUavRef.current] = g; return n; });
        setDroneStartAt(activeUavRef.current, g); // store-first: переживает unmount
      } else {
        setStartGeo(g);
        setSharedStartPoint(g); // upsert 'СТАРТ' в importLists + sharedStartId
        // Множественные старты (ТЗ): каждая новая точка — отдельный старт роя;
        // автопрокладка маршрутов старт→цель выполняется в addStartPointAt.
        if (!startPointIds.some((id) => { const p = importStarts?.find((x) => x.id === id); return !!p && Math.hypot(p.lat - g.lat, p.lng - g.lng) < 1e-7; })) {
          addStartPointAt(g);
        }
      }
      reopenStepForEdit(0);
    } else if (panelIdx === 1) {
      setDraftRoutePts((prev) => [...(prev || []), { lat: geo.lat, lng: geo.lng }]);
      reopenStepForEdit(1);
    } else {
      // Индивидуальная цель: клик по окну «Цель» переносит цель текущего дрона —
      // смещаем последний узел его маршрута (маршрут = старт→…→цель).
      if (!sharedGoal) {
        const g = { lat: geo.lat, lng: geo.lng };
        setDroneGoals((prev) => { const n = [...prev]; n[activeUavRef.current] = g; return n; });
        setDroneGoalAt(activeUavRef.current, g); // store-first
        const st = readProjectViewWithActions();
        const map = st.map;
        const r = (st.routes || [])[activeUavRef.current];
        if (r && map?.bounds && r.points.length >= 2) {
          // пиксели — из точной гео-привязки текущего растра
          const px = geoToPixelExact(g.lat, g.lng, map.bounds, map.width, map.height);
          st.moveRoutePoint(r.id, r.points.length - 1, { x: px.x, y: px.y });
        } else {
          setGoalGeo(g);
        }
      } else {
        const g = { lat: geo.lat, lng: geo.lng };
        setGoalGeo(g);
        setSharedGoalPoint(g); // upsert 'ЦЕЛЬ' в importLists + sharedGoalId
        // Множественные цели (ТЗ): каждая новая точка — отдельная цель;
        // при наличии свободных стартов addGoalPointAt прокладывает новый маршрут.
        if (!goalPointIds.some((id) => { const p = importGoals?.find((x) => x.id === id); return !!p && Math.hypot(p.lat - g.lat, p.lng - g.lng) < 1e-7; })) {
          addGoalPointAt(g);
        }
      }
      reopenStepForEdit(2);
    }
  }, [reopenStepForEdit, sharedStart, sharedGoal, setSharedStartPoint, setSharedGoalPoint, setDroneStartAt, setDroneGoalAt, startPointIds, goalPointIds, importStarts, importGoals, addStartPointAt, addGoalPointAt]);

  const tripleStepRef = useRef(tripleStep);
  useEffect(() => { tripleStepRef.current = tripleStep; }, [tripleStep]);
  const launchStateRef = useRef(launchState);
  useEffect(() => { launchStateRef.current = launchState; }, [launchState]);
  // Индекс активного дрона для стабильных колбэков панелей (клик/drag)
  const activeUavRef = useRef(activeUav);
  useEffect(() => { activeUavRef.current = activeUav; }, [activeUav]);

  // Смена вкладок из бокового меню: активная карта ВСЕГДА сверху (на месте
  // большой карты). Кнопки этапов работают как вкладки: клик по окну или по
  // кнопке этапа переносит это окно наверх, его предыдущее место занимает то,
  // что было сверху (циклическая ротация стека [верх, низ-лево, низ-право]).
  const [panelStack, setPanelStack] = useState<number[]>([1, 0, 2]);
  const panelStackRef = useRef(panelStack);
  useEffect(() => { panelStackRef.current = panelStack; }, [panelStack]);
  const topPanelIdx = panelStack[0];
  const bottomPanels = panelStack.slice(1);
  const focusAndRaisePanel = useCallback((idx: number) => {
    if (launchStateRef.current !== 'idle') return;
    reopenStepForEdit(idx);
    setPanelStack((s) => (s[0] === idx ? s : [idx, s[1], s[2]]));
  }, [reopenStepForEdit]);

  // ─── Удаление введённых точек/объектов кликом по ✛ на активной карте ───────
  // id форматы: 'triple:start' | 'triple:goal' | 'draft:N' | 'zone:<restrictionId>' |
  //             'pendingZone:<uid>' | 'drone-goal:<routeId>' | 'multiStart:<id>' | 'multiGoal:<id>'
  const handlePanelPointDelete = useCallback((id: string) => {
    if (id === 'triple:start') { setStartGeo(null); setSharedStartPoint(null); return; }
    if (id === 'triple:goal') { setGoalGeo(null); setSharedGoalPoint(null); return; }
    if (id.startsWith('multiStart:')) { removeStartPoint(id.slice('multiStart:'.length)); return; }
    if (id.startsWith('multiGoal:')) { removeGoalPoint(id.slice('multiGoal:'.length)); return; }
    if (id.startsWith('pendingZone:')) {
      const uid = Number(id.slice('pendingZone:'.length));
      setPendingZones((prev) => prev.filter((pz) => pz.uid !== uid));
      return;
    }
    if (id.startsWith('draft:')) {
      const i = Number(id.slice(6));
      setDraftRoutePts((prev) => (prev ? prev.filter((_, j) => j !== i) : prev));
      return;
    }
    if (id.startsWith('zone:')) {
      useStore.getState().deleteRestriction(id.slice(5));
      useStore.getState().flushReroute();
      return;
    }
    if (id.startsWith('drone-goal:')) {
      // удаление цели дрона = удаление последней путевой точки его маршрута
      const rid = id.slice('drone-goal:'.length);
      const st = readProjectViewWithActions();
      const r = (st.routes || []).find((rr) => rr.id === rid);
      if (r && r.points.length > 0) st.removeRoutePoint(rid, r.points.length - 1);
    }
  }, [setSharedStartPoint, setSharedGoalPoint]);
  const handlePanelZoneDelete = useCallback((id: string) => {
    if (id.startsWith('pendingZone:')) {
      const uid = Number(id.slice('pendingZone:'.length));
      setPendingZones((prev) => prev.filter((pz) => pz.uid !== uid));
      return;
    }
    useStore.getState().deleteRestriction(id);
    useStore.getState().flushReroute();
  }, []);

  // «ЗАПУСК»: загрузка данных миссии в дроны (имитация телеметрической загрузки).
  // На время async-операции выставляем isProcessing в mission-сторе — mutate-экшены
  // (addRoute/deleteRoute/commitRouteDraft/…) блокируются гардом шима, UI-кнопки —
  // через disabled по этому же флагу (защита от гонок состояний).
  const launchMission = useCallback(async () => {
    if (launchState !== 'idle') return;
    setLaunchState('uploading');
    useMissionStore.getState().beginProcessing();
    const st = readProjectViewWithActions();
    const mission = {
      start: startGeo, goal: goalGeo, sharedGoal, droneCount,
      routes: (st.routes || []).filter((r) => r.visible !== false).map((r) => ({
        id: r.id, name: r.name,
        waypoints: r.points.map((p) => ({ lat: p.lat, lng: p.lng })),
      })),
      // все поставленные зоны (флаг active устарел — см. types/Restriction)
      zones: st.project.restrictions.filter((z) => z.points.length > 0).map((z) => ({
        id: z.id, name: z.name, type: z.type,
        geoPoints: mapBounds && st.project.map ? z.points.map((pt) => {
          const g = pixelToGeoExact(pt, mapBounds, st.project.map!.width, st.project.map!.height);
          return { lat: g.lat, lng: g.lng };
        }) : [],
      })),
      createdAt: new Date().toISOString(),
    };
    try {
      await new Promise((res) => setTimeout(res, 1200)); // имитация последовательной загрузки полётных заданий в рой
      localStorage.setItem(`mission-launch-${Date.now()}`, JSON.stringify(mission));
      setLaunchState('done');
      setPopup({ x: canvasSize.width / 2 - 160, y: 60, title: '🚀 ЗАПУСК выполнен', lines: [
        `Полётные задания загружены в ${droneCount} БПЛА`,
        `Старт: ${startGeo ? `${startGeo.lat.toFixed(5)}, ${startGeo.lng.toFixed(5)}` : '—'}`,
        `Цель: ${sharedGoal ? (goalGeo ? `${goalGeo.lat.toFixed(5)}, ${goalGeo.lng.toFixed(5)} (общая)` : '—') : `${Math.min(droneCount, tripleRoutes.length)} индив. целей`}`,
        `Маршрутов: ${mission.routes.length} · Активных зон: ${mission.zones.length}`,
      ] });
    } catch {
      setLaunchState('idle');
    } finally {
      useMissionStore.getState().endProcessing();
    }
  }, [launchState, startGeo, goalGeo, sharedGoal, droneCount, mapBounds, canvasSize, tripleRoutes]);

  // Готовность миссии к запуску: все данные утверждены (шаг 3) либо заданы вручную
  const missionReady = (sharedStart ? !!startGeo : droneStarts.some((s) => !!s) || !!startGeo) && ((draftRoutePts?.length ?? 0) >= 2 || tripleRoutes.length > 0) && (!!goalGeo || !sharedGoal);
  const canLaunch = tripleStep === 3 || missionReady;

  // «НОВАЯ МИССИЯ»: после ЗАПУСКА очищаем данные — можно начинать следующий полёт.
  const newMission = useCallback(() => {
    if (launchState !== 'done') return;
    setStartGeo(null); setGoalGeo(null); setDraftRoutePts([]); setPendingZones([]);
    // очистка store-first зеркал: общие точки + индивидуальные старты/цели дронов
    setSharedStartPoint(null); setSharedGoalPoint(null);
    setDroneStarts([]); setDroneGoals([]);
    useFleetStore.setState({ droneStarts: [], droneGoals: [] });
    setApprovedSteps([false, false, false]); setTripleStep(0); setLaunchState('idle');
    setActiveUav(0);
    // маршруты предыдущей миссии удаляем из проекта (зоны-ограничения остаются)
    useStore.setState((cur) => ({ project: { ...cur.project, routes: [] } }));
    setPopup({ x: canvasSize.width / 2 - 160, y: 60, title: '🆕 Новая миссия', lines: ['Данные предыдущего полёта очищены.', 'Окно «Старт» активно — кликните по карте, чтобы задать точку старта.'] });
  }, [launchState, canvasSize]);

  // Перенос гео-объектов проекта (маршруты/маркеры/зоны) в виртуальный растр
  // новой активной карты при включении режима — иначе объекты останутся в
  // пикселях старого растра и будут вне bounds («карты пустые»).
  const remapProjectToRaster = useCallback(() => {
    const st = readProjectView();
    const map = st.map;
    if (!map?.bounds || map.width <= 0 || map.height <= 0) return;
    const b = map.bounds;
    const routes = (st.routes || []).map((r) => ({
      ...r,
      points: r.points.map((p) => ({ ...p, ...geoToPixelExact(p.lat, p.lng, b, map.width, map.height) })),
    }));
    const markers = st.markers.map((m) =>
      m.lat != null && m.lon != null ? { ...m, ...geoToPixelExact(m.lat, m.lon, b, map.width, map.height) } : m);
    const restrictions = st.restrictions.map((r) => {
      if (r.points.length === 0) return r;
      const geoPts = r.points.map((p) => pixelToGeoExact(p, b, map.width, map.height));
      const pts = geoPts.map((g) => geoToPixelExact(g.lat, g.lng, b, map.width, map.height));
      let radius = r.radius;
      if (r.type === 'circle' && r.radius) {
        const cLat = geoPts[0].lat;
        const dM = r.radius * metersPerPixelFromWorld(256 * Math.pow(2, ZOOM_REF + 10), cLat); // приблизительный перенос в метрах
        const edge = { lat: cLat + dM / 111320, lng: geoPts[0].lng };
        const pe = geoToPixelExact(edge.lat, edge.lng, b, map.width, map.height);
        radius = Math.hypot(pe.x - pts[0].x, pe.y - pts[0].y);
      }
      return { ...r, points: pts, radius };
    });
    useStore.setState((cur) => ({
      project: { ...cur.project, routes, markers, restrictions },
    }));
  }, []);

  // Инициализация тайловой карты при старте приложения (режим трёх окон всегда включён):
  // если активной тайловой карты нет — создаём под текущий центр вида.
  const remapDoneRef = useRef(false);
  useEffect(() => {
    if (remapDoneRef.current) return;
    remapDoneRef.current = true;
    // КОРНЕВОЙ ФИКС краша «Should not already be working» (React #127):
    // ensureDefaultTileMap синхронно вызывает setState(useMapStore), а zustand
    // уведомляет подписчиков СРАЗУ — в том числе useSyncExternalStore-подписку
    // шима, чей getSnapshot собирает merged-агрегат spread'ом внутри активной
    // фазы commit → React падает с «performConcurrentWorkOnRoot: Should not
    // already be working». Выносим автозагрузку за пределы render-фазы.
    const t = window.setTimeout(() => {
      // КОРНЕВОЙ ФИКС «призрачной карты» в тестах готовности: состояние читаем
      // НАПРЯМУЮ из доменного useMapStore, а не через фасад readProjectView().
      // Агрегат шима обновляется асинхронными подписками — сразу после
      // синхронного setState({map:null}) из beforeEach он ещё показывал старую
      // карту («tilesOn=true»), и MapCanvas не запускал автозагрузку. В итоге
      // готовность включал другой экземпляр MapCanvas (следующего этапа),
      // мутируя стор во время render-фазы текущего дерева → краш React #127
      // («Should not already be working») и пропавший readiness-оверлей.
      const st = useMapStore.getState();
      const tilesOn = !!st.settings?.tilesEnabled && !!st.map?.bounds;
      if (!tilesOn) {
        // АВТОНОСНАЯ автозагрузка: MapCanvas гарантирует карту сам, независимо от
        // того, смонтирован ли хук App/useAppInitialization (standalone-экраны,
        // интеграционные тесты этапов). Путь один для всех: ensureDefaultTileMap
        // идемпотентен и сам ждёт завершения async-гидрации persist.
        ensureDefaultTileMap();
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // Клик по карте с активным выбором точки (Старт/Цель) — раньше других обработчиков
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onClick = (e: MouseEvent) => {
      const what = pickWhatRef.current;
      if (what === 'none') return;
      const st = readProjectView();
      const map = st.map;
      if (!map?.bounds || map.width <= 0 || map.height <= 0) return;
      const r = canvas.getBoundingClientRect();
      const v = viewRef.current ?? NEUTRAL_VIEW;
      const mx = (e.clientX - r.left - v.offsetX) / v.scale;
      const my = (e.clientY - r.top - v.offsetY) / v.scale;
      const g = pixelToGeoExact({ x: mx, y: my }, map.bounds, map.width, map.height);
      // store-first: точка переживает unmount/remount MapCanvas (смена карты)
      if (what === 'start') { setStartGeo(g); useMissionStore.getState().setSharedStartPoint(g); }
      else { setGoalGeo(g); useMissionStore.getState().setSharedGoalPoint(g); }
      setPickWhat('none');
    };
    canvas.addEventListener('click', onClick, true); // capture: выполняемся до основной обработки кликов
    return () => canvas.removeEventListener('click', onClick, true);
  }, []);


  // Масштаб стартовой/целевой панелей: 1 см = 2 км при высоте панели ~230 px
  const panelZoomFor2km = (lat: number): number =>
    clampZoom(zoomForGroundMpp(GROUND_MPP_1CM_2KM, lat));

  // Перенос путевой точки маршрута drag-ом на любой из карт (редактирование маршрута)
  // Стабильные ссылки для dblclick-обработчика панелей (замыкания на state
  // в нативных слушателях MiniMapPanel недопустимы — ref-мост).
  const handlePanelMapClickRef = useRef(handlePanelMapClick);
  useEffect(() => { handlePanelMapClickRef.current = handlePanelMapClick; }, [handlePanelMapClick]);
  const pendingZonesRef = useRef(pendingZones);
  useEffect(() => {
    pendingZonesRef.current = pendingZones;
    // Черновик NFZ меняется при каждом клике — канвас перерисовываем сразу,
    // иначе поставленные точки на главной карте не видны до следующего рендера.
    setRenderTick((t) => t + 1);
  }, [pendingZones]);

  const handlePanelPointMove = useCallback((id: string, lat: number, lng: number) => {
    // Вершину черновика NFZ двигать нельзя (проще удалить ✛ и поставить заново).
    if (!id.startsWith('draft:')) return;
    const i = Number(id.slice(6));
    setDraftRoutePts((prev) => {
      if (!prev || i < 0 || i >= prev.length) return prev;
      const n = [...prev]; n[i] = { lat, lng }; return n;
    });
  }, []);

  // (curveGeo определён ниже — см. объявление перед мастером этапов)

  // Экспорт PNG высокого разрешения: композитинг трёх панелей + легенда
  const exportTriplePng = useCallback(async () => {
    // панели теперь в двух контейнерах: маршрут — сверху (вместо большой карты),
    // старт/цель — в нижней строке
    const routePanel = document.querySelector<HTMLCanvasElement>('#triple-route-top canvas');
    const bottomPanels = Array.from(document.querySelectorAll<HTMLCanvasElement>('#triple-map-row canvas'));
    const panels = [bottomPanels[0], routePanel, bottomPanels[1]].filter(Boolean) as HTMLCanvasElement[];
    if (panels.length < 3) return;
    const S = 2; // надбавка разрешения: 2× от css-размера (высокая детализация)
    const W = Math.max(...panels.map((p) => p.clientWidth)) * S;
    const H = Math.max(...panels.map((p) => p.clientHeight)) * S;
    const out = document.createElement('canvas');
    out.width = W * 3 + 40; out.height = H + 90;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0f1729'; ctx.fillRect(0, 0, out.width, out.height);
    const titles = ['СТАРТ (1 см = 2 км)', 'ВЕСЬ МАРШРУТ', 'ЦЕЛЬ (1 см = 2 км)'];
    panels.forEach((pc, i) => {
      const x = 10 + i * (W + 10);
      ctx.drawImage(pc, x, 40, pc.clientWidth * S, pc.clientHeight * S);
      ctx.fillStyle = '#7dd3fc'; ctx.font = `bold ${Math.round(13 * S / 2)}px sans-serif`;
      ctx.fillText(titles[i] || '', x + 4, 24);
    });
    ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(11 * S / 2)}px sans-serif`;
    const leg = `Рой: ${droneCount} БПЛА · ${sharedGoal ? 'общая цель' : `${Math.min(droneCount, Math.max(1, tripleRoutes.length))} индив. цели`} · Старт: ${startGeo ? `${startGeo.lat.toFixed(5)}, ${startGeo.lng.toFixed(5)}` : 'не выбран'} · Цель: ${goalGeo ? `${goalGeo.lat.toFixed(5)}, ${goalGeo.lng.toFixed(5)}` : 'не выбрана'}`;
    ctx.fillText(leg, 10, out.height - 12);
    const a = document.createElement('a');
    a.download = `route-maps-${Date.now()}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
  }, [droneCount, sharedGoal, startGeo, goalGeo, tripleRoutes]);


  // Полный экран
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  // Zoom колесом/кнопками к точке фокуса с ограничением minZoom/maxZoom
  const zoomAt = useCallback((factor: number, focusX?: number, focusY?: number) => {
    const map = project.map;
    const fx = focusX ?? canvasSize.width / 2;
    const fy = focusY ?? canvasSize.height / 2;
    // читаем актуальный вид из ref — колбэк стабилен и не пересоздаётся на каждый mousemove/wheel
    const v = viewRef.current ?? NEUTRAL_VIEW;
    let newScale = v.scale * factor;
    if (map?.bounds) {
      // Границы зума из единой инвариантной привязки: minZoom..maxNativeZoom сервера.
      // Допускается превышение нативного max (растяжение тайлов) — пользователь
      // может приближать карту БЕЗ ограничения («в любых пределах»).
      const z0 = v.z0 ?? ZOOM_REF;
      const bnds = scaleBoundsForZooms(canvasSize.height, z0, tileServer);
      const mppAtMax = metersPerPixelFromWorld(worldPxOf(canvasSize.height, bnds.max, z0), centerLatOf(map.bounds));
      // предельное приближение: не грубее ~0.05 м/пиксель (растяжение выше нативного уровня разрешено)
      const maxExtra = mppAtMax > 0.05 ? bnds.max * (mppAtMax / 0.05) : bnds.max * 16;
      newScale = Math.max(bnds.min, Math.min(maxExtra, newScale));
    } else {
      newScale = Math.max(1e-4, Math.min(1e4, newScale));
    }
    const newOffsetX = fx - (fx - v.offsetX) * (newScale / v.scale);
    const newOffsetY = fy - (fy - v.offsetY) * (newScale / v.scale);
    setViewState({ scale: newScale, offsetX: newOffsetX, offsetY: newOffsetY });
  }, [project.map, canvasSize, tileServer, setViewState]);

  // ─── Мгновенное переключение подложки: при смене сервера тайлов (OSM → 2ГИС и
  // обратно) НЕ нужно перезагружать страницу. Сбрасываем DOM-слой и кэш URL'ов,
  // затем форсируем перерисовку тайлов для текущего вида.
  useEffect(() => {
    const el = tileLayerRef.current;
    if (el) for (const img of tileElsRef.current.values()) img.remove();
    tileElsRef.current.clear();
    tileCache.current.clear();
    tileQueueRef.current = [];
    // Отменяем активные загрузки при смене подложки (OSM → 2ГИС): старые URL'ы
    // больше не нужны, а незакрытые Image держат соединения и память.
    for (const h of tileLoadHandlesRef.current.values()) h.cancel();
    tileLoadHandlesRef.current.clear();
    activeTilesRef.current = 0;
    tilePending.current.clear();
    setTilesVersion((v) => v + 1);
    syncTileDom();
  }, [tileServer, syncTileDom]);

  // Load map image when map data changes.
  // ВАЖНО: при активной тайловой подложке карта не обязана иметь растровое изображение —
  // иначе mapLoaded никогда не станет true и все режимы (маршруты, зоны, сетка) «не грузятся».
  useEffect(() => {
    const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    if (!project.map || !project.map.dataUrl) {
      mapImageRef.current = null;
      publishMapLoaded(tilesActive && !!project.map?.bounds);
      return;
    }

    // Legacy-подложка (статичная фотография карты): в режиме тайловой карты
    // (OSM/Яндекс/Google/2ГИС — штатный путь мастера) эта картинка НЕ нужна.
    // Если бы мы всё равно создавали new Image() с dataUrl, при моках Image без
    // событий onload/onerror (тесты стабильности) счётчик активных загрузок
    // рос бы даже при нулевом размере контейнера — ложные «утечки» и лишний
    // трафик декодирования. Пропускаем загрузку полностью: тайловая подложка
    // сама включает mapLoaded через ветку выше.
    if (tilesActive) {
      mapImageRef.current = null;
      publishMapLoaded(true);
      return;
    }

    // ГЕЙТ РАЗМЕРА (P0 «нулевые размеры»): загрузка растровой подложки стартует
    // ТОЛЬКО когда контейнер реально измерен. При width/height === 0 (сломанный
    // layout, display:none у родителя) Image не создаётся вообще — иначе тесты
    // стабильности фиксировали бы ложные «утечки», а в проде такая картинка
    // была бесполезна: canvas всё равно нечего рисовать. Как только ResizeObserver
    // доставит ненулевые размеры, project.map?.bounds/this effect перезапустится
    // через deps и загрузка начнётся штатно.
    const cs = canvasSizeRef.current;
    if (!(cs.width > 0 && cs.height > 0) || !Number.isFinite(cs.width) || !Number.isFinite(cs.height)) {
      mapImageRef.current = null;
      // ФИКС «СИНИЙ ЭКРАН»: раньше выход был терминальным — эффект не имел
      // canvasSize в deps и никогда не перезапускался после появления реальных
      // размеров → mapLoaded зависал на false, стартовый fit (гейт !mapLoaded)
      // не выполнялся, камера оставалась вне подложки. Теперь при нулевом
      // замере флаг готовности публикуем сразу для ТАЙЛОВОЙ карты (подложка
      // существует независимо от растрового снимка — см. loadActiveTileMap),
      // а появление ненулевого размера (0→N) перестроит этот эффект через
      // новый boolean-dep ниже (ResizeObserver → setCanvasSize → re-render).
      if (tilesActive) publishMapLoaded(true);
      return;
    }

    const img = new Image();
    // ИСПРАВЛЕНИЕ УТЕЧКИ (P0 «зависания»): legacy-подложка раньше не имела ни
    // таймаута, ни отмены. При быстром переключении шагов Мастера unmount не
    // прерывал эту загрузку → in-flight <img> оставался живым навсегда
    // (утечка памяти + setState на размонтированном компоненте). Теперь:
    // settled-флаг (ровно один resolve), гарантированный abort в cleanup и
    // принудительный finish по таймауту — «вечной загрузки» быть не может.
    let settled = false;
    let cancelled = false;
    const finish = (ok: boolean): void => {
      if (settled || cancelled) return;
      settled = true;
      window.clearTimeout(guardTimer);
      img.onload = null;
      img.onerror = null;
      if (ok) {
        mapImageRef.current = img;
        publishMapLoaded(true);
      } else {
        abortTileImage(img);
        console.error('Ошибка загрузки изображения карты');
        // fallback-картинка не загрузилась — но активная тайловая карта всё равно работает
        publishMapLoaded(!!project.settings?.tilesEnabled && !!project.map?.bounds);
      }
    };
    const guardTimer = window.setTimeout(() => finish(false), 12000);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = project.map.dataUrl;
    return () => {
      cancelled = true;
      window.clearTimeout(guardTimer);
      abortTileImage(img);
    };
  }, [project.map?.dataUrl, project.map?.bounds, project.settings?.tilesEnabled,
      // перезапуск при первом появлении валидного размера (0→N) — снятие
      // терминального publishMapLoaded(false) в ветке гейта размеров.
      // Boolean-dep: значение меняется только на границе 0↔N, лишних
      // пересозданий Image при resize нет.
      canvasSize.width > 0 && canvasSize.height > 0]);

  // Resize observer: при изменении размера окна МАСШТАБ НЕ СБИВАЕТСЯ —
  // смещаем offsetX/offsetY так, чтобы географическая точка в центре экрана осталась в центре.
  // (viewRef и rAF-подписка объявлены выше — дублирующий блок удалён.)

  // Троттлинговый подписчик: зоны ограничений изменились -> маршруты автоматически
  // перестраиваются (обход зон). Вызывается единый модульный планировщик scheduleRerouteAll —
  // троттлинг 250 мс и отмена предыдущего таймера гарантируются в одном месте.
  // ВАЖНО: НЕ вызывать s.rerouteAllRoutes() здесь — стор сам инициирует перестройку
  // после updateRestriction/deleteRestriction/setActiveRestriction; двойной вызов
  // порождал две гонки троттлеров на одну операцию изменения зон.
  useEffect(() => {
    let vTimer: ReturnType<typeof setTimeout> | null = null;
    let lastVKey = '';
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project.restrictions !== prev.project.restrictions) scheduleRerouteAll();
      // Автокоррекция высот: изменились ВЕРТИКАЛЬНЫЕ лимиты зон, настройки
      // высот или геометрия маршрутов — пересчитать требуемые ABS-высоты
      // по рельефу (Open-Elevation; кэш высот делает повторные прогоны дешёвыми).
      // Троттлинг 600 мс: при drag точек маршрута запросы не должны сыпаться
      // на каждый mousemove (публичный API тротлится; altitudeRunId отменяет
      // устаревшие прогоны, но сетевой шторм всё равно недопустим).
      const vKey = (rs: typeof s.project.restrictions) =>
        rs.reduce((acc, r) => acc + `${r.active ? 1 : 0}:${r.minHeightAGL ?? ''}:${r.maxHeightAGL ?? ''}|`, '');
      const geoKey = (s.project.routes || []).map((r) =>
        `${r.id}:${r.points.length}:${r.points.reduce((a, p) => a + `${p.lat.toFixed(4)},${p.lng.toFixed(4)};`, '')}`
      ).join('|');
      const elevAuto = s.project.settings.elevationAuto === true;
      const needAlt = elevAuto && (
        vKey(s.project.restrictions) !== vKey(prev.project.restrictions) ||
        s.project.settings.altitudeClearanceM !== prev.project.settings.altitudeClearanceM ||
        geoKey !== lastVKey
      );
      if (needAlt) {
        lastVKey = geoKey;
        if (vTimer) clearTimeout(vTimer);
        vTimer = setTimeout(() => {
          vTimer = null;
          void useStore.getState().updateRouteAltitudes();
        }, 600);
      } else if (!elevAuto && vTimer) {
        clearTimeout(vTimer); vTimer = null;
      }
    });
    // Клавиатурный зум из App.tsx: типобезопасный eventBus ('map:zoom-request')
    // вместо window CustomEvent — масштабирует вид вокруг центра канваса через
    // тот же zoomAt, что и колесо мыши (единые границы minZoom..maxNativeZoom,
    // центр не «прыгает»).
    const offZoomBus = eventBus.on('map:zoom-request', ({ factor }) => {
      if (typeof factor === 'number' && isFinite(factor) && factor > 0) zoomAt(factor);
    });
    return () => {
      unsub();
      offZoomBus();
    };
  }, [zoomAt]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Флаг монтирования: все асинхронные колбэки (ResizeObserver приходит через
    // микротаск/кадр после observe()) обязаны проверять его — иначе setState на
    // уже размонтированном компоненте при быстром переключении шагов Мастера.
    let mounted = true;
    // rAF-скобка для событий ResizeObserver: гарантирует ОДИН пересчёт размеров
    // на кадр даже при серии resize-событий (запрет «RO loop» — callback больше
    // не вызывает синхронный re-render внутри RO-колбэка).
    let roRaf = 0;
    const applySizes = (w: number, h: number): void => {
      if (!mounted) return;
      // ЖЁСТКАЯ ВАЛИДАЦИЯ РАЗМЕРОВ (шаг П1 ТЗ): NaN/отрицательные значения
      // от битого contentRect игнорируются полностью — иначе worldPx становится
      // NaN и вся математика тайлов зависает в бесконечном цикле перерисовок.
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) return;
      // ── ФИКС «ВИСНЕТ НАМЕРТВО» (корень #2, применение СПб-фолбэка) ────────
      // Первый РЕАЛЬНЫЙ замер контейнера: если при маунте не удалось восстановить
      // валидный вид (битый localStorage / stale-гидрация), фиксируем камеру над
      // СПб ровно так же, как это делает стартовая подгонка в режиме планирования
      // (центр СПб, зум DEFAULT_TILE_MAP_ZOOM, эталон z0). Без этого viewRef мог
      // остаться на нейтральном {0,0,scale:1} — камера вне подложки, вечный спиннер.
      if (pendingSpbFallbackRef.current && w > 0 && h > 0) {
        pendingSpbFallbackRef.current = false;
        const fb = spbFallbackView(h);
        const v: ViewState = { ...fb, offsetX: w / 2 - ((SPB_GEO_CONST.lng + 180) / 360) * Math.max(256, h * Math.pow(2, DEFAULT_TILE_MAP_ZOOM)) };
        viewRef.current = v;
        useStore.getState().setViewState({ ...v });
        writeMirrorNow();
      }
      setCanvasSize((prev) => {
        if (prev.width === w && prev.height === h) return prev; // нет изменения — нет ре-рендера
        if (prev.width > 0 && prev.height > 0 && w > 0 && h > 0) {
          // инвариант вида: scale и z0 сохраняются, центр карты не «прыгает»
          const v = viewRef.current ?? NEUTRAL_VIEW;
          useStore.getState().setViewState({
            offsetX: v.offsetX + (w - prev.width) / 2,
            offsetY: v.offsetY + (h - prev.height) / 2,
          });
        }
        // ФИКС «не удалось определить размер карты»: зеркало 'tq-view' обязано
        // содержать фактические размеры канваса СРАЗУ после замера — иначе
        // конвертер кликов мастера (screenToGeo) теряет базу worldPx до первого
        // пользовательского жеста. canvasSizeRef обновится только на следующем
        // рендере (useEffect), поэтому синхронизируем ref здесь же.
        canvasSizeRef.current = { width: w, height: h };
        writeMirrorNow();
        return { width: w, height: h };
      });
    };

    /** Синхронный замер контейнера с фолбэком на clientWidth/clientHeight. */
    const measureContainer = (): { w: number; h: number } => {
      const c = containerRef.current;
      if (!c) return { w: 0, h: 0 };
      const r = c.getBoundingClientRect();
      const w = r.width > 0 ? r.width : c.clientWidth;
      const h = r.height > 0 ? r.height : c.clientHeight;
      return { w, h };
    };

    // ЦИКЛ КОНТРОЛЯ РАЗМЕРОВ (P0 «вечная загрузка при нулевом размере», шаг П3 ТЗ):
    // layout может измениться ПОСЛЕ монтирования (display:none у родителя, нулевая
    // flex-ветка мастера, поздний CSS). Каждые 250 мс сверяем факт с состоянием:
    //   • размер появился → применяем его (карта стартует сама);
    //   • размер пропал → гасим canvasSize: включается circuit breaker размеров
    //     («Не удалось определить размер контейнера» + кнопка повтора), а ОЧЕРЕДЬ
    //     ЗАГРУЗКИ ТАЙЛОВ ПРИНИМАТЕЛЬНО ОПУСТОШАЕТСЯ — новые Image не создаются
    //     (запрет загрузки в невидимый слой = защита от NaN-математики и утечек).
    // Интервал принадлежит этому же cleanup-эффекту → при unmount гарантированно
    // снимается (ни одного «сиротского» setInterval между шагами Мастера).
    // ВАЖНО: цикл работает ВСЁ время жизни компонента (не только первые секунды):
    // именно он автоматически убирает оверлей «Не удалось определить размер
    // контейнера карты», как только layout восстановился (конец анимации шага
    // мастера, разворот панели, поворот экрана) — без нажатия «Попробовать снова».
    let zeroStreak = 0; // подряд идущие замеры 0×0 (для диагностического лога)
    const sizeWatchId = window.setInterval(() => {
      if (!mounted) return;
      const cur = canvasSizeRef.current;
      const m = measureContainer();
      if (m.w > 0 && m.h > 0) {
        if (zeroStreak >= 4) {
          console.warn('[MapCanvas] размеры контейнера восстановлены после серии нулевых замеров:',
            { wasZeroForMs: zeroStreak * 250, now: `${m.w}×${m.h}` });
        }
        zeroStreak = 0;
        if (cur.width !== m.w || cur.height !== m.h) applySizes(m.w, m.h);
      } else {
        zeroStreak++;
        // Диагностика корня ошибки «Не удалось определить размер контейнера
        // карты»: после ~1 с непрерывных нулевых замеров выводим во временную
        // консоль причины (display:none / схлопнутый flex-родитель / отсутствие
        // пиксельного базиса высоты у предков #map-container).
        if (zeroStreak === 4) {
          const c = containerRef.current;
          const parentHidden = !!(c && (getComputedStyle(c).display === 'none'
            || (c.parentElement && getComputedStyle(c.parentElement).display === 'none')));
          console.warn('[MapCanvas] контейнер карты имеет нулевой размер ≥1 с.',
            'Возможные причины: display:none у родителя; схлопнутый flex-элемент;',
            'у предков нет пиксельного базиса высоты (h-full без height у root).',
            { displayNone: parentHidden, rect: c?.getBoundingClientRect().toJSON?.() ?? null });
        }
        if (cur.width > 0 || cur.height > 0) {
          applySizes(0, 0);
          tileQueueRef.current.length = 0;
          for (const hh of tileLoadHandlesRef.current.values()) hh.cancel();
          tileLoadHandlesRef.current.clear();
          activeTilesRef.current = 0;
          tilePending.current.clear();
          for (const imgEl of tileElsRef.current.values()) { abortTileImage(imgEl); imgEl.remove(); }
          tileElsRef.current.clear();
        }
      }
    }, 250);

    const observer = new ResizeObserver((entries) => {
      if (roRaf) cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        if (!mounted) return;
        for (const entry of entries) {
          applySizes(entry.contentRect.width, entry.contentRect.height);
        }
      });
    });

    // СИНХРОННЫЙ первичный замер ДО observe(): ResizeObserver доставляет первое
    // событие только в следующем кадре, а в jsdom/happy-dom может не доставить
    // никогда. Без этого canvasSize оставался {0,0}, загрузка тайлов не стартовала
    // и лоадер висел вечно («карта грузится, но не видна»).
    // requestAnimationFrame(RO-скобка) тоже откладывается на кадр — в тестовой
    // среде (fake timers / отсутствие rAF-дренажа) размеры могли так и не
    // примениться. Поэтому сразу после синхронного замера планируем ещё один
    // микро-тик: к моменту проверки контейнер уже имеет измеренные размеры.
    const rect = container.getBoundingClientRect();
    const cw = rect.width > 0 ? rect.width : container.clientWidth;
    const ch = rect.height > 0 ? rect.height : container.clientHeight;
    // В тестовой среде размеры контейнера могут появиться ПОСЛЕ монтирования
    // (патчинг getBoundingClientRect в RTL-тестах). Односложный rAF-отложенный
    // повтор замера гарантирует, что canvasSize не останется {0,0} навечно —
    // иначе включался бы circuit breaker размеров вместо реальной карты.
    if (cw <= 0 || ch <= 0) {
      // Повтор замера: rAF + серия СИНХРОННЫХ таймеров setTimeout(0). В средах
      // без rAF-дренажа (fake timers в vitest, jsdom без кадров) один только rAF
      // никогда не выполняется — canvasSize оставался бы {0,0} до срабатывания
      // sizeWatchId (250 мс, тоже на fake-таймерах), и вместо карты показывался
      // circuit breaker «Не удалось определить размер контейнера». setTimeout(0)
      // гарантированно исполняется в любой среде с обычным event loop.
      // Фикс ошибки «Не удалось определить размер контейнера карты» при РЕАЛЬНОМ
      // layout: высота flex-ветки мастера разрешается браузером ПОСЛЕ первого
      // paint (поздний CSS, анимация шага, пересчёт vh-мобильной адресной строки),
      // поэтому одного тика недостаточно — делаем несколько отложенных повторов
      // (~до 1.3 с). Как только появился ненулевой базис — применяем размеры и
      // карта стартует сама, оверлей с кнопкой «Попробовать снова» показывается
      // только если layout реально сломан (размер так и не появился).
      const retryDelaysMs = [0, 60, 180, 400, 700, 1300];
      const retryMeasure = (): void => {
        if (!mounted) return;
        const c = containerRef.current;
        if (!c) return;
        const m = measureContainer();
        if (m.w > 0 && m.h > 0) applySizes(m.w, m.h);
      };
      requestAnimationFrame(retryMeasure);
      for (const d of retryDelaysMs) {
        const retryTimerId = window.setTimeout(retryMeasure, d);
        ownedTimersRef.current.add(retryTimerId as unknown as ReturnType<typeof setTimeout>);
      }
    }
    if (cw > 0 && ch > 0) applySizes(cw, ch);

    observer.observe(container);
    return () => {
      mounted = false;
      if (roRaf) cancelAnimationFrame(roRaf);
      observer.disconnect();
      window.clearInterval(sizeWatchId);
      // ИСПРАВЛЕНИЕ утечки при переходе между шагами Мастера: очистка дебаунса
      // и незавершённых загрузок тайлов. Без этого pending-промисы держат ссылки
      // на DOM-элементы размонтированного слоя, а setTimeout(pump) после
      // unmount вызывал setTilesVersion на несмонтированном компоненте.
      if (tileDebounceRef.current) clearOwnedTimeout(tileDebounceRef.current);
      tileQueueRef.current.length = 0;
      // P0: отменяем ВСЕ активные загрузки тайлов через реестр handles —
      // иначе Image с выставленным src доживает до 10-секундного таймаута,
      // держит DOM размонтированного слоя и резолвится на unmounted-компоненте.
      for (const h of tileLoadHandlesRef.current.values()) h.cancel();
      tileLoadHandlesRef.current.clear();
      for (const img of tileElsRef.current.values()) {
        abortTileImage(img);
        img.remove();
      }
      tileElsRef.current.clear();
      tilePending.current.clear();
      activeTilesRef.current = 0;
      // Сброс circuit breaker'ов при unmount/remount: повторная попытка загрузки
      // (следующий маунт) обязана начинаться с чистого состояния — иначе stale
      // оверлей «размер не определён»/«загрузка зависла» переживал remount и
      // блокировал реальную карту даже после появления корректных размеров.
      setTileLoadStalled(false);
      // Гарантированная очистка ВСЕХ таймеров, принадлежащих компоненту
      // (debounce pump, retry-замер и т.д.) — ни одного «сиротского» setState.
      for (const t of ownedTimersRef.current) clearTimeout(t);
      ownedTimersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setViewState]);

  // Стартовый zoom-инвариант z0: фиксируется ОДИН РАЗ на карту (не пересчитывается
  // при ресайзе — иначе масштаб «сбивается»). Тайлы, сетка и линейка используют его всегда.
  const lastFittedMapRef = useRef<string | null>(null);
  useEffect(() => {
    const map = project.map;
    if (!map?.bounds || canvasSize.height <= 0) return;
    const key = `${map.name}|${map.bounds.north.toFixed(6)},${map.bounds.south.toFixed(6)}`;
    if (lastFittedMapRef.current === key && viewRef.current?.z0 != null) return;
    lastFittedMapRef.current = key;
    // ── ФИКС «ВИСНЕТ НАМЕРТВО ПРИ ЗАГРУЗКЕ КАРТ» (корень #3) ────────────────
    // Раньше этот эффект СБРАСЫВАЛ z0 восстановленного вида на ZOOM_REF=14 при
    // каждом remount'е (редактор↔мастер), в то время как offsetX/offsetY/scale
    // оставались от сохранённого вида с другим z0. Итоговый worldPx уходил на
    // ~2^12 экранов: очередь тайлов бесконечно переполнялась (budget не спасал —
    // элементы создавались заново каждый кадр синхронизации), растровый цикл
    // канваса не завершался → страница «виснет намертво». Теперь z0 сохранённого
    // вида НЕ трогаем: он уже корректен (эталон записан при стартовой подгонке).
    if (viewRef.current?.z0 == null) setViewState({ z0: ZOOM_REF });
  }, [project.map?.name, project.map?.bounds, canvasSize.height]);

  // Auto-fit view: при загрузке карты — вписать её; если на карте есть объекты
  // (маршруты/маркеры/зоны) — автоматически масштабировать вид ПОД НИХ,
  // карта остаётся интерактивной (зум/панорама доступны всегда).
  const lastInitialFitRef = useRef<string | null>(null);
  useEffect(() => {
    const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    const map = project.map;
    // ФИКС «1 окно: неверный масштаб/смещение» (этап 2): стартовый fit использует
    // и width, и height контейнера (fit-to-bounds, worldPx = height·2^zoom). Если
    // эффект стартует на промежуточном layout (height ещё не разрешён CSS-flex ⇒
    // 0 или stale), битый вид фиксируется ОДИН раз (lastInitialFitRef) и больше не
    // пересчитывается. Ждём оба валидных измерения — для режима 3 окон логика не
    // меняется: MiniMapPanel имеет собственный рендер и этот эффект не использует.
    if (!map || !mapLoaded || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const boundsKey = map.bounds ? `${map.bounds.north},${map.bounds.south},${map.bounds.west},${map.bounds.east}` : 'nobounds';
    const fitKey = `${map.dataUrl ? 'img' : 'tiles'}|${boundsKey}`;
    // ФИКС «1 окно: битый вид зафиксирован навсегда» (этап 3): раньше ключ
    // ставился ДО проверки сохранённого вида — при невалидном/чужом savedView
    // эффект выходил с помеченным ключом, повторный fit блокировался и карта
    // оставалась на stale-виде от другой карты («карта также не работает»).
    // Флаги после ключа: '|pending' — промежуточный замер (fit пересчитается
    // на следующем изменении размеров), '|saved' — восстановлен savedView
    // (пересчёт при следующем resize — безопасный фолбэк). Штатно выполненный fit
    // хранит ключ без флага — ранний выход: ресайз/смена режима вид НЕ
    // трогают (прежнее поведение; режим трёх окон этим кодом не управляет).
    // ФИКС (этап 3, v2): сравнение по ПРЕФИКСУ ключа. Раньше проверялось
    // точное равенство «ключ === fitKey», но флаги '|pending'/'|saved'
    // дописываются ПОСЛЕ fitKey ⇒ строки никогда не совпадали, ветка сброса
    // была мертва, а штатно выполненный fit ('fitKey' без флага) при любом
    // повторном проходе эффекта перезапускал подгонку и затирал ручной
    // зум/пан пользователя (remount-гипотеза «карта также не работает»).
    const prevFit = lastInitialFitRef.current ?? '';
    if (prevFit === fitKey) return; // fit выполнен штатно — ресайз/смена режима вид НЕ трогают
    if (prevFit.startsWith(fitKey + '|')) {
      lastInitialFitRef.current = null; // был pending/saved — пересчитаем ниже на валидных размерах
    }
    if (!map.bounds) { lastInitialFitRef.current = `${fitKey}|pending`; return; }
    // ── ФИКС «ВИСНЕТ НАМЕРТВО ПРИ ЗАГРУЗКЕ КАРТ» + «Фиксация над СПб» ───────
    // Стартовая фиксация вида выполняется ровно ОДИН раз для конкретной карты:
    // если в localStorage-зеркале уже есть валидный сохранённый вид именно для
    // ЭТОЙ карты (ключ пары совпал), повторная подгонка НЕ делается — иначе
    // при каждом remount'е редактор↔мастер вид пересчитывался, стор и viewRef
    // разъезжались по z0, и тайловая очередь уходила в бесконечный цикл.
    // Отсутствие/несовпадение ключа → штатная стартовая фиксация (центр
    // bounds — объект загрузки: Москва/СПб — и запрошенный зум). После любой
    // фиксации пользователь свободно двигает и масштабирует карту: панорама
    // и непрерывный зум (DOM-тайлы уровня round(zoom) с плавным 2^(zoom−level))
    // дают чёткость на всём диапазоне z3..z19+ без перезагрузки подложки.
    {
      let savedKey: string | null = null;
      try { savedKey = localStorage.getItem(`${VIEW_STORAGE_KEY}-map`); } catch { savedKey = null; }
      const curKey = mapFitKey(map);
      if (sanitizeSavedView(readSavedView(), curKey, savedKey)) {
        // Валидное восстановление — приводим стор к тому же виду (идемпотентно,
        // если гидрация persist уже отдала идентичный viewState) и выходим.
        const v = viewRef.current ?? NEUTRAL_VIEW;
        if (v) {
          const sv = useStore.getState().viewState;
          if (sv.offsetX !== v.offsetX || sv.offsetY !== v.offsetY || sv.scale !== v.scale || sv.z0 !== v.z0) {
            setViewState({ ...v });
          }
        }
        lastInitialFitRef.current = `${fitKey}|saved`; // флаг: пересчёт возможен при resize
        return;
      }
    }
    // ИНВАРИАНТНЫЙ ЭТАЛОН z0: привязка вида задаётся формулой worldPx = vh·2^zoom,
    // zoom = ZOOM_REF + log2(scale). Он НЕ зависит от размеров окна — поэтому
    // масштаб не «сбивается» при ресайзе/восстановлении из persist.
    // ── КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ «карта загружается с ошибкой / не грузится» ──────
    // Старый код вычислял целевой зум из ГЕОМЕТРИИ РАСТРА
    // (zoom = log2(map.height / mercSpanY(bounds) / 256)). Для активной тайловой
    // карты loadActiveTileMap строит виртуальный растр = ПОЛНЫЙ мир уровня z
    // (height = 256·2^z), но bounds хранит окно обзора пользователя (например
    // область Москвы на z12: mercSpanY ≈ 0.002). Подстановка давала
    // zoom = log2(256·2^12 / 0.002 / 256) ≈ 23.7 → кламп к MAX_ZOOM=19 и камера
    // улетала в космос: тайлы запрашивались на z19 в радиусе тысяч экранов,
    // очередь не успевала — «карта не загружается». Теперь:
    //  • зум берётся ПРЯМО из размера bounds (стандартная формула fit-to-bounds,
    //    та же, что zoomToFitBounds) — корректен для любой пары растр/bounds;
    //  • центр — географический центр bounds;
    //  • эталон z0 = ZOOM_REF постоянен.
    if (mapImageRef.current && !tilesActive) {
      // Растровая карта (Google/Yandex/локальный снимок): вписать изображение
      // целиком. Привязка тайлов/сетки/линейки согласуется с ФАКТИЧЕСКИМ размером
      // растра относительно bounds: scale=1 ⇔ мир по X = map.width·2^z0 px ⇒
      // z0 = log2(worldPxNeeded/(256·fitScale)).
      const lngSpan = Math.abs(map.bounds.east - map.bounds.west);
      const worldPxNeeded = (canvasSize.width * 360) / Math.max(lngSpan, 1e-9);
      const fitScale = Math.min(canvasSize.width / map.width, canvasSize.height / map.height) * 0.9;
      const zFit = Math.log2(worldPxNeeded / (256 * fitScale));
      setViewState({
        scale: fitScale,
        offsetX: (canvasSize.width - map.width * fitScale) / 2,
        offsetY: (canvasSize.height - map.height * fitScale) / 2,
        z0: zFit,
      });
    } else if (tilesActive) {
      // Тайловая подложка (активная карта, как на openstreetmap.org).
      // ── КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ «карта загружается с ошибкой» (fit-to-bounds) ──
      // Старый расчёт брал ГЕОМЕТРИЮ РАСТРА: растр = полный мир уровня z
      // (height = 256·2^z), а bounds = узкое окно пользователя → формула
      // zoom = log2(map.height / mercSpanY(bounds)) давала ~23.7 → кламп к 19:
      // камера улетала в космос, тайлы не успевали, «карта не загружалась».
      // Теперь стартовый вид считается ПРЯМО из пары «виртуальный растр ⇔
      // bounds» loadActiveTileMap: пиксели растра привязаны к bounds линейно
      // (pixel ⇔ доля bounds), поэтому масштаб, при котором весь растр вписан
      // в экран, — это ровно тот зум z, что был запрошен при загрузке
      // (worldPx = 256·2^z). Центр — географический центр bounds (или центр
      // растра, если bounds шире окна). Никакой зависимости от размеров окна,
      // никакого «полёта в космоса»: строгая привязка к координатам при любом
      // масштабе и панораме.
      // ── ФИКС «В РЕЖИМЕ ОДНОГО ОКНА НЕВЕРНЫЙ МАСШТАБ/СМЕЩЕНИЕ» (v2) ────────
      // loadActiveTileMap фиксирует bounds как окно обзора под ЭТАЛОН 800×600
      // css px на зуме z. В режиме трёх окон контейнеры близки к эталону —
      // баг маскировался; в редакторе-«одном окне» flex-колонка даёт другой
      // размер ⇒ fit-to-bounds (zb) открывал карту на масштабе, отличном от
      // запрошенного z, со смещением центра. Исправление: для тайловой карты
      // виртуального растра (loadActiveTileMap: dataUrl === '', растр = полный
      // мир уровня z, width === height === 256·2^z) стартовый зум берётся
      // НАПРЯМУЮ из геометрии растра — ровно z загрузки — и НЕ зависит от
      // размера контейнера. Фолбэк fit-to-bounds остаётся для снимков с
      // включёнными тайлами (dataUrl ≠ '') и неполных растров.
      // ⚠ ПРЕДУПРЕЖДЕНИЕ v1: условие вида «rasterWorldPx >= 256·2^MIN_ZOOM»
      // всегда истинно при clampZoom(zb) ≥ MIN_ZOOM ⇒ ветка fit-to-bounds
      // была мертва, а первый же вызов с фиксированным z открывал карту на
      // неправильном масштабе («карта также не работает»). Теперь признак
      // проверяется структурно (полный мир ⇔ virtualRaster), без догадок.
      const b = map.bounds;
      const topM = latToMerc(b.north);
      const botM = latToMerc(b.south);
      const leftFx = (b.west + 180) / 360;
      const rightFx = (b.east + 180) / 360;
      // Размер bounds в нормализованных меркатор-долях мира
      const spanFx = Math.max(1e-12, rightFx - leftFx);
      const spanFy = Math.max(1e-12, botM - topM);
      // ── ФИКС «СИНИЙ ЭКРАН, ПРОПАДАЮЩИЙ ПРИ УВЕЛИЧЕНИИ» (v3) ────────────────
      // Структурный признак карты loadActiveTileMap: снимка нет (dataUrl === '')
      // и виртуальный растр = полный мир уровня z (width === height = 256·2^z,
      // z ∈ [6..19] ⇒ worldPx кратно 256·2^6).
      const virtualRaster =
        !map.dataUrl &&
        Number.isFinite(map.width) &&
        map.width === map.height &&
        map.width >= 256 * Math.pow(2, 6) &&
        Math.abs(map.width / (256 * Math.pow(2, 6)) - Math.round(map.width / (256 * Math.pow(2, 6)))) < 1e-9;
      // ПРЕЖДЕ чем считать зум из геометрии растра, проверяем СОГЛАСОВАНОСТЬ
      // растра с bounds. Раньше этого не было: legacy-карты (bounds = полный
      // мир west=-180…east=180 при узком растре-окне) давали
      // rasterWorldPx = 256·(360/lngSpan) ≈ 16.7 млн ⇒ zoom клампился к 19,
      // камера улетала в космос: экран заливался фоном канваса («синий»), а
      // при увеличении тайлы успевали за viewport — карта «появлялась».
      // Согласованная пара «виртуальный растр ⇔ bounds-window» из
      // loadActiveTileMap даёт worldPx = 256·2^z ± доли пикселя.
      const rasterWorldPx = (map.width / spanFx + map.height / spanFy) / 2; // ≈ 256·2^z
      const rasterConsistent =
        Number.isFinite(rasterWorldPx) &&
        Math.abs(rasterWorldPx / 256 - Math.round(rasterWorldPx / 256)) < 0.01; // целое число tile-миров
      // Базовый зум fit-to-bounds, при котором bounds целиком вписывается в
      // экран: spanFx·256·2^zb ≤ canvasW и spanFy·256·2^zb ≤ canvasH.
      const zb = Math.min(
        Math.log2(canvasSize.width / (256 * spanFx)),
        Math.log2(canvasSize.height / (256 * spanFy)),
      );
      let zoom: number;
      if (virtualRaster && rasterConsistent) {
        zoom = Math.log2(rasterWorldPx / 256); // ровно z загрузки (инвариант worldPx = 256·2^z)
      } else if (rasterConsistent && map.width <= canvasSize.width && map.height <= canvasSize.height) {
        zoom = Math.log2(rasterWorldPx / 256); // весь согласованный растр в окне — открываемся на его z
      } else {
        zoom = zb; // фолбэк: подогнать область bounds под экран (устаревшие/несогласованные пары)
      }
      zoom = clampZoom(zoom);
      const zFix = ZOOM_REF; // ЭТАЛОН для инварианта worldPx = canvasHeight·2^(zFix+log2 scale)
      const worldPx = canvasSize.height * Math.pow(2, zoom); // мир в экранных px на этом зуме
      // Центр вида — географическая середина bounds (ровно center при обычной
      // загрузке; при клампе bounds к краям мира центр может смещаться — берём
      // середину фактических bounds, чтобы не уходить в пустоту).
      const fx = leftFx + spanFx / 2;
      const fy = topM + spanFy / 2;
      setViewState({
        scale: worldPx / (canvasSize.height * Math.pow(2, zFix)), // ⇔ zoom = zFix + log2(scale)
        offsetX: canvasSize.width / 2 - fx * worldPx,
        offsetY: canvasSize.height / 2 - fy * worldPx,
        z0: zFix,
      });
    }
    // ── ФИКС «ВИСНЕТ НАМЕРТВО» (корень #4): зафиксированный стартовый вид
    // немедленно уходит в localStorage-зеркало 'tq-view' СИНХРОННО. Без этого
    // remount до ближайшего кадра/жеста читал бы зеркало со stale-видом или
    // без ключа карты → повторная подгонка → гонка стора и зеркала.
    lastInitialFitRef.current = fitKey; // штатный fit выполнен — защита от повтора (см. v2 выше)
    writeMirrorNow();
  }, [project.map?.dataUrl, project.map?.bounds, project.settings?.tilesEnabled, mapLoaded, canvasSize.width, canvasSize.height]);

  // Отдельный эффект: при ПЕРВОМ появлении объектов на новой карте —
  // автоматически подогнать вид под все объекты ровно один раз.
  // Ключ — ТОЛЬКО идентификатор карты (mapId): раньше в ключ входили id всех
  // маршрутов/маркеров, из-за чего добавление/удаление любой точки меняло ключ
  // и верхняя карта самовольно «возвращалась»/перемасштабивалась под bbox всех
  // объектов (автовозврат вида). Теперь ручной зум/пан пользователя никогда не
  // откатывается: перестройка маршрутов меняет только содержимое, но не вид.
  const lastFitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const map = project.map;
    if (!map || !map.bounds || !mapLoaded || canvasSize.width <= 0) return;
    const pts: Point[] = [];
    for (const r of project.routes || []) if (r.visible !== false) for (const p of r.points) pts.push({ x: p.x, y: p.y });
    for (const m of project.markers) pts.push({ x: m.x, y: m.y });
    if (pts.length < 2) return;
    // Ключ — ТОЛЬКО идентификатор карты + «есть ли объекты» (переход 0→N).
    // Смена состава объектов (добавление/удаление точек, перестройка маршрутов)
    // НЕ должна трогать вид — иначе верхняя карта самовольно возвращается к
    // общему bbox и сбрасывает ручной зум пользователя.
    const fitKey = String(map.mapId || '') + ':' + (pts.length > 0 ? 'has' : 'empty');
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    // ── ФИКС «в РЕЖИМЕ МАСТЕРА КАРТА НЕ ВИДНА» (корень расхождения режимов) ──
    // Для АКТИВНОЙ тайловой карты виртуальный растр = ПОЛНЫЙ МИР уровня z
    // (width=height=256·2^z). Подгонка вида под bbox объектов на таком растре
    // давала hFrac≈1e-4 → worldTarget≈vh·10⁴ → zoom клампился к MAX_ZOOM=19,
    // а scale ≈ 3700 при мире z10. В редакторе этот битый вид маскировался
    // широким окном и зеркалом 'tq-view'; в мастерской узкой панели карта
    // «загружалась, но не была видна». Тайловая подложка сама покрывает весь
    // мир — вписывать в неё объекты НЕ нужно: стартовая фиксация над СПб
    // (эффект выше) и есть штатный вид обоих режимов. Растровые снимки
    // (legacy-фото карты) вписываем по-прежнему.
    const tilesActiveNow = !!project.settings?.tilesEnabled && !!map.bounds;
    if (tilesActiveNow) return;
    const fit = fitViewToData(map.width, map.height, map.bounds, pts, canvasSize.width, canvasSize.height, viewRef.current?.z0);
    if (fit) setViewState(fit);
  }, [project.routes, project.markers, mapLoaded, canvasSize.width, canvasSize.height, project.map?.bounds, project.settings?.tilesEnabled]);

  // Convert screen coordinates to map coordinates (читаем вид из ref — стабильный колбэк)
  const screenToMap = useCallback((screenX: number, screenY: number): Point => {
    const v = viewRef.current ?? NEUTRAL_VIEW;
    return {
      x: (screenX - v.offsetX) / v.scale,
      y: (screenY - v.offsetY) / v.scale,
    };
  }, []);

  // Drag-обратная связь: refs читаются внутри эффекта рендера (deps ниже),
  // чтобы захваченный элемент подсвечивался в реальном времени.
  const draggingMarkerRef = useRef<string | null>(null);
  const draggingRouteRef = useRef<{ routeId: string; index: number } | null>(null);
  useEffect(() => { draggingMarkerRef.current = draggingMarker; }, [draggingMarker]);
  useEffect(() => { draggingRouteRef.current = draggingRoute; }, [draggingRoute]);

  // Fallback-заглушка «нет карты»: hit-зоны нарисованных кнопок + скрытый input
  // для загрузки файла прямо с канваса (без похода в тулбар).
  type FallbackBtn = { id: 'tile' | 'upload'; rect: { x: number; y: number; w: number; h: number } };
  const fallbackButtonsRef = useRef<FallbackBtn[]>([]);
  const fallbackFileInputRef = useRef<HTMLInputElement | null>(null);
  const loadActiveTileHere = useCallback((): void => {
    const st = useStore.getState();
    const cs = canvasSizeRef.current;
    const v = viewRef.current ?? NEUTRAL_VIEW;
    const wp = worldPxOf(cs.height, v.scale, v.z0 ?? ZOOM_REF);
    const latC = mercToLat((cs.height / 2 - v.offsetY) / wp);
    const lngC = ((cs.width / 2 - v.offsetX) / wp) * 360 - 180;
    const zNow = clampZoom(zoomAtWorldPx(wp));
    st.loadActiveTileMap({ lat: latC, lng: lngC }, Math.round(Math.min(12, zNow)));
  }, []);
  const handleFallbackFile = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      setFallbackMsg('Поддерживаются только PNG, JPG, WebP, BMP');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        useStore.getState().loadMap({
          name: file.name, width: img.width, height: img.height, dataUrl,
          source: 'local',
        });
        setRenderTick((t) => t + 1);
      };
      img.onerror = () => setFallbackMsg('Не удалось прочитать изображение');
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, []);
  const [fallbackMsg, setFallbackMsg] = useState<string>('');

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // HiDPI: физический размер канваса больше логического в dpr раз
    const physW = Math.max(1, Math.round(canvasSize.width * dpr));
    const physH = Math.max(1, Math.round(canvasSize.height * dpr));
    if (canvas.width !== physW) canvas.width = physW;
    if (canvas.height !== physH) canvas.height = physH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Широта центра видимой области — для точного расчёта метров/пиксель
    let centerLatRef = project.map?.bounds ? (project.map.bounds.north + project.map.bounds.south) / 2 : 0;
    if (project.map?.bounds && project.map.height > 0) {
      const topM = latToMerc(project.map.bounds.north);
      const botM = latToMerc(project.map.bounds.south);
      const cyMapPx = (canvasSize.height / 2 - vs.offsetY) / vs.scale;
      centerLatRef = mercToLat(topM + ((botM - topM) / project.map.height) * Math.max(0, Math.min(project.map.height, cyMapPx)));
    }

    // Clear: при активной подложке OSM canvas ПРОЗРАЧЕН — сквозь него виден
    // DOM-слой тайлов (подложка как на openstreetmap.org), а объекты рисуются
    // поверх. Без подложки — классический непрозрачный фон + растр fallback.
    const tilesActiveNow = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    if (tilesActiveNow) {
      ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
    } else {
      ctx.fillStyle = '#0f1729';
      ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
    }

    if (!project.map || (!mapImageRef.current && !tilesActiveNow)) {
      // Fallback-состояние без тайловой подложки и без растра: вместо «синего
      // прямоугольника» — информативная заглушка с реальными кнопками действий.
      // (Раньше этот блок был закомментирован как недоделанный placeholder.)
      ctx.fillStyle = '#1a2744';
      ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
      // Декоративная сетка, чтобы экран не выглядел «мёртвым»
      ctx.strokeStyle = 'rgba(90, 130, 190, 0.15)';
      ctx.lineWidth = 1;
      const gs = 48;
      for (let gx = 0; gx < canvasSize.width; gx += gs) { ctx.beginPath(); ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, canvasSize.height); ctx.stroke(); }
      for (let gy = 0; gy < canvasSize.height; gy += gs) { ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(canvasSize.width, gy + 0.5); ctx.stroke(); }
      const cx0 = canvasSize.width / 2;
      const cy0 = canvasSize.height / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#dbe7ff';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('Карта ещё не загружена', cx0, cy0 - 46);
      ctx.fillStyle = '#8fa8cc';
      ctx.font = '14px sans-serif';
      ctx.fillText('Загрузите растровую карту (PNG/JPG/WebP/BMP)', cx0, cy0 - 22);
      ctx.fillText('или включите активную тайловую карту OSM вокруг текущей позиции.', cx0, cy0 - 2);
      // Кнопка 1: быстрая активная карта (центр по умолчанию, z12)
      const btnW = 250, btnH = 38, gap = 12;
      const b1x = cx0 - btnW - gap / 2, b1y = cy0 + 22;
      const b2x = cx0 + gap / 2, b2y = cy0 + 22;
      fallbackButtonsRef.current = [
        { id: 'tile', rect: { x: b1x, y: b1y, w: btnW, h: btnH } },
        { id: 'upload', rect: { x: b2x, y: b2y, w: btnW, h: btnH } },
      ];
      for (const [i, label] of [[0, '🌍 Активная карта (OSM)'], [1, '🗺️ Загрузить файл…']] as const) {
        const r = i === 0 ? { x: b1x, y: b1y } : { x: b2x, y: b2y };
        ctx.fillStyle = i === 0 ? '#0b6fb8' : '#2c4a73';
        ctx.beginPath();
        const rad = 8;
        ctx.roundRect(r.x, r.y, btnW, btnH, rad);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(label, r.x + btnW / 2, r.y + btnH / 2 + 5);
      }
      // Баг «плохо работает установка бесполётных зон (не видно установленных
      // точек)»: раньше этот блок завершал рендер ранним return — live-preview
      // рисования полигона (вершины и границы) был полностью невидим до
      // загрузки карты. Рисуем текущее начертание ЗДЕСЬ, поверх заглушки.
      if (drawingPoints.length > 0) drawCurrentDrawing(ctx);
      return;
    }
    fallbackButtonsRef.current = [];

    // Draw map: подложка OSM — DOM-слой (см. syncTileDom), canvas прозрачен и
    // рисует поверх неё ТОЛЬКО объекты. Растровая карта (Google/Yandex/local) —
    // рисуется на canvas, когда тайловая подложка выключена.
    if (!tilesActiveNow && mapImageRef.current) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);
      // Чёткость при увеличении: при сильном зуме — резкая (пиксельная) интерполяция,
      // при уменьшении — сглаженная. Canvas физически рендерится в dpr-разрешении.
      ctx.imageSmoothingEnabled = vs.scale < 1;
      if (ctx.imageSmoothingEnabled) (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(mapImageRef.current, 0, 0, project.map!.width, project.map!.height);
      ctx.restore();
    }

    // Draw restrictions
    drawRestrictions(ctx);

    // ─── Пользовательские тактические карты (Задача 2, п.3) ────────────────
    // Растровые слои (GeoTIFF/PNG/JPEG/KMZ-изображения) накладываются поверх
    // подложки по ТОЙ ЖЕ математике Web Mercator, что и DOM-слой тайлов OSM
    // (worldPx = canvasHeight·2^zoom) — жёсткая привязка при любом зуме/панораме.
    // Векторы (KML/GeoJSON полигоны) — тем же аффинным geo→screen преобразованием.
    {
      const tacticalLayers = project.tacticalOverlays || [];
      if (tacticalLayers.length > 0) {
        const stT = useStore.getState() as unknown as { getTacticalOverlayPayload?: (id: string) => string | null };
        const wpT = worldPxOf(canvasSize.height, vs.scale, vs.z0 ?? ZOOM_REF);
        for (const tl of tacticalLayers) {
          if (!tl.visible) continue;
          if (tl.format === 'kml' || tl.format === 'geojson') {
            if (project.map?.bounds && project.map.width > 0 && project.map.height > 0) {
              drawTacticalVectorLayer(ctx, tl, makeRasterToScreen(vs, project.map.bounds, project.map.width, project.map.height));
            } else if (tl.vectors?.length) {
              // Тайловая подложка без растра: mercator-прямая привязка к миру
              const toScr = (lat: number, lng: number) => ({
                x: vs.offsetX + ((lng + 180) / 360) * wpT,
                y: vs.offsetY + ((latToMerc(85.0511287798066) - latToMerc(lat)) / (latToMerc(85.0511287798066) - latToMerc(-85.0511287798066))) * wpT,
              });
              drawTacticalVectorLayer(ctx, tl, toScr);
            }
          }
          if (tl.format === 'geotiff' || tl.format === 'image' || tl.format === 'kmz' || tl.format === 'mbtiles') {
            const img = getCachedOverlayRaster(tl.id);
            if (img) {
              drawTacticalRasterLayer(ctx, tl, img, vs, wpT, canvasSize.width, canvasSize.height);
            } else if (!overlayDecodeInflightRef.current.has(tl.id)) {
              overlayDecodeInflightRef.current.add(tl.id);
              const payload = typeof stT.getTacticalOverlayPayload === 'function' ? stT.getTacticalOverlayPayload(tl.id) : null;
              ensureOverlayRaster(tl.id, payload)
                .then((decoded) => { if (decoded) setRenderTick((t) => t + 1); })
                .finally(() => overlayDecodeInflightRef.current.delete(tl.id));
            }
          }
        }
      }
    }

    // Draw pending NFZ polygon drafts (вершины/контур на главной карте)
    drawPendingZones(ctx);

    // Draw markers
    drawMarkers(ctx);

    // Draw measurement
    drawMeasurement(ctx);

    // Draw current drawing
    drawCurrentDrawing(ctx);

    // Draw routes (маршруты миссии: редактирование, автообход зон, предупреждения)
    drawRoutes(ctx);

    // Draw map border: у активной тайловой карты «виртуальный растр» покрывает
    // всю mercator-площадку — рамка границы не нужна (подложка бесконечна, как на osm.org)
    if (!(!!project.settings?.tilesEnabled && !!project.map?.bounds)) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
      ctx.lineWidth = 2 / vs.scale;
      ctx.strokeRect(0, 0, project.map.width, project.map.height);
      ctx.restore();
    }

    // Сетка поверх карты (чтобы линии и подписи НЕ тонули в подложке тайлов)
    if (project.settings?.showGrid) {
      drawGrid(ctx);
    }

    // Позиция пользователя (геолокация) — гео-привязка строгая
    drawUserPosition(ctx);

    // Масштабная линейка + плашка масштаба — всегда поверх всего
    drawScaleOverlay(ctx);

    function drawUserPosition(g: CanvasRenderingContext2D) {
      const map = project.map;
      if (!map?.bounds) return;
      const b = map.bounds;
      // гео -> пиксель карты -> экранные px (та же Mercator-привязка, что и у всех объектов)
      const toScreen = (lat: number, lng: number) => {
        const mx = ((lng - b.west) / (b.east - b.west)) * map.width;
        const my = ((latToMerc(b.north) - latToMerc(lat)) / (latToMerc(b.south) - latToMerc(b.north))) * map.height;
        return { x: mx * vs.scale + vs.offsetX, y: my * vs.scale + vs.offsetY };
      };
      g.save();
      // позиция пользователя (геолокация)
      if (userPos) {
        const p = toScreen(userPos.lat, userPos.lng);
        const mppLoc = metersPerPixelFromWorld(worldPx, userPos.lat);
        const accPx = Math.min(400, userPos.acc / Math.max(mppLoc, 1e-6));
        g.beginPath(); g.arc(p.x, p.y, accPx, 0, Math.PI * 2);
        g.fillStyle = 'rgba(59,130,246,0.15)'; g.fill();
        g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2);
        g.fillStyle = '#3b82f6'; g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
        g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillStyle = '#93c5fd';
        g.fillText(`Вы здесь ±${Math.round(userPos.acc)} м`, p.x, p.y - 12);
      }
      g.restore();
    }

    function drawGrid(ctx: CanvasRenderingContext2D) {
      // ГЕОГРАФИЧЕСКАЯ адаптивная сетка: шаг в реальных метрах подбирается
      // под текущий масштаб (1/2/5 × 10^n), линии строго привязаны к координатам,
      // подписи всегда рисуются поверх карты фиксированным размером (не тонут в тайлах).
      if (!project.map) return;
      const map = project.map;
      const s = vs.scale;
      const bounds = map.bounds;

      // Шаг сетки: пользовательский gridSize по умолчанию, иначе авто-подбор
      let stepM = project.settings?.gridSize && project.settings.gridSize > 0 ? project.settings.gridSize : 0;
      if (!stepM) {
        const mppX = metersPerPixelFromWorld(worldPx, centerLatOf(bounds ?? { north: 0, south: 0 }));
        const targetPx = 90; // желаемый шаг ~90 экранных px
        const raw = targetPx * mppX;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const mults = [1, 2, 5, 10];
        stepM = mults.map((m) => m * pow).find((v) => v >= raw) || 10 * pow;
      }

      // Метров на пиксель КАРТЫ по долготе (через точную Mercator-привязку bounds)
      let mppMap: number | null = null;
      if (bounds && bounds.north !== bounds.south && map.width > 0 && map.height > 0) {
        const lngSpan = Math.abs((map.width / map.height) * (bounds.north - bounds.south));
        mppMap = (lngSpan / 360) * 40075016.686 * Math.cos(0) / map.width; // на экваторе
      }

      ctx.save();

      if (mppMap != null && bounds) {
        // --- Гео-привязанная сетка: узлы в реальных метрах от левого верхнего угла bounds ---
        const stepPxX = stepM / mppMap;                       // шаг по X в пикселях карты (экваториальный эталон)
        const latTop = bounds.north;
        const cosTop = Math.max(0.05, Math.cos((latTop * Math.PI) / 180));
        // Видимая область в пикселях карты:
        const vx0 = (0 - vs.offsetX) / s;
        const vy0 = (0 - vs.offsetY) / s;
        const vx1 = (canvasSize.width - vs.offsetX) / s;
        const vy1 = (canvasSize.height - vs.offsetY) / s;

        ctx.lineWidth = 1 / s;
        ctx.strokeStyle = 'rgba(140, 190, 255, 0.35)';

        // Вертикальные линии (постоянный шаг по долготе)
        const startXi = Math.floor(vx0 / stepPxX);
        const endXi = Math.ceil(vx1 / stepPxX);
        for (let i = startXi; i <= endXi; i++) {
          const x = i * stepPxX;
          if (x < 0 || x > map.width) continue;
          ctx.beginPath();
          ctx.moveTo(x, Math.max(0, vy0));
          ctx.lineTo(x, Math.min(map.height, vy1));
          ctx.stroke();
        }

        // Горизонтальные линии: шаг по широте = stepM / (mppMap * cos²(lat)) — корректный Mercator.
        // Идём сверху вниз с переменной плотностью.
        const topMercY = latToMerc(bounds.north);
        const botMercY = latToMerc(bounds.south);
        const mercPerMapPx = (botMercY - topMercY) / map.height;
        let my = Math.max(0, vy0);
        const bottomY = Math.min(map.height, vy1);
        const yLines: number[] = [];
        // Интегрируем метрическую сетку от северной границы до нижней видимой
        // точки; цикл имеет три гарантии завершения: прирост my, лимит высоты
        // и жёсткий лимит числа линий (защита от вырожденных масштабов).
        while (my <= bottomY && yLines.length <= 500) {
          const latAtY = mercToLat(topMercY + my * mercPerMapPx);
          const cosLat = Math.max(0.05, Math.cos((latAtY * Math.PI) / 180));
          const dMerc = (stepM / (mppMap * cosLat * cosLat)) * mercPerMapPx; // Mercator Δ на один шаг
          if (!(dMerc > 0)) break; // защита от NaN/0 шага
          my += dMerc;
          if (my > bottomY) break;
          yLines.push(my);
        }
        void cosTop;
        ctx.beginPath();
        for (const y of yLines) {
          ctx.moveTo(Math.max(0, vx0), y);
          ctx.lineTo(Math.min(map.width, vx1), y);
        }
        ctx.stroke();

        // Подписи шага (фиксированный размер на экране, поверх карты)
        const fs = 11;
        ctx.font = `${fs}px monospace`;
        ctx.textAlign = 'left';
        const label = stepM >= 1000 ? `${stepM / 1000} км` : `${stepM} м`;
        for (let i = Math.max(0, startXi); i <= Math.min(endXi, Math.ceil(map.width / stepPxX)); i++) {
          const sx = i * stepPxX * s + vs.offsetX;
          if (sx < 0 || sx > canvasSize.width) continue;
          if ((i - Math.max(0, startXi)) % 2 !== 0) continue; // реже подписи при густой сетке
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(sx + 2, 2, fs * 3.4, fs + 4);
          ctx.fillStyle = 'rgba(190, 220, 255, 0.9)';
          ctx.fillText(`${i * stepM >= 1000 ? ((i * stepM) / 1000).toFixed(i * stepM % 1000 ? 1 : 0) + 'км' : i * stepM + 'м'}`, sx + 4, 2 + fs);
        }
        let li = 1;
        for (const y of yLines) {
          const sy = y * s + vs.offsetY;
          if (sy < 14 || sy > canvasSize.height - 4) { li++; continue; }
          if (li % 2 === 0) { li++; continue; }
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(2, sy - fs - 2, fs * 3.4, fs + 4);
          ctx.fillStyle = 'rgba(190, 220, 255, 0.9)';
          const mtr = li * stepM;
          ctx.fillText(`${mtr >= 1000 ? (mtr / 1000).toFixed(mtr % 1000 ? 1 : 0) + 'км' : mtr + 'м'}`, 4, sy - 4);
          li++;
        }
        void label;
      } else {
        // --- Нет гео-привязки: классическая пиксельная сетка ---
        const gridSize = project.settings?.gridSize || 100;
        ctx.translate(vs.offsetX, vs.offsetY);
        ctx.scale(s, s);
        ctx.strokeStyle = 'rgba(140, 190, 255, 0.3)';
        ctx.lineWidth = 1 / s;
        ctx.beginPath();
        for (let x = 0; x <= map.width; x += gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, map.height); }
        for (let y = 0; y <= map.height; y += gridSize) { ctx.moveTo(0, y); ctx.lineTo(map.width, y); }
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(190, 220, 255, 0.8)';
        for (let x = 0; x <= map.width; x += gridSize * 2) {
          const sx = x * s + vs.offsetX;
          if (sx < 0 || sx > canvasSize.width) continue;
          ctx.fillText(`${x}`, sx + 2, 12);
        }
        for (let y = gridSize; y <= map.height; y += gridSize * 2) {
          const sy = y * s + vs.offsetY;
          if (sy < 14 || sy > canvasSize.height) continue;
          ctx.fillText(`${y}`, 2, sy - 3);
        }
      }
      ctx.restore();
    }

    function drawScaleOverlay(g: CanvasRenderingContext2D) {
      const map = project.map;
      if (!map?.bounds) return;
      const mpp = metersPerPixelFromWorld(worldPx, centerLatRef);
      // Отрезок в 2 см по экрану (96 css px = 2.54 см → 2 см ≈ 75.6 px)
      const rulerPx = 75.6;
      const metersFor2cm = mpp * rulerPx;
      const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
      const chosen = nice.find((n) => n >= metersFor2cm) || Math.round(metersFor2cm);
      const linePx = Math.min(chosen / mpp, canvasSize.width * 0.4);
      const rx = canvasSize.width - linePx - 24;
      const ry = canvasSize.height - 22;
      g.save();
      g.strokeStyle = '#e2e8f0';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(rx, ry); g.lineTo(rx + linePx, ry);
      g.moveTo(rx, ry - 5); g.lineTo(rx, ry + 5);
      g.moveTo(rx + linePx, ry - 5); g.lineTo(rx + linePx, ry + 5);
      g.stroke();
      g.font = 'bold 11px sans-serif';
      g.textAlign = 'center';
      const txt = chosen >= 1000 ? `${chosen / 1000} км` : `${chosen} м`;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(rx + linePx / 2 - 26, ry - 20, 52, 14);
      g.fillStyle = '#e2e8f0';
      g.fillText(txt, rx + linePx / 2, ry - 9);
      g.textAlign = 'right';
      g.fillStyle = 'rgba(148,197,255,0.95)';
      g.fillRect(canvasSize.width - 210, ry - 40, 202, 16);
      g.fillStyle = '#0c1a2e';
      g.font = 'bold 11px sans-serif';
      g.fillText(`${scaleLabel(mpp)} · ${rulerScaleText(mpp)}`, canvasSize.width - 12, ry - 28);
      g.restore();
    }

    function drawRestrictions(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      for (const restriction of project.restrictions) {
        // ВСЕ поставленные зоны — полные ограничения (флаг active устарел):
        // раньше неактивные рисовались серыми и не участвовали в обходе, из-за
        // чего «при утверждении маршрута ограничения пропадали».
        const isActive = true;
        ctx.fillStyle = 'rgba(255, 50, 50, 0.12)';
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
        ctx.lineWidth = 2 / vs.scale;

        if (restriction.type === 'polygon') {
          if (restriction.points.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(restriction.points[0].x, restriction.points[0].y);
            for (let i = 1; i < restriction.points.length; i++) {
              ctx.lineTo(restriction.points[i].x, restriction.points[i].y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw vertices
            for (const p of restriction.points) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, 4 / vs.scale, 0, Math.PI * 2);
              ctx.fillStyle = isActive ? 'rgba(255, 100, 100, 0.8)' : 'rgba(150, 150, 150, 0.6)';
              ctx.fill();
            }
          }
        } else if (restriction.type === 'rectangle') {
          if (restriction.points.length >= 2) {
            const minX = Math.min(restriction.points[0].x, restriction.points[1].x);
            const maxX = Math.max(restriction.points[0].x, restriction.points[1].x);
            const minY = Math.min(restriction.points[0].y, restriction.points[1].y);
            const maxY = Math.max(restriction.points[0].y, restriction.points[1].y);
            ctx.beginPath();
            ctx.rect(minX, minY, maxX - minX, maxY - minY);
            ctx.fill();
            ctx.stroke();
          }
        } else if (restriction.type === 'circle' && restriction.points.length >= 1) {
          const center = restriction.points[0];
          const radius = restriction.radius || 0;
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Draw center
          ctx.beginPath();
          ctx.arc(center.x, center.y, 4 / vs.scale, 0, Math.PI * 2);
          ctx.fillStyle = isActive ? 'rgba(255, 100, 100, 0.8)' : 'rgba(150, 150, 150, 0.6)';
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Черновики NFZ-полигонов (ставятся кликами, замыкаются двойным кликом):
    // рисуем на ГЛАВНОЙ карте — раньше вершины были видны только в мини-панели,
    // из-за чего «не видно установленных точек» при рисовании зон.
    function drawPendingZones(ctx: CanvasRenderingContext2D) {
      const pend = pendingZonesRef.current;
      if (pend.length === 0 || !project.map?.bounds || project.map.width <= 0 || project.map.height <= 0) return;
      const bounds = project.map.bounds;
      const w = project.map.width;
      const h = project.map.height;
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);
      for (const pz of pend) {
        if (pz.pts.length === 0) continue;
        const pxPts = pz.pts.map((g) => geoToPixelExact(g.lat, g.lng, bounds, w, h));
        if (pxPts.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(pxPts[0].x, pxPts[0].y);
          for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i].x, pxPts[i].y);
          ctx.closePath();
          ctx.fillStyle = 'rgba(251, 146, 60, 0.18)';
          ctx.fill();
        }
        if (pxPts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(pxPts[0].x, pxPts[0].y);
          for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i].x, pxPts[i].y);
          ctx.strokeStyle = '#fb923c';
          ctx.lineWidth = 2 / vs.scale;
          ctx.setLineDash([6 / vs.scale, 4 / vs.scale]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Вершины: белые точки с оранжевой обводкой + нумерация
        ctx.font = `${11 / vs.scale}px sans-serif`;
        pxPts.forEach((p, i) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5 / vs.scale, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.lineWidth = 2 / vs.scale;
          ctx.strokeStyle = '#fb923c';
          ctx.stroke();
          ctx.fillStyle = '#ea580c';
          ctx.fillText(String(i + 1), p.x + 7 / vs.scale, p.y - 5 / vs.scale);
        });
      }
      ctx.restore();
    }

    function drawMarkers(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      for (const marker of project.markers) {
        const layer = project.layers.find(l => l.id === marker.layer);
        if (layer && !layer.visible) continue;

        // П.5: раньше использовался isPointInActiveRestriction с инвертированной
        // семантикой (true = точка ВНЕ зон) — маркеры краснели как раз тогда,
        // когда были в безопасности. Теперь честно: красный = внутри зоны.
        const insideRestriction = isPointInsideAnyRestriction(
          { x: marker.x, y: marker.y },
          project.restrictions
        );

        const isSelected = marker.id === selectedMarkerId;
        // Drag-обратная связь: захваченный маркер — увеличенная «тень-подсветка»,
        // прозрачность и явная белая обводка (пользователь видит, что элемент схвачен).
        const isDragging = draggingMarkerRef.current === marker.id;
        const radius = (isSelected || isDragging ? 12 : 8) / vs.scale;

        if (isDragging) {
          ctx.beginPath();
          ctx.arc(marker.x, marker.y, radius * 1.9, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0, 208, 255, 0.28)';
          ctx.fill();
          ctx.setLineDash([4 / vs.scale, 3 / vs.scale]);
          ctx.strokeStyle = 'rgba(0, 208, 255, 0.9)';
          ctx.lineWidth = 2 / vs.scale;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Shadow
        ctx.beginPath();
        ctx.arc(marker.x + 1 / vs.scale, marker.y + 1 / vs.scale, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // Draw marker
        ctx.globalAlpha = isDragging ? 0.75 : 1;
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = !insideRestriction ? marker.color : '#ff3333';
        ctx.fill();
        ctx.strokeStyle = isDragging ? '#00d0ff' : isSelected ? '#ffffff' : 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (isDragging || isSelected ? 3 : 1.5) / vs.scale;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Inner dot
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, radius * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fill();

        // Draw label
        const fontSize = Math.max(10, 12 / vs.scale);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'left';

        // Label background
        const labelX = marker.x + radius + 5 / vs.scale;
        const labelY = marker.y + 4 / vs.scale;
        const textWidth = ctx.measureText(marker.name).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(labelX - 2 / vs.scale, labelY - fontSize, textWidth + 4 / vs.scale, fontSize + 4 / vs.scale);
        ctx.fillStyle = !insideRestriction ? "#ffffff" : "#ff6666";
        ctx.fillText(marker.name, labelX, labelY);
      }
      ctx.restore();
    }

    function drawMeasurement(ctx: CanvasRenderingContext2D) {
      if (measurementPoints.length < 1) return;
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      if (measurementPoints.length >= 2) {
        ctx.strokeStyle = '#ffdd00';
        ctx.lineWidth = 2 / vs.scale;
        ctx.setLineDash([6 / vs.scale, 4 / vs.scale]);

        ctx.beginPath();
        ctx.moveTo(measurementPoints[0].x, measurementPoints[0].y);
        for (let i = 1; i < measurementPoints.length; i++) {
          ctx.lineTo(measurementPoints[i].x, measurementPoints[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw points and distances
      for (let i = 0; i < measurementPoints.length; i++) {
        const p = measurementPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / vs.scale, 0, Math.PI * 2);
        ctx.fillStyle = '#ffdd00';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / vs.scale;
        ctx.stroke();

        if (i > 0) {
          const dist = distanceBetween(measurementPoints[i - 1], p);
          const midX = (measurementPoints[i - 1].x + p.x) / 2;
          const midY = (measurementPoints[i - 1].y + p.y) / 2;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          let label: string;
          if (project.map?.bounds) {
            // Географически привязанная карта — расстояние в метрах (WGS-84)
            const gA = pixelToGeoFromBounds(measurementPoints[i - 1], project.map.bounds, project.map.width, project.map.height);
            const gB = pixelToGeoFromBounds(p, project.map.bounds, project.map.width, project.map.height);
            const m = haversineDistanceM(gA, gB);
            label = m >= 1000 ? `${(m / 1000).toFixed(2)} км` : `${Math.round(m)} м`;
          } else {
            label = `${Math.round(dist)} px`;
          }
          const tw = ctx.measureText(label).width;
          ctx.fillRect(midX - tw / 2 - 3 / vs.scale, midY - 18 / vs.scale, tw + 6 / vs.scale, 14 / vs.scale);
          ctx.fillStyle = '#ffdd00';
          ctx.font = `bold ${11 / vs.scale}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(label, midX, midY - 7 / vs.scale);
        }
      }
      ctx.restore();
    }

    function drawCurrentDrawing(ctx: CanvasRenderingContext2D) {
      if (drawingPoints.length === 0) return;
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      ctx.strokeStyle = '#00ddff';
      ctx.lineWidth = 2 / vs.scale;
      ctx.setLineDash([5 / vs.scale, 3 / vs.scale]);

      if (drawingPoints.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
        for (let i = 1; i < drawingPoints.length; i++) {
          ctx.lineTo(drawingPoints[i].x, drawingPoints[i].y);
        }
        if (currentTool === 'drawPolygon') {
          ctx.closePath();
        }
        ctx.stroke();
      }

      ctx.setLineDash([]);

      // Rubber-band preview: пунктирная линия от последней вершины к курсору
      const cur = cursorPosRef.current ?? cursorPosition;
      if (cur && drawingPoints.length > 0) {
        const lastP = drawingPoints[drawingPoints.length - 1];
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 221, 255, 0.55)';
        ctx.lineWidth = 1.5 / vs.scale;
        ctx.setLineDash([4 / vs.scale, 4 / vs.scale]);
        ctx.beginPath();
        ctx.moveTo(lastP.x, lastP.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.restore();
      }

      // Draw vertices (с порядковыми номерами 1, 2, 3...)
      for (let i = 0; i < drawingPoints.length; i++) {
        const p = drawingPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / vs.scale, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#00ff88' : '#00ddff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / vs.scale;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${11 / vs.scale}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(String(i + 1), p.x + 7 / vs.scale, p.y - 7 / vs.scale);
      }

      // Instructions
      if (currentTool === 'drawPolygon') {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.9)';
        ctx.font = `${12 / vs.scale}px sans-serif`;
        ctx.textAlign = 'left';
        const lastP = cur ?? drawingPoints[drawingPoints.length - 1];
        ctx.fillText('Клик — добавить вершину, двойной клик или Enter — завершить, Esc — отмена, Ctrl+Z — убрать точку', lastP.x + 10 / vs.scale, lastP.y - 10 / vs.scale);
      }

      ctx.restore();
    }

    // ─── Маршруты миссии (три окна карты) ────────────────────────────────────
    // Все точки маршрутов хранятся в WGS-84; пиксельные координаты (x, y)
    // пересчитаны из bounds при загрузке — привязка строго географическая.
    function drawRoutes(ctx: CanvasRenderingContext2D) {
      const routes = project.routes || [];
      if (routes.length === 0) return;

      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);
      const s = vs.scale;

      for (let ri = 0; ri < routes.length; ri++) {
        const route = routes[ri];
        if (!route.visible || route.points.length < 2) continue;

        const color = route.color || ROUTE_PALETTE[ri % ROUTE_PALETTE.length];
        const isActive = route.id === activeRouteId;

        // Предупреждения о пересечении зон ограничений.
        // П.7: НЕ вызываем analyzeRoute на каждый кадр — он пересчитывает
        // haversine-длины всех сегментов (O(N)) только ради crossedZones.
        // Активные зоны берутся из кэша (инвалидируется при изменении зон),
        // проверка отрезок↔зона выполняется сразу на пиксельных точках.
        let crossed: { name: string }[] = [];
        try {
          const activeZonesForDraw = getActiveZonesCached(project.restrictions);
          if (activeZonesForDraw.length > 0) {
            crossed = zonesCrossedBy(
              route.points.map((p) => ({ x: p.x, y: p.y })),
              activeZonesForDraw
            );
          }
        } catch { /* зоны могут быть невалидными — не роняем отрисовку */ }

        // Ограничение по дальности (max/min) — нарушение помечаем красным
        let rangeViolation = false;
        if (route.rangeMode && route.rangeMode !== 'off' && route.rangeM && route.rangeM > 0) {
          const len = routeLengthM(route.points.map((p) => ({ lat: p.lat, lng: p.lng })));
          rangeViolation = route.rangeMode === 'max' ? len > route.rangeM : len < route.rangeM;
        }

        // Линии сегментов: авто-обходные сегменты — пунктир, ключевые — сплошные.
        // shape==='curve': рисуем сглаженную кривую Catmull-Rom через все точки
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (route.shape === 'curve') {
          ctx.strokeStyle = rangeViolation ? '#ff4d4d' : color;
          ctx.lineWidth = (isActive ? 3.5 : 2.2) / s;
          ctx.setLineDash([]);
          ctx.beginPath();
          const cp = route.points;
          ctx.moveTo(cp[0].x, cp[0].y);
          for (let i = 0; i < cp.length - 1; i++) {
            const p0 = cp[Math.max(0, i - 1)];
            const p1 = cp[i];
            const p2 = cp[i + 1];
            const p3 = cp[Math.min(cp.length - 1, i + 2)];
            const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
            const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
            ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
          }
          ctx.stroke();
        } else {
          for (let i = 0; i < route.points.length - 1; i++) {
            const a = route.points[i];
            const b = route.points[i + 1];
            ctx.strokeStyle = rangeViolation ? '#ff4d4d' : color;
            ctx.lineWidth = (isActive ? 3.5 : 2.2) / s;
            if (a.auto || b.auto) ctx.setLineDash([8 / s, 5 / s]);
            else ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }

        // Точки маршрута: ключевые (ставит пользователь) — цветные и чуть
        // крупнее; авто-обходные (результат обхода ограничений) — мелкие
        // полупрозрачные, их видно как «цепочку» вокруг зон.
        const drawR = (isActive ? 5 : 3.5) / s;
        for (let i = 0; i < route.points.length; i++) {
          const p = route.points[i];
          const rPt = p.auto ? drawR * 0.55 : drawR;
          // Drag-обратная связь: захваченная точка маршрута — пульсирующая
          // cyan-подсветка + увеличенный радиус, видно что элемент «схвачен».
          const drag = draggingRouteRef.current;
          const isDragPt = isActive && !!drag && drag.routeId === route.id && drag.index === i;
          if (isDragPt) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, rPt * 2.4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 208, 255, 0.30)';
            ctx.fill();
            ctx.setLineDash([4 / s, 3 / s]);
            ctx.strokeStyle = 'rgba(0, 208, 255, 0.95)';
            ctx.lineWidth = 2 / s;
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, isDragPt ? rPt * 1.6 : rPt, 0, Math.PI * 2);
          ctx.fillStyle = p.auto ? 'rgba(255,255,255,0.45)' : color;
          ctx.fill();
          ctx.lineWidth = (isDragPt ? 2.2 : 1.2) / s;
          ctx.strokeStyle = isDragPt ? '#00d0ff' : 'rgba(0,0,0,0.6)';
          ctx.stroke();
          // Подписи высот (Open-Elevation): у активного маршрута — рельеф/ABS;
          // ручной AGL на этапе помечается стрелкой ↑
          if (isActive && typeof p.altitudeAbs === 'number') {
            const fsA = Math.max(8, 9 / s);
            ctx.font = `${fsA}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            const manualTag = typeof p.altitudeAGL === 'number' ? ` ↑${Math.round(p.altitudeAGL)}` : '';
            const tTxt = p.terrainM != null
              ? `${Math.round(p.altitudeAbs)} м (з ${Math.round(p.terrainM)})${manualTag}`
              : `${Math.round(p.altitudeAbs)} м${manualTag}`;
            const twA = ctx.measureText(tTxt).width;
            ctx.fillRect(p.x - twA / 2 - 2 / s, p.y + drawR + 1 / s, twA + 4 / s, fsA + 3 / s);
            ctx.fillStyle = '#7dd3fc';
            ctx.fillText(tTxt, p.x, p.y + drawR + 1 / s + fsA + 1 / s);
            ctx.textAlign = 'left';
          }
        }

        // Стрелка направления на финише
        const last = route.points[route.points.length - 1];
        const prev = route.points[route.points.length - 2];
        const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
        const ah = 12 / s;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x - ah * Math.cos(ang - 0.4), last.y - ah * Math.sin(ang - 0.4));
        ctx.lineTo(last.x - ah * Math.cos(ang + 0.4), last.y - ah * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();

        // Подписи показываем только для активного маршрута или при малом числе маршрутов
        if (isActive || routes.length <= 20) {
          const fs = Math.max(10, 12 / s);
          const first = route.points[0];
          ctx.font = `bold ${fs}px sans-serif`;
          ctx.textAlign = 'left';
          const label = `${route.name}${isActive ? ' ●' : ''}`;
          const tw = ctx.measureText(label).width;
          const lx = first.x + 8 / s;
          const ly = first.y - 8 / s;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(lx - 3 / s, ly - fs, tw + 6 / s, fs + 5 / s);
          ctx.fillStyle = color;
          ctx.fillText(label, lx, ly);
        }

        // Предупреждение о зонах ограничений прямо на карте (для активного маршрута)
        if (isActive && crossed.length > 0) {
          const mid = route.points[Math.floor(route.points.length / 2)];
          const fs = Math.max(11, 13 / s);
          const warn = `⚠ Пересекает: ${crossed.map((z) => z.name).join(', ')}`;
          ctx.font = `bold ${fs}px sans-serif`;
          const tw = ctx.measureText(warn).width;
          ctx.fillStyle = 'rgba(120,20,20,0.85)';
          ctx.fillRect(mid.x - tw / 2 - 5 / s, mid.y - fs - 5 / s, tw + 10 / s, fs + 9 / s);
          ctx.fillStyle = '#ffd166';
          ctx.textAlign = 'center';
          ctx.fillText(warn, mid.x, mid.y - 2 / s);
          ctx.textAlign = 'left';
        }

        // Отметка нарушения ограничения по дальности (красный маркер у финиша)
        if (rangeViolation) {
          const len = routeLengthM(route.points.map((p) => ({ lat: p.lat, lng: p.lng })));
          const txt = `${route.rangeMode === 'max' ? '>' : '<'} лимита: ${Math.round(len)} м / ${Math.round(route.rangeM || 0)} м`;
          const fs = Math.max(10, 12 / s);
          ctx.font = `bold ${fs}px sans-serif`;
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = 'rgba(150,20,20,0.9)';
          ctx.fillRect(last.x + 8 / s, last.y + 4 / s, tw + 8 / s, fs + 6 / s);
          ctx.fillStyle = '#ffb3b3';
          ctx.fillText(txt, last.x + 12 / s, last.y + 4 / s + fs + 1 / s);
        }
      }

      ctx.restore();
    }

  }, [project, renderTick, canvasSize, selectedMarkerId, activeRouteId, drawingPoints, measurementPoints, mapLoaded, currentTool, dpr, tilesVersion, userPos, draggingMarker, draggingRoute]);

  // Mouse wheel zoom (к колесу курсора; границы minZoom/maxZoom внутри zoomAt)
  // ВАЖНО: React навешивает on-wheel/on-touch как passive-слушатели, и вызов
  // e.preventDefault() внутри них игнорируется браузером с предупреждением
  // "Unable to preventDefault inside passive event listener invocation".
  // Поэтому обработчик вызывает preventDefault, но реально он навешивается ниже
  // через addEventListener(..., { passive: false }) на самом canvas-элементе.
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Плавный зум: шаг зависит от величины прокрутки (у тачпада deltaY маленький),
    // ограничен — чтобы одно движение не «сбрасывало» масштаб в разы.
    const delta = Math.max(-120, Math.min(120, e.deltaY || 0));
    const factor = Math.pow(2, -delta / 60); // ≈ ×2 на один щелчок мыши, плавно для тачпада
    zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  // Touch: одноfinger панорама, pinch — зум к центру щипка
  const touchState = useRef<{ mode: 'pan' | 'pinch'; x: number; y: number; dist: number } | null>(null);
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 1) {
      touchState.current = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0 };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState.current = { mode: 'pinch', x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, dist: Math.hypot(dx, dy) };
    }
  }, []);
  const handleTouchMove = useCallback((e: TouchEvent) => {
    const st = touchState.current;
    if (!st) return;
    e.preventDefault();
    if (st.mode === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - st.x;
      const dy = e.touches[0].clientY - st.y;
      const vcur = viewRef.current ?? NEUTRAL_VIEW; // актуальный вид из ref — колбэк не зависит от state
      setViewState({ offsetX: vcur.offsetX + dx, offsetY: vcur.offsetY + dy });
      touchState.current = { ...st, x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (st.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (dist > 8 && st.dist > 8) {
        const rect = canvasRef.current?.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect?.left || 0);
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect?.top || 0);
        zoomAt(dist / st.dist, cx, cy);
        touchState.current = { ...st, dist };
      }
    }
  }, [setViewState, zoomAt]);
  const handleTouchEnd = useCallback(() => { touchState.current = null; }, []);

  // Навешиваем wheel/touch НЕчерез JSX (React делает их passive и preventDefault
  // молча игнорируется), а через addEventListener с { passive: false }.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Mouse down
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Режим выбора точки старт/цель: основной канвас не редактируется — клик
    // перехватывается capture-обработчиком (см. pickWhat выше); остальное глушим.
    if (pickWhatRef.current !== 'none') return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // Fallback-экран «нет карты»: кликабельные кнопки действий (hit-зоны
    // регистрируются в render-эффекте). Условие совпадает с рендером заглушки:
    // нет растра И тайловая подложка не активна.
    const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    if (!project.map && !tilesActive) {
      const hit = fallbackButtonsRef.current.find(
        (b) => screenX >= b.rect.x && screenX <= b.rect.x + b.rect.w &&
              screenY >= b.rect.y && screenY <= b.rect.y + b.rect.h,
      );
      if (hit) {
        if (hit.id === 'tile') loadActiveTileHere();
        else fallbackFileInputRef.current?.click();
      }
      // Фикс «не видно установленных точек зоны»: рисование полигона доступно
      // и без карты — вершины хранятся в Экранных координатах проекта
      // (виртуальный растр). Клик по кнопке не добавляет вершину.
      if (!hit && currentTool === 'drawPolygon' && e.button === 0) {
        addDrawingPoint(screenToMap(screenX, screenY));
        setDrawing(true);
      }
      return;
    }

    const mapPoint = screenToMap(screenX, screenY);

    if (currentTool === 'pan' || e.button === 1 || (e.button === 0 && e.shiftKey)) {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (currentTool === 'select') {
      // 1) Прицел к точкам маршрутов активного режима редактирования:
      //    клик рядом с точкой — «цепляем» её и тянем (drag), двойной клик — удаляем.
      const routes = project.routes || [];
      const activeRoute = routes.find((r) => r.id === activeRouteId && r.visible);
      const grabPx = 12 / (viewRef.current?.scale ?? 1); // радиус захвата в пикселях карты (~12 экранных px)

      if (activeRoute) {
        let bestI = -1;
        let bestD = Infinity;
        for (let i = 0; i < activeRoute.points.length; i++) {
          const p = activeRoute.points[i];
          const d = Math.hypot(mapPoint.x - p.x, mapPoint.y - p.y);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0 && bestD <= grabPx) {
          setActiveRoute(activeRoute.id);
          setDraggingRoute({ routeId: activeRoute.id, index: bestI });
          return;
        }
      }

      // 2) Клик по линии любого видимого маршрута — сделать его активным
      //    (дальше можно цеплять точки и добавлять новые кликами)
      if (e.altKey || e.button === 0) {
        let hitRoute: Route | null = null;
        let hitD = Infinity;
        for (const r of routes) {
          if (!r.visible || r.points.length < 2) continue;
          const d = distPxToPolyline(mapPoint, r.points);
          if (d < hitD) { hitD = d; hitRoute = r; }
        }
        if (hitRoute && hitD <= grabPx) {
          setActiveRoute(hitRoute.id);
          // если попали точно на точку активного маршрута — сразу цепляем
          if (hitRoute.points.length) {
            let bi = -1, bd = Infinity;
            for (let i = 0; i < hitRoute.points.length; i++) {
              const p = hitRoute.points[i];
              const d = Math.hypot(mapPoint.x - p.x, mapPoint.y - p.y);
              if (d < bd) { bd = d; bi = i; }
            }
            if (bi >= 0 && bd <= grabPx) setDraggingRoute({ routeId: hitRoute.id, index: bi });
          }
          return;
        }
      }

      // Check if clicked on a marker
      const clickedMarker = [...project.markers].reverse().find(m => {
        const dx = mapPoint.x - m.x;
        const dy = mapPoint.y - m.y;
        return Math.sqrt(dx * dx + dy * dy) < 15 / (viewRef.current?.scale ?? 1);
      });
      if (clickedMarker) {
        selectMarker(clickedMarker.id);
        setDraggingMarker(clickedMarker.id);
        // Popup: координаты, высота, расстояние до точки запуска/маршрута
        const geo = project.map?.bounds
          ? pixelToGeoExact({ x: clickedMarker.x, y: clickedMarker.y }, project.map.bounds, project.map.width, project.map.height)
          : { lat: NaN, lng: NaN };
        const lines: string[] = [];
        if (isFinite(geo.lat)) lines.push(`Широта: ${geo.lat.toFixed(6)}°`);
        if (isFinite(geo.lng)) lines.push(`Долгота: ${geo.lng.toFixed(6)}°`);
        lines.push(`Высота: ${(clickedMarker as any).altitude ?? (clickedMarker as any).elevation ?? '—'} м`);
        const start = (project.routes || []).find((r) => r.id === activeRouteId)?.points[0]
          || project.markers.find((m) => (m.type as any) === 'start');
        if (start) {
          // Расстояние в МЕТРАХ через haversine по гео-координатам. Старый код
          // считал distanceBetween() по пикселям и подписывал результат «м/км» —
          // единицы измерения были перепутаны (пиксель ≠ метр).
          const gStart = project.map?.bounds
            ? pixelToGeoExact({ x: (start as any).x, y: (start as any).y }, project.map.bounds, project.map.width, project.map.height)
            : null;
          if (gStart && isFinite(gStart.lat) && isFinite(geo.lat)) {
            const R = 6371000;
            const toRad = (v: number) => (v * Math.PI) / 180;
            const dLat = toRad(gStart.lat - geo.lat);
            const dLng = toRad(gStart.lng - geo.lng);
            const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(gStart.lat)) * Math.cos(toRad(geo.lat)) * Math.sin(dLng / 2) ** 2;
            const d = 2 * R * Math.asin(Math.sqrt(a));
            lines.push(`До старта: ${d >= 1000 ? (d / 1000).toFixed(2) + ' км' : Math.round(d) + ' м'}`);
          }
        }
        setPopup({ x: screenX, y: screenY, title: clickedMarker.name || 'Маркер', lines });
      } else {
        selectMarker(null);
        setPopup(null);
      }
      return;
    }

    if (currentTool === 'addMarker') {
      if (project.map) {
        const isInBounds = mapPoint.x >= 0 && mapPoint.x <= project.map.width &&
          mapPoint.y >= 0 && mapPoint.y <= project.map.height;
        if (!isInBounds) {
          alert('⚠️ Точка вне пределов карты!');
          return;
        }
        // Честная семантика: предупреждаем, если точка ВНУТРИ зоны ограничения
        // (раньше из-за инвертированной isPointInActiveRestriction вопрос
        // «вне активного ограничения» задавался обратным условием).
        const insideRestriction = isPointInsideAnyRestriction(mapPoint, project.restrictions);
        if (insideRestriction) {
          if (!confirm('⚠️ Точка находится внутри зоны ограничения. Всё равно добавить?')) {
            return;
          }
        }
        addMarker({ x: mapPoint.x, y: mapPoint.y });
      }
      return;
    }

    if (currentTool === 'drawPolygon') {
      addDrawingPoint(mapPoint);
      setDrawing(true);
      return;
    }

    // drawRect/drawCircle удалены: ограничения — только бесполетные зоны
    // произвольной геометрии (полигоны). Завершение полигона — двойной клик.

    if (currentTool === 'measure') {
      const newPoints = [...measurementPoints, mapPoint];
      setMeasurementPoints(newPoints);
      return;
    }

    // Клик по карте добавляет/вставляет точку в активный маршрут
    // (рядом с существующей точкой — перемещаем её, на линии — вставляем в середину)
    if (e.button === 0 && project.map) {
      const active = (project.routes || []).find((r) => r.id === activeRouteId && r.visible);
      if (active) {
        appendRoutePoint(active.id, mapPoint);
      } else {
        // нет активного маршрута — создаём новый из двух точек (кнопка «Новый маршрут» или второй клик)
        addRouteFromClick(mapPoint);
      }
      return;
    }
  }, [currentTool, project, isDrawing, drawingPoints, measurementPoints,
    screenToMap, addMarker, selectMarker, addDrawingPoint, addRestriction,
    clearDrawingPoints, setDrawing, setMeasurementPoints,
    activeRouteId, appendRoutePoint, setActiveRoute, loadActiveTileHere]);

  // Быстрое создание маршрута кликами в режиме действий:
  // первый клик — точка старта (маршрут-заготовка), каждый следующий — новая точка.
  const pendingRouteRef = useRef<string | null>(null);
  const addRouteFromClick = useCallback((mapPoint: Point) => {
    const st = useStore.getState();
    if (!st.project.map) return;
    if (pendingRouteRef.current) {
      // уже есть заготовка — добавляем точку
      st.appendRoutePoint(pendingRouteRef.current, mapPoint);
      st.setActiveRoute(pendingRouteRef.current);
      return;
    }
    const rp: RoutePoint = (() => {
      const bounds = st.project.map!.bounds;
      const geo = bounds
        ? pixelToGeoExact(mapPoint, bounds, st.project.map!.width, st.project.map!.height)
        : { lat: NaN, lng: NaN };
      return { x: mapPoint.x, y: mapPoint.y, lat: geo.lat, lng: geo.lng };
    })();
    const id = st.addRoute([rp], undefined, undefined);
    if (id) {
      pendingRouteRef.current = id;
      st.setActiveRoute(id);
    }
  }, []);

  // Mouse move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const mapPoint = screenToMap(screenX, screenY);
    // Троттлинг курсора: set() в сторе на каждый mousemove вызывал ре-рендер
    // всех подписанных компонентов (StatusBar) — десятки раз в секунду.
    // Обновляем не чаще ~10 Гц; drag/pan ниже работают без троттлинга.
    const nowMs = performance.now();
    if (nowMs - lastCursorUpdateRef.current >= 100) {
      lastCursorUpdateRef.current = nowMs;
      setCursorPosition(mapPoint);
      cursorPosRef.current = mapPoint;
    } else if (drawingPoints.length > 0 && currentTool === 'drawPolygon') {
      // Резинка-превью требует актуального курсора между троттл-окнами:
      // пишем в ref и планируем кадр без ре-рендера подписанных компонентов.
      cursorPosRef.current = mapPoint;
      schedulePolygonDraw();
    }

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      const vcur = viewRef.current ?? NEUTRAL_VIEW; // актуальный вид из ref — колбэк стабилен между mousemove
      setViewState({
        offsetX: vcur.offsetX + dx,
        offsetY: vcur.offsetY + dy,
      });
      panStartRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (draggingMarker && project.map) {
      const clampedX = Math.max(0, Math.min(project.map.width, mapPoint.x));
      const clampedY = Math.max(0, Math.min(project.map.height, mapPoint.y));
      // Объекты строго привязаны к географии: при перемещении пересчитываем lat/lon
      if (project.map.bounds) {
        const geo = pixelToGeoFromBounds({ x: clampedX, y: clampedY }, project.map.bounds, project.map.width, project.map.height);
        updateMarker(draggingMarker, { x: clampedX, y: clampedY, lat: geo.lat, lon: geo.lng });
      } else {
        updateMarker(draggingMarker, { x: clampedX, y: clampedY });
      }
    }

    // Перетаскивание точки маршрута («цепляем за точку») — гео-привязка пересчитывается в store
    if (draggingRoute && project.map) {
      const clampedX = Math.max(0, Math.min(project.map.width, mapPoint.x));
      const clampedY = Math.max(0, Math.min(project.map.height, mapPoint.y));
      moveRoutePoint(draggingRoute.routeId, draggingRoute.index, { x: clampedX, y: clampedY });
    }
  }, [screenToMap, setCursorPosition, setViewState,
    draggingMarker, draggingRoute, project.map, updateMarker, moveRoutePoint,
    drawingPoints.length, currentTool, schedulePolygonDraw]);

  // Mouse up
  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
    setDraggingMarker(null);
    setDraggingRoute(null);
    // Сброс подсветки захвата должен отрисоваться немедленно (иначе ref уже null,
    // а новый кадр не запланирован — «гост»-подсветка залипает до следующего действия)
    setRenderTick((t) => t + 1);
  }, []);

  // Double click - finish polygon drawing / clear measurement / удалить точку маршрута
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (currentTool === 'drawPolygon' && drawingPoints.length >= 3) {
      addRestriction({ type: 'polygon', points: [...drawingPoints] });
      clearDrawingPoints();
    }
    if (currentTool === 'measure') {
      setMeasurementPoints([]);
    }
    // Двойной клик по точке активного маршрута — удалить её (маршрут перестроится)
    if (currentTool === 'select' && activeRouteId && project.map) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mp = screenToMap(e.clientX - rect.left, e.clientY - rect.top);
      const route = (project.routes || []).find((r) => r.id === activeRouteId);
      if (route) {
        const grabPx = 12 / (viewRef.current?.scale ?? 1);
        let bi = -1, bd = Infinity;
        for (let i = 0; i < route.points.length; i++) {
          const p = route.points[i];
          const d = Math.hypot(mp.x - p.x, mp.y - p.y);
          if (d < bd) { bd = d; bi = i; }
        }
        if (bi >= 0 && bd <= grabPx) {
          removeRoutePoint(activeRouteId, bi);
          pendingRouteRef.current = null;
        }
      }
    }
  }, [currentTool, drawingPoints, addRestriction, clearDrawingPoints, setMeasurementPoints,
    activeRouteId, project.map, project.routes, screenToMap, removeRoutePoint]);

  // Горячие клавиши рисования полигона: Enter — завершить (>=3 точек),
  // Esc — отменить, Ctrl+Z / Cmd+Z — убрать последнюю вершину.
  useEffect(() => {
    if (currentTool !== 'drawPolygon') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Enter') {
        if (drawingPoints.length >= 3) {
          e.preventDefault();
          addRestriction({ type: 'polygon', points: [...drawingPoints] });
          clearDrawingPoints();
        }
      } else if (e.key === 'Escape') {
        if (drawingPoints.length > 0) {
          e.preventDefault();
          clearDrawingPoints();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (drawingPoints.length > 0) {
          e.preventDefault();
          undoDrawingPoint();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentTool, drawingPoints, addRestriction, clearDrawingPoints, undoDrawingPoint]);

  // Right click - cancel drawing
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isDrawing || drawingPoints.length > 0) {
      clearDrawingPoints();
    }
    if (measurementPoints.length > 0) {
      setMeasurementPoints([]);
    }
  }, [isDrawing, drawingPoints, measurementPoints, clearDrawingPoints, setMeasurementPoints]);

  const cursorStyle = currentTool === 'pan' ? (isPanningRef.current ? 'grabbing' : 'grab') :
    currentTool === 'select' ? (draggingMarker ? 'move' : 'default') :
    'crosshair';
  // Панорама без state: курсор «grabbing» обновляем напрямую через DOM —
  // это не вызывает ре-рендер канваса на каждое движение мыши.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let last = false;
    const id = window.setInterval(() => {
      if (currentTool !== 'pan') { if (last) { el.style.cursor = 'crosshair'; last = false; } return; }
      const p = isPanningRef.current;
      if (p !== last) { el.style.cursor = p ? 'grabbing' : 'grab'; last = p; }
    }, 120);
    return () => window.clearInterval(id);
  }, [currentTool]);

  // Управление видом: зум/геолокация/полный экран + переключатели слоёв
  const setViewStateForZoom10k = useCallback(() => {
    // Целевой масштаб 1:10 000 (1 см ≈ 100 м): подбираем scale из Mercator-привязки
    const map = project.map;
    if (!map?.bounds) return;
    // mpp для 1 см = 100 м: 100 м / (0.3937 css px) ≈ 254 м на css px... считаем через zoom:
    // mppEq(z) * cos(lat) = 100 / 37.795 → z = log2(156543.0339*cos(lat)/mpp)
    const latC = centerLatOf(map.bounds);
    const vcur = viewRef.current ?? NEUTRAL_VIEW; // актуальный вид из ref — колбэк стабилен
    const targetMpp = 100 / (2.54 / 96 * 100); // 100 м на 1 см экрана
    // Обратная задача: мир в px под целевые м/пиксель, затем scale относительно z0
    const worldTarget = worldPxForMetersPerPixel(targetMpp, latC);
    // ЕДИНАЯ инвариантная привязка: worldPx = canvasHeight·2^(z0+log2 scale).
    // Отсюда scale = worldTarget / (canvasHeight·2^z0). (Раньше здесь ошибочно
    // использовалась ширина канваса — масштаб сбивался на aspect-ratio окна.)
    const z0 = vcur.z0 ?? ZOOM_REF;
    let sc = worldTarget / (Math.max(1, canvasSize.height) * Math.pow(2, z0));
    const bnds = scaleBoundsForZooms(canvasSize.width, z0, tileServer);
    sc = Math.max(bnds.min, Math.min(Math.max(bnds.max * 4, bnds.max), sc));
    const cx = canvasSize.width / 2, cy = canvasSize.height / 2;
    const newOffsetX = cx - (cx - vcur.offsetX) * (sc / vcur.scale);
    const newOffsetY = cy - (cy - vcur.offsetY) * (sc / vcur.scale);
    setViewState({ scale: sc, offsetX: newOffsetX, offsetY: newOffsetY });
  }, [project.map, tileServer, setViewState, canvasSize]);

  const btnCls = 'w-9 h-9 flex items-center justify-center rounded-md bg-gray-800/90 hover:bg-gray-700 text-gray-100 border border-gray-600 shadow text-base select-none';

  // ─── Данные для трёх окон карты ─────────────────────────────────────────────
  const goalForUav = (i: number): { lat: number; lng: number } | null => {
    if (sharedGoal) return goalGeo;
    // Индивидуальная цель дрона: явная (клик по окну «Цель») иначе — последняя
    // точка его маршрута (маршрут всегда заканчивается в цели).
    const dg = droneGoals[i];
    if (dg) return dg;
    const r = tripleRoutes[i];
    if (r && r.geo.length > 0) return r.geo[r.geo.length - 1];
    return goalGeo;
  };
  // Стартовая точка i-го дрона: общая (весь рой взлетает с одной точки) или
  // индивидуальная (задана кликом по окну «Старт», когда общий старт выключен).
  const startForUav = (i: number): { lat: number; lng: number } | null => {
    if (sharedStart) return startGeo;
    return droneStarts[i] ?? startGeo;
  };
  // Изначальная фокусировка всех окон карты — Санкт-Петербург. Ключевой источник
  // данных окна: старт/цель — их точка (пока не задана — СПб); маршрут — точки
  // маршрута (проект + черновик; пока пусто — СПб). Только ЭТОТ источник участвует
  // в center/fit панели: добавление точек на других окнах (например, цели при
  // редактировании старта) НЕ сбивает фокус текущего окна.
  const SPB_GEO = { lat: 59.9398, lng: 30.3146 };

  const startCenter = startGeo || SPB_GEO;
  const goalCenter = goalForUav(activeUav) || goalGeo || startGeo || SPB_GEO;
  const routeGeoPts = React.useMemo(() => {
    const out: { lat: number; lng: number }[] = [];
    for (const r of tripleRoutes) out.push(...r.geo);
    if (draftRoutePts) out.push(...draftRoutePts);
    return out;
  }, [tripleRoutes, draftRoutePts]);
  const routeLineGeo = tripleRoutes.length > 0
    ? (activeUav < tripleRoutes.length ? tripleRoutes[activeUav].geo : tripleRoutes.flatMap((r) => r.geo))
    : [];
  const linesOut: MiniOverlayLine[] = [
    ...tripleRoutes.map((r) => ({ pts: r.geo, color: r.color, width: 2 })),
    ...(startGeo && goalGeo ? [{ pts: [startGeo, goalGeo], color: '#facc15', width: 2, dashed: true }] : []),
  ];
  const pointsOut: MiniOverlayPoint[] = [
    ...(startGeo ? [{ id: 'triple:start', lat: startGeo.lat, lng: startGeo.lng, label: 'СТАРТ', color: '#4ade80' }] : []),
    ...(goalGeo ? [{ id: 'triple:goal', lat: goalGeo.lat, lng: goalGeo.lng, label: sharedGoal ? 'ЦЕЛЬ (общая)' : 'ЦЕЛЬ (выбранная)', color: '#f87171' }] : []),
    // Множественные старты/цели (ТЗ): все точки набора — с id для удаления кликом.
    ...multiStarts.filter((p) => !startGeo || Math.hypot(p.lat - startGeo.lat, p.lng - startGeo.lng) > 1e-7)
      .map((p, i) => ({ id: `multiStart:${p.id}`, lat: p.lat, lng: p.lng, label: `СТАРТ ${i + 2}`, color: '#34d399' })),
    ...multiGoals.filter((p) => !goalGeo || Math.hypot(p.lat - goalGeo.lat, p.lng - goalGeo.lng) > 1e-7)
      .map((p, i) => ({ id: `multiGoal:${p.id}`, lat: p.lat, lng: p.lng, label: `ЦЕЛЬ ${i + 2}`, color: '#fb7185' })),
    ...(!sharedGoal ? tripleRoutes.slice(0, droneCount).map((r, i) => {
      const g = r.geo[r.geo.length - 1];
      return g ? { id: `drone-goal:${r.id}`, lat: g.lat, lng: g.lng, label: `Дрон ${i + 1}`, color: uavColors[i % uavColors.length] } : null;
    }).filter(Boolean) as MiniOverlayPoint[] : []),
  ];
  const panelH = 260;

  return (
    // ФИКС «Не удалось определить размер контейнера карты» в режиме мастера:
    // раньше здесь был только h-full (height:100%) — процентная высота без
    // пиксельного базиса у предков flex-колонки мастера разрешалась в 0px,
    // ResizeObserver фиксировал нулевой размер и срабатывал circuit breaker.
    // В режиме планирования всё работало потому, что там контейнеру высоты
    // дают явные правила. Теперь MapCanvas сам гарантирует себе ненулевой
    // базис: absolute inset-0 заполняет любой relative-родитель (оба режима),
    // а min-h/min-w в пикселях не дают схлопнуться даже при битом layout.
    <div
      id="map-container"
      ref={containerRef}
      data-testid="map-container"
      className="absolute inset-0 min-h-[280px] min-w-[320px] overflow-hidden bg-[#0f1729]"
    >
      {/* Подложка OSM: DOM-слой настоящих <img>-тайлов (как на openstreetmap.org),
          positioned под canvas. Позиция/набор тайлов обновляются напрямую через
          transform/syncTileDom без React-рендера; pointer-events отключены — все
          события мыши принимает canvas поверх. */}
      <div
        ref={tileLayerRef}
        aria-hidden="true"
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'hidden', transformOrigin: '0 0', pointerEvents: 'none', zIndex: 0 }}
      />
      {/* Скрытый input для загрузки файла с fallback-кнопки «Загрузить файл…» */}
      <input
        ref={(el) => { fallbackFileInputRef.current = el; }}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        className="hidden"
        onChange={handleFallbackFile}
      />
      {fallbackMsg && (
        <div className="absolute z-30 left-1/2 top-4 -translate-x-1/2 rounded-md bg-red-900/90 border border-red-500 text-white text-xs px-3 py-2 shadow-lg">
          {fallbackMsg}
        </div>
      )}
      {/* CIRCUIT BREAKER размеров (шаг П3 ТЗ): если за 5 секунд после монтирования
          контейнер так и не получил валидные ненулевые размеры (display:none у
          родителя, нулевая flex-ветка, сломанный layout) — это НЕ бесконечное
          ожидание, а явная ошибка с кнопкой повторной замеры. Без этого лоадер
          тайлов висел бы вечно («карта грузится, но не видна»). */}
      {canvasSize.width <= 0 || canvasSize.height <= 0 ? (
        <div
          role="alert"
          data-testid="map-size-error-overlay"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-slate-950/80 p-4 text-center"
        >
          <p className="text-sm text-amber-300">Не удалось определить размер контейнера карты</p>
          <button
            type="button"
            data-testid="map-retry-measure"
            className="rounded bg-cyan-600 px-3 py-1 text-xs font-bold text-white hover:bg-cyan-500"
            onClick={() => {
              const el = containerRef.current;
              if (!el) return;
              const r = el.getBoundingClientRect();
              const w = r.width > 0 ? r.width : el.clientWidth;
              const h = r.height > 0 ? r.height : el.clientHeight;
              if (w > 0 && h > 0) {
                setCanvasSize({ width: w, height: h });
                // ФИКС «Попробовать снова» был декоративным: он обновлял только
                // размер, но не сбрасывал circuit breaker загрузки тайлов и не
                // перезапускал очередь. Теперь повтор = полный перезапуск:
                // снимаем флаг «загрузка зависла» и поднимаем retry-нонсу,
                // effect [tilesEnabled, tilesVersion, tileRetryNonce, ...]
                // заново наполняет очередь тайлов с чистого состояния.
                setTileLoadStalled(false);
                setTileRetryNonce((n) => n + 1);
              } else {
                // Размер всё ещё нулевой — не даём камере/тайлам уйти в NaN:
                // оставляем оверлей активным (он сам скроется, когда sizeWatchId
                // увидит ненулевой контейнер).
              }
            }}
          >
            Попробовать снова
          </button>
        </div>
      ) : null}
      {/* CIRCUIT BREAKER «вечной загрузки тайлов» (шаг П3 ТЗ): если подложка не
          догрузилась за 5 секунд — спиннер заменяется явной ошибкой с кнопкой
          повтора, а не висит бесконечно. */}
      {tilesEnabled && tileLoadStalled && canvasSize.width > 0 && canvasSize.height > 0 ? (
        <div
          role="alert"
          data-testid="map-tile-stall-overlay"
          className="absolute inset-x-0 top-12 z-40 mx-auto flex w-fit flex-col items-center gap-2 rounded-md bg-slate-950/90 border border-amber-500 p-3 text-center"
        >
          <p className="text-sm text-amber-300">Карты не загружаются: сервер тайлов не отвечает</p>
          <button
            type="button"
            data-testid="map-retry-tiles"
            className="rounded bg-cyan-600 px-3 py-1 text-xs font-bold text-white hover:bg-cyan-500"
            onClick={() => {
              setTileLoadStalled(false);
              setTileRetryNonce((n) => n + 1);
            }}
          >
            Попробовать снова
          </button>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        style={{
          width: `${canvasSize.width}px`,
          height: `${canvasSize.height}px`,
          cursor: cursorStyle,
          touchAction: 'none',
          zIndex: 1,
        }}
        className="absolute inset-0"
        role="application"
        aria-label="Интерактивная карта: перетаскивание, зум колесом, кнопки управления справа"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === '+' || e.key === '=') zoomAt(2);
          else if (e.key === '-') zoomAt(0.5);
          // Пан стрелками: приоритет ?? связывается СЛАБЕЕ арифметики, поэтому
          // скобки обязательны — иначе при пустом ref получалось 0+40/0-40 вместо
          // сдвига текущего вида (и «0 - 40» уводило камеру на −40 px).
          else if (e.key === 'ArrowLeft') setViewState({ offsetX: (viewRef.current?.offsetX ?? 0) + 40 });
          else if (e.key === 'ArrowRight') setViewState({ offsetX: (viewRef.current?.offsetX ?? 0) - 40 });
          else if (e.key === 'ArrowUp') setViewState({ offsetY: (viewRef.current?.offsetY ?? 0) + 40 });
          else if (e.key === 'ArrowDown') setViewState({ offsetY: (viewRef.current?.offsetY ?? 0) - 40 });
          else return;
          // Предотвращаем прокрутку страницы стрелками/зумом с клавиатуры
          e.preventDefault();
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />

      {/* Popup объекта: координаты, высота, расстояние */}
      {popup && (
        <div
          className="absolute z-20 max-w-[260px] rounded-lg bg-gray-900/95 border border-cyan-500/50 text-gray-100 text-xs shadow-xl p-2 pointer-events-auto"
          style={{ left: Math.min(popup.x + 12, canvasSize.width - 270), top: Math.min(popup.y + 12, canvasSize.height - 120) }}
          onClick={() => setPopup(null)}
        >
          <div className="font-bold text-cyan-300 mb-1">{popup.title}</div>
          {popup.lines.map((l, i) => (<div key={i} className="leading-relaxed">{l}</div>))}
          <div className="text-gray-400 mt-1">клик — закрыть</div>
        </div>
      )}

      {/* Индикатор состояния слоя подложки (пункт C аудита): загружается/загружен/ошибка.
        Временные сообщения (геолокация и т.п.) показываются поверх статуса слоя. */}
    {tilesEnabled && (
      <div
        role="status"
        aria-live="polite"
        aria-label={`Состояние слоя подложки: ${
          tileStatusMsg ?? (layerLoadState === 'err' ? 'ошибка загрузки' : layerLoadState === 'loading' ? 'слой загружается' : 'слой загружен')
        }`}
        className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-lg border text-xs shadow-lg pointer-events-none whitespace-nowrap ${
          tileStatusMsg
            ? tileStatusMsg.startsWith('⚠')
              ? 'bg-red-950/90 border-red-500/70 text-red-200'
              : tileStatusMsg.startsWith('✓')
                ? 'bg-gray-900/85 border-emerald-500/50 text-emerald-200'
                : 'bg-gray-900/85 border-amber-500/60 text-amber-200'
            : layerLoadState === 'err'
              ? 'bg-red-950/90 border-red-500/70 text-red-200'
              : layerLoadState === 'loading'
                ? 'bg-gray-900/85 border-amber-500/60 text-amber-200'
                : 'bg-gray-900/85 border-emerald-500/50 text-emerald-200'
        }`}
      >
        {tileStatusMsg
          ? tileStatusMsg
          : layerLoadState === 'err'
            ? `⚠ Слой «${TILE_PROVIDERS[tileServer].label}» недоступен — попробуйте другой стиль`
            : layerLoadState === 'loading'
              ? `⏳ Загрузка слоя «${TILE_PROVIDERS[tileServer].label}»…`
              : `✓ Слой «${TILE_PROVIDERS[tileServer].label}» загружен`}
      </div>
    )}

      {/* Кнопки управления картой (доступность: aria-label, клавиатура) */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5" aria-label="Управление картой">
        <button className={btnCls} aria-label="Приблизить" title="Приблизить (+)" onClick={() => zoomAt(2)}>＋</button>
        <button className={btnCls} aria-label="Отдалить" title="Отдалить (−)" onClick={() => zoomAt(0.5)}>－</button>
        <button className={btnCls} aria-label="Масштаб 1 к 10000" title="Целевой масштаб 1:10 000 (1 см ≈ 100 м)" onClick={setViewStateForZoom10k}>⌖</button>
        <button className={btnCls} aria-label="Геолокация" title="Моё местоположение" onClick={locateUser}>📍</button>
        <button className={btnCls} aria-label="Полный экран" title="Полный экран (F)" onClick={toggleFullscreen}>⛶</button>
      </div>

      {/* ─── Три отдельных окна карты + пошаговый мастер: СТАРТ → МАРШРУТ → ЦЕЛЬ → ЗАПУСК ─── */}
      {tripleMode && (() => {
        // гео-зоны проекта (для отрисовки ограничений на активной панели)
        const zoneGeoList = (() => {
          const map = project.map;
          if (!map?.bounds || map.width <= 0 || map.height <= 0) return [] as { pts: { lat: number; lng: number }[]; color?: string; radiusM?: number; centerGeo?: { lat: number; lng: number } }[];
          const worldPxZ14 = Math.max(256, canvasSizeRef.current.height * Math.pow(2, ZOOM_REF));
          return (project.restrictions || []).filter((z) => z.points.length > 0).map((z) => {
            const geoPts = z.points.map((p) => pixelToGeoExact(p, map.bounds!, map.width, map.height));
            if (z.type === 'circle' && z.radius) {
              const mppZ14 = metersPerPixelFromWorld(worldPxZ14, geoPts[0].lat);
              return { id: `zone:${z.id}`, pts: [] as { lat: number; lng: number }[], color: '#f87171', radiusM: z.radius * mppZ14, centerGeo: geoPts[0] };
            }
            return { id: `zone:${z.id}`, pts: geoPts, color: '#f87171' };
          });
        })();
        const draftLine: MiniOverlayLine[] = draftRoutePts && draftRoutePts.length >= 2
          ? [{ pts: curveGeo(draftRoutePts), color: '#34d399', width: 3 }] : [];
        const draftPoints: MiniOverlayPoint[] = (draftRoutePts || []).map((g, i) => ({ id: `draft:${i}`, lat: g.lat, lng: g.lng, label: `${i + 1}`, color: '#34d399' }));
        const stepDefs = [
          { idx: 0, title: 'СТАРТ (масштаб 1 см = 2 км)', icon: '🟢' },
          { idx: 1, title: 'ВЕСЬ МАРШРУТ (высокая детализация)', icon: '🧭' },
          { idx: 2, title: sharedGoal ? 'ЦЕЛЬ — общая для роя (1 см = 2 км)' : `ЦЕЛЬ дрона ${Math.min(activeUav + 1, droneCount)} (1 см = 2 км)`, icon: '🔴' },
        ] as const;
        const panelPropsFor = (idx: number): React.ComponentProps<typeof MiniMapPanel> => {
          // общие пропсы панелей: фокус, редактирование, удаление кликом —
          // ОДИНАКОВО во всех трёх окнах (редактировать можно любое окно сразу)
          const base: Partial<React.ComponentProps<typeof MiniMapPanel>> = {
            tileServer, // тот же рабочий стиль подложки, что у большой карты (аудит)
            focused: tripleStep === idx,
            panelIdx: idx,
            onFocus: () => { focusAndRaisePanel(idx); },
            onMapClick: handlePanelMapClick,
            onPointClick: handlePanelPointDelete,
            pointDeleteEnabled: tripleWorkMode === 'route',
            onPointMove: handlePanelPointMove,
            onZoneClick: handlePanelZoneDelete,
            zones: [...zoneGeoList, ...pendingZoneMini],
            // Двойной клик по карте панели в режиме ограничений — замкнуть
            // текущий полигон NFZ (создать новый черновик для следующей зоны).
            onPanelDoubleClick: () => {
              if (workModeRef.current !== 'restrictions') return;
              const last = pendingZonesRef.current[pendingZonesRef.current.length - 1];
              if (!last || last.pts.length < 3) {
                setPendingZones((prev) => prev.map((pz) => (pz === last ? { ...pz, pts: [] } : pz)));
                return;
              }
              setPendingZones((prev) => [...prev, { uid: pendingZoneUidRef.current++, pts: [] }]);
            },
          };
          if (idx === 0) return {
            ...base,
            title: stepDefs[0].title, icon: '🟢',
            center: startCenter, zoom: panelZoomFor2km(startCenter.lat),
            points: pointsOut.filter((p) => p.label === 'СТАРТ'), lines: linesOut, height: '100%',
          };
          if (idx === 1) return {
            ...base,
            title: stepDefs[1].title, icon: '🧭',
            // изначальная фокусировка — Санкт-Петербург; после ввода данных — авто-fit по маршруту
            center: routeGeoPts.length > 0 ? routeGeoPts[0] : SPB_GEO, zoom: 10,
            fitPoints: routeGeoPts.length > 0 ? routeGeoPts : undefined,
            points: [...pointsOut, ...draftPoints], lines: [...tripleRoutes.map((r) => ({ pts: curveGeo(r.geo), color: r.color, width: 2 })), ...(startGeo && goalGeo ? [{ pts: [startGeo, goalGeo], color: '#facc15', width: 2, dashed: true }] : []), ...draftLine.map((l) => ({ ...l, pts: curveGeo(l.pts) }))], height: '100%',
          };
          return {
            ...base,
            title: stepDefs[2].title, icon: '🔴',
            center: goalCenter, zoom: panelZoomFor2km(goalCenter.lat),
            points: pointsOut.filter((p) => p.label !== 'СТАРТ'),
            lines: [...(routeLineGeo.length > 1 ? [{ pts: routeLineGeo, color: '#facc15', width: 2 }] : []), ...linesOut],
            height: '100%',
          };
        };
        const stepHint = ['① Утвердите точку старта', '② Утвердите маршрут', '③ Утвердите цель', '✔ Все этапы утверждены — можно запускать'][tripleStep];
        // Компоновка «три карты»: АКТИВНАЯ карта всегда сверху (на месте большой
        // карты) — смена как вкладками; остальные две — внизу.
        return (
        <>
        {/* ВЕРХ: активная карта (вкладка) вместо большой карты */}
        <div id="triple-route-top" className="absolute inset-0 z-30">
          <MiniMapPanel key={`top-${topPanelIdx}`} {...panelPropsFor(topPanelIdx)} />
        </div>
        {/* НИЗ: две неактивные карты + панель мастера */}
        <div id="triple-map-row" className="absolute left-2 right-2 bottom-2 z-40 rounded-xl border border-cyan-700/60 bg-gray-900/95 shadow-2xl p-2">
          <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <span className="font-bold text-cyan-300">Карта миссии роя</span>
            {/* Вкладки карт: активная всегда наверху */}
            <div className="flex items-center gap-1" role="tablist" aria-label="Карты миссии">
              {['Старт', 'Маршрут', 'Цель'].map((lbl, i) => (
                <button key={lbl} role="tab" aria-selected={topPanelIdx === i}
                  onClick={() => { focusAndRaisePanel(i); }}
                  className={`px-2 py-0.5 rounded border ${approvedSteps[i] ? 'bg-emerald-900/70 border-emerald-500 text-emerald-200' : tripleStep === i ? 'bg-cyan-800 border-cyan-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700'}`}
                  title={`Перенести карту «${lbl}» наверх и редактировать`}
                >{approvedSteps[i] ? '✓' : `${i + 1}.`} {lbl}</button>
              ))}
              <span className="text-gray-400 ml-1">{stepHint}</span>
            </div>
            {/* Отдельные пункты меню: Установка ограничений / Редактирование маршрута */}
            <div className="flex items-center gap-1">
              <button role="tab" aria-selected={tripleWorkMode === 'route'}
                className={`px-2 py-0.5 rounded border ${tripleWorkMode === 'route' ? 'bg-cyan-700 border-cyan-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'}`}
                onClick={() => setTripleWorkMode('route')}
                title="Клик по ЛЮБОЙ из трёх карт добавляет/перемещает точку старта, цели или маршрута; drag точки — перенос; ✛ — удаление">✏️ Редактирование маршрута</button>
              <button role="tab" aria-selected={tripleWorkMode === 'restrictions'}
                className={`px-2 py-0.5 rounded border ${tripleWorkMode === 'restrictions' ? 'bg-orange-700 border-orange-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'}`}
                onClick={() => setTripleWorkMode('restrictions')}
                title="Клик по ЛЮБОЙ из трёх карт ставит круговую зону ограничения (r = 2 км); зоны утверждаются автоматически при переходе к следующему этапу; клик по ✛ зоны — удалить">⛔ Установка ограничений</button>
              <button className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300"
                onClick={() => setRouteShape((sh) => (sh === 'straight' ? 'curve' : 'straight'))}
                title="Форма линии маршрута: ломаная (по точкам) ⇄ сглаженная кривая (Catmull-Rom)">〰️ {routeShape === 'straight' ? 'Ломаная' : 'Кривая'}</button>
            </div>
            <label className="flex items-center gap-1 text-gray-300">Дронов:
              <input type="number" min={1} max={8} value={droneCount} disabled={launchState !== 'idle'}
                onChange={(e) => setDroneCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="w-12 px-1 bg-gray-800 border border-gray-600 rounded text-white" />
            </label>
            <label className="flex items-center gap-1 text-gray-300 cursor-pointer">
              <input type="checkbox" checked={sharedGoal} disabled={launchState !== 'idle'} onChange={(e) => setSharedGoal(e.target.checked)} />
              Общая цель для всего роя
            </label>
            {!sharedGoal && tripleRoutes.length > 0 && (
              <select
                value={Math.min(activeUav, tripleRoutes.length - 1)}
                onChange={(e) => setActiveUav(Number(e.target.value))}
                className="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-white"
                title="Выбрать дрон (его маршрут и цель — в окне «Цель»)"
              >
                {tripleRoutes.slice(0, droneCount).map((r, i) => (
                  <option key={r.id} value={i}>Дрон {i + 1}: {r.name}</option>
                ))}
              </select>
            )}
            <div className="flex-1" />
            <button className="px-2 py-0.5 rounded bg-cyan-800 hover:bg-cyan-700 border border-cyan-600 text-white" onClick={exportTriplePng} title="PNG высокого разрешения: три карты в одном файле">💾 PNG</button>
          </div>
          <div className="grid grid-cols-2 gap-2" style={{ height: 260 }}>
            {bottomPanels.map((idx) => (
              <MiniMapPanel
                key={`bot-${idx}`}
                {...panelPropsFor(idx)}
              />
            ))}
          </div>
          {/* Нижняя панель мастера: тип ВС / назад / утвердить / ЗАПУСК */}
          <div className="flex items-center gap-2 mt-2 text-xs">
            {/* Шаг 0 (ТЗ): выбор типа воздушного судна — лимит дальности миссии */}
            <span className="text-gray-400">Тип ВС:</span>
            <button
              className={`px-2 py-1 rounded border font-medium transition-colors ${craftType === 'drone' ? 'bg-emerald-700 border-emerald-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'}`}
              onClick={() => setCraftType('drone')}
              disabled={launchState !== 'idle'}
              title="Дрон: дальность миссии до 100 км"
            >🛩 Дрон ≤100 км</button>
            <button
              className={`px-2 py-1 rounded border font-medium transition-colors ${craftType === 'uav' ? 'bg-indigo-700 border-indigo-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'}`}
              onClick={() => setCraftType('uav')}
              disabled={launchState !== 'idle'}
              title="БПЛА: дальность миссии до 100 000 км"
            >🛰 БПЛА ≤100 000 км</button>
            {(multiStarts.length > 1 || multiGoals.length > 1) && (
              <span className="text-cyan-300" title="Каждая лишняя точка старта/цели порождает отдельный маршрут старт→цель">
                Старты: {Math.max(1, multiStarts.length)} · Цели: {Math.max(1, multiGoals.length)}
              </span>
            )}
            <button
              className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-200 disabled:opacity-40"
              disabled={tripleStep === 0 || launchState !== 'idle'}
              onClick={backTripleStep}
            >← Назад</button>
            {tripleStep < 3 ? (
              <button
                className="px-3 py-1 rounded font-semibold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!canApproveStep(tripleStep as 0 | 1 | 2)}
                onClick={approveTripleStep}
                title={canApproveStep(tripleStep as 0 | 1 | 2) ? 'Утвердить изменения этого этапа и перейти к следующему' : 'Сначала задайте данные этапа кликами по сфокусированной карте'}
              >✓ Утвердить и далее</button>
            ) : canLaunch ? (
              <button
                className={`px-4 py-1 rounded font-bold border text-white transition-all ${launchState === 'done' ? 'bg-emerald-600 border-emerald-400 cursor-default' : launchState === 'uploading' ? 'bg-amber-700 border-amber-500 animate-pulse cursor-wait' : 'bg-red-700 hover:bg-red-600 border-red-400 shadow-[0_0_14px_rgba(239,68,68,0.5)]'}`}
                onClick={launchMission}
                disabled={launchState !== 'idle'}
                title="Все данные миссии утверждены — загрузить полётные задания в дроны"
              >{launchState === 'uploading' ? '⏳ Загрузка в дроны…' : launchState === 'done' ? '✅ Задания загружены' : '🚀 ЗАПУСК'}</button>
            ) : null}
            {launchState === 'done' && (
              <button
                className="px-4 py-1 rounded font-bold border text-white bg-cyan-700 hover:bg-cyan-600 border-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.45)]"
                onClick={newMission}
                title="Очистить данные предыдущего полёта и начать новую миссию"
              >🆕 Новая миссия</button>
            )}
            <span className="text-gray-400">
              {tripleStep === 0 && 'Кликните по подсвеченной карте «Старт», чтобы выбрать точку старта.'}
              {tripleStep === 1 && 'Кликами по карте «Маршрут» добавляйте путевые точки; перетащите карту/зум для обзора.'}
              {tripleStep === 2 && 'На карте «Цель»: ставьте цель (🎯) и ограничения зон (⛔).'}
              {tripleStep === 3 && 'Проверьте карты и нажмите «ЗАПУСК» — задания уйдут в рой.'}
              {launchState === 'done' && ' ✅ Задания загружены в дроны. Нажмите «Новая миссия», чтобы начать следующий полёт.'}
            </span>
          </div>
        </div>
        </>
        );
      })()}
    </div>
  );
};

export default MapCanvas;
