// ─── Геометрия пользовательских тактических карт ─────────────────────────────
// Единая Mercator-математика (та же, что в MapCanvas / googleMaps): все
// пользовательские слои привязываются к географии через нормализованные
// Web-Mercator доли мира (0..1), поэтому они жёстко «приклеены» к подложке
// на ЛЮБОМ зуме и не расходятся с тайлами.

import { latToMercatorY, mercatorYToLat } from './googleMaps';
import type { MapBounds } from '../types';

/**
 * Тайл (x, y) уровня z в Web-Mercator покрывает долготы
 * [x/n·360−180, (x+1)/n·360−180] и широты merc→lat[(y+1)/n]..merc→lat[y/n].
 * Используется для вычисления bbox тайловых наборов (MBTiles без metadata.bounds).
 */
export function tileBounds(z: number, x: number, y: number): MapBounds | null {
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const zi = Math.round(z);
  if (zi < 0 || zi > 30) return null;
  const n = Math.pow(2, zi);
  if (x < 0 || y < 0 || x >= n || y >= n) return null;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = mercatorYToLat(y / n);
  const south = mercatorYToLat((y + 1) / n);
  return { north, south, east, west };
}

/** EPSG:4326 (широта/долгота, градусы) */
export const EPSG_4326 = 'EPSG:4326';
/** EPSG:3857 (Web Mercator, метры) */
export const EPSG_3857 = 'EPSG:3857';

export type ProjectionId = typeof EPSG_4326 | typeof EPSG_3857;

/** Полная меркаторов широта (граница проекции) */
export const MAX_MERC_LAT = 85.051128779806;

const EARTH_RADIUS_M = 6378137;
const DEG2RAD = Math.PI / 180;

export interface WorldFrac { x: number; y: number }
export interface LngLatLike { lng: number; lat: number }

/** Долгота -> нормализованная X мира (0..1) */
export function lngToWorldX(lng: number): number {
  return ((lng + 180) % 360 + 360) % 360 / 360;
}

/** Нормализованная X мира -> долгота (-180..180) */
export function worldXToLng(x: number): number {
  return x * 360 - 180;
}

/** Широта/долгота -> нормализованные доли мира (0..1) */
export function lngLatToWorldFrac(lng: number, lat: number): WorldFrac {
  return { x: lngToWorldX(lng), y: latToMercatorY(lat) };
}

/** EPSG:4326 -> EPSG:3857 (метры Web Mercator) */
export function wgs84ToEpsg3857(lat: number, lng: number): { x: number; y: number } {
  const clamped = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
  return {
    x: EARTH_RADIUS_M * lng * DEG2RAD,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG2RAD) / 2)),
  };
}

/** EPSG:3857 -> EPSG:4326 */
export function epsg3857ToWgs84(x: number, y: number): { lat: number; lng: number } {
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) / DEG2RAD;
  const lng = x / EARTH_RADIUS_M / DEG2RAD;
  return { lat, lng };
}

/** Распознавание системы координат по значениям bbox (защита от «градусы в метрах») */
export function detectProjection(bbox: MapBounds): ProjectionId {
  const degish = Math.abs(bbox.north) <= 90.001 && Math.abs(bbox.south) <= 90.001
    && Math.abs(bbox.east) <= 180.001 && Math.abs(bbox.west) <= 180.001;
  return degish ? EPSG_4326 : EPSG_3857;
}

/** Приведение границ к WGS-84 (если переданы метры EPSG:3857 — пересчёт) */
export function normalizeBoundsToWgs84(bbox: MapBounds): MapBounds {
  if (detectProjection(bbox) === EPSG_4326) return clampBounds(bbox);
  const sw = epsg3857ToWgs84(bbox.west, bbox.south);
  const ne = epsg3857ToWgs84(bbox.east, bbox.north);
  return clampBounds({ north: ne.lat, south: sw.lat, east: ne.lng, west: sw.lng });
}

/** Корректный порядок north > south, east > west + лимиты Mercator */
export function clampBounds(b: MapBounds): MapBounds {
  const n = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, b.north));
  const s = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, b.south));
  return {
    north: Math.max(n, s),
    south: Math.min(n, s),
    east: Math.max(b.east, b.west),
    west: Math.min(b.east, b.west),
  };
}

export function isValidBounds(b?: MapBounds | null): b is MapBounds {
  return !!b && [b.north, b.south, b.east, b.west].every((v) => Number.isFinite(v))
    && b.north > b.south && b.east > b.west;
}

/** Границы -> прямоугольник в долях мира (x0<x1, y0<y1; y растёт вниз) */
export function boundsToWorldRect(bounds: MapBounds): { x0: number; y0: number; x1: number; y1: number } {
  const c = clampBounds(bounds);
  return {
    x0: lngToWorldX(c.west),
    x1: lngToWorldX(c.east),
    y0: latToMercatorY(c.north),
    y1: latToMercatorY(c.south),
  };
}

/** Обратное преобразование: прямоугольник долей мира -> границы */
export function worldRectToBounds(r: { x0: number; y0: number; x1: number; y1: number }): MapBounds {
  return clampBounds({
    west: worldXToLng(r.x0),
    east: worldXToLng(r.x1),
    north: mercatorYToLat(r.y0),
    south: mercatorYToLat(r.y1),
  });
}

/** Bounding box набора [lat,lng]-точек (WGS-84) */
export function bboxFromPoints(points: [number, number][]): MapBounds | null {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let n = 0;
  for (const [lat, lng] of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    n++;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (n === 0) return null;
  // вырожденный bbox (точка/вертикаль/горизонталь) расширяем на минимальный шаг,
  // иначе у слоя нулевая площадь и он невидим при любом зуме
  if (maxLat - minLat < 1e-9) { minLat -= 1e-6; maxLat += 1e-6; }
  if (maxLng - minLng < 1e-9) { minLng -= 1e-6; maxLng += 1e-6; }
  return { north: maxLat, south: minLat, east: maxLng, west: minLng };
}

/**
 * Позиция внутри растра слоя как доля (0..1) от его bbox.
 * fy считается ПО МЕРКАТОРУ (как в MapCanvas: latToMercatorY), поэтому
 * полигоны из GeoTIFF/KML ложатся на подложку без смещения по широте.
 */
export function geoToFracInBounds(bounds: MapBounds, lat: number, lng: number): { fx: number; fy: number } {
  const c = clampBounds(bounds);
  const topY = latToMercatorY(c.north);
  const botY = latToMercatorY(c.south);
  const mercSpan = Math.max(1e-12, botY - topY);
  const lngSpan = Math.max(1e-12, c.east - c.west);
  return {
    fx: (lng - c.west) / lngSpan,
    fy: (latToMercatorY(lat) - topY) / mercSpan,
  };
}

/** Доля внутри растра -> география (обратное geoToFracInBounds) */
export function fracInBoundsToGeo(bounds: MapBounds, fx: number, fy: number): LngLatLike {
  const c = clampBounds(bounds);
  const topY = latToMercatorY(c.north);
  const botY = latToMercatorY(c.south);
  return {
    lat: mercatorYToLat(topY + (botY - topY) * fy),
    lng: c.west + (c.east - c.west) * fx,
  };
}

/**
 * Гео-координата -> пиксель канваса.
 * Формула повторяет привязку MapCanvas: screen = rasterPx·scale + offset,
 * где rasterPx = worldFrac·worldPx, а worldPx = canvasHeight·2^zoom.
 * Здесь worldPx передаётся явно (вызывается из рендера).
 */
export function geoToCanvasPx(
  lat: number, lng: number, worldPx: number, offsetX: number, offsetY: number
): { x: number; y: number } {
  const f = lngLatToWorldFrac(lng, lat);
  return { x: f.x * worldPx + offsetX, y: f.y * worldPx + offsetY };
}

/** Пиксель канваса -> география (обратное geoToCanvasPx) */
export function canvasPxToGeo(
  x: number, y: number, worldPx: number, offsetX: number, offsetY: number
): LngLatLike {
  return {
    lng: worldXToLng((x - offsetX) / worldPx),
    lat: mercatorYToLat((y - offsetY) / worldPx),
  };
}

/**
 * Привязка растра по ЧЕТЫРЁМ угловым точкам (ручная калибровка PNG/JPG).
 * Углы задаются в пикселях изображения (0..w, 0..h) и их географии;
 * считаются две независимые линейные модели (fx по колонке, fy по строке) —
 * это корректно для «север вверх» и даёт честный bbox для наклонных снимков.
 */
export interface CornerCalibration {
  /** [lat, lng] левого верхнего угла растра */
  topLeft: [number, number];
  topRight: [number, number];
  bottomLeft: [number, number];
  bottomRight: [number, number];
}

export function boundsFromCorners(c: CornerCalibration): MapBounds {
  const lats = [c.topLeft[0], c.topRight[0], c.bottomLeft[0], c.bottomRight[0]];
  const lngs = [c.topLeft[1], c.topRight[1], c.bottomLeft[1], c.bottomRight[1]];
  return clampBounds({
    north: Math.max(...lats),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    west: Math.min(...lngs),
  });
}

/** Пиксель растра -> география по 4 углам (билинейная модель) */
export function pixelToGeoByCorners(
  px: number, py: number, imgW: number, imgH: number, c: CornerCalibration
): LngLatLike {
  const u = Math.max(0, Math.min(1, px / Math.max(1, imgW)));
  const v = Math.max(0, Math.min(1, py / Math.max(1, imgH)));
  const lngTop = c.topLeft[1] + (c.topRight[1] - c.topLeft[1]) * u;
  const lngBot = c.bottomLeft[1] + (c.bottomRight[1] - c.bottomLeft[1]) * u;
  const latLeft = c.topLeft[0] + (c.bottomLeft[0] - c.topLeft[0]) * v;
  const latRight = c.topRight[0] + (c.bottomRight[0] - c.topRight[0]) * v;
  return { lng: lngTop + (lngBot - lngTop) * v, lat: latLeft + (latRight - latLeft) * v };
}

/**
 * GeoTIFF ModelTiepoint + ModelPixelScale -> привязка пикселя к географии.
 * Возвращает функцию (col,row) -> [x,y] в единицах CRS исходника.
 */
export function tiepointMapper(
  tiepoints: number[][], pixelScale: [number, number, number]
): (col: number, row: number) => [number, number] {
  const tp = tiepoints[0];
  const i0 = tp[0], j0 = tp[1], k0 = tp[2];
  const x0 = tp[3], y0 = tp[4], z0 = tp[5];
  void k0; void z0;
  const sx = pixelScale[0], sy = pixelScale[1];
  return (col, row) => [x0 + (col - i0) * sx, y0 - (row - j0) * sy];
}

/**
 * GeoTIFF ModelTransformation (Matrix 3x4/4x4, row-major) -> аффинная модель
 * пиксель -> CRS. Строки матрицы:
 *   [ a b c d ]   x = a·col + b·row + d      (c — сдвиг по X, d — постоянный член)
 *   ...
 * В классическом GeoTIFF используется запись GTModelTypeGeoPDF:
 *   row0: (11 12 13 14) — X = 11·col + 12·row + 14
 *   row1: (21 22 23 24) — Y = 21·col + 22·row + 24
 * Возвращаемая функция учитывает только col/row-компоненты (Z игнорируется).
 */
export function transformationMapper(matrix: number[]): (col: number, row: number) => [number, number] {
  // GeoTIFF Tag 34264 — массив из 16 double (4×4, row-major):
  //   row0 = (11 12 13 14), row1 = (21 22 23 24), ...
  const stride = 4;
  const aX = matrix[0], bX = matrix[1], dX = matrix[3];
  const aY = matrix[stride], bY = matrix[stride + 1], dY = matrix[2 * stride - 1];
  return (col, row) => [aX * col + bX * row + dX, aY * col + bY * row + dY];
}

