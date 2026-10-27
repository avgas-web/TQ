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
