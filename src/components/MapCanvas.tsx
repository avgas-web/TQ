import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore, scheduleRerouteAll, getActiveZonesCached } from '../store/useStore';
import { isPointInActiveRestriction, distanceBetween } from '../utils/geometry';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import { haversineDistanceM, bearingDeg, boundsFromPoints } from '../utils/actionMode';
import { pixelToGeoExact, routeLengthM, zonesCrossedBy } from '../utils/routing';
import { getOSMTileUrl, loadTileImage } from '../utils/openStreetMap';
import type { Point, Route, RoutePoint } from '../types';

/** Границы зума тайловой карты: minZoom 3 (вся страна/регион), maxZoom 19 (уровни OSM).
 *  Раньше нижняя граница была z10 — поэтому «большая карта» (страна/область) не
 *  загружалась целиком и не отдалялась дальше крупного города. */
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

/** Палитра цветов маршрутов (повторяется циклически при большом числе маршрутов) */
const ROUTE_PALETTE = ['#22d3ee', '#a78bfa', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#38bdf8', '#e879f9'];

/** Нативный max zoom тайловых серверов (выше НЕ поднимаемся — нет данных, только растяжение) */
const NATIVE_MAX_BY_SERVER: Record<string, number> = { osm: 19, carto: 18, opentopomap: 17 };
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
  mapW: number, mapH: number, bounds: { north: number; south: number },
  pts: Point[], vw: number, vh: number
): { scale: number; offsetX: number; offsetY: number } | null {
  if (pts.length === 0 || mapW <= 0 || mapH <= 0) return null;
  // Пиксели объектов -> география через точную Mercator-привязку растра к bounds
  const north = bounds.north, south = bounds.south;
  const east = (bounds as any).east ?? 180;
  const west = (bounds as any).west ?? -180;
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
  // нужный мир в px, чтобы bbox с запасом влез в окно
  const worldTarget = Math.min(vw / wFrac, vh / hFrac);
  let zoom = zoomAtWorldPx(worldTarget);
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  const worldPx = Math.max(256, vh * Math.pow(2, zoom));
  const scale = worldPx / (vh * Math.pow(2, ZOOM_REF)); // scale относительно z0=ZOOM_REF
  // центр bbox в world-px -> смещение, чтобы центр оказался в центре экрана
  const cxW = ((minFx + maxFx) / 2) * worldPx;
  const cyW = ((minFy + maxFy) / 2) * worldPx;
  return { scale, offsetX: vw / 2 - cxW, offsetY: vh / 2 - cyW };
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

const MapCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapImageRef = useRef<HTMLImageElement | null>(null);
  const isPanningRef = useRef(false); // без state — панорама не вызывает ре-рендер на каждый mousemove
  const panStartRef = useRef<Point>({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const canvasSizeRef = useRef(canvasSize);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  const [draggingMarker, setDraggingMarker] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Перетаскивание точки маршрута: id + индекс (для moveRoutePoint)
  const [draggingRoute, setDraggingRoute] = useState<{ routeId: string; index: number } | null>(null);
  // Popup по клику на объект (координаты, высота, расстояние)
  const [popup, setPopup] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  // Кэш тайлов подложки: url -> изображение (или undefined при ошибке)
  const tileCache = useRef<Map<string, HTMLImageElement | undefined>>(new Map());
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
  const activeTilesRef = useRef(0);
  const tileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Троттлинг обновления координат курсора в сторе (см. handleMouseMove)
  const lastCursorUpdateRef = useRef(0);
  // pending-загрузки тайлов: url -> промис (дедупликация — один запрос на тайл)
  const tilePending = useRef<Map<string, Promise<void>>>(new Map());
  const [tilesVersion, setTilesVersion] = useState(0);
  // Геолокация пользователя
  const [userPos, setUserPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);

  const {
    project,
    currentTool,
    actionMode,
    selectedMarkerId,
    activeRouteId,
    isDrawing,
    drawingPoints,
    measurementPoints,
    setViewState,
    setCursorPosition,
    addMarker,
    updateMarker,
    selectMarker,
    addRestriction,
    addDrawingPoint,
    clearDrawingPoints,
    setDrawing,
    setMeasurementPoints,
    appendRoutePoint,
    moveRoutePoint,
    removeRoutePoint,
    setActiveRoute,
  } = useStore();

  // ===== viewTick: троттлинг перерисовки канваса (rAF) =====
  // viewState обновляется на каждое движение мыши. Реакция на него идёт НЕ через
  // подписку useStore() на весь store (это тянуло полный React-рендер и шторм
  // запросов тайлов на каждый mousemove -> страница «виснет»), а через лёгкую
  // zustand-подписку с requestAnimationFrame: вид читается из viewRef, canvas
  // перерисовывается не чаще одного кадра, обработчики мыши стабильны.
  // ВАЖНО: viewRef инициализируется напрямую из стора (useStore.getState()), а не
  // из пропсов/деструктуризации — иначе при re-render до гидрации persist можно
  // получить undefined-вид (краш «viewState is not defined» / reading 'scale').
  const viewRef = useRef(useStore.getState().viewState);
  useEffect(() => { viewRef.current = useStore.getState().viewState; });
  const [renderTick, setRenderTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const unsub = useStore.subscribe((s) => {
      if (s.viewState === viewRef.current) return;
      viewRef.current = s.viewState;
      // Подложка OSM — DOM-слой: его позиция обновляется напрямую без
      // React-рендера (как на openstreetmap.org). Функция объявлена ниже через
      // useCallback — берём актуальную ссылку из ref, чтобы не создавать
      // цикл зависимостей и не терять вызов при HMR.
      tileLayerPositionRef.current?.();
      if (raf) return; // уже запланировано — не плодим рендеры (троттлинг до 1/кадр)
      raf = requestAnimationFrame(() => { raf = 0; setRenderTick((t) => t + 1); });
    });
    return () => { unsub(); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Актуальный вид для РЕНДЕРА (обновлён в последнем кадре)
  const vs = viewRef.current;

  // devicePixelRatio — для чёткого рендера на Retina/HiDPI экранах
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

  // ===== Тайловая подложка: карта активна, а НЕ статичная фотография =====
  // Кэш тайлов, дозагрузка при изменении вида; maxNativeZoom — выше не растягиваем.
  const tilesEnabled = !!project.settings?.tilesEnabled && !!project.map?.bounds;
  // Только стандартная схема OSM (режимы «спутник/гибрид» удалены из приложения)
  const tileStyle: 'scheme' = 'scheme';
  const tileServer = (project.openStreetMap?.tileServer as any) || 'osm';
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
    const v = viewRef.current;
    const cs = canvasSizeRef.current;
    const st = useStore.getState();
    const mapBounds = st.project.map?.bounds;
    const tilesOn = !!st.project.settings?.tilesEnabled && !!mapBounds;
    if (!tilesOn || !mapBounds || cs.height <= 0) { el.style.display = 'none'; return; }
    const wp = worldPxOf(cs.height, v.scale, v.z0 ?? ZOOM_REF);
    const zoom = clampZoom(zoomAtWorldPx(wp));
    const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[(st.project.openStreetMap?.tileServer as any) || 'osm'] ?? MAX_ZOOM);
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
    const map = st.project.map!;
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
    const st = useStore.getState();
    const mapBounds = st.project.map?.bounds;
    const tilesOn = !!st.project.settings?.tilesEnabled && !!mapBounds;
    if (!tilesOn || !mapBounds) {
      for (const img of tileElsRef.current.values()) img.remove();
      tileElsRef.current.clear();
      return;
    }
    const v = viewRef.current;
    const cs = canvasSizeRef.current;
    if (cs.height <= 0) return;
    const wp = worldPxOf(cs.height, v.scale, v.z0 ?? ZOOM_REF);
    const zoom = clampZoom(zoomAtWorldPx(wp));
    const server = (st.project.openStreetMap?.tileServer as any) || 'osm';
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
          const p = loadTileImage(u, 10000) // таймаут: зависший тайл не блокирует очередь
            .then((loaded) => {
              tileCache.current.set(u, loaded || undefined);
              if (tileCache.current.size > TILE_CACHE_MAX) {
                const firstKey = tileCache.current.keys().next().value as string | undefined;
                if (firstKey !== undefined) tileCache.current.delete(firstKey);
              }
              if (loaded && tileElsRef.current.get(u) === imgEl) imgEl.src = u;
            })
            .finally(() => {
              tilePending.current.delete(u);
              activeTilesRef.current--;
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
      tileDebounceRef.current = setTimeout(pump, idle ? 0 : TILE_DEBOUNCE_MS);
    }
  }, [positionTileLayer]);

  // Пересинхронизация DOM-слоя при смене вида (rAF-троттлинг), карты и настроек
  useEffect(() => {
    syncTileDom();
  }, [renderTick, tilesEnabled, tileServer, project.map?.bounds, canvasSize, syncTileDom]);

  // Геолокация пользователя (по требованию — кнопка 📍)
  const locateUser = useCallback(() => {
    if (!navigator.geolocation) { alert('Геолокация не поддерживается браузером'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      (err) => alert('Ошибка геолокации: ' + err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);


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
    const v = viewRef.current;
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

  // Load map image when map data changes.
  // ВАЖНО: при активной тайловой подложке карта не обязана иметь растровое изображение —
  // иначе mapLoaded никогда не станет true и все режимы (маршруты, зоны, сетка) «не грузятся».
  useEffect(() => {
    const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    if (!project.map || !project.map.dataUrl) {
      mapImageRef.current = null;
      setMapLoaded(tilesActive && !!project.map?.bounds);
      return;
    }

    const img = new Image();
    img.onload = () => {
      mapImageRef.current = img;
      setMapLoaded(true);
    };
    img.onerror = () => {
      console.error('Ошибка загрузки изображения карты');
      // fallback-картинка не загрузилась — но активная тайловая карта всё равно работает
      setMapLoaded(tilesActive);
    };
    img.src = project.map.dataUrl;
  }, [project.map?.dataUrl, project.map?.bounds, project.settings?.tilesEnabled]);

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
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project.restrictions !== prev.project.restrictions) scheduleRerouteAll();
    });
    // Клавиатурный зум из App.tsx: событие tq:zoom принимает factor и масштабирует
    // вид вокруг центра канваса через тот же zoomAt, что и колесо мыши
    // (единые границы minZoom..maxNativeZoom, центр не «прыгает»).
    const onZoomEvent = (e: Event) => {
      const factor = (e as CustomEvent<number>).detail;
      if (typeof factor === 'number' && isFinite(factor) && factor > 0) zoomAt(factor);
    };
    window.addEventListener('tq:zoom', onZoomEvent);
    return () => {
      unsub();
      window.removeEventListener('tq:zoom', onZoomEvent);
    };
  }, [zoomAt]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        setCanvasSize((prev) => {
          if (prev.width > 0 && prev.height > 0 && (w !== prev.width || h !== prev.height)) {
            // инвариант вида: scale и z0 сохраняются, центр карты не «прыгает»
            const v = viewRef.current;
            setViewState({
              offsetX: v.offsetX + (w - prev.width) / 2,
              offsetY: v.offsetY + (h - prev.height) / 2,
            });
          }
          return { width: w, height: h };
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Стартовый zoom-инвариант z0: фиксируется ОДИН РАЗ на карту (не пересчитывается
  // при ресайзе — иначе масштаб «сбивается»). Тайлы, сетка и линейка используют его всегда.
  const lastFittedMapRef = useRef<string | null>(null);
  useEffect(() => {
    const map = project.map;
    if (!map?.bounds || canvasSize.height <= 0) return;
    const key = `${map.name}|${map.bounds.north.toFixed(6)},${map.bounds.south.toFixed(6)}`;
    if (lastFittedMapRef.current === key && viewRef.current.z0 != null) return;
    lastFittedMapRef.current = key;
    // z0 — ЭТАЛОН привязки (14): мир = canvasHeight·2^(z0+log2 scale). Постоянен
    // для всех карт — вид восстанавливается из persist точно, масштаб не «сбивается».
    if (viewRef.current.z0 !== ZOOM_REF) setViewState({ z0: ZOOM_REF });
  }, [project.map?.name, project.map?.bounds, canvasSize.height]);

  // Auto-fit view: при загрузке карты — вписать её; если на карте есть объекты
  // (маршруты/маркеры/зоны) — автоматически масштабировать вид ПОД НИХ,
  // карта остаётся интерактивной (зум/панорама доступны всегда).
  const lastInitialFitRef = useRef<string | null>(null);
  useEffect(() => {
    const tilesActive = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    const map = project.map;
    if (!map || !mapLoaded || canvasSize.width <= 0) return;
    const boundsKey = map.bounds ? `${map.bounds.north},${map.bounds.south}` : 'nobounds';
    const fitKey = `${map.dataUrl ? 'img' : 'tiles'}|${boundsKey}`;
    if (lastInitialFitRef.current === fitKey) return; // только ОДИН раз на карту — ресайз вид не трогает
    lastInitialFitRef.current = fitKey;
    if (!map.bounds) return;
    // ИНВАРИАНТНЫЙ ЭТАЛОН z0: привязка вида задаётся формулой worldPx = vh·2^zoom,
    // zoom = ZOOM_REF + log2(scale). Он НЕ зависит от размеров окна — поэтому
    // масштаб не «сбивается» при ресайзе/восстановлении из persist. Старый расчёт
    // z0 = startZoomForBounds(...) менял эталон при каждом изменении высоты окна
    // и конфликтовал с фиксатором z0=14 — из-за этого зум «залипал», а тайлы
    // уезжали относительно объектов.
    if (mapImageRef.current) {
      // Растровая карта: вписать изображение целиком. Привязка тайлов/сетки/линейки
      // согласуется с ФАКТИЧЕСКИМ размером растра относительно bounds: scale=1 ⇔
      // мир по X = map.width·2^z0 экранных px ⇒ z0 = log2(worldPxNeeded/(256·fitScale)).
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
      // Только тайловая подложка (активная карта, как на openstreetmap.org):
      // стартовый вид = ровно ТОТ зум, что указан при загрузке (диапазон масштаба
      // соблюдается жёстко), центр — географический центр bounds. Никакого
      // произвольного z15: пользователь задал zoom → на нём карта и открывается.
      const cLat = (map.bounds.north + map.bounds.south) / 2;
      const cLng = (map.bounds.east + map.bounds.west) / 2;
      // Целевой зум восстанавливаем из Mercator-геометрии самого растрового
      // «виртуального» растра loadActiveTileMap: он построен так, что высота
      // мира на уровне z равна map.height по Y. Это даёт точный zoom загрузки
      // без догадок и независим от размеров окна.
      const mercSpanY = latToMerc(map.bounds.south) - latToMerc(map.bounds.north);
      const zoomFromRaster = Math.log2(Math.max(map.height / Math.max(mercSpanY, 1e-12), 256) / 256);
      const zoom = clampZoom(Number.isFinite(zoomFromRaster) ? zoomFromRaster : 15);
      const zFix = ZOOM_REF; // ЭТАЛОН для инварианта worldPx = canvasHeight·2^(zFix+log2 scale)
      const worldPx = canvasSize.height * Math.pow(2, zoom); // мир в экранных px на этом зуме
      const fx = (cLng + 180) / 360;  // mercator-доля мира по X для центра bounds
      const fy = latToMerc(cLat);     // mercator-доля мира по Y
      setViewState({
        scale: worldPx / (canvasSize.height * Math.pow(2, zFix)), // ⇔ zoom = zFix + log2(scale)
        offsetX: canvasSize.width / 2 - fx * worldPx,
        offsetY: canvasSize.height / 2 - fy * worldPx,
        z0: zFix,
      });
    }
  }, [project.map?.dataUrl, project.map?.bounds, project.settings?.tilesEnabled, mapLoaded, canvasSize.width]);

  // Отдельный эффект: как только появляются точки маршрутов/маркеров —
  // автоматически подогнать вид под все объекты (один раз на набор объектов)
  const lastFitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const map = project.map;
    if (!map || !map.bounds || !mapLoaded || canvasSize.width <= 0) return;
    const pts: Point[] = [];
    for (const r of project.routes || []) if (r.visible !== false) for (const p of r.points) pts.push({ x: p.x, y: p.y });
    for (const m of project.markers) pts.push({ x: m.x, y: m.y });
    if (pts.length < 2) return;
    // Ключ — ТОЛЬКО набор объектов (mapId + упорядоченные id маршрутов/маркеров),
    // но не их количество и не dataUrl. Старый ключ `${dataUrl}|${pts.length}`
    // менялся при каждом добавлении/удалении точки → вид самовольно перемасштабивался
    // под все объекты, откатывая ручной зум пользователя (редактирование маршрутов
    // становилось невозможным). Смена карты определяется по mapId (стабилен между
    // загрузками), а не по dataUrl (меняется при каждой перезагрузке одного bbox).
    const fitKeyParts: string[] = [String(map.mapId || '')];
    for (const r of project.routes || []) fitKeyParts.push(`R:${r.id}`);
    for (const m of project.markers) fitKeyParts.push(`M:${m.id}`);
    const key = fitKeyParts.join('|');
    if (lastFitKeyRef.current === key) return;
    lastFitKeyRef.current = key;
    const fit = fitViewToData(map.width, map.height, map.bounds, pts, canvasSize.width, canvasSize.height);
    if (fit) setViewState(fit);
  }, [project.routes, project.markers, mapLoaded, canvasSize.width, canvasSize.height, project.map?.bounds]);

  // Convert screen coordinates to map coordinates (читаем вид из ref — стабильный колбэк)
  const screenToMap = useCallback((screenX: number, screenY: number): Point => {
    const v = viewRef.current;
    return {
      x: (screenX - v.offsetX) / v.scale,
      y: (screenY - v.offsetY) / v.scale,
    };
  }, []);

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
      // No map - draw placeholder (fallback-состояние без тайловой подложки)
      ctx.fillStyle = '#1a2744';
      ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
      ctx.fillStyle = '#4a6fa5';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Загрузите карту для начала работы', canvasSize.width / 2, canvasSize.height / 2 - 10);
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#3a5a85';
      ctx.fillText('Нажмите кнопку «Карта» в панели инструментов', canvasSize.width / 2, canvasSize.height / 2 + 15);
      return;
    }

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

    // Draw markers
    drawMarkers(ctx);

    // Draw measurement
    drawMeasurement(ctx);

    // Draw current drawing
    drawCurrentDrawing(ctx);

    // Draw action-mode route (СТАРТ → ЦЕЛЬ) in real geographic coordinates
    if (actionMode) {
      drawActionRoute(ctx);
    }

    // Draw routes (маршруты режима действий: редактирование, обход зон, предупреждения)
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
        let accM = 0;
        const yLines: number[] = [];
        if (my > 0) {
          // найти первый узел ниже верха экрана: интегрируем метры от верха bounds
          // (для простоты стартуем с 0 от северной границы)
        }
        while (true) {
          const latAtY = mercToLat(topMercY + my * mercPerMapPx);
          const cosLat = Math.max(0.05, Math.cos((latAtY * Math.PI) / 180));
          const dMerc = (stepM / (mppMap * cosLat * cosLat)) * mercPerMapPx; // Mercator Δ на один шаг
          my += dMerc;
          accM += stepM;
          if (my > Math.min(map.height, vy1)) break;
          yLines.push(my);
          if (yLines.length > 500) break; // защита от вырожденных случаев
        }
        void accM; void cosTop;
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
        const isActive = restriction.active;
        ctx.fillStyle = isActive ? 'rgba(255, 50, 50, 0.12)' : 'rgba(100, 100, 100, 0.08)';
        ctx.strokeStyle = isActive ? 'rgba(255, 80, 80, 0.7)' : 'rgba(150, 150, 150, 0.4)';
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

    function drawMarkers(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      for (const marker of project.markers) {
        const layer = project.layers.find(l => l.id === marker.layer);
        if (layer && !layer.visible) continue;

        const isInRestriction = isPointInActiveRestriction(
          { x: marker.x, y: marker.y },
          project.restrictions
        );

        const isSelected = marker.id === selectedMarkerId;
        const radius = (isSelected ? 12 : 8) / vs.scale;

        // Shadow
        ctx.beginPath();
        ctx.arc(marker.x + 1 / vs.scale, marker.y + 1 / vs.scale, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // Draw marker
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = isInRestriction ? marker.color : '#ff3333';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (isSelected ? 3 : 1.5) / vs.scale;
        ctx.stroke();

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
        ctx.fillStyle = isInRestriction ? '#ffffff' : '#ff6666';
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

      // Draw vertices
      for (let i = 0; i < drawingPoints.length; i++) {
        const p = drawingPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / vs.scale, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#00ff88' : '#00ddff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / vs.scale;
        ctx.stroke();
      }

      // Instructions
      if (currentTool === 'drawPolygon') {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.9)';
        ctx.font = `${12 / vs.scale}px sans-serif`;
        ctx.textAlign = 'left';
        const lastP = drawingPoints[drawingPoints.length - 1];
        ctx.fillText('Клик — добавить вершину, двойной клик — завершить', lastP.x + 10 / vs.scale, lastP.y - 10 / vs.scale);
      }

      ctx.restore();
    }

    function drawActionRoute(ctx: CanvasRenderingContext2D) {
      if (!project.map?.bounds) return;
      const start = project.markers.find(m => m.name === 'СТАРТ' && m.lat != null && m.lon != null);
      const goal = project.markers.find(m => m.name === 'ЦЕЛЬ' && m.lat != null && m.lon != null);
      if (!start || !goal) return;

      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);

      const geoStart = { lat: start.lat as number, lng: start.lon as number };
      const geoGoal = { lat: goal.lat as number, lng: goal.lon as number };
      const distM = haversineDistanceM(geoStart, geoGoal);
      const az = bearingDeg(geoStart, geoGoal);

      // Line start->goal
      ctx.strokeStyle = '#ff9500';
      ctx.lineWidth = 3 / vs.scale;
      ctx.setLineDash([10 / vs.scale, 6 / vs.scale]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(goal.x, goal.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow at goal
      const ang = Math.atan2(goal.y - start.y, goal.x - start.x);
      const ah = 14 / vs.scale;
      ctx.fillStyle = '#ff9500';
      ctx.beginPath();
      ctx.moveTo(goal.x, goal.y);
      ctx.lineTo(goal.x - ah * Math.cos(ang - 0.4), goal.y - ah * Math.sin(ang - 0.4));
      ctx.lineTo(goal.x - ah * Math.cos(ang + 0.4), goal.y - ah * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();

      // Labels with real geo data
      const fs = Math.max(11, 13 / vs.scale);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = 'left';
      const midX = (start.x + goal.x) / 2;
      const midY = (start.y + goal.y) / 2;
      const label = `${distM >= 1000 ? (distM / 1000).toFixed(2) + ' км' : Math.round(distM) + ' м'} | Азимут ${az.toFixed(0)}°`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(midX - tw / 2 - 4 / vs.scale, midY - fs - 4 / vs.scale, tw + 8 / vs.scale, fs + 8 / vs.scale);
      ctx.fillStyle = '#ffcc66';
      ctx.fillText(label, midX - tw / 2, midY - 4 / vs.scale);

      ctx.restore();
    }

    // ─── Маршруты режима действий ────────────────────────────────────────────
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

        // Точки маршрута
        const drawR = (isActive ? 5 : 3.5) / s;
        for (let i = 0; i < route.points.length; i++) {
          const p = route.points[i];
          ctx.beginPath();
          ctx.arc(p.x, p.y, drawR, 0, Math.PI * 2);
          ctx.fillStyle = p.auto ? 'rgba(255,255,255,0.75)' : color;
          ctx.fill();
          ctx.lineWidth = 1.2 / s;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.stroke();
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

  }, [project, renderTick, canvasSize, selectedMarkerId, activeRouteId, drawingPoints, measurementPoints, mapLoaded, currentTool, dpr, actionMode, tilesVersion, userPos]);

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
      const vcur = viewRef.current; // актуальный вид из ref — колбэк не зависит от state
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
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
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
      const grabPx = 12 / viewRef.current.scale; // радиус захвата в пикселях карты (~12 экранных px)

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
        return Math.sqrt(dx * dx + dy * dy) < 15 / viewRef.current.scale;
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
        const isInRestriction = isPointInActiveRestriction(mapPoint, project.restrictions);
        if (!isInRestriction) {
          if (!confirm('⚠️ Точка находится вне активного ограничения. Всё равно добавить?')) {
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

    if (currentTool === 'drawRect') {
      if (!isDrawing) {
        addDrawingPoint(mapPoint);
        setDrawing(true);
      } else {
        // Complete rectangle
        const points = [drawingPoints[0], mapPoint];
        addRestriction({ type: 'rectangle', points });
        clearDrawingPoints();
      }
      return;
    }

    if (currentTool === 'drawCircle') {
      if (!isDrawing) {
        addDrawingPoint(mapPoint);
        setDrawing(true);
      } else {
        // Complete circle
        const center = drawingPoints[0];
        const radius = distanceBetween(center, mapPoint);
        addRestriction({ type: 'circle', points: [center], radius });
        clearDrawingPoints();
      }
      return;
    }

    if (currentTool === 'measure') {
      const newPoints = [...measurementPoints, mapPoint];
      setMeasurementPoints(newPoints);
      return;
    }

    // Режим действий: клик по карте добавляет/вставляет точку в активный маршрут
    // (рядом с существующей точкой — перемещаем её, на линии — вставляем в середину)
    if (actionMode && e.button === 0 && project.map) {
      const active = (project.routes || []).find((r) => r.id === activeRouteId && r.visible);
      if (active) {
        appendRoutePoint(active.id, mapPoint);
      } else {
        // нет активного маршрута — создаём новый из двух точек (кнопка «Новый маршрут» или второй клик)
        addRouteFromClick(mapPoint);
      }
      return;
    }
  }, [currentTool, actionMode, project, isDrawing, drawingPoints, measurementPoints,
    screenToMap, addMarker, selectMarker, addDrawingPoint, addRestriction,
    clearDrawingPoints, setDrawing, setMeasurementPoints,
    activeRouteId, appendRoutePoint, setActiveRoute]);

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
    }

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      const vcur = viewRef.current; // актуальный вид из ref — колбэк стабилен между mousemove
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
    draggingMarker, draggingRoute, project.map, updateMarker, moveRoutePoint]);

  // Mouse up
  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
    setDraggingMarker(null);
    setDraggingRoute(null);
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
    if ((currentTool === 'select' || actionMode) && activeRouteId && project.map) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mp = screenToMap(e.clientX - rect.left, e.clientY - rect.top);
      const route = (project.routes || []).find((r) => r.id === activeRouteId);
      if (route) {
        const grabPx = 12 / viewRef.current.scale;
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
  }, [currentTool, actionMode, drawingPoints, addRestriction, clearDrawingPoints, setMeasurementPoints,
    activeRouteId, project.map, project.routes, screenToMap, removeRoutePoint]);

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
  const updateSettings = useStore((s) => s.updateSettings);
  const setViewStateForZoom10k = useCallback(() => {
    // Целевой масштаб 1:10 000 (1 см ≈ 100 м): подбираем scale из Mercator-привязки
    const map = project.map;
    if (!map?.bounds) return;
    // mpp для 1 см = 100 м: 100 м / (0.3937 css px) ≈ 254 м на css px... считаем через zoom:
    // mppEq(z) * cos(lat) = 100 / 37.795 → z = log2(156543.0339*cos(lat)/mpp)
    const latC = centerLatOf(map.bounds);
    const vcur = viewRef.current; // актуальный вид из ref — колбэк стабилен
    const targetMpp = 100 / (2.54 / 96 * 100); // 100 м на 1 см экрана
    // Обратная задача: мир в px под целевые м/пиксель, затем scale относительно z0
    const worldTarget = worldPxForMetersPerPixel(targetMpp, latC);
    // ЕДИНАЯ инвариантная привязка: worldPx = canvasHeight·2^(z0+log2 scale).
    // Отсюда scale = worldTarget / (canvasHeight·2^z0). (Раньше здесь ошибочно
    // использовалась ширина канваса — масштаб сбивался на aspect-ratio окна.)
    const z0 = vcur.z0 ?? ZOOM_REF;
    let sc = worldTarget / (Math.max(1, canvasSize.height) * Math.pow(2, z0));
    const bnds = scaleBoundsForZooms(canvasSize.width, z0, (project.openStreetMap?.tileServer as any) || 'osm');
    sc = Math.max(bnds.min, Math.min(Math.max(bnds.max * 4, bnds.max), sc));
    const cx = canvasSize.width / 2, cy = canvasSize.height / 2;
    const newOffsetX = cx - (cx - vcur.offsetX) * (sc / vcur.scale);
    const newOffsetY = cy - (cy - vcur.offsetY) * (sc / vcur.scale);
    setViewState({ scale: sc, offsetX: newOffsetX, offsetY: newOffsetY });
  }, [project.map, project.openStreetMap?.tileServer, setViewState, canvasSize]);

  const btnCls = 'w-9 h-9 flex items-center justify-center rounded-md bg-gray-800/90 hover:bg-gray-700 text-gray-100 border border-gray-600 shadow text-base select-none';

  return (
    <div id="map-container" ref={containerRef} className="relative w-full h-full overflow-hidden bg-[#0f1729]">
      {/* Подложка OSM: DOM-слой настоящих <img>-тайлов (как на openstreetmap.org),
          positioned под canvas. Позиция/набор тайлов обновляются напрямую через
          transform/syncTileDom без React-рендера; pointer-events отключены — все
          события мыши принимает canvas поверх. */}
      <div
        ref={tileLayerRef}
        aria-hidden="true"
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'hidden', transformOrigin: '0 0', pointerEvents: 'none', zIndex: 0 }}
      />
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
          else if (e.key === 'ArrowLeft') setViewState({ offsetX: viewRef.current.offsetX + 40 });
          else if (e.key === 'ArrowRight') setViewState({ offsetX: viewRef.current.offsetX - 40 });
          else if (e.key === 'ArrowUp') setViewState({ offsetY: viewRef.current.offsetY + 40 });
          else if (e.key === 'ArrowDown') setViewState({ offsetY: viewRef.current.offsetY - 40 });
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
          role="dialog"
          aria-label="Информация об объекте"
          onClick={() => setPopup(null)}
        >
          <div className="font-bold text-cyan-300 mb-1">{popup.title}</div>
          {popup.lines.map((l, i) => (<div key={i} className="leading-relaxed">{l}</div>))}
          <div className="text-gray-400 mt-1">клик — закрыть</div>
        </div>
      )}

      {/* Кнопки управления картой (доступность: aria-label, клавиатура) */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5" aria-label="Управление картой">
        <button className={btnCls} aria-label="Приблизить" title="Приблизить (+)" onClick={() => zoomAt(2)}>＋</button>
        <button className={btnCls} aria-label="Отдалить" title="Отдалить (−)" onClick={() => zoomAt(0.5)}>－</button>
        <button className={btnCls} aria-label="Масштаб 1 к 10000" title="Целевой масштаб 1:10 000 (1 см ≈ 100 м)" onClick={setViewStateForZoom10k}>⌖</button>
        <button className={btnCls} aria-label="Геолокация" title="Моё местоположение" onClick={locateUser}>📍</button>
        <button className={btnCls} aria-label="Полный экран" title="Полный экран (F)" onClick={toggleFullscreen}>⛶</button>
        <button
          className={`${btnCls} ${project.settings?.tilesEnabled ? 'ring-1 ring-cyan-400' : ''}`}
          aria-label="Тайловая подложка" title="Активная тайловая карта (T)"
          onClick={() => updateSettings({ tilesEnabled: !project.settings?.tilesEnabled })}
        >▦</button>
      </div>
    </div>
  );
};

export default MapCanvas;
