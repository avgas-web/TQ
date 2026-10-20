// ═══════════════════════════════════════════════════════════════
// ОБЯЗАТЕЛЬНЫЙ АВТОМАТИЧЕСКИЙ обход бесполётных зон (NFZ).
// ТЗ: «исправь обход — он должен быть автоматическим и обязательным».
// Проверяем на уровне стора (не только чистого движка routing):
//  1) создание маршрута сквозь зону → точки-обходы (auto:true), пересечений нет;
//  2) добавление зоны поверх существующего маршрута → автоперестройка через
//     троттлер scheduleRerouteAll (fake timers);
//  3) удаление зоны → маршрут возвращается к прямой геометрии, warnings чистятся;
//  4) невозможный обход (старт внутри замкнутой стены) → НЕ undefined/throw:
//     остаётся валидный массив точек + warning «Пересекает зону» (graceful).
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Point, Restriction, RoutePoint, MapBounds } from '../src/types';
import { useMissionStore, rerouteAllNow, scheduleRerouteAll } from '../src/store/useMissionStore';
import { useMapStore, invalidateZoneCache } from '../src/store/useMapStore';
import { zonesCrossedBy } from '../src/utils/routing';

const MAP_W = 1000;
const MAP_H = 1000;
const BOUNDS: MapBounds = { north: 56, south: 55, east: 38, west: 37 };

/** Независимый ray-casting (тест не доверяет движку проверять себя). */
function ccw(p1: Point, p2: Point, p3: Point): boolean {
  return (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
}
function segsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}
function rayInside(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segHitsPoly(a: Point, b: Point, poly: Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (segsCross(a, b, c, d)) return true;
  }
  return rayInside(a, poly) || rayInside(b, poly);
}
function routeCrossesAnyPolyline(points: Point[], polys: Point[][]): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    for (const poly of polys) if (segHitsPoly(points[i], points[i + 1], poly)) return true;
  }
  return false;
}

function px(x: number, y: number): RoutePoint {
  // Пиксель → гео по тем же границам, что и стор (линейная проекция достаточна
  // для теста: важен сам факт автоматической вставки обходных точек).
  const lat = BOUNDS.north - (y / MAP_H) * (BOUNDS.north - BOUNDS.south);
  const lng = BOUNDS.west + (x / MAP_W) * (BOUNDS.east - BOUNDS.west);
  return { x, y, lat, lng };
}

function wallZone(name = 'Стена'): Restriction {
  return {
    id: name, type: 'polygon', active: true, color: '#f00', name,
    points: [
      { x: 400, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 950 }, { x: 400, y: 950 },
    ],
  };
}

/** Добавляет зону через стор и ВОЗВРАЩАЕТ её реальный id (addRestriction
 *  всегда генерирует uuidv4, игнорируя переданный id — удаление по «своему»
 *  id раньше молча не срабатывало). */
function addZone(z: Restriction): string {
  useMapStore.getState().addRestriction(z);
  return useMapStore.getState().restrictions[useMapStore.getState().restrictions.length - 1].id;
}

function resetStores(): void {
  useMissionStore.setState({ routes: [], activeRouteId: null, routeWarnings: {} });
  useMapStore.setState({
    map: { name: 'test', width: MAP_W, height: MAP_H, dataUrl: '', bounds: BOUNDS },
    restrictions: [],
  });
  invalidateZoneCache();
}

describe('Обязательный автоматический обход NFZ на уровне стора', () => {
  beforeEach(() => resetStores());
  afterEach(() => { vi.useRealTimers(); resetStores(); });

  it('1. маршрут сквозь зону создаётся УЖЕ с обходом: auto-точки, ноль пересечений', () => {
    addZone(wallZone());
    const id = useMissionStore.getState().addRoute([px(100, 500), px(900, 500)], 'Сквозь стену');
    expect(id).not.toBeNull();
    const route = useMissionStore.getState().routes.find((r) => r.id === id);
    expect(route).toBeDefined();
    // обходные вставные точки присутствуют
    expect(route!.points.some((p) => p.auto === true)).toBe(true);
    // ни один сегмент не пересекает полигон (независимый ray-casting)
    expect(routeCrossesAnyPolyline(route!.points.map((p) => ({ x: p.x, y: p.y })), [wallZone().points])).toBe(false);
    // предупреждений о пересечении нет
    expect(useMissionStore.getState().routeWarnings[id!] ?? []).toEqual([]);
  });

  it('2. зона добавлена ПОСЛЕ построения маршрута → автоматическая перестройка (троттлер)', () => {
    vi.useFakeTimers();
    try {
      const id = useMissionStore.getState().addRoute([px(100, 500), px(900, 500)], 'Прямой');
      expect(id).not.toBeNull();
      // пока зоны нет — путь прямой из 2 точек
      expect(useMissionStore.getState().routes[0].points).toHaveLength(2);
      // ставим зону поверх середины маршрута — подписчик приложения живёт в
      // React-хуке useAppInitialization, поэтому здесь воспроизводим ровно его
      // контракт: инвалидация кэша зон + троттлинг-перестройка всех маршрутов.
      useMapStore.getState().addRestriction(wallZone());
      invalidateZoneCache();
      scheduleRerouteAll();
      vi.advanceTimersByTime(300);
      const route = useMissionStore.getState().routes.find((r) => r.id === id)!;
      expect(route.points.length).toBeGreaterThan(2);
      expect(route.points.some((p) => p.auto === true)).toBe(true);
      expect(routeCrossesAnyPolyline(route.points.map((p) => ({ x: p.x, y: p.y })), [wallZone().points])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3. зона удалена → обходные auto-точки автоматически схлопываются в прямую, warnings пусты', () => {
    vi.useFakeTimers();
    try {
      const zoneId = addZone(wallZone());
      const id = useMissionStore.getState().addRoute([px(100, 500), px(900, 500)], 'Обходной');
      scheduleRerouteAll();
      vi.advanceTimersByTime(300);
      expect(useMissionStore.getState().routes[0].points.some((p) => p.auto === true)).toBe(true);
      // удаляем зону — обход больше не нужен
      useMapStore.getState().deleteRestriction(zoneId);
      invalidateZoneCache();
      scheduleRerouteAll();
      vi.advanceTimersByTime(300);
      const route = useMissionStore.getState().routes.find((r) => r.id === id)!;
      // ОБЯЗАТЕЛЬНОЕ автоматическое упрощение: ни одной служебной обходной
      // точки не остаётся, маршрут = старт→финиш (раньше «мусор» из auto-точек
      // жил вечно и искажал длину/высоты маршрута).
      expect(route.points.filter((p) => p.auto === true)).toHaveLength(0);
      expect(route.points).toHaveLength(2);
      expect(Object.keys(useMissionStore.getState().routeWarnings)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. невозможный обход (старт внутри замкнутой стены) → graceful: массив + warning, без throw', () => {
    const box: Restriction = {
      id: 'box', type: 'polygon', active: true, color: '#f00', name: 'Коробка',
      points: [{ x: 50, y: 50 }, { x: 950, y: 50 }, { x: 950, y: 950 }, { x: 50, y: 950 }],
    };
    useMapStore.getState().addRestriction(box);
    let id: string | null = null;
    expect(() => {
      id = useMissionStore.getState().addRoute([px(500, 500), px(520, 520)], 'Внутри зоны');
    }).not.toThrow();
    expect(id).not.toBeNull();
    const route = useMissionStore.getState().routes.find((r) => r.id === id)!;
    expect(Array.isArray(route.points)).toBe(true);
    expect(route.points.length).toBeGreaterThanOrEqual(2);
    // обход невозможен → ОБЯЗАТЕЛЬНО видимое предупреждение вместо молчания
    const warns = useMissionStore.getState().routeWarnings[id!] ?? [];
    expect(warns.some((w) => w.includes('Пересекает зону'))).toBe(true);
    // внутренний детектор стора согласован с независимым ray-casting
    const crossed = zonesCrossedBy(route.points.map((p) => ({ x: p.x, y: p.y })), [box]);
    expect(crossed.length > 0).toBe(true);
  });

  it('5. несколько зон одновременно — обходит ВСЕ активные зоны', () => {
    const a = wallZone('Стена A');
    const b: Restriction = {
      id: 'B', type: 'polygon', active: true, color: '#ff0', name: 'Стена B',
      points: [{ x: 700, y: 50 }, { x: 760, y: 50 }, { x: 760, y: 950 }, { x: 700, y: 950 }],
    };
    useMapStore.getState().addRestriction(a);
    useMapStore.getState().addRestriction(b);
    invalidateZoneCache();
    const id = useMissionStore.getState().addRoute([px(50, 500), px(980, 500)], 'Две стены');
    rerouteAllNow(); // немедленная сверка (контракт кнопки «Автокоррекция»)
    const route = useMissionStore.getState().routes.find((r) => r.id === id)!;
    expect(routeCrossesAnyPolyline(route.points.map((p) => ({ x: p.x, y: p.y })), [a.points, b.points])).toBe(false);
    expect(useMissionStore.getState().routeWarnings[id!] ?? []).toEqual([]);
  });
});
