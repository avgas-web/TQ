// ═══════════════════════════════════════════════════════════════
// Регрессия «Краш и зависание при загрузке карт»:
// loadTileImage обязан разрешаться НЕЗАВИСИМО от того, ответит ли
// сервер (onload/onerror/таймаут). Раньше при «висячем» CDN-соединении
// промис не резолвился никогда, слот очереди загрузки не освобождался —
// вся подложка останавливалась («вечный спиннер»).
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadTileImage, loadTileWithMirrors, resetTwoGisMirrorCache, normalizeTwoGisTileUrl } from '../src/utils/openStreetMap';

/** Мок Image: src в setter'е ничего не делает, события никто не вызывает. */
class HangingImage {
  static instances: HangingImage[] = [];
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abortCalls = 0;
  private _src = '';
  set src(v: string) { this._src = v; }
  get src(): string { return this._src; }
  abort(): void { this.abortCalls++; }
  constructor() { HangingImage.instances.push(this); }
}

/** Мок Image, который всегда «успешно загружается». */
class OkImage {
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    // асинхронно, как настоящий браузер
    setTimeout(() => this.onload?.(), 0);
  }
  abort(): void { /* noop */ }
}

describe('loadTileImage — защита от зависания загрузки тайлов', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    HangingImage.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('разрешается null по таймауту, если сервер молчит (без onload/onerror)', async () => {
    vi.stubGlobal('Image', HangingImage);
    const p = loadTileImage('https://tile.openstreetmap.org/10/512/340.png', 8000);
    await vi.advanceTimersByTimeAsync(8001);
    await expect(p).resolves.toBeNull();
    // незавершённая загрузка ОТМЕНЕНА (abort + сброс src), соединение освобождено
    const img = HangingImage.instances[0];
    expect(img.abortCalls).toBe(1);
    expect(img.src).toBe('');
  });

  it('не резолвится дважды: поздний onload после таймаута игнорируется', async () => {
    vi.stubGlobal('Image', HangingImage);
    const resolveSpy = vi.fn();
    const p = loadTileImage('https://tile.openstreetmap.org/10/512/340.png', 1000);
    p.then(resolveSpy);
    await vi.advanceTimersByTimeAsync(1001);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // «поздний» успех сервера не должен перерешать исход
    const img = HangingImage.instances[0];
    img.onload?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(null);
  });

  it('успешная загрузка резолвится изображением и снимает таймер', async () => {
    vi.stubGlobal('Image', OkImage);
    const p = loadTileImage('https://tile-b01.2gis.com/tiles?x=1&y=1&z=10', 8000);
    await vi.advanceTimersByTimeAsync(5);
    const img = await p;
    expect(img).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0); // timer очищен — нет утечки таймеров
  });

  it('очередь зеркал OSM завершается даже когда все хосты висят', async () => {
    vi.stubGlobal('Image', HangingImage);
    const p = loadTileWithMirrors('https://tile.openstreetmap.org/10/512/340.png', 2000);
    // 4 зеркала × 2 c таймаута = до 8 c; раньше — навсегда
    await vi.advanceTimersByTimeAsync(9000);
    await expect(p).resolves.toBeNull();
    expect(HangingImage.instances.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// Регрессия «ERR_NAME_NOT_RESOLVED у tile-b01.2gis.com»:
// loadTileWithMirrors обязан для URL 2ГИС перебирать рабочие зеркала
// sl{1..4}.2gis.com и кэшировать живой хост (без шторма запросов в
// мёртвый DNS-хост). Раньше использовался единственный tile-b01 —
// при его недоступности подложка «2ГИС» молча не загружалась вообще.
// ═══════════════════════════════════════════════════════════════
describe('loadTileWithMirrors — зеркала 2ГИС при недоступном tile-b01', () => {
  /** Мок Image, запоминающий все запрошенные src; падает по onerror для
   * мёртвого хоста tile-b01, успешно грузится с sl*.2gis.com. */
  class TwoGisImage {
    static srcs: string[] = [];
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      TwoGisImage.srcs.push(v);
      if (v.includes('tile-b01')) setTimeout(() => this.onerror?.(), 0);
      else setTimeout(() => this.onload?.(), 0);
    }
    get src(): string { return ''; }
    abort(): void { /* noop */ }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TwoGisImage.srcs = [];
    resetTwoGisMirrorCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('перебирает зеркала sl*.2gis.com, пока одно не ответит', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    const p = loadTileWithMirrors('https://tile-b01.2gis.com/tiles?x=511&y=340&z=10', 1000);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
    const img = await p;
    expect(img).not.toBeNull();
    // tile-b01 при ERR_NAME_NOT_RESOLVED больше НЕ опрашивается первым:
    // сразу идём на живые зеркала sl{1..4} (нет шторма DNS-ошибок в консоли)
    expect(TwoGisImage.srcs[0]).toMatch(/sl[1-4]\.2gis\.com\/tiles\?x=511&y=340&z=10/);
    expect(TwoGisImage.srcs.some((s) => s.includes('tile-b01'))).toBe(false);
  });

  it('кэширует рабочий хост: следующий тайл идёт сразу на живое зеркало', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    const first = loadTileWithMirrors('https://tile-b01.2gis.com/tiles?x=1&y=1&z=10', 1000);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
    await first;
    TwoGisImage.srcs = [];
    const second = loadTileWithMirrors('https://tile-b01.2gis.com/tiles?x=2&y=2&z=10', 1000);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(TwoGisImage.srcs.length).toBe(1);
    expect(TwoGisImage.srcs[0]).toMatch(/sl[1-4]\.2gis\.com/);
    expect(TwoGisImage.srcs[0]).not.toContain('tile-b01');
  });

  it('регрессия ERR_NAME_NOT_RESOLVED шторма: ни один тайл не уходит в tile-b01', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    // Десятый тайл подряд — как в браузере при недоступном DNS-хосте:
    // раньше каждый тайл сначала падал на tile-b01 (шторм ошибок в консоли).
    const urls = Array.from({ length: 10 }, (_, i) =>
      `https://tile-b01.2gis.com/tiles?x=${i}&y=${i}&z=10`);
    for (const u of urls) {
      const p = loadTileWithMirrors(u, 1000);
      for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
      await p;
    }
    expect(TwoGisImage.srcs.every((s) => /sl[1-4]\.2gis\.com/.test(s))).toBe(true);
    expect(TwoGisImage.srcs.some((s) => s.includes('tile-b01'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Финальный барьер DNS-шторма: normalizeTwoGisTileUrl обязан
// переписывать ЛЮБОЙ входящий 2ГИС-URL (в т.ч. с мёртвым хостом
// tile-b01 — старые сохранённые проекты, кэш, сторонние шаблоны) на
// живое зеркало sl{1..4}. Это закрывает последний путь, которым
// битый хост мог попасть в img.src браузера (net::ERR_NAME_NOT_RESOLVED).
// ═══════════════════════════════════════════════════════════════
describe('normalizeTwoGisTileUrl — санация 2ГИС-URL перед любой загрузкой', () => {
  /** Мок Image, записывающий фактический src каждой попытки. */
  class SrcImage {
    static srcs: string[] = [];
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    set src(v: string) { SrcImage.srcs.push(v); this._src = v; setTimeout(() => this.onload?.(), 0); }
    get src(): string { return this._src; }
    abort(): void { /* noop */ }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetTwoGisMirrorCache();
    SrcImage.srcs = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loadTileImage с URL tile-b01 реально запрашивает живое зеркало sl*', async () => {
    vi.stubGlobal('Image', SrcImage);
    const p = loadTileImage('https://tile-b01.2gis.com/tiles?x=0&y=0&z=4', 5000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.not.toBeNull();
    expect(SrcImage.srcs.length).toBe(1);
    // Ключевая регрессия: ни одного запроса к tile-b01.x — даже при прямом
    // вызове loadTileImage/startTileLoad с битым хостом (шторм из консоли).
    expect(SrcImage.srcs[0]).toMatch(/^https:\/\/sl[1-4]\.2gis\.com\/tiles\?x=0&y=0&z=4$/);
    expect(SrcImage.srcs[0]).not.toContain('tile-b01');
  });

  it('OSM/прочие URL не затрагиваются (no-op)', () => {
    expect(normalizeTwoGisTileUrl('https://tile.openstreetmap.org/10/512/340.png'))
      .toBe('https://tile.openstreetmap.org/10/512/340.png');
    expect(normalizeTwoGisTileUrl('https://basemaps.cartocdn.com/dark_all/10/1/1.png'))
      .toBe('https://basemaps.cartocdn.com/dark_all/10/1/1.png');
  });

  it('сторонний шаблон с 2gis.com в адресе тоже ведётся на зеркала', () => {
    const out = normalizeTwoGisTileUrl('https://cdn.example.ru/2gis.com/tiles?x=7&y=8&z=9');
    expect(out).toMatch(/^https:\/\/sl[1-4]\.2gis\.com\//);
    expect(out).not.toContain('tile-b01');
    expect(out).toContain('/tiles?x=7&y=8&z=9'); // путь+query сохранены
  });
});
