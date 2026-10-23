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
// Регрессия «ERR_NAME_NOT_RESOLVED / таймауты у 2ГИС»: ДОМЕН ПОЛНОСТЬЮ
// ВЫВЕДЕН ИЗ ЗАГРУЗКИ. По консоль-логам пользователя недоступны ВСЕ хосты:
// tile-b01.2gis.com (DNS-блокировка) и зеркала sl{1..4}.2gis.com (таймауты).
// loadTileWithMirrors/loadTileImage обязаны НИКОГДА не обращаться к 2gis.com,
// а сразу грузить рабочий слой эталона «без ключей» (Esri World_Street_Map).
// ═══════════════════════════════════════════════════════════════
describe('2ГИС полностью выведен из загрузки — карты грузятся через рабочие слои эталона', () => {
  /** Мок Image, записывающий все запрошенные src; падает по onerror для
   * любого хоста 2gis.com (имитация ERR_NAME_NOT_RESOLVED/таймаутов сети),
   * успешно грузится для прочих (эталонных) хостов. */
  class TwoGisImage {
    static srcs: string[] = [];
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      TwoGisImage.srcs.push(v);
      if (v.includes('2gis.com')) setTimeout(() => this.onerror?.(), 0);
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

  it('tile-b01 переписывается на рабочий слой эталона (OSM France, как алиас 2gis) без единого запроса к 2gis.com', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    const p = loadTileWithMirrors('https://tile-b01.2gis.com/tiles?x=511&y=340&z=10', 1000);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
    const img = await p;
    expect(img).not.toBeNull();
    // Ключевая регрессия: ни одного запроса к ЛЮБОМУ хосту 2gis.com
    // (ни tile-b01, ни sl1..sl4) — раньше шторм ERR_NAME_NOT_RESOLVED/таймаутов
    // вешал очередь загрузки и карта оставалась пустой.
    expect(TwoGisImage.srcs.every((s) => !s.includes('2gis.com'))).toBe(true);
    // Единая схема разворота с реестром провайдеров: '2gis' → OSM France
    // standard (тот же улично-топографический стиль). Раньше здесь стоял
    // Esri Streets — один сохранённый проект рисовал разные подложки в
    // редакторе и мастере, а кэш тайлов промахивался по URL.
    expect(TwoGisImage.srcs[0]).toContain('tile.openstreetmap.fr/osmfr');
    // Те же тайловые координаты сохранены (XYZ-схема {z}/{x}/{y}.png)
    expect(TwoGisImage.srcs[0]).toMatch(/\/10\/511\/340\.png$/);
  });

  it('зеркала sl*.2gis.com тоже гасятся — домен недоступен целиком', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    const first = loadTileWithMirrors('https://sl2.2gis.com/tiles?x=1&y=1&z=10', 1000);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
    await first;
    TwoGisImage.srcs = [];
    const second = loadTileWithMirrors('https://sl3.2gis.com/tiles?x=2&y=2&z=10', 1000);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(TwoGisImage.srcs.length).toBe(1);
    expect(TwoGisImage.srcs[0]).not.toContain('2gis.com');
    expect(TwoGisImage.srcs[0]).toContain('tile.openstreetmap.fr/osmfr');
  });

  it('регрессия шторма из консоли: 10 тайлов подряд — ноль запросов к 2gis.com', async () => {
    vi.stubGlobal('Image', TwoGisImage);
    // Десятый тайл подряд — как в браузере пользователя при недоступном DNS-хосте:
    // раньше каждый тайл падал на tile-b01/sl* (шторм ошибок, пустая карта).
    const urls = Array.from({ length: 10 }, (_, i) =>
      `https://tile-b01.2gis.com/tiles?x=${i}&y=${i}&z=10`);
    for (const u of urls) {
      const p = loadTileWithMirrors(u, 1000);
      for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10);
      await p;
    }
    expect(TwoGisImage.srcs.every((s) => !s.includes('2gis.com'))).toBe(true);
    expect(TwoGisImage.srcs.every((s) => s.includes('tile.openstreetmap.fr'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Финальный барьер: normalizeTwoGisTileUrl обязан переписывать ЛЮБОЙ
// входящий 2ГИС-URL (мёртвый tile-b01, таймаотящие sl1..4, сторонние
// шаблоны, старые сохранённые проекты) на URL рабочего слоя ЭТАЛОНА с
// теми же тайловыми координатами. Это закрывает последний путь, которым
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

  it('loadTileImage с URL tile-b01 реально запрашивает рабочий слой эталона (OSM France)', async () => {
    vi.stubGlobal('Image', SrcImage);
    const p = loadTileImage('https://tile-b01.2gis.com/tiles?x=0&y=0&z=4', 5000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.not.toBeNull();
    expect(SrcImage.srcs.length).toBe(1);
    // Ключевая регрессия: ни одного запроса к 2gis.com — даже при прямом
    // вызове loadTileImage/startTileLoad с битым хостом (шторм из консоли).
    expect(SrcImage.srcs[0]).not.toContain('2gis.com');
    // Единая схема разворота '2gis' → OSM France standard (как в реестре
    // провайдеров) — XYZ-схема {z}/{x}/{y}.png, поддомен a для x+y=0.
    expect(SrcImage.srcs[0]).toMatch(/^https:\/\/a\.tile\.openstreetmap\.fr\/osmfr\/4\/0\/0\.png$/);
  });

  it('OSM/прочие URL не затрагиваются (no-op)', () => {
    expect(normalizeTwoGisTileUrl('https://tile.openstreetmap.org/10/512/340.png'))
      .toBe('https://tile.openstreetmap.org/10/512/340.png');
    expect(normalizeTwoGisTileUrl('https://basemaps.cartocdn.com/dark_all/10/1/1.png'))
      .toBe('https://basemaps.cartocdn.com/dark_all/10/1/1.png');
  });

  it('сторонний шаблон с 2gis.com в адресе тоже ведётся на рабочий слой эталона', () => {
    const out = normalizeTwoGisTileUrl('https://cdn.example.ru/2gis.com/tiles?x=7&y=8&z=9');
    expect(out).not.toContain('2gis.com');
    // '2gis' → OSM France standard (единая схема с реестром провайдеров);
    // поддомен для x+y=15 → (15)%3=0 → 'a'; XYZ-схема {z}/{x}/{y}.png.
    expect(out).toContain('tile.openstreetmap.fr/osmfr');
    expect(out).toMatch(/\/9\/7\/8\.png$/); // те же тайловые координаты x=7,y=8,z=9
  });

  it('2ГИС-URL без узнаваемой XYZ-схемы гасится прозрачным пикселем (в сеть не уходит)', () => {
    const out = normalizeTwoGisTileUrl('https://tile-b01.2gis.com/some/other/path');
    expect(out.startsWith('data:image/png')).toBe(true);
  });
});
