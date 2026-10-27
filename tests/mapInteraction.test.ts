// ═══════════════════════════════════════════════════════════════
// Тесты конвертации координат и hit-test (ПРОБЛЕМА 2: «не ставятся
// точки», ПРОБЛЕМА 3: редактирование маршрута). Формула screen→map
// вынесена из MapCanvas в чистый модуль — покрыта здесь напрямую.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  screenToMapPoint,
  hitTestRoutePoint,
  nearestRoutePoint,
  findClosestPointOnLine,
  insertPointAtIndex,
  projectOnSegment,
} from '../src/utils/mapInteraction';

describe('screenToMapPoint (формула mapX = (screenX - offsetX) / scale)', () => {
  it('конвертирует экранные координаты в координаты карты', () => {
    const p = screenToMapPoint(150, 250, { offsetX: 50, offsetY: 100, scale: 2 });
    expect(p.x).toBeCloseTo(50); // (150-50)/2
    expect(p.y).toBeCloseTo(75); // (250-100)/2
  });

  it('нулевой/битый scale не даёт NaN/Infinity (защита от деления на 0)', () => {
    const p = screenToMapPoint(100, 100, { offsetX: 0, offsetY: 0, scale: 0 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it('инверсна к прямой формуле screen = map*scale + offset', () => {
    const view = { offsetX: -30, offsetY: 12.5, scale: 0.75 };
    const mapP = { x: 400, y: 220 };
    const screen = { x: mapP.x * view.scale + view.offsetX, y: mapP.y * view.scale + view.offsetY };
    const back = screenToMapPoint(screen.x, screen.y, view);
    expect(back.x).toBeCloseTo(mapP.x, 6);
    expect(back.y).toBeCloseTo(mapP.y, 6);
  });
});

describe('hit-test точек маршрута (увеличенный радиус захвата ~12 экран. px)', () => {
  const routePts = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }];
  const view = { offsetX: 0, offsetY: 0, scale: 1 };

  it('попадание точно в точку → её индекс', () => {
    expect(hitTestRoutePoint({ x: 300, y: 300 }, view, routePts)).toBe(2);
  });

  it('попадание в пределах 12px → ближайшая точка', () => {
    expect(hitTestRoutePoint({ x: 108, y: 97 }, view, routePts)).toBe(0);
  });

  it('мимо всех точек (>12px) → null', () => {
    expect(hitTestRoutePoint({ x: 200, y: 200 }, view, routePts)).toBeNull();
  });

  it('при зуме ×4 радиус захвата в пикселях КАРТЫ уменьшается (экранные px постоянны)', () => {
    const zoomed = { offsetX: 0, offsetY: 0, scale: 4 };
    // карта-точка (100,100) на экране = 100*4 = 400; клик на 405 (=1.25 px карты) — попадаем
    expect(hitTestRoutePoint({ x: 405, y: 400 }, zoomed, routePts)).toBe(0);
    // клик на 420 (=5 px карты > 12/4=3? нет: 5 > 3) — мимо
    expect(hitTestRoutePoint({ x: 420, y: 400 }, zoomed, routePts)).toBeNull();
  });

  it('nearestRoutePoint на пустом массиве → null (без краша)', () => {
    expect(nearestRoutePoint({ x: 0, y: 0 }, [])).toBeNull();
    expect(hitTestRoutePoint({ x: 0, y: 0 }, view, [])).toBeNull();
  });
});

describe('findClosestPointOnLine + insertPointAtIndex (вставка waypoint на линию)', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

  it('проекция на горизонтальный сегмент: t и расстояние корректны', () => {
    const c = findClosestPointOnLine({ x: 40, y: 10 }, line);
    expect(c).not.toBeNull();
    expect(c!.segmentIndex).toBe(0);
    expect(c!.point.x).toBeCloseTo(40);
    expect(c!.point.y).toBeCloseTo(0);
    expect(c!.dist).toBeCloseTo(10);
  });

  it('проекция на второй сегмент (вертикальный)', () => {
    const c = findClosestPointOnLine({ x: 110, y: 60 }, line);
    expect(c!.segmentIndex).toBe(1);
    expect(c!.point.x).toBeCloseTo(100);
    expect(c!.point.y).toBeCloseTo(60);
  });

  it('за пределами ломаной — t клампится в [0,1]', () => {
    const pr = projectOnSegment({ x: -50, y: 5 }, line[0], line[1]);
    expect(pr.t).toBe(0);
    const pr2 = projectOnSegment({ x: 150, y: 5 }, line[0], line[1]);
    expect(pr2.t).toBe(1);
  });

  it('ломаная < 2 точек → null (без краша)', () => {
    expect(findClosestPointOnLine({ x: 1, y: 1 }, [{ x: 0, y: 0 }])).toBeNull();
  });

  it('insertPointAtIndex вставляет ПОСЛЕ индекса сегмента, исходный массив не mutate-ится', () => {
    const np = { x: 40, y: 0 };
    const out = insertPointAtIndex(line, 0, np);
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual(np);
    expect(line).toHaveLength(3); // иммутабельность
  });

  it('вставка после последней точки = append', () => {
    const out = insertPointAtIndex(line, 2, { x: 5, y: 5 });
    expect(out[3]).toEqual({ x: 5, y: 5 });
  });

  it('полный сценарий: клик по линии → проекция → вставка waypoint', () => {
    const click = { x: 100, y: 40 };
    const c = findClosestPointOnLine(click, line)!;
    const next = insertPointAtIndex(line, c.segmentIndex, c.point);
    expect(next.map((p) => `${p.x},${p.y}`)).toEqual(['0,0', '100,0', '100,40', '100,100']);
  });
});
