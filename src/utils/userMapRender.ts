// ─── Рендер пользовательских тактических карт ────────────────────────────────
// Слой рисуется ПОВЕРХ базовой подложки (OSM/Google/Yandex) в той же
// Web-Mercator-системе координат, что и весь остальной проект:
//   screenX = worldFracX · worldPx + offsetX,  worldPx = canvasH · 2^zoom.
// Поэтому полигоны/линии/растры «приклеены» к географии и не расходятся с
// тайлами ни на одном зуме (включая интерполяцию между уровнями).

import type { MapBounds, UserMapFeature, UserMapLayer } from '../types';
import { lngLatToWorldFrac, boundsToWorldRect } from './userMapGeo';

// ─── Асинхронный кэш изображений слоёв ───────────────────────────────────────
// Декодирование больших PNG/JPG не блокирует рендер: элемент создаётся сразу,
// готовность отслеживается по onload/onerror, а подписчики (MapCanvas)
// перерисовываются через onImageReady. При смене данных слоя старый элемент
// открепляется, чтобы onload не рисовал устаревшее изображение.

interface LayerImageEntry {
  el: HTMLImageElement;
  ready: boolean;
  failed: boolean;
  /** src на момент создания — защита от «протухших» колбэков */
  src: string;
}

const imageCache = new Map<string, LayerImageEntry>();

/** Обратный вызов «изображение стало готово» — задаёт компонент-рицатель */
let imageReadyCb: ((layerId: string) => void) | null = null;
export function setUserLayerImageListener(cb: ((layerId: string) => void) | null): void {
  imageReadyCb = cb;
}

export function getUserLayerImage(layer: UserMapLayer): HTMLImageElement | null {
  if (!layer.imageDataUrl) return null;
  const cached = imageCache.get(layer.id);
  if (cached && cached.src === layer.imageDataUrl) return cached.el;
  if (typeof Image === 'undefined') return null;
  const el = new Image();
  const entry: LayerImageEntry = { el, ready: false, failed: false, src: layer.imageDataUrl };
  el.onload = () => {
    entry.ready = true;
    imageReadyCb?.(layer.id);
  };
  el.onerror = () => {
    entry.failed = true;
    imageReadyCb?.(layer.id);
  };
  imageCache.set(layer.id, entry);
  el.src = layer.imageDataUrl;
  return el;
}

/** Слой готов к отрисовке (изображение декодировано и не ошибочно) */
export function isUserLayerImageReady(layer: UserMapLayer): boolean {
  if (!layer.imageDataUrl) return false;
  const e = imageCache.get(layer.id);
  if (!e) return false;
  if (e.src !== layer.imageDataUrl) return false;
  return e.ready && !e.failed;
}

export function isUserLayerImageFailed(layer: UserMapLayer): boolean {
  const e = imageCache.get(layer.id);
  return !!e && e.failed;
}

export function dropUserLayerImage(id: string): void {
  const e = imageCache.get(id);
  if (e) {
    // открепляем колбэки: устаревший decode не должен ничего перерисовывать
    e.el.onload = null;
    e.el.onerror = null;
    e.el.src = '';
  }
  imageCache.delete(id);
  mbtilesCache.delete(id);
  pendingMbtilesRequests.delete(id);
}

// ─── MBTiles: ленивое извлечение тайлов из SQLite (sql.js) ───────────────────
// Бинарник .mbtiles хранится в IndexedDB; при появлении слоя на экране мы один
// раз открываем его через sql.js и вытаскиваем ВВИДУЕМЫЕ тайлы нужного уровня
// (TMS -> XYZ flip). Декодер (decodeTile) даёт data URL для конкретного тайла —
// это позволяет работать и с PNG, и с JPEG без догадок о формате.
const mbtilesCache = new Map<string, Record<string, HTMLImageElement>>();
const pendingMbtilesRequests = new Set<string>();

/** Сколько тайлов видимой области запрашивать за одну волну (защита от z19-флуда) */
const MAX_TILES_PER_WAVE = 256;

export function getMbtilesTileImages(layerId: string): Record<string, HTMLImageElement> {
  return mbtilesCache.get(layerId) ?? {};
}

/**
 * Инициировать асинхронную выборку тайлов слоя для видимой области.
 * Возвращает true, если волна запроса стартовала (вызывается из рендера,
 * который затем перерисуется через imageReadyCb по мере готовности картинок).
 */
export function requestMbtilesTiles(
  layer: UserMapLayer,
  zoom: number, worldPx: number, offsetX: number, offsetY: number,
  viewW: number, viewH: number,
  loadSource: (layerId: string) => Promise<ArrayBuffer | null>,
  decodeTile: (buffer: ArrayBuffer, keys: string[]) => Promise<Record<string, string>>,
): boolean {
  const info = layer.tileInfo;
  if (!info || pendingMbtilesRequests.has(layer.id)) return false;
  const z = Math.max(info.minZoom, Math.min(info.maxZoom, Math.round(zoom)));
  const n = Math.pow(2, z);
  const tileWorldPx = worldPx / n;
  if (tileWorldPx <= 0) return false;

  const x0 = Math.max(0, Math.floor(-offsetX / tileWorldPx));
  const x1 = Math.min(n - 1, Math.floor((viewW - offsetX) / tileWorldPx));
  const y0 = Math.max(0, Math.floor(-offsetY / tileWorldPx));
  const y1 = Math.min(n - 1, Math.floor((viewH - offsetY) / tileWorldPx));

  const cache = mbtilesCache.get(layer.id) ?? {};
  const wanted: string[] = [];
  for (let x = x0; x <= x1 && wanted.length < MAX_TILES_PER_WAVE; x++) {
    for (let y = y0; y <= y1 && wanted.length < MAX_TILES_PER_WAVE; y++) {
      const key = `${z}/${x}/${y}`;
      if (cache[key]) continue;
      wanted.push(key);
    }
  }
  if (!wanted.length) return false;

  pendingMbtilesRequests.add(layer.id);
  try {
    // мгновенная «занятость» волны снимается сразу после старта: повторный вызов
    // на следующем кадре не блокируется надолго, а уже запрошенные ключи просто
    // отсутствуют в кэше до onload — дублей запросов не возникает ниже
    (async () => {
      try {
        const buffer = await loadSource(layer.id);
        if (!buffer) return;
        const urls = await decodeTile(buffer, wanted);
        const cur = mbtilesCache.get(layer.id) ?? {};
        let anyNew = false;
        for (const [key, dataUrl] of Object.entries(urls)) {
          if (!dataUrl || cur[key]) continue;
          const el = new Image();
          el.src = dataUrl;
          el.onload = () => imageReadyCb?.(layer.id);
          el.onerror = () => imageReadyCb?.(layer.id);
          cur[key] = el;
          anyNew = true;
        }
        if (anyNew) {
          mbtilesCache.set(layer.id, cur);
          imageReadyCb?.(layer.id);
        }
      } catch {
        /* битый источник — слой просто останется пустым, рендер не падаем */
      }
    })();
    return true;
  } finally {
    pendingMbtilesRequests.delete(layer.id);
  }
}

/** Прямоугольник bbox слоя в экранных пикселях */
export function layerScreenRect(
  layer: UserMapLayer, worldPx: number, offsetX: number, offsetY: number
): { x: number; y: number; w: number; h: number } {
  const r = boundsToWorldRect(effectiveBbox(layer));
  return {
    x: r.x0 * worldPx + offsetX,
    y: r.y0 * worldPx + offsetY,
    w: Math.max(0, (r.x1 - r.x0) * worldPx),
    h: Math.max(0, (r.y1 - r.y0) * worldPx),
  };
}

/** Пересчёт [lat,lng] -> экранный пиксель (та же формула, что у привязки растра) */
export function geoToScreen(lat: number, lng: number, worldPx: number, offsetX: number, offsetY: number) {
  const f = lngLatToWorldFrac(lng, lat);
  return { x: f.x * worldPx + offsetX, y: f.y * worldPx + offsetY };
}

/** Допуск экранного отбора: ширина обводки + маркер точки */
const VISIBILITY_MARGIN_PX = 64;

/**
 * Границы геометрии элементов слоя в WGS-84. Если bbox метаданных слоя пустой
 * или вырожден (0×0), а элементы заданы, берём реальные координаты элементов —
 * иначе слой с корректной геометрией никогда не попал бы в отбор по видимости.
 */
function featuresBoundsWgs84(features: UserMapFeature[] | undefined): MapBounds | null {
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  for (const f of features ?? []) {
    const rings = f.geometry.rings ?? [];
    for (const ring of rings) {
      for (const [lat, lng] of ring) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        north = Math.max(north, lat); south = Math.min(south, lat);
        east = Math.max(east, lng); west = Math.min(west, lng);
      }
    }
    for (const [lat, lng] of f.geometry.points ?? []) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      north = Math.max(north, lat); south = Math.min(south, lat);
      east = Math.max(east, lng); west = Math.min(west, lng);
    }
  }
  if (!Number.isFinite(north) || !Number.isFinite(west)) return null;
  return { north, south, east, west };
}

/**
 * Границы слоя для экранных расчётов. Если bbox метаданных вырожден (точечный
 * или линейный слой), границы берём из фактической геометрии элементов — иначе
 * такой слой имел бы нулевую площадь и никогда не попал бы в отбор к отрисовке.
 */
function effectiveBbox(layer: UserMapLayer): MapBounds {
  const b = layer.bbox;
  const validBox = !!b && Number.isFinite(b.north) && Number.isFinite(b.south) &&
    Number.isFinite(b.east) && Number.isFinite(b.west) && b.north >= b.south && b.east >= b.west;
  if (!validBox) {
    const fromFeatures = featuresBoundsWgs84(layer.features);
    if (fromFeatures) return fromFeatures;
  }
  return b;
}

/** Экранные координаты всех элементов слоя (для вырожденного bbox) */
function featureScreenPoints(
  layer: UserMapLayer, worldPx: number, offsetX: number, offsetY: number
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const f of layer.features ?? []) {
    for (const ring of f.geometry.rings ?? []) {
      for (const [lat, lng] of ring) out.push(geoToScreen(lat, lng, worldPx, offsetX, offsetY));
    }
    for (const [lat, lng] of f.geometry.points ?? []) {
      out.push(geoToScreen(lat, lng, worldPx, offsetX, offsetY));
    }
  }
  return out;
}

/** Есть ли смысл рисовать слой при текущем зуме (вне экрана / слишком мелко) */
export function layerIsVisibleOnScreen(
  layer: UserMapLayer, worldPx: number, offsetX: number, offsetY: number, viewW: number, viewH: number
): boolean {
  const r = layerScreenRect(layer, worldPx, offsetX, offsetY);
  if (r.w > 0 && r.h > 0) {
    return r.x < viewW && r.y < viewH && r.x + r.w > 0 && r.y + r.h > 0;
  }
  // Вырожденный bbox (точечный/линейный слой без площади): отбираем по
  // экранным координатам самих элементов с полем на толщину обводки.
  const pts = featureScreenPoints(layer, worldPx, offsetX, offsetY);
  if (!pts.length) {
    const m = VISIBILITY_MARGIN_PX;
    return r.x + m > 0 && r.x - m < viewW && r.y + m > 0 && r.y - m < viewH;
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs) - VISIBILITY_MARGIN_PX, maxX = Math.max(...xs) + VISIBILITY_MARGIN_PX;
  const minY = Math.min(...ys) - VISIBILITY_MARGIN_PX, maxY = Math.max(...ys) + VISIBILITY_MARGIN_PX;
  return minX < viewW && maxX > 0 && minY < viewH && maxY > 0;
}

/** Стиль элемента: цвет по умолчанию — различимый на любой подложке */
const DEFAULT_COLORS = ['#ff3d5a', '#ffb020', '#2bd4a7', '#4aa8ff', '#c07bff', '#ff7ad9'];

export function featureStyle(f: UserMapFeature, index: number) {
  const color = f.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
  return { color, fillOpacity: f.fillOpacity ?? 0.22, lineWidth: 2 };
}

/** Отрисовка векторного слоя: полигоны (с дырками), линии, точки */
export function drawVectorLayer(
  ctx: CanvasRenderingContext2D, layer: UserMapLayer,
  worldPx: number, offsetX: number, offsetY: number
): void {
  const features = layer.features ?? [];
  if (!features.length) return;
  ctx.save();
  ctx.globalAlpha = clamp01(layer.opacity);
  features.forEach((f, i) => {
    const st = featureStyle(f, i);
    const kind = f.geometry.kind;

    if (kind === 'polygon') {
      // единый путь с дырками (evenodd) — корректная заливка «пончика»
      const path = newPath();
      for (const ring of f.geometry.rings) {
        if (ring.length < 3) continue;
        ring.forEach(([lat, lng], j) => {
          const p = geoToScreen(lat, lng, worldPx, offsetX, offsetY);
          if (j === 0) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y);
        });
        path.closePath();
      }
      ctx.fillStyle = hexWithAlpha(st.color, st.fillOpacity);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.lineWidth;
      paintPath(ctx, path);
      ctx.fill('evenodd');
      ctx.stroke();
    } else if (kind === 'line') {
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.lineWidth;
      ctx.lineJoin = 'round';
      for (const ring of f.geometry.rings) {
        if (ring.length < 2) continue;
        ctx.beginPath();
        ring.forEach(([lat, lng], j) => {
          const p = geoToScreen(lat, lng, worldPx, offsetX, offsetY);
          if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }
    } else {
      // точки: квадратные маркеры фиксированного размера (не тонут при зуме-out)
      ctx.fillStyle = st.color;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      for (const [lat, lng] of f.geometry.points ?? []) {
        const p = geoToScreen(lat, lng, worldPx, offsetX, offsetY);
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
      }
    }
  });
  ctx.restore();
}

/**
 * Отрисовка растрового слоя (PNG/JPG-привязка или GeoTIFF-превью):
 * изображение растягивается ровно на свой bbox в экранной системе координат.
 * imageSmoothing включён только при уменьшении — при увеличении снимок
 * остаётся читаемым (пиксельно), как в основной карте проекта.
 */
export function drawRasterLayer(
  ctx: CanvasRenderingContext2D, layer: UserMapLayer, img: HTMLImageElement,
  worldPx: number, offsetX: number, offsetY: number
): void {
  // ждём фактической готовности (onload), а не только naturalWidth: в части
  // окружений naturalWidth появляется до завершения декодирования
  if (!isUserLayerImageReady(layer) || !img.naturalWidth || !img.naturalHeight) return;
  const r = layerScreenRect(layer, worldPx, offsetX, offsetY);
  if (r.w <= 0 || r.h <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp01(layer.opacity);
  const downscaling = r.w < img.naturalWidth;
  ctx.imageSmoothingEnabled = downscaling;
  if (downscaling) (ctx as any).imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/**
 * Отрисовка MBTiles-слоя доменными тайлами: для видимой области подбирается
 * ближайший доступный уровень [minZoom..maxZoom] и тайлы извлекаются из БД
 * асинхронно (getTile) — здесь рисуем только уже готовые (кэшированные).
 */
export function drawMbtilesTiles(
  ctx: CanvasRenderingContext2D, layer: UserMapLayer,
  tiles: Record<string, HTMLImageElement>, zoom: number,
  worldPx: number, offsetX: number, offsetY: number
): void {
  const info = layer.tileInfo;
  if (!info) return;
  const z = Math.max(info.minZoom, Math.min(info.maxZoom, Math.round(zoom)));
  const n = Math.pow(2, z);
  const tileWorldPx = worldPx / n;
  ctx.save();
  ctx.globalAlpha = clamp01(layer.opacity);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const sx = x * tileWorldPx + offsetX;
      const sy = y * tileWorldPx + offsetY;
      if (sx > ctx.canvas.width || sy > ctx.canvas.height || sx + tileWorldPx < 0 || sy + tileWorldPx < 0) continue;
      const img = tiles[`${z}/${x}/${y}`];
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, sx, sy, tileWorldPx + 1, tileWorldPx + 1);
    }
  }
  ctx.restore();
}

/** Рамка границ слоя (служебная, видна всегда когда слой включён) */
export function drawLayerOutline(
  ctx: CanvasRenderingContext2D, layer: UserMapLayer,
  worldPx: number, offsetX: number, offsetY: number
): void {
  const r = layerScreenRect(layer, worldPx, offsetX, offsetY);
  if (r.w <= 0 && r.h <= 0) return;
  ctx.save();
  ctx.setLineDash([6 / Math.max(r.w / 400, 0.2), 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function clampAlpha(v: number): number {
  return Math.round(clamp01(v) * 1e3) / 1e3;
}

/** #rgb/#rrggbb(+aa) -> rgba() c учётом альфы (для заливки полигонов) */
/**
 * #rgb / #rrggbb / #rrggbbaa -> rgba(r,g,b,a).
 * Альфа-канал есть только у 8-символьной формы: для #rgb/#rrggbb итоговая
 * прозрачность равна запрошенной, для #rrggbbaa — собственный канал × alpha.
 * Строки с недопустимыми символами дают чёрный с запрошенной альфой.
 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const raw = (hex || '').trim().replace(/^#/, '');
  let rgb = '';
  let own = 1;
  if (/^[0-9a-f]{3}$/i.test(raw)) rgb = raw.split('').map((c) => c + c).join('');
  else if (/^[0-9a-f]{6}$/i.test(raw)) rgb = raw;
  else if (/^[0-9a-f]{8}$/i.test(raw)) {
    rgb = raw.slice(0, 6);
    own = parseInt(raw.slice(6, 8), 16) / 255;
  }
  if (!rgb) return `rgba(0,0,0,${clampAlpha(alpha)})`;
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${clampAlpha(own * alpha)})`;
}

/**
 * Path2D отсутствует в jsdom — для тестов и старых движков используем
 * ctx-совместимый прокси, накапливающий команды и воспроизводящий их на fill/stroke.
 */
class Path2DPolyfill {
  private ops: Array<[string, ...number[]]> = [];
  moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
  lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
  closePath() { this.ops.push(['closePath']); }
  apply(ctx: CanvasRenderingContext2D | any) {
    ctx.beginPath();
    for (const [op, ...args] of this.ops) {
      if (op === 'closePath') ctx.closePath(); else (ctx as any)[op](...args);
    }
  }
}

type PaintPath = Path2D | Path2DPolyfill;

function newPath(): PaintPath {
  return typeof Path2D !== 'undefined' ? new Path2D() : new Path2DPolyfill();
}

function paintPath(ctx: CanvasRenderingContext2D | any, path: PaintPath) {
  if (path instanceof Path2DPolyfill) path.apply(ctx);
}

/** Hit-test: попал ли экранный клик в полигон/линию/точку слоя (для tooltips) */
/** Класс элемента для приоритета: 0 — точка, 1 — линия, 2 — зона (полигон) */
function hitRank(kind: string): number {
  return kind === 'point' ? 0 : kind === 'line' ? 1 : 2;
}

/**
 * Hit-test экранных координат по элементам слоя.
 * Мелкие объекты всегда приоритетнее крупных зон: иначе ADIZ (полигон)
 * «съедала» клики по целям и узлам боевого курса внутри неё. Поэтому сначала
 * ищем точку/линию, и только если их нет — отвечаем зоной-полигоном.
 */
export function hitTestFeature(
  layer: UserMapLayer, screenX: number, screenY: number,
  worldPx: number, offsetX: number, offsetY: number, tolPx = 6
): UserMapFeature | null {
  const features = layer.features ?? [];
  let zones: UserMapFeature | null = null;
  // Проход по рангам: сначала все точки (0), затем линии (1), затем полигоны-зоны (2).
  for (let rank = 0; rank <= 2; rank++) {
    for (const f of features) {
      if (hitRank(f.geometry.kind) !== rank) continue;
      if (rank < 2 && hitOne(f, screenX, screenY, worldPx, offsetX, offsetY, tolPx)) return f;
      if (rank === 2 && !zones && hitOne(f, screenX, screenY, worldPx, offsetX, offsetY, tolPx)) zones = f;
    }
  }
  return zones;
}

function hitOne(
  f: UserMapFeature, screenX: number, screenY: number,
  worldPx: number, offsetX: number, offsetY: number, tolPx: number
): boolean {
  if (f.geometry.kind === 'polygon') {
    for (const ring of f.geometry.rings) {
      const pts = ring.map(([lat, lng]) => geoToScreen(lat, lng, worldPx, offsetX, offsetY));
      if (pts.length >= 3 && pointInPolygon(screenX, screenY, pts)) {
        // дырки: если точка внутри дырки — попадание отменяется
        const holes = f.geometry.holes ?? [];
        const inHole = holes.some((idx) => {
          const hr = (f.geometry.rings[idx] ?? []).map(([lat, lng]) => geoToScreen(lat, lng, worldPx, offsetX, offsetY));
          return hr.length >= 3 && pointInPolygon(screenX, screenY, hr);
        });
        if (!inHole) return true;
      }
    }
    return false;
  }
  if (f.geometry.kind === 'line') {
    for (const ring of f.geometry.rings) {
      const pts = ring.map(([lat, lng]) => geoToScreen(lat, lng, worldPx, offsetX, offsetY));
      for (let i = 0; i < pts.length - 1; i++) {
        if (distPointSegment(screenX, screenY, pts[i], pts[i + 1]) <= tolPx) return true;
      }
    }
    return false;
  }
  for (const [lat, lng] of f.geometry.points ?? []) {
    const p = geoToScreen(lat, lng, worldPx, offsetX, offsetY);
    if (Math.hypot(screenX - p.x, screenY - p.y) <= tolPx + 4) return true;
  }
  return false;
}

function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPointSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
