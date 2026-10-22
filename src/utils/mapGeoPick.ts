// ═══════════════════════════════════════════════════════════════
// mapGeoPick — СТРОГАЯ гео-привязка клика по живой карте (режим мастера).
//
// КОРНЕВАЯ ПРИЧИНА «координаты не соответствуют реальному месту»: раньше
// клик по карте мастера конвертировался НЕ к подложке, а к нормированному
// полю 1000×700 псевдо-карты (readCanvasClick: nx·1000 → pxToLon/pyToLat —
// равнопромежуточная широта!). Ставишь точку на Неву в Петербурге — получаешь
// случайные координаты где-то в другой части света.
//
// Теперь используется ТОТА ЖЕ формула экрана↔мира, что и внутри MapCanvas
// (см. loadActiveTileHere / positionTileLayer):
//   worldPx = canvasHeight · 2^zoom,  zoom = z0 + log2(scale)   (инвариант вида)
//   lng = (sx − offsetX)/worldPx · 360 − 180
//   lat = mercToLat((sy − offsetY)/worldPx)
// offset/scale/z0 читаются из localStorage-зеркала 'tq-view' — единого
// источника истины вида для обоих режимов (редактор/мастер), поэтому точка
// ставится ровно туда, куда кликнули, при любом зуме и панораме.
// ═══════════════════════════════════════════════════════════════

export interface GeoPick { lat: number; lon: number }

const VIEW_STORAGE_KEY = 'tq-view';
/** Эталонный уровень привязки (тот же ZOOM_REF, что в MapCanvas). */
export const ZOOM_REF = 14;

/** Нормализованная Mercator Y широты (0..1) — зеркало MapCanvas.latToMerc. */
export function latToMerc(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Обратная Mercator: нормализованная Y → широта — зеркало MapCanvas.mercToLat. */
export function mercToLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

interface RawView { offsetX: number; offsetY: number; scale: number; z0?: number; width?: number; height?: number }

function readMirrorView(): RawView | null {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RawView>;
    const offsetX = Number(v.offsetX);
    const offsetY = Number(v.offsetY);
    const scale = Number(v.scale);
    // Санатор: один NaN делал все последующие вычисления NaN («точки в никуда»).
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !(scale > 0)) return null;
    const width = Number(v.width);
    const height = Number(v.height);
    return {
      offsetX, offsetY, scale,
      z0: Number.isFinite(Number(v.z0)) ? Number(v.z0) : undefined,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    };
  } catch {
    return null;
  }
}

/** Размер мира в пикселях для текущего вида канваса высотой canvasH
 *  (та же формула worldPxOf, что в MapCanvas). */
export function worldPxOf(canvasH: number, scale: number, z0: number = ZOOM_REF): number {
  return canvasH * Math.pow(2, z0) * scale;
}

/** Экранные координаты клика (относительно канваса) → реальные WGS84.
 *  @param sx экран X относительно левого края канваса
 *  @param sy экран Y относительно верхнего края канваса
 *  @param canvasH высота канваса в CSS-пикселях (мировая шкала привязана к ней)
 *  @param fallback центр обзора при недоступном зеркале вида (СПб по умолчанию)
 *  Возвращает null только если координаты физически невалидны. */
export function screenToGeo(
  sx: number,
  sy: number,
  canvasH: number,
  fallback: GeoPick = { lat: 59.9398, lon: 30.3146 },
): GeoPick | null {
  const v = readMirrorView();
  // ФИКС «Не удалось определить размер карты»: если контейнер мастера в данный
  // момент имеет нулевую высоту (jsdom / поздний layout), берём базу из зеркала
  // 'tq-view' — MapCanvas пишет туда фактические CSS-размеры канваса при каждой
  // публикации вида. Это сохраняет СТРОГУЮ привязку клика к реальной подложке
  // даже когда локальный замер недоступен.
  const h = canvasH > 0 ? canvasH : (v?.height ?? 0);
  if (!v || !(h > 0)) {
    // Нет сохранённого вида (первый кадр до любого жеста) — используем
    // дефолтный вид MapCanvas {offset:0, scale:1, z0:ZOOM_REF}: мир =
    // canvasH·2^14 px; клик по центру канваса даёт СПб-окрестности центра
    // карты — это всё ещё строгая формула, а не псевдо-поле.
    if (!(h > 0)) return null;
    const wp = worldPxOf(h, 1, ZOOM_REF);
    const lon = (sx / wp) * 360 - 180;
    const lat = mercToLat(sy / wp);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  const wp = worldPxOf(h, v.scale, v.z0 ?? ZOOM_REF);
  const lon = ((sx - v.offsetX) / wp) * 360 - 180;
  const lat = mercToLat((sy - v.offsetY) / wp);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -85.06 || lat > 85.06) return null; // за пределами тайловой проекции Web Mercator
  // Долгота живёт на бесконечной горизонтальной ленте карт: при панораме за
  // край «основного» диапазона [-180..180] координата оборачивается обратно —
  // это всё ещё СТРОГО та же реальная точка (Web Mercator периодичен по X).
  return { lat, lon: ((lon + 540) % 360) - 180 };
}
