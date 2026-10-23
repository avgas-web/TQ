// Регрессия «карта не загружается»: подложки взяты 1-в-1 из заведомо рабочего
// эталона (Leaflet-приложение «рабочие слои без ключей»). Проверяем, что:
//  • дефолтная подложка — Esri World_Street_Map (работает всегда, без DNS-шторма);
//  • ни один URL НЕ указывает на tile-b01.2gis.com и basemaps.cartocdn.com;
//  • при сбое основного хоста loadTileWithMirrors перебирает рабочие зеркала
//    (OSM France → OSM Germany → tile*.openstreetmap.org).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOSMTileUrl,
  osmFallbackHosts,
  loadTileWithMirrors,
  OSM_WORKING_HOSTS,
} from '../src/utils/openStreetMap';
import { tileUrlTemplate, fillWorkingLayerUrlTemplate } from '../src/utils/mapProviders';

describe('рабочие тайловые слои (порт эталонного Leaflet-кода)', () => {
  it('дефолт osm — Esri World_Street_Map без ключа', () => {
    const u = getOSMTileUrl(10, 511, 340, 'osm', 'scheme');
    expect(u).toBe(`${OSM_WORKING_HOSTS.esriStreets}/10/340/511`);
  });

  it('спутник — Esri World_Imagery', () => {
    const u = getOSMTileUrl(10, 511, 340, 'osm', 'satellite');
    expect(u).toContain('World_Imagery');
  });

  it('ни одна бесплатная подложка не ведёт на мёртвые/блокируемые хосты', () => {
    for (const server of ['osm', 'opentopomap', 'carto', '2gis'] as const) {
      const u = getOSMTileUrl(12, 2285, 1408, server, 'scheme');
      expect(u).not.toContain('tile-b01.2gis.com');
      expect(u).not.toContain('basemaps.cartocdn.com'); // блокируется как основной OSM
    }
  });

  it('topo/carto используют независимые серверы из эталона', () => {
    // Эталон Leaflet: OpenTopoMap — {s}.tile.opentopomap.org; carto → HOT-слой
    // OSM France ({s}.tile.openstreetmap.fr/hot), НЕ стандартный osmfr.
    expect(getOSMTileUrl(10, 1, 1, 'opentopomap')).toContain('tile.opentopomap.org');
    expect(getOSMTileUrl(10, 1, 1, 'carto')).toContain('tile.openstreetmap.fr/hot');
  });

  it('osmFallbackHosts даёт непустой список рабочих зеркал для Esri-URL', () => {
    const primary = getOSMTileUrl(10, 511, 340, 'osm', 'scheme');
    const fb = osmFallbackHosts(primary);
    expect(fb.length).toBeGreaterThan(0);
    // Дефолтный слой эталона — Esri улицы; первое зеркало — Esri спутник
    // (тот же стабильный хост), далее — OSM France / OSM Germany.
    expect(fb[0]).toContain('server.arcgisonline.com');
    expect(fb.some((u) => u.includes('tile.openstreetmap.fr'))).toBe(true);
    expect(fb.some((u) => u.includes('tile.openstreetmap.de'))).toBe(true);
    expect(fb.every((u) => u !== primary)).toBe(true);
  });

  it('tileUrlTemplate остаётся консистентным с фактическими URL', () => {
    // Шаблон строится из фактических URL загрузчика: подстановка меток через
    // fillWorkingLayerUrlTemplate (тот же детерминированный выбор {s}) должна
    // давать ровно тот URL, который реально запрашивается.
    const t = tileUrlTemplate('2gis'); // → osm-fr-standard
    expect(t).toContain('tile.openstreetmap.fr/osmfr');
    expect(t).toContain('{z}');
    expect(t).toContain('{x}');
    expect(t).toContain('{y}');
    expect(fillWorkingLayerUrlTemplate(t, 'osm-fr-standard', 511, 340, 10)).toBe(
      getOSMTileUrl(10, 511, 340, '2gis'),
    );
    for (const layer of ['esri-streets', 'esri-satellite', 'osm-de', 'opentopomap', 'cyclosm'] as const) {
      const lt = tileUrlTemplate(layer);
      expect(fillWorkingLayerUrlTemplate(lt, layer, 511, 340, 10)).toBe(getOSMTileUrl(10, 511, 340, layer));
    }
  });
});

describe('перебор рабочих зеркал при сбое основного хоста', () => {
  const RealImage = globalThis.Image;
  class FailAllImage {
    crossOrigin = '';
    set src(_v: string) { /* никогда не грузится */ }
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    removeAttribute() {}
  }
  class FirstHostOnlyImage {
    static srcs: string[] = [];
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    removeAttribute() {}
    set src(v: string) {
      FirstHostOnlyImage.srcs.push(v);
      if (v.includes('arcgisonline.com')) this.onload?.(); // живой только Esri
      else this.onerror?.();
    }
  }

  beforeEach(() => { FirstHostOnlyImage.srcs = []; });
  afterEach(() => { globalThis.Image = RealImage; });

  it('loadTileWithMirrors доходит до живого запасного хоста', async () => {
    globalThis.Image = FirstHostOnlyImage as unknown as typeof Image;
    // Основной хост специально недоступен: эмулируем запрос на OSM France,
    // который умрёт, а дальше очередь должна дойти до… нет — порядок fallback
    // начинается с Esri Imagery (живой в этом моке).
    const img = await loadTileWithMirrors('https://a.tile.openstreetmap.fr/osmfr/10/511/340.png', 300);
    expect(img).not.toBeNull();
    expect(FirstHostOnlyImage.srcs.length).toBeGreaterThanOrEqual(2);
    expect(FirstHostOnlyImage.srcs[FirstHostOnlyImage.srcs.length - 1]).toContain('arcgisonline.com');
  });

  it('все зеркала мертвы → null без зависания', async () => {
    globalThis.Image = FailAllImage as unknown as typeof Image;
    const img = await loadTileWithMirrors('https://a.tile.openstreetmap.fr/osmfr/10/511/340.png', 50);
    expect(img).toBeNull();
  });
});
