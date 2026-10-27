// ─── pick-геокодирования: экранный пиксель -> WGS-84 ────────────────────────
// ЕДИНЫЙ СТАНДАРТ возвращаемых координат клика по карте: { lat, lng }.
//
// ИСПРАВЛЕНИЕ РАССИНХРОНИЗАЦИИ КООРДИНАТ (аудит, задача 1.2): раньше модуль
// возвращал `{ lat, lon }`, тогда как весь стек расчётов (elevation.ts —
// ElevationPoint.lng, routing.pixelToGeoExact — GeoPoint.lng, геокодинг —
// { lat, lng }) потребляет поле `lng`. Из-за этого рельеф и обратный геокодинг
// получали `undefined` вместо долготы (NaN в запросах к Open-Elevation /
// Nominatim, молчаливый отказ высот). Сигнатура приведена к стандарту
// { lat, lng }; совместимость со старыми вызовами (.lon) сохранена через
// устаревшее поле-алиас, помеченное @deprecated.
import type { MapBounds, Point } from '../types';
import { latToMercatorY, mercatorYToLat } from './googleMaps';

export interface GeoPick {
  lat: number;
  lng: number;
}

/** Нормализатор «сырых» пар координат из любых источников (старые сериализованные
 *  проекты с полем `lon`, ответы Nominatim `{lat, lon}`, клики `{lat, lng}`).
 *  Единый стандарт на выходе — { lat, lng } (аудит 1.2): потребители рельефа и
 *  геокодинга больше никогда не получают undefined вместо долготы. */
export function normalizeGeoPick(raw: { lat?: any; lng?: any; lon?: any } | null | undefined): GeoPick {
  const lngRaw = raw?.lng !== undefined && raw?.lng !== null ? raw.lng : raw?.lon;
  return { lat: Number(raw?.lat), lng: Number(lngRaw) };
}

/** Пиксель экрана/канваса -> гео WGS-84 при affine-привязке вида
 *  (screen = rasterPx·scale + offset) и растру карты с Mercator-bounds.
 *  Формула идентична pixelToGeoExact(routing.ts) — единый источник математики. */
export function screenToGeo(
  screen: Point,
  view: { offsetX: number; offsetY: number; scale: number },
  bounds: MapBounds,
  mapWidth: number,
  mapHeight: number,
): GeoPick {
  if (!Number.isFinite(view.scale) || view.scale === 0 || mapWidth <= 0 || mapHeight <= 0) {
    return { lat: NaN, lng: NaN };
  }
  const fx = Math.max(0, Math.min(1, ((screen.x - view.offsetX) / view.scale) / mapWidth));
  const fy = Math.max(0, Math.min(1, ((screen.y - view.offsetY) / view.scale) / mapHeight));
  const topY = latToMercatorY(bounds.north);
  const botY = latToMercatorY(bounds.south);
  return {
    lat: mercatorYToLat(topY + (botY - topY) * fy),
    lng: bounds.west + (bounds.east - bounds.west) * fx,
  };
}

// ─── Wizard-мост: экран мастера (полноэкранный div панели) -> реальные WGS-84 ──
// Зеркало вида 'tq-view' публикуется MapCanvas синхронно (offsetX/offsetY/scale/z0
// + фактические width/height канваса). Мастер конвертирует клики по ЭТОЙ ЖЕ
// Mercator-формуле, что и слой тайлов: worldPx = canvasH·2^(z0+log2(scale)),
//   screen = offsetX + frac(lng)·worldPx ; screen = offsetY + frac(lat)·worldPx.
// Обратная задача (экран -> гео) решается аналитически — та же математика, что
// в geoToScreen выше (привязка через доли мира, независимые от bounds подложки).

export interface WizardViewMirror {
  offsetX: number;
  offsetY: number;
  scale: number;
  z0?: number;
  width?: number;
  height?: number;
}

const VIEW_MIRROR_KEY = 'tq-view';

/** Прочитать зеркало вида из localStorage (источник истины MapCanvas). */
export function readWizardViewMirror(): WizardViewMirror | null {
  try {
    const raw = localStorage.getItem(VIEW_MIRROR_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as WizardViewMirror;
    if (!v || !Number.isFinite(v.offsetX) || !Number.isFinite(v.offsetY) || !(v.scale > 0)) return null;
    return v;
  } catch {
    return null;
  }
}

const MERC_MAX_LAT = 85.0511287798066;

/** Клик по контейнеру карты мастера -> СТРОГИЕ координаты WGS-84 или null,
 *  если зеркало вида ещё не опубликовано / размеры не зафиксированы.
 *  Перегруженная форма совместима со старыми вызовами (sx, sy, rectHeight). */
export function wizardClickToGeo(sx: number, sy: number, canvasHeight: number): { lat: number; lng: number } | null;
export function wizardClickToGeo(mirror: WizardViewMirror | null, sx: number, sy: number): { lat: number; lng: number } | null;
export function wizardClickToGeo(
  a: number | WizardViewMirror | null,
  b: number,
  c: number,
): { lat: number; lng: number } | null {
  let mirror: WizardViewMirror | null;
  let sx: number;
  let sy: number;
  if (typeof a === 'number') {
    // Старая сигнатура: (sx, sy, canvasHeight) — зеркало читаем сами.
    sx = a; sy = b;
    mirror = readWizardViewMirror();
    if (mirror && !(Number.isFinite(mirror.height!) && mirror.height! > 0)) {
      mirror = { ...mirror, height: c }; // fallback на высоту контейнера из вызова
    }
  } else {
    mirror = a; sx = b; sy = c;
  }
  if (!mirror) return null;
  const canvasH = Number.isFinite(mirror.height!) && mirror.height! > 0 ? mirror.height! : NaN;
  if (!Number.isFinite(canvasH)) return null;
  const z0 = Number.isFinite(mirror.z0!) ? (mirror.z0 as number) : 14;
  const worldPx = Math.max(256, canvasH * Math.pow(2, z0 + Math.log2(Math.max(mirror.scale, 1e-12))));
  // Доли мира из экранных координат (без clamp: клик вне карты мастерской
  // панели всё равно даёт честную гео-координату продолжения мира).
  const fracX = (sx - mirror.offsetX) / worldPx;
  const fracY = (sy - mirror.offsetY) / worldPx;
  const lng = ((fracX % 1) + 1) % 1 * 360 - 180;
  // mercator-доля сверху мира -> широта (обратная формура тайловой схемы)
  const mTop = latToMercatorY(MERC_MAX_LAT);
  const mBot = latToMercatorY(-MERC_MAX_LAT);
  const mercY = mTop + (mBot - mTop) * fracY;
  if (!Number.isFinite(mercY)) return null;
  const lat = mercatorYToLat(Math.max(mTop, Math.min(mBot, mercY)));
  return { lat, lng };
}

/** Гео -> пиксель экрана (прямая задача, та же формула что у слоя тайлов OSM). */
export function geoToScreen(
  geo: { lat: number; lng: number },
  view: { offsetX: number; offsetY: number; scale: number },
  bounds: MapBounds,
  mapWidth: number,
  mapHeight: number,
): Point {
  const topY = latToMercatorY(bounds.north);
  const botY = latToMercatorY(bounds.south);
  const x = (((geo.lng - bounds.west) / (bounds.east - bounds.west)) * mapWidth) * view.scale + view.offsetX;
  const y = (((latToMercatorY(geo.lat) - topY) / (botY - topY)) * mapHeight) * view.scale + view.offsetY;
  return { x, y };
}
