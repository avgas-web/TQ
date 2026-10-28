// Юнит-тесты тайлового I/O и tile-математики openStreetMap.ts:
// loadTileImage / loadTileWithMirrors / latLngToTile / tileToLatLng / isOSMLoaded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initOpenStreetMap, isOSMLoaded, latLngToTile, tileToLatLng,
  loadTileImage, loadTileWithMirrors, getOSMTileUrl, normalizeTileServer,
  loadOSMStaticMap,
} from '../src/utils/openStreetMap';
import { calculateBoundsFromCenter } from '../src/utils/googleMaps';

/** Мок canvas для loadOSMStaticMap: рисование тайлов без реального кодирования PNG */
function mockCanvasForStaticMap() {
  class Ctx {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 1;
    fillRect() {}
    strokeRect() {}
    drawImage() {}
  }
  HTMLCanvasElement.prototype.getContext = function () { return new Ctx(); } as any;
  HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,TQSTATIC'; };
}

/** Подмена Image: src-сеттер инициирует onload/onerror без реальной сети */
class FakeImage {
  static mode: 'load' | 'error' = 'load';
  crossOrigin = '';
  width = 256;
  height = 256;
  naturalWidth = 256;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly loadedSrcs: string[] = [];
  set src(v: string) {
    this.loadedSrcs.push(v);
    if (!v) return; // сброс src при таймауте
    const cb = FakeImage.mode === 'load' ? this.onload : this.onerror;
    setTimeout(() => cb?.(), 0);
  }
  get src() { return this.loadedSrcs[this.loadedSrcs.length - 1] ?? ''; }
}

const realImage = globalThis.Image;

beforeEach(() => {
  FakeImage.mode = 'load';
  (globalThis as any).Image = FakeImage;
});

afterEach(() => {
  (globalThis as any).Image = realImage;
  vi.useRealTimers();
});

describe('initOpenStreetMap / isOSMLoaded', () => {
  it('после инициализации статус loaded=true', async () => {
    await initOpenStreetMap();
    expect(isOSMLoaded()).toBe(true);
  });
});

describe('latLngToTile / tileToLatLng', () => {
  it('нулевой меридиан и экватор — центр тайловой сетки (кроме z=0, где сетка 1x1)', () => {
    for (const z of [3, 8]) {
      const n = Math.pow(2, z);
      expect(latLngToTile(0, 0, z)).toEqual({ x: n / 2, y: n / 2 });
    }
    // z=0: единственный тайл, floor(...) всегда 0
    expect(latLngToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(latLngToTile(0, -180, 4)).toEqual({ x: 0, y: 8 });
    expect(latLngToTile(0, 180, 4).x).toBe(16); // восточная граница = за пределами сетки
  });

  it('обратное преобразование согласовано с прямым (границы тайла)', () => {
    const cases: Array<[number, number, number]> = [[55.75, 37.62, 12], [-33.87, 151.21, 10], [0.5, -0.5, 6]];
    for (const [lat, lng, z] of cases) {
      const t = latLngToTile(lat, lng, z);
      const n = Math.pow(2, z);
      const west = tileToLatLng(t.x, t.y + 1, z).lng;
      const east = tileToLatLng(t.x + 1, t.y + 1, z).lng;
      const north = tileToLatLng(t.x, t.y, z).lat;
      const south = tileToLatLng(t.x, t.y + 1, z).lat;
      expect(west).toBeLessThanOrEqual(lng);
      expect(east).toBeGreaterThanOrEqual(lng);
      expect(north).toBeGreaterThanOrEqual(lat);
      expect(south).toBeLessThanOrEqual(lat);
      // ширина тайла по долготе ровно 360/n
      expect(east - west).toBeCloseTo(360 / n, 6);
    }
  });

  it('tileToLatLng: x — западная граница тайла, y — северная (пределы Mercator ~±85°)', () => {
    expect(tileToLatLng(0, 0, 1).lat).toBeGreaterThan(84);
    expect(tileToLatLng(0, 2, 1).lat).toBeLessThan(-84);
    // lng = x/n*360 - 180: x=0 -> -180, x=n/2 -> 0
    expect(tileToLatLng(0, 1, 1).lng).toBe(-180);
    expect(tileToLatLng(1, 1, 1).lng).toBeCloseTo(0, 6);
    // x=2 при zoom=1 выходит за диапазон тайлов (n=2) — формула даёт +180 как продолжение линейной шкалы
    expect(tileToLatLng(2, 1, 1).lng).toBeCloseTo(180, 6);
    expect(tileToLatLng(3, 0, 2).lng).toBeCloseTo(90, 6);
  });
});

describe('loadTileImage', () => {
  it('успешная загрузка -> HTMLImageElement с crossOrigin', async () => {
    const img = await loadTileImage('https://tile.openstreetmap.org/3/1/2.png');
    expect(img).not.toBeNull();
    expect(img!.crossOrigin).toBe('anonymous');
  });

  it('onerror -> null', async () => {
    FakeImage.mode = 'error';
    expect(await loadTileImage('https://tile.openstreetmap.org/3/1/999.png')).toBeNull();
  });

  it('таймаут обрывает загрузку и возвращает null', async () => {
    vi.useFakeTimers();
    class SilentImage extends FakeImage {
      // никогда не вызывает onload/onerror
      set src(_v: string) { /* noop */ }
      get src() { return ''; }
    }
    (globalThis as any).Image = SilentImage;
    const p = loadTileImage('https://tile.openstreetmap.org/1/0/0.png', 100);
    vi.advanceTimersByTime(150);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe('loadTileWithMirrors', () => {
  it('для OSM перебирает зеркала, пока одна не сработала', async () => {
    let attempt = 0;
    class FlakyImage extends FakeImage {
      set src(v: string) {
        this.loadedSrcs.push(v);
        attempt++;
        const ok = attempt >= 3; // первые два зеркала падают
        setTimeout(() => (ok ? this.onload : this.onerror)?.(), 0);
      }
      get src() { return this.loadedSrcs[this.loadedSrcs.length - 1] ?? ''; }
    }
    (globalThis as any).Image = FlakyImage;
    const url = getOSMTileUrl(4, 8, 5, 'osm', 'scheme');
    const img = await loadTileWithMirrors(url);
    expect(img).not.toBeNull();
    expect(attempt).toBe(3);
  });

  it('все зеркала упали -> null', async () => {
    FakeImage.mode = 'error';
    expect(await loadTileWithMirrors(getOSMTileUrl(4, 8, 5, 'osm', 'scheme'))).toBeNull();
  });

  it('URL другого провайдера грузится напрямую без зеркал', async () => {
    const esri = getOSMTileUrl(4, 8, 5, normalizeTileServer('esri'), 'satellite');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const img = await loadTileWithMirrors(esri);
    expect(img).not.toBeNull();
    expect(img!.src).toBe(esri);
    spy.mockRestore();
  });
});

describe('withTileSlot: лимит параллельной загрузки тайлов', () => {
  it('не более 4 одновременных задач, остальные ждут освобождения слота', async () => {
    // loadOSMStaticMap вызывает withTileSlot косвенно; проверяем поведение через
    // саму функцию сборки снимка ниже. Здесь — примитив синхронизации:
    // 9 «тайлов» при лимите 4 не должны перекрываться пятым одновременно.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let live = 0;
    let peak = 0;
    class SlowImage extends FakeImage {
      set src(v: string) {
        this.loadedSrcs.push(v);
        live++;
        peak = Math.max(peak, live);
        setTimeout(() => { live--; this.onload?.(); }, 5);
      }
      get src() { return this.loadedSrcs[this.loadedSrcs.length - 1] ?? ''; }
    }
    (globalThis as any).Image = SlowImage;
    mockCanvasForStaticMap();
    const res = await loadOSMStaticMap({ lat: 55.75, lng: 37.62 }, 12, 600, 600, 'osm');
    expect(res.dataUrl).toBe('data:image/png;base64,TQSTATIC');
    expect(peak).toBeLessThanOrEqual(4);
    expect(live).toBe(0);
    spy.mockRestore();
  });
});

describe('loadOSMStaticMap: точная Mercator-привязка снимка', () => {
  beforeEach(() => mockCanvasForStaticMap());

  it('границы симметричны центру и соответствуют размеру окна', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { bounds } = await loadOSMStaticMap({ lat: 0, lng: 0 }, 4, 512, 512, 'osm');
    // z=4: world px = 4096; 512 px по X = 45° полного размаха -> ±22.5°
    expect(bounds.west).toBeCloseTo(-22.5, 6);
    expect(bounds.east).toBeCloseTo(22.5, 6);
    // На экваторе нормализованная Mercator-координата y линейна по широте лишь
    // вблизи 0, поэтому на z=4 (низкий зум) север/юг расходятся с меридианами:
    // проверяем инварианты, а не «±22.5°».
    expect(bounds.north).toBeGreaterThan(0);
    expect(bounds.south).toBeLessThan(0);
    expect(bounds.north).toBeLessThanOrEqual(85);
    expect(bounds.south).toBeGreaterThanOrEqual(-85);
    spy.mockRestore();
  });

  it('привязка снимка совпадает с calculateBoundsFromCenter (общая Mercator-математика)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cases: Array<[{ lat: number; lng: number }, number, number, number]> = [
      [{ lat: 0, lng: 0 }, 4, 512, 512],
      [{ lat: 55.75, lng: 37.62 }, 10, 800, 600],
      [{ lat: -33.87, lng: 151.21 }, 8, 640, 480],
    ];
    for (const [center, zoom, w, h] of cases) {
      const { bounds } = await loadOSMStaticMap(center, zoom, w, h, 'osm');
      const ref = calculateBoundsFromCenter(center, zoom, w, h);
      expect(bounds.north).toBeCloseTo(ref.north, 6);
      expect(bounds.south).toBeCloseTo(ref.south, 6);
      expect(bounds.east).toBeCloseTo(ref.east, 6);
      expect(bounds.west).toBeCloseTo(ref.west, 6);
    }
    spy.mockRestore();
  });

  it('центр вне экватора: mercator-размах по Y даёт north > center > south', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { bounds } = await loadOSMStaticMap({ lat: 60, lng: 10 }, 6, 512, 512, 'osm');
    expect(bounds.north).toBeGreaterThan(60);
    expect(bounds.south).toBeLessThan(60);
    // z=6 -> world px 16384; 512 px по X = 11.25° полного размаха => west = центр - 5.625°
    expect(bounds.west).toBeCloseTo(10 - 5.625, 6);
    expect(bounds.east).toBeCloseTo(10 + 5.625, 6);
    spy.mockRestore();
  });

  it('несуществующие тайлы не валят снимок (серая заглушка вместо падения)', async () => {
    FakeImage.mode = 'error';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await loadOSMStaticMap({ lat: 55.75, lng: 37.62 }, 3, 300, 300, 'carto');
    expect(res.dataUrl.startsWith('data:image/png')).toBe(true);
    expect(res.bounds.north).toBeGreaterThan(res.bounds.south);
    spy.mockRestore();
  });

  it('zoom clamp: z<1 и z>19 не приводят к NaN в границах', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const z of [-5, 0, 25, 99]) {
      const { bounds } = await loadOSMStaticMap({ lat: 10, lng: 20 }, z, 256, 256, 'osm');
      expect(Number.isFinite(bounds.north)).toBe(true);
      expect(Number.isFinite(bounds.west)).toBe(true);
    }
    spy.mockRestore();
  });

  it('широта за пределами ±85° ограничивается, а не ломает проекцию', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { bounds } = await loadOSMStaticMap({ lat: 89.9, lng: 0 }, 5, 512, 512, 'osm');
    expect(bounds.north).toBeLessThanOrEqual(90);
    expect(bounds.north).toBeGreaterThanOrEqual(bounds.south);
    spy.mockRestore();
  });
});
