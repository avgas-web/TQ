// Утилиты «Режима действий»: гео-расчёты и парсинг точек старта/цели
import type { MapBounds, Point } from '../types';
import { latToMercatorY, mercatorYToLat } from './googleMaps';

const EARTH_R = 6371008.8; // средний радиус Земли, м (WGS-84)
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Расстояние по эллипсоиду (сферическая формула гаверсинуса), метры
 */
export function haversineDistanceM(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Истинный азимут от a к b, градусы 0..360 (по часовой от севера)
 */
export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const f1 = a.lat * DEG2RAD;
  const f2 = b.lat * DEG2RAD;
  const dl = (b.lng - a.lng) * DEG2RAD;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

/**
 * Смещение точки на расстояние (м) по азимуту (град) — большая окружность
 */
export function destinationPoint(from: GeoPoint, distanceM: number, bearingD: number): GeoPoint {
  const d = distanceM / EARTH_R;
  const br = bearingD * DEG2RAD;
  const f1 = from.lat * DEG2RAD;
  const l1 = from.lng * DEG2RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(br));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(f1),
      Math.cos(d) - Math.sin(f1) * Math.sin(f2)
    );
  return {
    lat: f2 * RAD2DEG,
    lng: ((l2 * RAD2DEG + 540) % 360) - 180,
  };
}

/**
 * Азимут в формат «СЕВЕРО-ВОСТОК 45°» (русские роза ветров названия)
 */
export function bearingToCompass(bearing: number): string {
  const dirs = [
    'СЕВЕР', 'СЕВЕРО-ВОСТОК', 'ВОСТОК', 'ЮГО-ВОСТОК',
    'ЮГ', 'ЮГО-ЗАПАД', 'ЗАПАД', 'СЕВЕРО-ЗАПАД',
  ];
  const idx = Math.round(((bearing % 360) / 45)) % 8;
  return `${dirs[idx]} ${bearing.toFixed(0)}°`;
}

/**
 * Форматирование расстояния
 */
export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} км`;
  return `${meters.toFixed(0)} м`;
}

/**
 * Парсинг строки координат без обращения к API геокодирования.
 * Поддерживает форматы:
 *   "55.7539, 37.6208" | "55.7539 37.6208" | "55.7539;37.6208"
 *   "55.7539N 37.6208E" | "55°45'14\"N 37°37'15\"E" | DMS с N/S/E/W
 * Возвращает { lat, lng } или null.
 */
export function parseCoordinatesString(input: string): GeoPoint | null {
  if (!input) return null;
  const s = input.trim();

  // Попытка 1: формат с полушариями N/S/E/W (градусы, опционально минуты/секунды)
  // Примеры: 55\u00b045'14"N 37\u00b037'15"E ; 55.7539N 37.6208E
  const partRe = /(\d+(?:[.,]\d+)?)\s*(?:[°d]\s*(\d+(?:[.,]\d+)?)\s*[′']?\s*(\d+(?:[.,]\d+)?)?\s*[″"]?)?\s*([NSWE])/gi;
  const matches = [...s.matchAll(partRe)];
  const nsMatch = matches.find((m) => /^[NS]$/i.test(m[4]));
  const ewMatch = matches.find((m) => /^[EW]$/i.test(m[4]));
  if (nsMatch && ewMatch) {
    const toDec = (m: RegExpMatchArray): number => {
      let v = parseFloat(m[1].replace(',', '.')) +
        (m[2] ? parseFloat(m[2].replace(',', '.')) / 60 : 0) +
        (m[3] ? parseFloat(m[3].replace(',', '.')) / 3600 : 0);
      if (/^[SW]$/i.test(m[4])) v = -v;
      return v;
    };
    const p = { lat: toDec(nsMatch), lng: toDec(ewMatch) };
    if (isValidGeo(p)) return p;
  }

  // Попытка 2: просто два числа (десятичные), разделители: запятая / точка с запятой / пробел
  const nums = s.match(/-?\d+(?:[.,]\d+)?/g);
  if (nums && nums.length >= 2) {
    const a = parseFloat(nums[0].replace(',', '.'));
    const b = parseFloat(nums[1].replace(',', '.'));
    // стандартный порядок — lat,lng; если не проходит валидацию — пробуем наоборот
    if (isValidGeo({ lat: a, lng: b })) return { lat: a, lng: b };
    if (isValidGeo({ lat: b, lng: a })) return { lat: b, lng: a };
  }

  return null;
}

export function isValidGeo(p: GeoPoint): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/**
 * Границы прямоугольной области, охватывающей набор точек, с запасом (в долях от размера)
 */
export function boundsFromPoints(points: GeoPoint[], paddingFrac = 0.12): MapBounds {
  if (points.length === 0) throw new Error('Нет точек для расчёта границ');
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  // одна точка — искусственный разброс ~1 км
  if (maxLat - minLat < 1e-6) { minLat -= 0.005; maxLat += 0.005; }
  if (maxLng - minLng < 1e-6) { minLng -= 0.005; maxLng += 0.005; }
  const padLat = (maxLat - minLat) * paddingFrac;
  const padLng = (maxLng - minLng) * paddingFrac;
  return {
    north: Math.min(89.9, maxLat + padLat),
    south: Math.max(-89.9, minLat - padLat),
    east: maxLng + padLng,
    west: minLng - padLng,
  };
}

/**
 * Максимально целый зум Web Mercator, при котором область bounds целиком
 * помещается в изображение width×height пикселей (с учётом высоты канваса).
 */
export function zoomToFitBounds(bounds: MapBounds, width: number, height: number, maxZoom = 19): number {
  const topY = latToMercatorY(bounds.north);
  const bottomY = latToMercatorY(bounds.south);
  const lngSpan = Math.abs(bounds.east - bounds.west) / 360;
  const latSpan = Math.abs(bottomY - topY);
  for (let z = maxZoom; z >= 1; z--) {
    const worldPx = 256 * Math.pow(2, z);
    if (lngSpan * worldPx <= width && latSpan * worldPx <= height) return z;
  }
  return 1;
}

/**
 * Пиксель изображения -> гео-точка (для measure в метрах)
 */
export function pixelToGeo(px: Point, bounds: MapBounds, mapW: number, mapH: number): GeoPoint {
  const topY = latToMercatorY(bounds.north);
  const bottomY = latToMercatorY(bounds.south);
  const fy = Math.max(0, Math.min(1, px.y / mapH));
  const fx = Math.max(0, Math.min(1, px.x / mapW));
  return {
    lat: mercatorYToLat(topY + (bottomY - topY) * fy),
    lng: bounds.west + (bounds.east - bounds.west) * fx,
  };
}
