// ═══════════════════════════════════════════════════════════════
// ПРОБЛЕМА 4: обход бесполётных зон. Start и goal разделены полигоном;
// проверяем ray-casting'ом, что ни один сегмент возврата НЕ пересекает
// зону; при невозможности обхода — прямой fallback без throw/undefined.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import type { Point, Restriction } from '../src/types';
import { planPathAroundZones, isPointInZone, segmentHitsZone } from '../src/utils/routing';

function zone(name: string, pts: Point[]): Restriction {
  return { id: name, type: 'polygon', points: pts, color: '#f00', name, active: true };
}

/** Независимый ray-casting в тесте (не доверяем движку проверять сам себя). */
function segIntersectsPolygon(a: Point, b: Point, poly: Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i];
    const d = poly[(i + 1) % poly.length];
    if (segmentsCross(a, b, c, d)) return true;
  }
  // отрезок целиком внутри полигона
  if (rayCastInside(a, poly) || rayCastInside(b, poly)) return true;
  return false;
}
function ccw(p1: Point, p2: Point, p3: Point): boolean {
  return (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
}
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}
function rayCastInside(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const WALL = zone('Стена', [
  { x: 400, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 950 }, { x: 400, y: 950 },
]);
const MAP_W = 1000;
const MAP_H = 1000;

describe('planPathAroundZones — обход NFZ', () => {
  it('старт и цель разделены полигоном → путь огибает зону, пересечений нет', () => {
    const start: Point = { x: 100, y: 500 };
    const goal: Point = { x: 900, y: 500 };
    const path = planPathAroundZones(start, goal, [WALL], MAP_W, MAP_H);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(goal);
    // ни один сегмент результата не должен пересекать полигон (ray-casting)
    for (let i = 0; i + 1 < path.length; i++) {
      expect(
        segIntersectsPolygon(path[i], path[i + 1], WALL.points),
        `сегмент ${i}: ${JSON.stringify(path[i])}→${JSON.stringify(path[i + 1])} пересекает зону`,
      ).toBe(false);
    }
    // и сам движок так считает
    for (let i = 0; i + 1 < path.length; i++) {
      expect(segmentHitsZone(path[i], path[i + 1], WALL)).toBe(false);
    }
  });

  it('зона не на пути → возвращается прямой путь [start, goal]', () => {
    const path = planPathAroundZones({ x: 100, y: 100 }, { x: 300, y: 100 }, [WALL], MAP_W, MAP_H);
    expect(path).toHaveLength(2);
  });

  it('нет зон → прямой путь', () => {
    const path = planPathAroundZones({ x: 10, y: 10 }, { x: 500, y: 500 }, [], MAP_W, MAP_H);
    expect(path).toHaveLength(2);
  });

  it('крайний случай: старт ВНУТРИ зоны → не падает, возвращает массив с началом/концом', () => {
    const path = planPathAroundZones({ x: 500, y: 500 }, { x: 900, y: 500 }, [WALL], MAP_W, MAP_H);
    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toEqual({ x: 500, y: 500 });
  });

  it('битые/декоративные данные зон игнорируются без краша', () => {
    const junk = zone('junk', []);
    const path = planPathAroundZones({ x: 100, y: 500 }, { x: 900, y: 500 }, [junk], MAP_W, MAP_H);
    expect(path.length).toBeGreaterThanOrEqual(2);
  });

  it('isPointInZone согласован с независимым ray-casting', () => {
    expect(isPointInZone({ x: 500, y: 500 }, WALL)).toBe(true);
    expect(rayCastInside({ x: 500, y: 500 }, WALL.points)).toBe(true);
    expect(isPointInZone({ x: 100, y: 100 }, WALL)).toBe(false);
    expect(rayCastInside({ x: 100, y: 100 }, WALL.points)).toBe(false);
  });
});
