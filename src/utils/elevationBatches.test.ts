// Юнит-тесты батчевой загрузки высот (регрессия аудита 1.1):
// раньше `return readChunkResults(...)` внутри цикла for обрывал обработку
// маршрутов длиннее 100 точек — второй и последующие батчи не запрашивались.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test_clearElevationCache,
  __test_fetchElevationsBatch,
  fetchElevations,
} from './elevation';
import type { ElevationPoint } from './elevation';

function makeResponse(lat: number, lng: number, elev: number) {
  return {
    ok: true,
    json: async () => ({
      results: [{ latitude: lat, longitude: lng, elevation: elev }],
    }),
  };
}

/** Маршрут из N точек; высота i-й точки = i (детерминированно для проверок). */
function route(n: number): ElevationPoint[] {
  return Array.from({ length: n }, (_, i) => ({ lat: 50 + i * 0.001, lng: 30 + i * 0.001 }));
}

beforeEach(() => {
  __test_clearElevationCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchElevationsBatch — обработка ВСЕХ чанков (аудит 1.1)', () => {
  it('маршрут из 250 точек порождает ровно 3 запроса (чанки ≤100)', async () => {
    const pts = route(250);
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const locations = JSON.parse(init.body).locations;
      return {
        ok: true,
        json: async () => ({
          results: locations.map((l: any) => ({
            latitude: l.latitude,
            longitude: l.longitude,
            elevation: Math.round(l.latitude * 1000), // детерминированная «высота»
          })),
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await __test_fetchElevationsBatch(pts);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    expect(res).toHaveLength(250);
    // Хвост (>100 точек) НЕ остаётся null — это и был регрессионный баг:
    for (let i = 0; i < 250; i++) {
      expect(res[i]).toBe(Math.round(pts[i].lat * 1000));
    }
  });

  it('заполняет переданный target-массив по ссылке', async () => {
    const pts = route(120);
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      const locations = JSON.parse(init.body).locations;
      return {
        ok: true,
        json: async () => ({
          results: locations.map((l: any) => ({
            latitude: l.latitude, longitude: l.longitude, elevation: 42,
          })),
        }),
      } as any;
    }));
    const target: (number | null)[] = new Array(pts.length).fill(null);
    const res = await __test_fetchElevationsBatch(pts, undefined, target);
    expect(res).toBe(target);
    expect(target.every((v) => v === 42)).toBe(true);
  });

  it('один сбойный чанк не обрывает остальные: мягкая деградация до null', async () => {
    const pts = route(150);
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
    }));
    const res = await __test_fetchElevationsBatch(pts);
    expect(call).toBe(2); // оба чанка запрошены, несмотря на ошибку первого
    expect(res).toHaveLength(150);
    expect(res.slice(0, 100).every((v) => v === null)).toBe(true);
  });
});

describe('fetchElevations — публичный API >100 точек', () => {
  it('возвращает высоты для всех 205 точек маршрута (регрессия обрыва батчей)', async () => {
    const pts = route(205);
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      const locations = JSON.parse(init.body).locations;
      return {
        ok: true,
        json: async () => ({
          results: locations.map((l: any) => ({
            latitude: l.latitude, longitude: l.longitude, elevation: 77,
          })),
        }),
      } as any;
    }));
    const out = await fetchElevations(pts);
    expect(out).toHaveLength(205);
    expect(out.filter((v) => v === 77)).toHaveLength(205);
    // ни одного «хвоста» из null после 100-й точки:
    expect(out.slice(100).some((v) => v === null)).toBe(false);
  });

  it('кэш повторных точек исключает лишние сетевые запросы', async () => {
    const pts = route(3);
    const fetchMock = vi.fn(async (_u: any, init: any) => {
      const locations = JSON.parse(init.body).locations;
      return {
        ok: true,
        json: async () => ({
          results: locations.map((l: any) => ({
            latitude: l.latitude, longitude: l.longitude, elevation: 10,
          })),
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchElevations(pts);
    const second = await fetchElevations(pts); // полностью из кэша
    expect(second).toEqual([10, 10, 10]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
