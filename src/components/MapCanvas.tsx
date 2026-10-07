import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore } from '../store/useStore';
import { isPointInActiveRestriction, distanceBetween } from '../utils/geometry';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import { haversineDistanceM, bearingDeg, boundsFromPoints } from '../utils/actionMode';
import { analyzeRoute, pixelToGeoExact, routeLengthM } from '../utils/routing';
import { getOSMTileUrl, loadTileImage } from '../utils/openStreetMap';
import type { Point, Route, RoutePoint } from '../types';

/** Границы зума тайловой карты: minZoom 10, maxZoom 19 (уровни OSM) */
const MIN_ZOOM = 10;
const MAX_ZOOM = 19;

/** Палитра цветов маршрутов (повторяется циклически при большом числе маршрутов) */
const ROUTE_PALETTE = ['#22d3ee', '#a78bfa', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#38bdf8', '#e879f9'];

/** Нативный max zoom тайловых серверов (выше НЕ поднимаемся — нет данных, только растяжение) */
const NATIVE_MAX_BY_SERVER: Record<string, number> = { osm: 19, carto: 18, opentopomap: 17 };

/** Стартовый zoom z0 из Mercator-высоты bounds и высоты экрана (z10–z19) */
function startZoomForBounds(bounds: { north: number; south: number }, vh: number): number {
  const mercSpan = Math.max(1e-9, latToMerc(bounds.north) - latToMerc(bounds.south));
  const z = Math.log2((vh * 360) / (256 * mercSpan)); // целый мир по Y = vh px при зуме z
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
}
/** scale, соответствующий целому zoom поверх z0 */
function scaleForZoom(viewW: number, z0: number, zoom: number): number {
  return Math.pow(2, zoom - z0);
}

/**
 * ЕДИНАЯ инвариантная привязка вида «экран ↔ география» (Web Mercator EPSG:3857):
 *   worldPx = размер мира в экранных px при текущем масштабе.
 * Всё (тайлы, сетка, линейка, зум, курсор) считается ТОЛЬКО через worldPx —
 * поэтому масштаб не может «сбиться»: он одинаков для подложки и объектов,
 * устойчив к ресайзу окна и корректен на любой широте.
 * Стартовый zoom z0 фиксируется один раз при загрузке карты; scale — множитель
 * поверх него (scale=1 ⇔ мир = canvasWidth·2^z0 px).
 */
function worldPxOf(canvasW: number, scale: number, z0: number): number {
  return Math.max(256, canvasW * scale * Math.pow(2, z0));
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
function scaleBoundsForZooms(canvasW: number, z0: number, server: string): { min: number; max: number } {
  const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[server] ?? MAX_ZOOM);
  return {
    min: scaleForZoom(canvasW, z0, MIN_ZOOM),
    max: scaleForZoom(canvasW, z0, nativeMax),
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
 * НЕ статичной картинкой «в размер окна», а активным видом, охватывающим данные,
 * с запасом до предела приближения (сетка и тайлы остаются чёткими).
 */
function fitViewToData(
  mapW: number, mapH: number, bounds: { north: number; south: number },
  pts: Point[], vw: number, vh: number
): { scale: number; offsetX: number; offsetY: number } | null {
  if (pts.length === 0) return null;
  const b = boundsFromPoints(pts as any, 0.15);
  // Пиксели карты -> география через точную Mercator-привязку bounds
  const topY = latToMerc(bounds.north);
  const botY = latToMerc(bounds.south);
  const xL = ((b.west - (-180)) / 360) * mapW;
  const xR = ((b.east - (-180)) / 360) * mapW;
  const yT = ((topY - latToMerc(b.north)) / (botY - topY)) * mapH;
  const yB = ((topY - latToMerc(b.south)) / (botY - topY)) * mapH;
  const w = Math.max(1e-6, xR - xL);
  const h = Math.max(1e-6, yB - yT);
  let scale = Math.min(vw / w, vh / h) * 0.85;
  scale = Math.min(Math.max(scale, 0.02), 40); // в пределах допустимого диапазона зума
  const cx = (xL + xR) / 2;
  const cy = (yT + yB) / 2;
  return { scale, offsetX: vw / 2 - cx * scale, offsetY: vh / 2 - cy * scale };
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
  // pending-загрузки тайлов: url -> промис (дедупликация — один запрос на тайл)
  const tilePending = useRef<Map<string, Promise<void>>>(new Map());
  const [tilesVersion, setTilesVersion] = useState(0);
  // Геолокация пользователя
  const [userPos, setUserPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);

  const {
    project,
    currentTool,
    actionMode,
    viewState,
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
  const viewRef = useRef(viewState);
  useEffect(() => { viewRef.current = viewState; }, [viewState]);
  const [renderTick, setRenderTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const unsub = useStore.subscribe((s) => {
      if (s.viewState === viewRef.current) return;
      viewRef.current = s.viewState;
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
  const tileStyle = project.settings?.tileStyle || 'scheme';
  const tileServer = (project.openStreetMap?.tileServer as any) || 'osm';
  // ЕДИНАЯ инвариантная привязка вида (worldPx = размер мира в экранных px):
  //   worldPx = canvasWidth · scale · 2^z0  (z0 фиксируется при загрузке карты).
  // Объекты хранятся в пикселях растра map.width×map.height, которые покрывают bounds,
  // поэтому worldPx также = map.width·scale·360/lngSpan — обе формулы совпадают
  // благодаря тому, что z0 подбирается ПОД ФАКТИЧЕСКИЙ РАЗМЕР РАСТРА (см. initial fit).
  const effZ0 = vs.z0 ?? (project.map?.bounds ? startZoomForBounds(project.map.bounds, canvasSize.height) : 14);
  const worldPx = Math.max(256, canvasSize.width * vs.scale * Math.pow(2, effZ0));

  // Стабильные примитивы для эффекта загрузки тайлов: сам viewState меняется на
  // каждом движении мыши — подписывать эффект на весь объект нельзя (шторм запросов).
  const offXq = Math.round(vs.offsetX / 24);
  const offYq = Math.round(vs.offsetY / 24);
  const zoomQ = Math.round(zoomAtWorldPx(worldPx));
  const kxq = Math.round(canvasSize.width / 96);
  const kyq = Math.round(canvasSize.height / 96);
  const boundsRef = project.map?.bounds;
  const mapHRef = project.map?.height || 0;

  useEffect(() => {
    if (!tilesEnabled || !boundsRef) return;
    const bounds = boundsRef;
    const vcur = viewRef.current; // актуальный вид (не из рендер-замыкания — эффект читает ref)
    const cs = canvasSizeRef.current;
    const wp = Math.max(256, cs.width * vcur.scale * Math.pow(2, vcur.z0 ?? effZ0));
    // центр экрана -> гео напрямую через инвариантную Mercator-привязку
    const lngC = -180 + ((cs.width / 2 - vcur.offsetX) / wp) * 360;
    const mercTop = latToMerc(bounds.north);
    const mercBot = latToMerc(bounds.south);
    if (!isFinite(lngC)) return;
    let zoom = Math.round(zoomAtWorldPx(wp));
    const nativeMax = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[tileServer] ?? MAX_ZOOM);
    zoom = Math.max(MIN_ZOOM, Math.min(nativeMax, zoom));
    const n = Math.pow(2, zoom);
    const xC = ((lngC + 180) / 360) * n;
    // широта центра экрана — через ту же raster-привязку Y, что и у всех объектов
    const mercPerScreenPxY = (mercBot - mercTop) / (mapHRef * vcur.scale);
    const cyMerc = mercTop + (cs.height / 2 - vcur.offsetY) * mercPerScreenPxY;
    const yTile = cyMerc * n;
    const tileSizePx = wp / n; // экранных px на тайл текущего zoom
    const tilesX = Math.ceil(cs.width / tileSizePx) + 2;
    const tilesY = Math.ceil(cs.height / tileSizePx) + 2;
    const urls: string[] = [];
    for (let dx = -Math.ceil(tilesX / 2); dx <= Math.ceil(tilesX / 2); dx++) {
      for (let dy = -Math.ceil(tilesY / 2); dy <= Math.ceil(tilesY / 2); dy++) {
        const tx = Math.floor(xC) + dx;
        const ty = Math.floor(yTile) + dy;
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        const url = getOSMTileUrl(zoom, tx, ty, tileServer, tileStyle);
        if (!tileCache.current.has(url)) urls.push(url);
      }
    }
    if (urls.length === 0) return;
    // Де дупликация: тайл, уже находящийся в загрузке (в т.ч. из ранее «отменённого»
    // эффекта), НЕ запрашивается повторно. Прежняя логика отменяла промисы при каждом
    // сдвиге вида, кэш почти не наполнялся и на каждое движение мыши стартовала новая
    // волна из сотен параллельных запросов — это и была причина зависания при загрузке карты.
    // Ограничение одновременных загрузок: браузер даёт ~6 соединений на хост,
    // сотни тайлов в очереди без лимита = таймауты и «вечная» загрузка карты.
    const MAX_PARALLEL = 6;
    const toLoad = urls.filter((u) => !tilePending.current.has(u));
    if (toLoad.length === 0) return;
    let active = 0;
    const queue = [...toLoad];
    const startNext = (): Promise<void> | null => {
      const u = queue.shift();
      if (!u) return null;
      const p = loadTileImage(u)
        .then((img) => { tileCache.current.set(u, img || undefined); })
        .finally(() => {
          tilePending.current.delete(u);
          active--;
          setTilesVersion((t2) => t2 + 1); // карта «проявляется» по мере готовности тайлов
          startNext();
        });
      tilePending.current.set(u, p);
      active++;
      return p;
    };
    const initial: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_PARALLEL, queue.length); i++) {
      const p = startNext();
      if (p) initial.push(p);
    }
    // Дозаряжаем очередь волнами: как только пачка готова — стартуем следующую
    const drain = (): void => {
      while (active < MAX_PARALLEL && queue.length > 0) { const p = startNext(); if (p) initial.push(p); else break; }
    };
    Promise.all(initial).then(() => { drain(); }).catch(() => {});
    setTimeout(drain, 2500); // страховка: сдвинуть очередь, если часть загрузок зависла/отменилась
    setTilesVersion((t2) => t2 + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesEnabled, tileStyle, tileServer, offXq, offYq, zoomQ, kxq, kyq, boundsRef, mapHRef]);

  // Геолокация пользователя (по требованию — кнопка 📍)
  const locateUser = useCallback(() => {
    if (!navigator.geolocation) { alert('Геолокация не поддерживается браузером'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      (err) => alert('Ошибка геолокации: ' + err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  // Внешние слои: аэропорты (Overpass), NOTAM-районы, геозоны — по видимой области
  type ExtObj = { kind: 'airport' | 'notam' | 'geozone'; lat: number; lng: number; name: string; r?: number };
  const [extObjs, setExtObjs] = useState<ExtObj[]>([]);
  const layersOn = !!(project.settings?.airportsLayer || project.settings?.notamLayer || project.settings?.geozonesLayer);
  useEffect(() => {
    if (!layersOn || !project.map?.bounds) { setExtObjs([]); return; }
    const b = project.map.bounds;
    const box = `${b.south},${b.west},${b.north},${b.east}`;
    let cancelled = false;
    const out: ExtObj[] = [];
    const jobs: Promise<void>[] = [];
    if (project.settings?.airportsLayer) {
      const q = `[out:json][timeout:15];(node["aeroway"="aerodrome"](${box});node["amenity"="airfield"](${box});way["aeroway"="aerodrome"](${box}););out center 40;`;
      jobs.push(fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d && !cancelled) for (const el of d.elements || []) out.push({ kind: 'airport', lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon, name: el.tags?.name || 'Аэродром' }); })
        .catch(() => {}));
    }
    if (project.settings?.notamLayer) {
      // Демо-источник NOTAM-подобных районов (без ключей API): крупные запретные районы OSM boundary=military
      const q = `[out:json][timeout:15];way["boundary"="military"](${box});out center 20;`;
      jobs.push(fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d && !cancelled) for (const el of d.elements || []) out.push({ kind: 'notam', lat: el.center?.lat ?? el.lat, lng: el.center?.lon ?? el.lon, name: (el.tags?.name || 'Военный район') + ' (NOTAM)', r: 3000 }); })
        .catch(() => {}));
    }
    if (project.settings?.geozonesLayer) {
      const q = `[out:json][timeout:15];way["landuse"="military"](${box});relation["boundary"="protected_area"](${box});out center 20;`;
      jobs.push(fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d && !cancelled) for (const el of d.elements || []) out.push({ kind: 'geozone', lat: el.center?.lat ?? el.lat, lng: el.center?.lon ?? el.lon, name: el.tags?.name || 'Геозона', r: 2000 }); })
        .catch(() => {}));
    }
    Promise.all(jobs).then(() => { if (!cancelled) setExtObjs(out.filter((o) => isFinite(o.lat) && isFinite(o.lng))); });
    return () => { cancelled = true; };
  }, [layersOn, project.settings?.airportsLayer, project.settings?.notamLayer, project.settings?.geozonesLayer, project.map?.bounds]);

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
      const z0 = v.z0 ?? startZoomForBounds(map.bounds, Math.max(1, canvasSize.height));
      const bnds = scaleBoundsForZooms(canvasSize.width, z0, tileServer);
      // предельное приближение: не грубее ~1 м/пиксель даже если нативный max меньше
      const mppAtMax = metersPerPixelFromWorld(worldPxOf(canvasSize.width, bnds.max, z0), centerLatOf(map.bounds));
      const maxExtra = mppAtMax > 1 ? bnds.max * Math.pow(2, Math.log2(mppAtMax)) : bnds.max;
      newScale = Math.max(bnds.min, Math.min(Math.max(maxExtra, bnds.max), newScale));
    } else {
      newScale = Math.max(0.01, Math.min(50, newScale));
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
  // перестраиваются (обход зон). rerouteAllRoutes внутри — с троттлингом 250 мс.
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project.restrictions !== prev.project.restrictions) s.rerouteAllRoutes();
    });
    return unsub;
  }, []);

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
    if (lastFittedMapRef.current === key && viewState.z0 != null) return;
    lastFittedMapRef.current = key;
    const z0 = startZoomForBounds(map.bounds, canvasSize.height);
    if (viewState.z0 !== z0) setViewState({ z0 });
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
    const z0 = startZoomForBounds(map.bounds, Math.max(1, canvasSize.height));
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
      // Только тайловая подложка: стартовый вид ≈ z15 вокруг центра bounds.
      const cLat = (map.bounds.north + map.bounds.south) / 2;
      const cLng = (map.bounds.east + map.bounds.west) / 2;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 15));
      const scale = scaleForZoom(canvasSize.width, z0, zoom);
      const lngSpan = Math.abs(map.bounds.east - map.bounds.west);
      const scrX = ((cLng - map.bounds.west) / lngSpan) * map.width * scale;
      const topM = latToMerc(map.bounds.north);
      const botM = latToMerc(map.bounds.south);
      const cyMap = ((topM - latToMerc(cLat)) / (botM - topM)) * map.height;
      setViewState({
        scale,
        offsetX: canvasSize.width / 2 - scrX,
        offsetY: canvasSize.height / 2 - cyMap * scale,
        z0,
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
    const key = `${map.dataUrl}|${pts.length}`;
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

    // Clear
    ctx.fillStyle = '#0f1729';
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    const tilesOnNow = !!project.settings?.tilesEnabled && !!project.map?.bounds;
    if (!project.map || (!mapImageRef.current && !tilesOnNow)) {
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

    // Draw map: тайловая подложка (активная карта) или загруженный растр как fallback-картинка
    const tilesOn = tilesOnNow;
    if (tilesOn && project.map?.bounds) {
      drawTiles(ctx);
    } else if (mapImageRef.current) {
      ctx.save();
      ctx.translate(vs.offsetX, vs.offsetY);
      ctx.scale(vs.scale, vs.scale);
      // Чёткость при увеличении: при сильном зуме — резкая (пиксельная) интерполяция,
      // при уменьшении — сглаженная. Canvas физически рендерится в dpr-разрешении.
      ctx.imageSmoothingEnabled = vs.scale < 1;
      if (ctx.imageSmoothingEnabled) (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(mapImageRef.current, 0, 0, project.map.width, project.map.height);
      ctx.restore();
    }

    function drawTiles(g: CanvasRenderingContext2D) {
      // Строгая Mercator-привязка тайлов к карте проекта: тот же bounds и та же формула,
      // что используют маркеры/маршруты → привязка координат соблюдается автоматически.
      const map = project.map!;
      const bounds = map.bounds!;
      const topM = latToMerc(bounds.north);
      const botM = latToMerc(bounds.south);
      // zoom из ЕДИНОЙ инвариантной привязки worldPx (не выше нативного уровня сервера)
      let zoom = Math.round(zoomAtWorldPx(worldPx));
      const nativeMaxT = Math.min(MAX_ZOOM, NATIVE_MAX_BY_SERVER[(project.openStreetMap?.tileServer as any) || 'osm'] ?? MAX_ZOOM);
      zoom = Math.max(MIN_ZOOM, Math.min(nativeMaxT, zoom));
      const n = Math.pow(2, zoom);
      const lngSpan = Math.abs(bounds.east - bounds.west);
      const tilePx = worldPx / n; // экранных px на тайл текущего zoom
      const server = (project.openStreetMap?.tileServer as any) || 'osm';
      const style = project.settings?.tileStyle || 'scheme';
      // Границы видимой области в гео-координатах (через ту же инвариантную привязку):
      // X — через worldPx; Y — через raster-привязку mercPerScreenPxY (то же, что у объектов).
      const mercPerScreenPxY = (botM - topM) / (map.height * vs.scale);
      const westLng = -180 + ((0 - vs.offsetX) / worldPx) * 360;
      const eastLng = -180 + ((canvasSize.width - vs.offsetX) / worldPx) * 360;
      const northLat = mercToLat(topM + (0 - vs.offsetY) * mercPerScreenPxY);
      const southLat = mercToLat(topM + (canvasSize.height - vs.offsetY) * mercPerScreenPxY);
      const txMin = Math.floor(((westLng + 180) / 360) * n);
      const txMax = Math.floor(((eastLng + 180) / 360) * n);
      const tyMin = Math.floor(Math.max(0, latToMerc(northLat) * n));
      const tyMax = Math.floor(Math.min(n - 1, latToMerc(southLat) * n));
      g.save();
      g.fillStyle = '#1a2744';
      // Экранный x левой границы мира (lng=-180): из привязки центра экрана
      const worldOriginX = canvasSize.width / 2 - (((lngFromScreen(canvasSize.width / 2)) + 180) / 360) * worldPx;
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          // позиция левого верхнего угла тайла: гео -> экранные px (та же привязка worldPx/X, raster/Y)
          const scrXTile = worldOriginX + (tx / n) * worldPx;
          const mercTopT = ty / n; // нормализованная Mercator Y северной границы тайла
          const mapYTop = ((topM - mercTopT) / (botM - topM)) * map.height;
          const scrY = mapYTop * vs.scale + vs.offsetY;
          const url = getOSMTileUrl(zoom, tx, ty, server, style);
          const img = tileCache.current.get(url);
          if (img) {
            // НЕ растягиваем выше maxNativeZoom: рисуем ровно tilePx (при scale > нативного
            // тайл z19 остаётся чётким до ~1 м/px за счёт dpr-канваса)
            g.drawImage(img, scrXTile, scrY, tilePx + 0.5, tilePx + 0.5);
          } else if (img === undefined) {
            g.fillRect(scrXTile, scrY, tilePx, tilePx);
          }
        }
      }
      g.restore();

      function lngFromScreen(x: number): number {
        return -180 + ((x - vs.offsetX) / worldPx) * 360;
      }
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

    // Draw map border
    ctx.save();
    ctx.translate(vs.offsetX, vs.offsetY);
    ctx.scale(vs.scale, vs.scale);
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
    ctx.lineWidth = 2 / vs.scale;
    ctx.strokeRect(0, 0, project.map.width, project.map.height);
    ctx.restore();

    // Сетка поверх карты (чтобы линии и подписи НЕ тонули в подложке тайлов)
    if (project.settings?.showGrid) {
      drawGrid(ctx);
    }

    // Внешние слои: аэропорты / NOTAM / геозоны + позиция пользователя (гео-привязка строгая)
    drawExternalLayers(ctx);

    // Масштабная линейка + плашка масштаба — всегда поверх всего
    drawScaleOverlay(ctx);

    function drawExternalLayers(g: CanvasRenderingContext2D) {
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
      for (const o of extObjs) {
        const p = toScreen(o.lat, o.lng);
        if (p.x < -50 || p.y < -50 || p.x > canvasSize.width + 50 || p.y > canvasSize.height + 50) continue;
        // радиус зоны в экранных px (для notam/geozone)
        if (o.r && (o.kind === 'notam' || o.kind === 'geozone')) {
          const mppLoc = metersPerPixelFromWorld(worldPx, o.lat);
          const rpx = Math.min(3000, o.r / Math.max(mppLoc, 1e-6));
          g.beginPath();
          g.arc(p.x, p.y, rpx, 0, Math.PI * 2);
          g.fillStyle = o.kind === 'notam' ? 'rgba(245,158,11,0.10)' : 'rgba(239,68,68,0.10)';
          g.fill();
          g.strokeStyle = o.kind === 'notam' ? 'rgba(245,158,11,0.6)' : 'rgba(239,68,68,0.6)';
          g.setLineDash([6, 4]);
          g.lineWidth = 1.5;
          g.stroke();
          g.setLineDash([]);
        }
        // маркер объекта
        g.font = 'bold 14px sans-serif';
        g.textAlign = 'center';
        g.fillStyle = o.kind === 'airport' ? '#34d399' : o.kind === 'notam' ? '#fbbf24' : '#f87171';
        g.fillText(o.kind === 'airport' ? '✈' : o.kind === 'notam' ? '⚠' : '⛔', p.x, p.y + 5);
        g.font = '10px sans-serif';
        g.fillStyle = 'rgba(226,232,240,0.9)';
        const nm = o.name.length > 24 ? o.name.slice(0, 23) + '…' : o.name;
        g.fillText(nm, p.x, p.y + 18);
      }
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

        // Предупреждения о пересечении зон ограничений
        let crossed: { name: string }[] = [];
        try {
          crossed = analyzeRoute(route, project.restrictions).crossedZones;
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

  }, [project, renderTick, canvasSize, selectedMarkerId, activeRouteId, drawingPoints, measurementPoints, mapLoaded, currentTool, dpr, actionMode, tilesVersion, extObjs, userPos]);

  // Mouse wheel zoom (к колесу курсора; границы minZoom/maxZoom внутри zoomAt)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY > 0 ? 0.5 : 2;
    zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  // Touch: одноfinger панорама, pinch — зум к центру щипка
  const touchState = useRef<{ mode: 'pan' | 'pinch'; x: number; y: number; dist: number } | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchState.current = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0 };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState.current = { mode: 'pinch', x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, dist: Math.hypot(dx, dy) };
    }
  }, []);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
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
          const d = distanceBetween({ x: clickedMarker.x, y: clickedMarker.y }, { x: (start as any).x, y: (start as any).y });
          lines.push(`До старта: ${d >= 1000 ? (d / 1000).toFixed(2) + ' км' : Math.round(d) + ' м'}`);
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
    setCursorPosition(mapPoint);

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
    const z0 = vcur.z0 ?? startZoomForBounds(map.bounds, Math.max(1, canvasSize.height));
    let sc = worldTarget / (Math.max(1, canvasSize.width) * Math.pow(2, z0));
    const bnds = scaleBoundsForZooms(canvasSize.width, z0, (project.openStreetMap?.tileServer as any) || 'osm');
    sc = Math.max(bnds.min, Math.min(Math.max(bnds.max * 4, bnds.max), sc));
    const cx = canvasSize.width / 2, cy = canvasSize.height / 2;
    const newOffsetX = cx - (cx - vcur.offsetX) * (sc / vcur.scale);
    const newOffsetY = cy - (cy - vcur.offsetY) * (sc / vcur.scale);
    setViewState({ scale: sc, offsetX: newOffsetX, offsetY: newOffsetY });
  }, [project.map, project.openStreetMap?.tileServer, setViewState, canvasSize]);

  const btnCls = 'w-9 h-9 flex items-center justify-center rounded-md bg-gray-800/90 hover:bg-gray-700 text-gray-100 border border-gray-600 shadow text-base select-none';

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[#0f1729]" data-testid="map-container">
      <canvas
        ref={canvasRef}
        style={{
          width: `${canvasSize.width}px`,
          height: `${canvasSize.height}px`,
          cursor: cursorStyle,
          touchAction: 'none',
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
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
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
        {/* Слои: схема / спутник / гибрид */}
        <div className="flex flex-col gap-1 mt-1" role="group" aria-label="Слои карты">
          {(['scheme', 'satellite', 'hybrid'] as const).map((st) => (
            <button
              key={st}
              className={`h-7 px-1.5 rounded-md text-[10px] font-semibold ${btnCls} !w-auto ${(project.settings?.tileStyle || 'scheme') === st ? 'bg-cyan-700/80 ring-1 ring-cyan-300' : ''}`}
              aria-pressed={(project.settings?.tileStyle || 'scheme') === st}
              title={st === 'scheme' ? 'Схема' : st === 'satellite' ? 'Спутник' : 'Гибрид'}
              onClick={() => updateSettings({ tileStyle: st, tilesEnabled: true })}
            >
              {st === 'scheme' ? 'СХЕМА' : st === 'satellite' ? 'СПУТ' : 'ГИБР'}
            </button>
          ))}
          <button
            className={`h-7 px-1.5 rounded-md text-[10px] font-semibold ${btnCls} !w-auto ${project.settings?.airportsLayer ? 'bg-emerald-700/80 ring-1 ring-emerald-300' : ''}`}
            aria-pressed={!!project.settings?.airportsLayer}
            title="Аэропорты (Overpass API)"
            onClick={() => updateSettings({ airportsLayer: !project.settings?.airportsLayer })}
          >✈ АЭРО</button>
          <button
            className={`h-7 px-1.5 rounded-md text-[10px] font-semibold ${btnCls} !w-auto ${project.settings?.geozonesLayer ? 'bg-red-700/80 ring-1 ring-red-300' : ''}`}
            aria-pressed={!!project.settings?.geozonesLayer}
            title="Геозоны / No-Fly зоны"
            onClick={() => updateSettings({ geozonesLayer: !project.settings?.geozonesLayer })}
          >⛔ ГЕО</button>
          <button
            className={`h-7 px-1.5 rounded-md text-[10px] font-semibold ${btnCls} !w-auto ${project.settings?.notamLayer ? 'bg-amber-700/80 ring-1 ring-amber-300' : ''}`}
            aria-pressed={!!project.settings?.notamLayer}
            title="NOTAM-уведомления"
            onClick={() => updateSettings({ notamLayer: !project.settings?.notamLayer })}
          >! NOTAM</button>
        </div>
      </div>
    </div>
  );
};

export default MapCanvas;
