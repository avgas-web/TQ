// ─── РЕНДЕР ПОЛЬЗОВАТЕЛЬСКИХ ТАКТИЧЕСКИХ КАРТ НА CANVAS (Задача 2, п.3) ────
// Единая математика Web Mercator со слоем тайлов OSM: world-пиксели
//   wpX(lng) = (lng+180)/360 · W,   wpY(lat) = (1 − ln(tan+sec)/π)/2 · W,
// где W = мир в экранных px текущего вида. Растр оверлея (GeoTIFF/PNG/JPEG)
// привязан к georef.boundsWgs84: пиксель (col,row) -> mercator-доля мира через
// линейное интерполирование по X (lon равноразмерен) и по Y (mercator).
// Векторы KML/GeoJSON рисуются тем же аффинным преобразованием geo->screen.
import type { MapBounds, TacticalOverlayLayer, TacticalOverlayVector } from '../types';
import { latToMercY } from './tacticalMapParsers';

export interface OverlayView {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** Привязка «гео → экран» растра карты map.width×map.height, покрывающего bounds
 *  (та же формула, что у drawUserPosition/объектов MapCanvas). */
export function makeRasterToScreen(
  view: OverlayView,
  bounds: MapBounds,
  mapWidth: number,
  mapHeight: number,
): (lat: number, lng: number) => { x: number; y: number } {
  const topY = latToMercY(bounds.north);
  const botY = latToMercY(bounds.south);
  const mercSpan = Math.max(1e-12, botY - topY);
  return (lat: number, lng: number) => {
    const mx = ((lng - bounds.west) / Math.max(1e-12, bounds.east - bounds.west)) * mapWidth;
    const my = ((latToMercY(lat) - topY) / mercSpan) * mapHeight;
    return { x: mx * view.scale + view.offsetX, y: my * view.scale + view.offsetY };
  };
}

/**
 * Позиция и размер растрового слоя оверлея на экране.
 * Инвариант (ЖЁСТКАЯ привязка): углы bounding box слоя попадают ровно в те же
 * экранные точки, что и соответствующие координаты подложки — при любом зуме и
 * панораме. Считается через mercator-доли МИРА того же масштаба, что использует
 * тайловый слой (worldPx = canvasHeight·2^zoom), затем affine вида.
 */
export function overlayRasterRect(
  layer: TacticalOverlayLayer,
  view: OverlayView,
  worldPx: number,
): { x: number; y: number; w: number; h: number } | null {
  const b = layer.georef.boundsWgs84;
  if (![b.north, b.south, b.east, b.west].every(Number.isFinite)) return null;
  const fracX0 = (b.west + 180) / 360;
  const fracX1 = (b.east + 180) / 360;
  // mercator-доля сверху мира (как в тайловой схеме: y растёт на юг)
  const mN = latToMercY(b.north);
  const mS = latToMercY(b.south);
  const mTop = latToMercY(85.0511287798066);
  const mBot = latToMercY(-85.0511287798066);
  const fracY0 = (mTop - mN) / (mTop - mBot);
  const fracY1 = (mTop - mS) / (mTop - mBot);
  const x = view.offsetX + fracX0 * worldPx;
  const y = view.offsetY + fracY0 * worldPx;
  return { x, y, w: (fracX1 - fracX0) * worldPx, h: (fracY1 - fracY0) * worldPx };
}

/** Нарисовать один растровый слой поверх подложки. src — декодированное изображение. */
export function drawTacticalRasterLayer(
  g: CanvasRenderingContext2D,
  layer: TacticalOverlayLayer,
  img: HTMLImageElement | ImageBitmap,
  view: OverlayView,
  worldPx: number,
  canvasW: number,
  canvasH: number,
): void {
  const r = overlayRasterRect(layer, view, worldPx);
  if (!r) return;
  // отсечение вне экрана — не тратим растеризацию на невидимые слои
  if (r.x + r.w < 0 || r.y + r.h < 0 || r.x > canvasW || r.y > canvasH) return;
  g.save();
  g.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
  g.imageSmoothingEnabled = true;
  (g as any).imageSmoothingQuality = 'high';
  g.drawImage(img as CanvasImageSource, r.x, r.y, r.w, r.h);
  g.restore();
}

// ─── ВНЕШНИЙ КЭШ ДЕКОДИРОВАННЫХ РАСТРОВ СЛОЁВ ──────────────────────────────
// base64-payload хранится в IndexedDB/Zustand-сторе, но декодированные
// HTMLImageElement вынесены в этот кэш (вне React-стейта — без ре-рендеров).
// LRU: при переполнении старые изображения выгружаются (освобождение памяти).
const rasterImgCache = new Map<string, HTMLImageElement>();
const pendingRasters = new Map<string, Promise<HTMLImageElement | null>>();
const RASTER_CACHE_MAX = 32;

export function getCachedOverlayRaster(id: string): HTMLImageElement | null {
  return rasterImgCache.get(id) ?? null;
}

/** Гарантированно освобождает память слоя при удалении/размонтировании */
export function evictOverlayRaster(id: string): void {
  const img = rasterImgCache.get(id);
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.src = ''; // обрыв загрузки/освобождение декодированных пикселей
    rasterImgCache.delete(id);
  }
  pendingRasters.delete(id);
}

/** Асинхронно получить декодированное изображение слоя из payload (data URL) */
export function ensureOverlayRaster(id: string, payload: string | null): Promise<HTMLImageElement | null> {
  const cached = rasterImgCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = pendingRasters.get(id);
  if (pending) return pending;
  if (!payload || !payload.startsWith('data:image/')) return Promise.resolve(null);
  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      pendingRasters.delete(id);
      rasterImgCache.set(id, img);
      // LRU-вытеснение: Map сохраняет порядок вставки — удаляем самые старые
      while (rasterImgCache.size > RASTER_CACHE_MAX) {
        const oldestKey = rasterImgCache.keys().next().value as string;
        evictOverlayRaster(oldestKey);
      }
      resolve(img);
    };
    img.onerror = () => {
      pendingRasters.delete(id);
      img.src = '';
      resolve(null);
    };
    img.src = payload;
  });
  pendingRasters.set(id, p);
  return p;
}

const DEFAULT_VECTOR_COLORS = ['#f472b6', '#22d3ee', '#a78bfa', '#fb923c'];

/** Нарисовать векторные геометрии слоя (KML/GeoJSON полигоны и линии) */
export function drawTacticalVectorLayer(
  g: CanvasRenderingContext2D,
  layer: TacticalOverlayLayer,
  toScreen: (lat: number, lng: number) => { x: number; y: number },
): void {
  const vectors: TacticalOverlayVector[] = layer.vectors || [];
  if (vectors.length === 0) return;
  g.save();
  g.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
  vectors.forEach((v, i) => {
    if (!v.ring || v.ring.length < 2) return;
    const color = v.color || DEFAULT_VECTOR_COLORS[i % DEFAULT_VECTOR_COLORS.length];
    g.beginPath();
    v.ring.forEach((p, j) => {
      const s = toScreen(p.lat, p.lng);
      if (j === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y);
    });
    if (v.kind === 'polygon') {
      g.closePath();
      g.fillStyle = color + '33'; // ~20% fill
      g.fill();
    }
    g.strokeStyle = color;
    g.lineWidth = v.kind === 'polygon' ? 1.5 : 2;
    g.stroke();
    if (v.name) {
      const anchor = toScreen(v.ring[0].lat, v.ring[0].lng);
      g.fillStyle = color;
      g.font = '11px sans-serif';
      g.textAlign = 'left';
      g.fillText(v.name, anchor.x + 4, anchor.y - 4);
    }
  });
  g.restore();
}
