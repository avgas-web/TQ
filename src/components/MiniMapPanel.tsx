// ─── MiniMapPanel: отдельное окно карты (старт / весь маршрут / цель) ────────
// Полностью автономная канвас-панель со строгой Web-Mercator привязкой:
//   worldPx = canvasSize·2^zoom, screen = geoFrac·worldPx + centerOffset.
// Тайлы OSM рисуются прямо на canvas (без DOM-слоя) — три панели суммарно
// потребляют минимум соединений (общий кэш тайлов + лимит параллельных загрузок).
// Зум колесом/кнопками, панорама перетаскиванием — в любых пределах z3..z19+.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getOSMTileUrl, loadTileImage } from '../utils/openStreetMap';
import {
  PanelView, viewBox, geoToScreenPx, zoomPanelAt, panPanelBy,
  metersPerPixel, fitView, GROUND_MPP_1CM_2KM,
} from '../utils/pannelli';

export interface MiniOverlayPoint { lat: number; lng: number; label?: string; color?: string }
export interface MiniOverlayLine { pts: { lat: number; lng: number }[]; color?: string; width?: number; dashed?: boolean }

interface MiniMapPanelProps {
  title: string;
  icon: string;
  /** Центр вида по умолчанию (гео) */
  center: { lat: number; lng: number };
  /** Стартовый зум; если задан fitPoints — он перекрывает center+zoom */
  zoom?: number;
  /** Точки для авто-вписывания вида (например весь маршрут) */
  fitPoints?: { lat: number; lng: number }[];
  minZoom?: number;
  maxZoom?: number;
  points?: MiniOverlayPoint[];
  lines?: MiniOverlayLine[];
  height?: number | string;
  onReady?: () => void;
  /** Режим «фокус»: панель активна для редактирования (принимает клики) */
  focused?: boolean;
  /** Вызывается при фокусировке панели (клик по неактивной панели) */
  onFocus?: () => void;
  /** Клик по карте панели → гео-координаты (для добавления точек маршрута и т.п.) */
  onMapClick?: (geo: { lat: number; lng: number }) => void;
  /** Ограничения/зоны, привязанные к этой панели (рисуются поверх тайлов).
   *  radiusM — радиус круга в метрах; pts — полигон по гео-точкам. */
  zones?: { pts: { lat: number; lng: number }[]; color?: string; radiusM?: number; centerGeo?: { lat: number; lng: number } }[];
}

/** Обратное преобразование экран→гео для панели (нужно для кликов редактирования).
 *  Совпадает с screenPxToGeo из pannelli.ts (центр канваса как точка отсчёта). */
export function screenPxToGeoPanel(vb: { fx: number; fy: number; wpx: number }, sx: number, sy: number, canvasW: number, canvasH: number): { lat: number; lng: number } {
  const fx = vb.fx + (sx - canvasW / 2) / vb.wpx;
  const fy = vb.fy + (sy - canvasH / 2) / vb.wpx;
  const lng = fx * 360 - 180;
  const nn = Math.PI - 2 * Math.PI * fy;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn)));
  return { lat, lng };
}

/** Общий LRU-кэш изображений тайлов для ВСЕХ мини-панелей (экономит трафик OSM) */
const sharedTileCache = new Map<string, HTMLImageElement | null>();
const SHARED_CACHE_MAX = 400;
let sharedActiveLoads = 0;
const SHARED_MAX_PARALLEL = 4; // щадим tile.openstreetmap.org (суммарно по всем панелям)

function cacheTile(url: string, img: HTMLImageElement | null): void {
  sharedTileCache.set(url, img);
  if (sharedTileCache.size > SHARED_CACHE_MAX) {
    const firstKey = sharedTileCache.keys().next().value as string | undefined;
    if (firstKey !== undefined) sharedTileCache.delete(firstKey);
  }
}

const MiniMapPanel: React.FC<MiniMapPanelProps> = ({
  title, icon, center, zoom = 11, fitPoints, minZoom = 3, maxZoom = 19,
  points = [], lines = [], height = 260, onReady,
  focused = false, onFocus, onMapClick, zones = [],
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 320, h: typeof height === 'number' ? height : 260 });
  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // Вид панели — локальный ref (не трогает глобальный viewState основного канваса)
  const viewRef = useRef<PanelView>({ zoom, fx: (center.lng + 180) / 360, fy: 0.5 - Math.log((1 + Math.sin(center.lat * Math.PI / 180)) / (1 - Math.sin(center.lat * Math.PI / 180))) / (4 * Math.PI) });
  const [, forceTick] = useState(0);
  const tickRef = useRef(0);
  const bump = useCallback(() => { tickRef.current++; forceTick(tickRef.current); }, []);

  // Авто-вид по точкам (для «весь маршрут») — при смене набора точек
  const fitKey = fitPoints && fitPoints.length > 0 ? fitPoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|') : '';
  const lastFitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fitPoints || fitPoints.length === 0) return;
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    const aspect = sizeRef.current.w > 0 && sizeRef.current.h > 0 ? sizeRef.current.w / sizeRef.current.h : 1.5;
    const v = fitView(fitPoints, aspect, minZoom, maxZoom);
    if (v) { viewRef.current = v; bump(); }
  }, [fitKey, fitPoints, minZoom, maxZoom, bump]);

  // Размер контейнера
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(120, Math.round(r.width)), h: Math.max(120, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Отрисовка: тайлы + оверлеи, строгая привязка координат
  const drawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = sizeRef.current;
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1729';
    ctx.fillRect(0, 0, w, h);

    const v = viewRef.current;
    const vb = viewBox(v, w, h);
    const level = Math.max(minZoom, Math.min(maxZoom, Math.round(v.zoom)));
    const n = Math.pow(2, level);
    const tileSize = vb.wpx / n; // экранных px на тайл (плавный непрерывный зум)
    // мир уровня: x = fx·256·2^level; экран = (x_worldLevel - fx_center·worldPx_level) + w/2
    const toTileScreen = (tx: number, ty: number): { x: number; y: number } => ({
      x: (tx * tileSize) - v.fx * (n * tileSize) + w / 2,
      y: (ty * tileSize) - v.fy * (n * tileSize) + h / 2,
    });
    const tx0 = Math.floor(v.fx * n - w / tileSize / 2) - 1;
    const tx1 = Math.ceil(v.fx * n + w / tileSize / 2) + 1;
    const ty0 = Math.floor(v.fy * n - h / tileSize / 2) - 1;
    const ty1 = Math.ceil(v.fy * n + h / tileSize / 2) + 1;
    const need: { url: string; tx: number; ty: number }[] = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++) {
        if (tx < 0 || tx >= n) continue;
        const url = getOSMTileUrl(level, tx, ty, 'osm', 'scheme');
        const img = sharedTileCache.get(url);
        if (img === undefined) { need.push({ url, tx, ty }); continue; }
        if (img === null) continue; // ошибка загрузки — пропускаем (фон остаётся)
        const p = toTileScreen(tx, ty);
        ctx.drawImage(img, p.x, p.y, tileSize + 0.5, tileSize + 0.5);
      }
    }
    // Дозагрузка недостающих тайлов общей бережной очередью
    if (need.length > 0) {
      const cxw = w / 2, cyw = h / 2;
      need.sort((a, b) => {
        const pa = toTileScreen(a.tx, a.ty), pb = toTileScreen(b.tx, b.ty);
        return ((pa.x - cxw) ** 2 + (pa.y - cyw) ** 2) - ((pb.x - cxw) ** 2 + (pb.y - cyw) ** 2);
      });
      for (const t of need.slice(0, 24)) { // жёсткий лимит запросов на перерисовку
        if (sharedActiveLoads >= SHARED_MAX_PARALLEL) break;
        sharedActiveLoads++;
        loadTileImage(t.url, 10000)
          .then((loaded) => { cacheTile(t.url, loaded); })
          .finally(() => { sharedActiveLoads--; bump(); });
      }
    }

    // Линии (маршруты)
    for (const ln of lines) {
      if (ln.pts.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = ln.color || '#22d3ee';
      ctx.lineWidth = ln.width || 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (ln.dashed) ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ln.pts.forEach((p, i) => {
        const s = geoToScreenPx(p.lat, p.lng, vb, w, h);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // Зоны ограничений (для панели в режиме редактирования).
    // radiusM — радиус в МЕТРАХ (передаётся вызывающим кодом), рисуется точно
    // через масштаб панели (м/пиксель с учётом широты).
    for (const zn of zones) {
      ctx.save();
      ctx.strokeStyle = zn.color || 'rgba(248,113,113,0.9)';
      ctx.fillStyle = 'rgba(248,113,113,0.13)';
      ctx.lineWidth = 1.5;
      if (zn.radiusM && zn.centerGeo) {
        const c = geoToScreenPx(zn.centerGeo.lat, zn.centerGeo.lng, vb, w, h);
        const mppPanel = metersPerPixel(v.zoom, mercLatOf(v));
        const rScreen = zn.radiusM / Math.max(mppPanel, 1e-9);
        ctx.beginPath(); ctx.arc(c.x, c.y, Math.min(rScreen, 4000), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else if (zn.pts.length >= 2) {
        ctx.beginPath();
        zn.pts.forEach((p, i) => {
          const s = geoToScreenPx(p.lat, p.lng, vb, w, h);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    // Точки (старт/цели дронов)
    for (const pt of points) {
      const s = geoToScreenPx(pt.lat, pt.lng, vb, w, h);
      ctx.save();
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = pt.color || '#facc15'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0f1729'; ctx.stroke();
      if (pt.label) {
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(pt.label).width;
        ctx.fillStyle = 'rgba(15,23,41,0.85)';
        ctx.fillRect(s.x + 9, s.y - 8, tw + 8, 16);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(pt.label, s.x + 13, s.y);
      }
      ctx.restore();
    }

    // Плашка масштаба (фактический текущий)
    const mpp = metersPerPixel(v.zoom, mercLatOf(v));
    // м на 1 см ЭКРАНА: 1 см = 96/2.54 css-px ⇒ m1cm = mpp·37.795
    const m1cm = mpp * (96 / 2.54);
    const txt = m1cm >= 1000 ? `1 см ≈ ${(m1cm / 1000).toFixed(1)} км` : m1cm >= 1 ? `1 см ≈ ${m1cm.toFixed(m1cm < 10 ? 1 : 0)} м` : `1 см ≈ ${Math.round(m1cm * 100)} см`;
    ctx.save();
    ctx.font = '10px sans-serif';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(15,23,41,0.8)';
    ctx.fillRect(6, h - 22, tw + 12, 16);
    ctx.fillStyle = '#7dd3fc';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, 12, h - 14);
    // масштабная линейка: отрезок ровно 1 см экрана (37.795 css-px) — подпись слева
    // показывает, сколько метров на местности в него помещается (при 1см=2км это ~100px при mpp≈52.9)
    // длина линейки ~1 см эталонного масштаба в текущих px: при mpp==GROUND_MPP_1CM_2KM это ровно 1 см экрана
    const barPx = Math.max(20, Math.min(140, (GROUND_MPP_1CM_2KM / Math.max(mpp, 1e-9)) * (96 / 2.54)));
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(w - barPx - 10, h - 14); ctx.lineTo(w - 10, h - 14); ctx.stroke();
    ctx.restore();
  }, [lines, points, zones, minZoom, maxZoom, bump]);

  function mercLatOf(v: PanelView): number {
    const nn = Math.PI - 2 * Math.PI * v.fy;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn)));
  }

  // Перерисовка на каждый тик/ресайз
  useEffect(() => { drawAll(); }, [drawAll, size, tickRef.current]);

  // Управление: wheel (не-passive!), touch, кнопки зума + клики редактирования
  const focusedRef = useRef(focused);
  useEffect(() => { focusedRef.current = focused; }, [focused]);
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rectOf = () => canvas.getBoundingClientRect();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rectOf();
      viewRef.current = zoomPanelAt(viewRef.current, e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX - r.left, e.clientY - r.top, sizeRef.current.w, sizeRef.current.h, minZoom, maxZoom);
      bump();
    };
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, moved: false }; canvas.setPointerCapture?.(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag = { x: e.clientX, y: e.clientY, moved: drag.moved };
      viewRef.current = panPanelBy(viewRef.current, dx, dy, sizeRef.current.w, sizeRef.current.h);
      bump();
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag?.moved;
      drag = null;
      if (wasDrag) return;
      // Клик (без перетаскивания): неактивная панель — фокусируется;
      // активная в режиме редактирования — передаёт гео-точку вызывающему коду.
      const r = rectOf();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return;
      if (!focusedRef.current) { onFocusRef.current?.(); return; }
      if (onMapClickRef.current) {
        const { w, h } = sizeRef.current;
        const vb = viewBox(viewRef.current, w, h);
        onMapClickRef.current(screenPxToGeoPanel(vb, sx, sy, w, h));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [bump, minZoom, maxZoom]);

  const zoomBy = (f: number) => {
    viewRef.current = zoomPanelAt(viewRef.current, f, size.w / 2, size.h / 2, size.w, size.h, minZoom, maxZoom);
    bump();
  };
  const recenter = () => {
    if (fitPoints && fitPoints.length > 0) {
      const aspect = size.w / Math.max(1, size.h);
      const v = fitView(fitPoints, aspect, minZoom, maxZoom);
      if (v) { viewRef.current = v; bump(); return; }
    }
    const s = Math.sin((center.lat * Math.PI) / 180);
    viewRef.current = { zoom, fx: (center.lng + 180) / 360, fy: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
    bump();
  };

  useEffect(() => { onReady?.(); /* панель готова к экспорту PNG */ }, [onReady, size]);

  const btn = 'w-7 h-7 flex items-center justify-center rounded bg-gray-800/90 hover:bg-gray-700 text-gray-100 border border-gray-600 text-sm select-none';
  return (
    <div
      className={`rounded-lg overflow-hidden ${focused ? 'border-2 border-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.35)]' : 'border border-gray-700'}`}
      style={{ height }}
    >
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700 bg-gray-800/60">
        <span className="text-xs font-bold text-cyan-300">{icon} {title}</span>
        {focused && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-800/80 text-emerald-100 border border-emerald-500 animate-pulse">✏️ редактируется — клик по карте добавляет точку</span>}
        <div className="flex-1" />
        <button className={btn} title="Приблизить" onClick={() => zoomBy(1.5)}>＋</button>
        <button className={btn} title="Отдалить" onClick={() => zoomBy(1 / 1.5)}>－</button>
        <button className={btn} title="Вписать объект / сбросить вид" onClick={recenter}>⌂</button>
      </div>
      <div ref={wrapRef} className="relative w-full" style={{ height: `calc(100% - 30px)` }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: focused && onMapClick ? 'crosshair' : 'grab' }} aria-label={`Карта: ${title}`} />
      </div>
    </div>
  );
};

export default MiniMapPanel;
