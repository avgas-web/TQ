// Юнит-тесты единого стандарта координат клика { lat, lng } (регрессия аудита 1.2):
// раньше pick возвращал { lat, lon }, из-за чего рельеф/геокодинг получали
// undefined вместо долготы.
import { describe, expect, it } from 'vitest';
import { geoToScreen, normalizeGeoPick, screenToGeo } from './mapGeoPick';
import type { MapBounds } from '../types';

const bounds: MapBounds = { north: 50.5, south: 50.0, east: 31.0, west: 30.0 };
const view = { offsetX: -120, offsetY: 64, scale: 1.37 };
const MAP_W = 1024;
const MAP_H = 768;

describe('normalizeGeoPick — стандарт { lat, lng }', () => {
  it('принимает легаси-поле lon и нормализует в lng', () => {
    expect(normalizeGeoPick({ lat: 50.1, lon: 30.2 })).toEqual({ lat: 50.1, lng: 30.2 });
  });
  it('каноническое lng имеет приоритет над легаси lon', () => {
    expect(normalizeGeoPick({ lat: 1, lng: 2, lon: 99 })).toEqual({ lat: 1, lng: 2 });
  });
  it('отсутствие координат -> NaN (явный сигнал ошибки, а не undefined)', () => {
    const r = normalizeGeoPick({});
    expect(Number.isNaN(r.lat)).toBe(true);
    expect(Number.isNaN(r.lng)).toBe(true);
    expect(normalizeGeoPick(null)).toEqual({ lat: NaN, lng: NaN });
  });
});

describe('screenToGeo / geoToScreen — обратимость (математика Web Mercator)', () => {
  it('round-trip гео -> экран -> гео совпадает с точностью 1e-6°', () => {
    const probes = [
      { lat: 50.25, lng: 30.5 },
      { lat: 50.49, lng: 30.99 },
      { lat: 50.01, lng: 30.01 },
    ];
    for (const g of probes) {
      const s = geoToScreen(g, view, bounds, MAP_W, MAP_H);
      const back = screenToGeo(s, view, bounds, MAP_W, MAP_H);
      expect(back.lat).toBeCloseTo(g.lat, 6);
      expect(back.lng).toBeCloseTo(g.lng, 6);
    }
  });

  it('возвращаемый тип — строго { lat, lng } (без поля lon)', () => {
    const p = screenToGeo({ x: 500, y: 300 }, view, bounds, MAP_W, MAP_H);
    expect(Object.keys(p).sort()).toEqual(['lat', 'lng']);
    expect('lon' in p).toBe(false);
  });

  it('центр экрана соответствует центру mercator-полосы bounds', () => {
    const c = screenToGeo(
      { x: MAP_W / 2 * view.scale + view.offsetX, y: MAP_H / 2 * view.scale + view.offsetY },
      view, bounds, MAP_W, MAP_H,
    );
    expect(c.lng).toBeCloseTo((bounds.west + bounds.east) / 2, 6);
    // широта центра — mercator-среднее, не арифметическое:
    expect(c.lat).toBeLessThan((bounds.north + bounds.south) / 2 + 0.001);
    expect(c.lat).toBeGreaterThan(bounds.south);
  });

  it('некорректный вид (scale=0) даёт NaN, а не деление на ноль', () => {
    const bad = screenToGeo({ x: 10, y: 10 }, { ...view, scale: 0 }, bounds, MAP_W, MAP_H);
    expect(Number.isNaN(bad.lat) && Number.isNaN(bad.lng)).toBe(true);
  });
});
