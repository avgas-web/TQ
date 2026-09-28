// Геометрические утилиты
import type { Point, Restriction } from '../types';

/**
 * Проверка, находится ли точка внутри полигона (ray casting algorithm)
 */
export function isPointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Проверка, находится ли точка внутри прямоугольника
 */
export function isPointInRect(point: Point, rect: Point[]): boolean {
  if (rect.length < 2) return false;
  const minX = Math.min(rect[0].x, rect[1].x);
  const maxX = Math.max(rect[0].x, rect[1].x);
  const minY = Math.min(rect[0].y, rect[1].y);
  const maxY = Math.max(rect[0].y, rect[1].y);
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

/**
 * Проверка, находится ли точка внутри круга
 */
export function isPointInCircle(point: Point, center: Point, radius: number): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Проверка, находится ли точка внутри ограничения
 */
export function isPointInRestriction(point: Point, restriction: Restriction): boolean {
  switch (restriction.type) {
    case 'polygon':
      return isPointInPolygon(point, restriction.points);
    case 'rectangle':
      return isPointInRect(point, restriction.points);
    case 'circle':
      if (restriction.points.length < 2) return false;
      return isPointInCircle(point, restriction.points[0], restriction.radius || 0);
    default:
      return true;
  }
}

/**
 * Проверка, находится ли точка внутри активного ограничения
 */
export function isPointInActiveRestriction(point: Point, restrictions: Restriction[]): boolean {
  const activeRestrictions = restrictions.filter(r => r.active);
  if (activeRestrictions.length === 0) return true; // Нет активных ограничений
  return activeRestrictions.every(r => isPointInRestriction(point, r));
}

/**
 * Расстояние между двумя точками в пикселях
 */
export function distanceBetween(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Площадь полигона (formula shoelace)
 */
export function polygonArea(polygon: Point[]): number {
  let area = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += polygon[i].x * polygon[j].y;
    area -= polygon[j].x * polygon[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Периметр полигона
 */
export function polygonPerimeter(polygon: Point[]): number {
  let perimeter = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    perimeter += distanceBetween(polygon[i], polygon[j]);
  }
  return perimeter;
}

/**
 * Конвертация пикселей в географические координаты (линейная интерполяция)
 */
export function pixelToGeo(
  pixel: Point,
  calibrationPoints: { pixelX: number; pixelY: number; lat: number; lon: number }[]
): { lat: number; lon: number } | null {
  if (calibrationPoints.length < 2) return null;

  // Используем первые две точки для линейной интерполяции
  const p1 = calibrationPoints[0];
  const p2 = calibrationPoints[1];

  const dxPixel = p2.pixelX - p1.pixelX;
  const dyPixel = p2.pixelY - p1.pixelY;
  const dLat = p2.lat - p1.lat;
  const dLon = p2.lon - p1.lon;

  if (dxPixel === 0 && dyPixel === 0) return null;

  // Простая линейная интерполяция (для более точных результатов нужна аффинная трансформация)
  const scaleX = dLon / (dxPixel || 1);
  const scaleY = dLat / (dyPixel || 1);

  const lon = p1.lon + (pixel.x - p1.pixelX) * scaleX;
  const lat = p1.lat + (pixel.y - p1.pixelY) * scaleY;

  return { lat, lon };
}

/**
 * Валидация координат точки
 */
export function validateMarkerPosition(x: number, y: number, mapWidth: number, mapHeight: number): string | null {
  if (x < 0 || x > mapWidth) return 'Координата X вне пределов карты';
  if (y < 0 || y > mapHeight) return 'Координата Y вне пределов карты';
  return null;
}

/**
 * Валидация географических координат
 */
export function validateGeoCoordinates(lat: number, lon: number): string | null {
  if (lat < -90 || lat > 90) return 'Широта должна быть от -90 до 90';
  if (lon < -180 || lon > 180) return 'Долгота должна быть от -180 до 180';
  return null;
}

/**
 * Парсинг DMS в десятичные градусы
 */
export function parseDMS(dms: string): number | null {
  // Формат: 55°45'20.9"N или 55°45'20.9"S
  const match = dms.match(/(\d+)[°]\s*(\d+)[']\s*([\d.]+)["]?\s*([NSEW])?/i);
  if (!match) return null;

  const degrees = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const seconds = parseFloat(match[3]);
  const direction = match[4]?.toUpperCase();

  let decimal = degrees + minutes / 60 + seconds / 3600;
  if (direction === 'S' || direction === 'W') decimal = -decimal;

  return decimal;
}

/**
 * Конвертация десятичных градусов в DMS
 */
export function decimalToDMS(decimal: number, isLat: boolean): string {
  const abs = Math.abs(decimal);
  const degrees = Math.floor(abs);
  const minutesDecimal = (abs - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = (minutesDecimal - minutes) * 60;

  const direction = isLat
    ? (decimal >= 0 ? 'N' : 'S')
    : (decimal >= 0 ? 'E' : 'W');

  return `${degrees}°${minutes.toString().padStart(2, '0')}'${seconds.toFixed(1)}"${direction}`;
}
