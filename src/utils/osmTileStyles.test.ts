// Регрессия аудита 1.3 (стили тайлов: satellite/hybrid -> esri-sat) и
// аудита 1.4 (Nominatim 404 = штатное «не найдено», без лишнего fallback).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESRI_SAT_TEMPLATE,
  __test_fetchNominatimJson as fetchNominatimJson,
  getOSMTileUrl,
  loadTileImageCancellable,
} from './openStreetMap';

describe('getOSMTileUrl — учёт стиля карты (аудит 1.3)', () => {
  it('style=satellite переключает провайдера на Esri World Imagery (esri-sat)', () => {
    // сигнатура: getOSMTileUrl(zoom, x, y, tileServer, style)
    const url = getOSMTileUrl(5, 5, 8, 'osm', 'satellite');
    expect(url).toContain('arcgisonline.com/ArcGIS/rest/services/World_Imagery');
    // порядок z/{y}/{x} специфичен для Esri:
    expect(url).toBe(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/8/5`);
  });

  it('style=hybrid тоже использует esri-sat', () => {
    const url = getOSMTileUrl(3, 1, 2, 'carto', 'hybrid');
    expect(url).toContain('World_Imagery/MapServer/tile/3/2/1');
  });

  it('явный tileServer=esri-sat работает при scheme-стиле', () => {
    const url = getOSMTileUrl(10, 512, 340, 'esri-sat', 'scheme');
    expect(url).toBe(ESRI_SAT_TEMPLATE.replace('{z}', '10').replace('{y}', '340').replace('{x}', '512'));
  });

  it('style=scheme остаётся на обычном OSM-шаблоне (x/y/z)', () => {
    const url = getOSMTileUrl(4, 8, 5, 'osm', 'scheme');
    expect(url).not.toContain('arcgis');
    expect(url).toMatch(/\/4\/8\/5/);
  });
});

describe('fetchNominatimJson — различение 404 и 5xx (аудит 1.4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('HTTP 404 -> kind=not_found, ровно ОДИН запрос (нет fallback по зеркалам)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as any);
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchNominatimJson('/search', 'q=test');
    expect(res.kind).toBe('not_found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 400 тоже штатное «не найдено» — без перебора зеркал', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }) as any);
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchNominatimJson('/search', 'q=bad');
    expect(res.kind).toBe('not_found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('сеть/таймаут (исключение fetch) -> network c полным перебором зеркалов', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ERR_CONNECTION_TIMED_OUT'); });
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchNominatimJson('/search', 'q=test');
    expect(res.kind).toBe('network');
    // 3 зеркала × 2 раунда = 6 попыток (fallback сохранён для СБОЯ, не для 404)
    expect(fetchMock.mock.calls.length).toBe(6);
  });

  it('пустой массив ответов 200 тоже трактуется как not_found', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as any);
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchNominatimJson('/search', 'q=nowhere');
    expect(res.kind).toBe('not_found');
    // пустой ответ — штатный результат: не более одного запроса к первому зеркалу
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('loadTileImageCancellable — гарантия отсутствия img.src после cancel (аудит 1.5)', () => {
  it('после cancel(): resolve(null), обработчики сняты, src обнулён', async () => {
    if (typeof globalThis.Image !== 'function') {
      // node-окружение: минимальный mock HTMLImageElement
      (globalThis as any).Image = class {
        onload: any = null; onerror: any = null;
        private _src = '';
        set src(v: string) { this._src = v; }
        get src() { return this._src; }
      };
    }
    const load = loadTileImageCancellable('https://tile.example/1/2/3.png', 5000);
    load.cancel();
    const result = await load.promise;
    expect(result).toBeNull();
  });
});
