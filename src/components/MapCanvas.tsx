import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore } from '../store/useStore';
import { isPointInActiveRestriction, distanceBetween } from '../utils/geometry';
import { pixelToGeoFromBounds } from '../utils/googleMaps';
import { haversineDistanceM, bearingDeg, boundsFromPoints } from '../utils/actionMode';
import { analyzeRoute, pixelToGeoExact, routeLengthM } from '../utils/routing';
import type { Point, Route, RoutePoint } from '../types';

/** Палитра цветов маршрутов (повторяется циклически при большом числе маршрутов) */
const ROUTE_PALETTE = ['#22d3ee', '#a78bfa', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#38bdf8', '#e879f9'];

/** Максимальный масштаб: 1 метр на пиксель экрана (зум «до 100 метров» с запасом) */
const MAX_SCALE = 1.0;

/**
 * Метров на один ЭКРАННЫЙ пиксель при текущем виде (строгая формула Web Mercator).
 * 1 см = 100 м соответствует ~37.8 px/m по горизонтали на обычных экранах
 * (96 CSS-px = 2.54 см), т.е. mpp ≈ 0.0265 м/px — наш предел масштаба намного ниже.
 */
function metersPerPixel(mapW: number, mapH: number, north: number, south: number, viewScale: number, latRef: number): number {
  const lngSpanDeg = Math.abs((mapW / mapH) * (north - south)); // из точной Mercator-привязки bounds
  const worldPx = (mapW * viewScale) / (lngSpanDeg / 360);      // размер мира в экранных px
  const mppEq = (156543.0339280412 / Math.pow(2, Math.log2(worldPx / 256)));
  return mppEq * Math.cos((latRef * Math.PI) / 180);
}

/** Человекочитаемая подпись масштаба */
function scaleLabel(mpp: number): string {
  if (mpp >= 1000) return `1 px ≈ ${(mpp / 1000).toFixed(1)} км`;
  if (mpp >= 1) return `1 px ≈ ${mpp.toFixed(1)} м`;
  if (mpp >= 0.01) return `1 px ≈ ${Math.round(mpp * 100)} см`;
  return `1 px ≈ ${(mpp * 1000).toFixed(1)} мм`;
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
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Point>({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [draggingMarker, setDraggingMarker] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Перетаскивание точки маршрута: id + индекс (для moveRoutePoint)
  const [draggingRoute, setDraggingRoute] = useState<{ routeId: string; index: number } | null>(null);

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

  // devicePixelRatio — для чёткого рендера на Retina/HiDPI экранах
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

  // Load map image when map data changes
  useEffect(() => {
    if (!project.map || !project.map.dataUrl) {
      mapImageRef.current = null;
      setMapLoaded(false);
      return;
    }

    const img = new Image();
    img.onload = () => {
      mapImageRef.current = img;
      setMapLoaded(true);
    };
    img.onerror = () => {
      console.error('Ошибка загрузки изображения карты');
      setMapLoaded(false);
    };
    img.src = project.map.dataUrl;
  }, [project.map?.dataUrl]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Auto-fit view: при загрузке карты — вписать её; если на карте есть объекты
  // (маршруты/маркеры/зоны) — автоматически масштабировать вид ПОД НИХ,
  // карта остаётся интерактивной (зум/панорама доступны всегда).
  const lastFittedMapRef = useRef<string | null>(null);
  useEffect(() => {
    const dataUrl = project.map?.dataUrl;
    if (project.map && mapLoaded && canvasSize.width > 0 && dataUrl && lastFittedMapRef.current !== dataUrl) {
      lastFittedMapRef.current = dataUrl;
      const scaleX = canvasSize.width / project.map.width;
      const scaleY = canvasSize.height / project.map.height;
      const scale = Math.min(scaleX, scaleY) * 0.9;
      const offsetX = (canvasSize.width - project.map.width * scale) / 2;
      const offsetY = (canvasSize.height - project.map.height * scale) / 2;
      setViewState({ scale, offsetX, offsetY });
    }
  }, [project.map?.dataUrl, mapLoaded, canvasSize.width, canvasSize.height]);

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

  // Convert screen coordinates to map coordinates
  const screenToMap = useCallback((screenX: number, screenY: number): Point => {
    return {
      x: (screenX - viewState.offsetX) / viewState.scale,
      y: (screenY - viewState.offsetY) / viewState.scale,
    };
  }, [viewState]);

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
      const cyMapPx = (canvasSize.height / 2 - viewState.offsetY) / viewState.scale;
      centerLatRef = mercToLat(topM + ((botM - topM) / project.map.height) * Math.max(0, Math.min(project.map.height, cyMapPx)));
    }

    // Clear
    ctx.fillStyle = '#0f1729';
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    if (!project.map || !mapImageRef.current) {
      // No map - draw placeholder
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

    // Draw map
    ctx.save();
    ctx.translate(viewState.offsetX, viewState.offsetY);
    ctx.scale(viewState.scale, viewState.scale);
    // Чёткость при увеличении: при сильном зуме — резкая (пиксельная) интерполяция,
    // при уменьшении — сглаженная. Canvas физически рендерится в dpr-разрешении,
    // поэтому тайлы OSM z19 (~0.3 м/пикс) остаются читаемыми вплоть до 100 м и ближе.
    ctx.imageSmoothingEnabled = viewState.scale < 1;
    if (ctx.imageSmoothingEnabled) (ctx as any).imageSmoothingQuality = 'high';
    ctx.drawImage(mapImageRef.current, 0, 0, project.map.width, project.map.height);
    ctx.restore();

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
    ctx.translate(viewState.offsetX, viewState.offsetY);
    ctx.scale(viewState.scale, viewState.scale);
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
    ctx.lineWidth = 2 / viewState.scale;
    ctx.strokeRect(0, 0, project.map.width, project.map.height);
    ctx.restore();

    // Сетка поверх карты (чтобы линии и подписи НЕ тонули в подложке тайлов)
    if (project.settings?.showGrid) {
      drawGrid(ctx);
    }

    // Масштабная линейка + плашка масштаба — всегда поверх всего
    drawScaleOverlay(ctx);

    function drawGrid(ctx: CanvasRenderingContext2D) {
      // ГЕОГРАФИЧЕСКАЯ адаптивная сетка: шаг в реальных метрах подбирается
      // под текущий масштаб (1/2/5 × 10^n), линии строго привязаны к координатам,
      // подписи всегда рисуются поверх карты фиксированным размером (не тонут в тайлах).
      if (!project.map) return;
      const map = project.map;
      const s = viewState.scale;
      const bounds = map.bounds;

      // Шаг сетки: пользовательский gridSize по умолчанию, иначе авто-подбор
      let stepM = project.settings?.gridSize && project.settings.gridSize > 0 ? project.settings.gridSize : 0;
      if (!stepM) {
        const mppX = metersPerPixel(map.width, map.height, bounds?.north ?? 0, bounds?.south ?? 0, s, 0);
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
        const vx0 = (0 - viewState.offsetX) / s;
        const vy0 = (0 - viewState.offsetY) / s;
        const vx1 = (canvasSize.width - viewState.offsetX) / s;
        const vy1 = (canvasSize.height - viewState.offsetY) / s;

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
          const sx = i * stepPxX * s + viewState.offsetX;
          if (sx < 0 || sx > canvasSize.width) continue;
          if ((i - Math.max(0, startXi)) % 2 !== 0) continue; // реже подписи при густой сетке
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(sx + 2, 2, fs * 3.4, fs + 4);
          ctx.fillStyle = 'rgba(190, 220, 255, 0.9)';
          ctx.fillText(`${i * stepM >= 1000 ? ((i * stepM) / 1000).toFixed(i * stepM % 1000 ? 1 : 0) + 'км' : i * stepM + 'м'}`, sx + 4, 2 + fs);
        }
        let li = 1;
        for (const y of yLines) {
          const sy = y * s + viewState.offsetY;
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
        ctx.translate(viewState.offsetX, viewState.offsetY);
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
          const sx = x * s + viewState.offsetX;
          if (sx < 0 || sx > canvasSize.width) continue;
          ctx.fillText(`${x}`, sx + 2, 12);
        }
        for (let y = gridSize; y <= map.height; y += gridSize * 2) {
          const sy = y * s + viewState.offsetY;
          if (sy < 14 || sy > canvasSize.height) continue;
          ctx.fillText(`${y}`, 2, sy - 3);
        }
      }
      ctx.restore();
    }

    function drawScaleOverlay(g: CanvasRenderingContext2D) {
      const map = project.map;
      if (!map?.bounds) return;
      const mpp = metersPerPixel(map.width, map.height, map.bounds.north, map.bounds.south, viewState.scale, centerLatRef);
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
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);

      for (const restriction of project.restrictions) {
        const isActive = restriction.active;
        ctx.fillStyle = isActive ? 'rgba(255, 50, 50, 0.12)' : 'rgba(100, 100, 100, 0.08)';
        ctx.strokeStyle = isActive ? 'rgba(255, 80, 80, 0.7)' : 'rgba(150, 150, 150, 0.4)';
        ctx.lineWidth = 2 / viewState.scale;

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
              ctx.arc(p.x, p.y, 4 / viewState.scale, 0, Math.PI * 2);
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
          ctx.arc(center.x, center.y, 4 / viewState.scale, 0, Math.PI * 2);
          ctx.fillStyle = isActive ? 'rgba(255, 100, 100, 0.8)' : 'rgba(150, 150, 150, 0.6)';
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawMarkers(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);

      for (const marker of project.markers) {
        const layer = project.layers.find(l => l.id === marker.layer);
        if (layer && !layer.visible) continue;

        const isInRestriction = isPointInActiveRestriction(
          { x: marker.x, y: marker.y },
          project.restrictions
        );

        const isSelected = marker.id === selectedMarkerId;
        const radius = (isSelected ? 12 : 8) / viewState.scale;

        // Shadow
        ctx.beginPath();
        ctx.arc(marker.x + 1 / viewState.scale, marker.y + 1 / viewState.scale, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // Draw marker
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = isInRestriction ? marker.color : '#ff3333';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (isSelected ? 3 : 1.5) / viewState.scale;
        ctx.stroke();

        // Inner dot
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, radius * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fill();

        // Draw label
        const fontSize = Math.max(10, 12 / viewState.scale);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'left';

        // Label background
        const labelX = marker.x + radius + 5 / viewState.scale;
        const labelY = marker.y + 4 / viewState.scale;
        const textWidth = ctx.measureText(marker.name).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(labelX - 2 / viewState.scale, labelY - fontSize, textWidth + 4 / viewState.scale, fontSize + 4 / viewState.scale);
        ctx.fillStyle = isInRestriction ? '#ffffff' : '#ff6666';
        ctx.fillText(marker.name, labelX, labelY);
      }
      ctx.restore();
    }

    function drawMeasurement(ctx: CanvasRenderingContext2D) {
      if (measurementPoints.length < 1) return;
      ctx.save();
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);

      if (measurementPoints.length >= 2) {
        ctx.strokeStyle = '#ffdd00';
        ctx.lineWidth = 2 / viewState.scale;
        ctx.setLineDash([6 / viewState.scale, 4 / viewState.scale]);

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
        ctx.arc(p.x, p.y, 5 / viewState.scale, 0, Math.PI * 2);
        ctx.fillStyle = '#ffdd00';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / viewState.scale;
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
          ctx.fillRect(midX - tw / 2 - 3 / viewState.scale, midY - 18 / viewState.scale, tw + 6 / viewState.scale, 14 / viewState.scale);
          ctx.fillStyle = '#ffdd00';
          ctx.font = `bold ${11 / viewState.scale}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(label, midX, midY - 7 / viewState.scale);
        }
      }
      ctx.restore();
    }

    function drawCurrentDrawing(ctx: CanvasRenderingContext2D) {
      if (drawingPoints.length === 0) return;
      ctx.save();
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);

      ctx.strokeStyle = '#00ddff';
      ctx.lineWidth = 2 / viewState.scale;
      ctx.setLineDash([5 / viewState.scale, 3 / viewState.scale]);

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
        ctx.arc(p.x, p.y, 5 / viewState.scale, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#00ff88' : '#00ddff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / viewState.scale;
        ctx.stroke();
      }

      // Instructions
      if (currentTool === 'drawPolygon') {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.9)';
        ctx.font = `${12 / viewState.scale}px sans-serif`;
        ctx.textAlign = 'left';
        const lastP = drawingPoints[drawingPoints.length - 1];
        ctx.fillText('Клик — добавить вершину, двойной клик — завершить', lastP.x + 10 / viewState.scale, lastP.y - 10 / viewState.scale);
      }

      ctx.restore();
    }

    function drawActionRoute(ctx: CanvasRenderingContext2D) {
      if (!project.map?.bounds) return;
      const start = project.markers.find(m => m.name === 'СТАРТ' && m.lat != null && m.lon != null);
      const goal = project.markers.find(m => m.name === 'ЦЕЛЬ' && m.lat != null && m.lon != null);
      if (!start || !goal) return;

      ctx.save();
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);

      const geoStart = { lat: start.lat as number, lng: start.lon as number };
      const geoGoal = { lat: goal.lat as number, lng: goal.lon as number };
      const distM = haversineDistanceM(geoStart, geoGoal);
      const az = bearingDeg(geoStart, geoGoal);

      // Line start->goal
      ctx.strokeStyle = '#ff9500';
      ctx.lineWidth = 3 / viewState.scale;
      ctx.setLineDash([10 / viewState.scale, 6 / viewState.scale]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(goal.x, goal.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow at goal
      const ang = Math.atan2(goal.y - start.y, goal.x - start.x);
      const ah = 14 / viewState.scale;
      ctx.fillStyle = '#ff9500';
      ctx.beginPath();
      ctx.moveTo(goal.x, goal.y);
      ctx.lineTo(goal.x - ah * Math.cos(ang - 0.4), goal.y - ah * Math.sin(ang - 0.4));
      ctx.lineTo(goal.x - ah * Math.cos(ang + 0.4), goal.y - ah * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();

      // Labels with real geo data
      const fs = Math.max(11, 13 / viewState.scale);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = 'left';
      const midX = (start.x + goal.x) / 2;
      const midY = (start.y + goal.y) / 2;
      const label = `${distM >= 1000 ? (distM / 1000).toFixed(2) + ' км' : Math.round(distM) + ' м'} | Азимут ${az.toFixed(0)}°`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(midX - tw / 2 - 4 / viewState.scale, midY - fs - 4 / viewState.scale, tw + 8 / viewState.scale, fs + 8 / viewState.scale);
      ctx.fillStyle = '#ffcc66';
      ctx.fillText(label, midX - tw / 2, midY - 4 / viewState.scale);

      ctx.restore();
    }

    // ─── Маршруты режима действий ────────────────────────────────────────────
    // Все точки маршрутов хранятся в WGS-84; пиксельные координаты (x, y)
    // пересчитаны из bounds при загрузке — привязка строго географическая.
    function drawRoutes(ctx: CanvasRenderingContext2D) {
      const routes = project.routes || [];
      if (routes.length === 0) return;

      ctx.save();
      ctx.translate(viewState.offsetX, viewState.offsetY);
      ctx.scale(viewState.scale, viewState.scale);
      const s = viewState.scale;

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

  }, [project, viewState, canvasSize, selectedMarkerId, activeRouteId, drawingPoints, measurementPoints, mapLoaded, currentTool, dpr, actionMode]);

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Дискретный зум с коэффициентом 2 (уровни масштаба как у тайловых карт):
    // один шаг колеса = один уровень, масштабирование точно к позиции курсора
    const zoomFactor = e.deltaY > 0 ? 0.5 : 2;
    const newScale = Math.max(0.01, Math.min(50, viewState.scale * zoomFactor));

    const newOffsetX = mouseX - (mouseX - viewState.offsetX) * (newScale / viewState.scale);
    const newOffsetY = mouseY - (mouseY - viewState.offsetY) * (newScale / viewState.scale);

    setViewState({ scale: newScale, offsetX: newOffsetX, offsetY: newOffsetY });
  }, [viewState, setViewState]);

  // Mouse down
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const mapPoint = screenToMap(screenX, screenY);

    if (currentTool === 'pan' || e.button === 1 || (e.button === 0 && e.shiftKey)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    if (currentTool === 'select') {
      // 1) Прицел к точкам маршрутов активного режима редактирования:
      //    клик рядом с точкой — «цепляем» её и тянем (drag), двойной клик — удаляем.
      const routes = project.routes || [];
      const activeRoute = routes.find((r) => r.id === activeRouteId && r.visible);
      const grabPx = 12 / viewState.scale; // радиус захвата в пикселях карты (~12 экранных px)

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
        return Math.sqrt(dx * dx + dy * dy) < 15 / viewState.scale;
      });
      if (clickedMarker) {
        selectMarker(clickedMarker.id);
        setDraggingMarker(clickedMarker.id);
      } else {
        selectMarker(null);
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
  }, [currentTool, actionMode, viewState, project, isDrawing, drawingPoints, measurementPoints,
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

    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setViewState({
        offsetX: viewState.offsetX + dx,
        offsetY: viewState.offsetY + dy,
      });
      setPanStart({ x: e.clientX, y: e.clientY });
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
  }, [isPanning, panStart, viewState, screenToMap, setCursorPosition, setViewState,
    draggingMarker, draggingRoute, project.map, updateMarker, moveRoutePoint]);

  // Mouse up
  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
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
        const grabPx = 12 / viewState.scale;
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
    activeRouteId, project.map, project.routes, viewState.scale, screenToMap, removeRoutePoint]);

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

  const cursorStyle = currentTool === 'pan' ? (isPanning ? 'grabbing' : 'grab') :
    currentTool === 'select' ? (draggingMarker ? 'move' : 'default') :
    'crosshair';

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[#0f1729]">
      <canvas
        ref={canvasRef}
        style={{
          width: `${canvasSize.width}px`,
          height: `${canvasSize.height}px`,
          cursor: cursorStyle,
        }}
        className="absolute inset-0"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
};

export default MapCanvas;
