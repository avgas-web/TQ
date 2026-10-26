// ═══════════════════════════════════════════════════════════════
// Тесты реестра провайдеров карт и дефолтов (ТЗ «Интеграция 2ГИС»,
// «Автоматическая загрузка и дефолты»).
// - Дефолтный провайдер при инициализации стора — 'osm'.
// - Переключение на '2gis' обновляет URL-шаблон тайлов.
// - Отсутствие API-ключа Google/Яндекс => состояние ошибки, без краша.
// - Регрессия: OSM/Topo/Carto работают без ключей.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProviderStatus,
  tileUrlTemplate,
  providerRequiresKey,
  KEYLESS_PROVIDERS,
} from '../src/utils/mapProviders';
import { useMapStore } from '../src/store/useMapStore';

type ProjectSlice = Parameters<typeof getProviderStatus>[0];

const noKeys: ProjectSlice = { googleMaps: undefined, yandexMaps: undefined };
const withGoogleKey: ProjectSlice = {
  googleMaps: { enabled: true, apiKey: 'AIza-test-key' },
  yandexMaps: undefined,
};

describe('mapProviders: дефолты стора', () => {
  beforeEach(() => {
    // Полный сброс к начальному состоянию (без persist-артефактов других тестов).
    useMapStore.setState(useMapStore.getInitialState());
  });

  it('дефолтный тайловый провайдер при инициализации — osm', () => {
    const st = useMapStore.getState();
    expect(st.openStreetMap.tileServer).toBe('osm');
    expect(KEYLESS_PROVIDERS.has('osm')).toBe(true);
  });

  it('переключение провайдера на 2gis корректно обновляет состояние стора', () => {
    useMapStore.getState().setOSMTileServer('2gis');
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('2gis');
    useMapStore.getState().setOSMTileServer('osm');
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('osm');
  });
});

describe('mapProviders: URL-шаблоны тайлов', () => {
  it('2gis рендерит рабочую подложку Esri (tile-b01.2gis.com не резолвится)', () => {
    const t = tileUrlTemplate('2gis');
    expect(t).not.toContain('2gis.com');
    expect(t).toContain('server.arcgisonline.com');
    expect(t).toContain('{z}');
    expect(t).toContain('{x}');
    expect(t).toContain('{y}');
  });

  it('osm — по аудиту рендерит Esri Streets (tile.openstreetmap.org даёт 403 с github.io)', () => {
    const t = tileUrlTemplate('osm');
    expect(t).not.toContain('tile.openstreetmap.org');
    expect(t).toContain('server.arcgisonline.com');
  });

  it('google/yandex/opentopomap/carto имеют собственные шаблоны', () => {
    expect(tileUrlTemplate('google')).toContain('google.com');
    expect(tileUrlTemplate('yandex')).toMatch(/webmap|yandex/);
    expect(tileUrlTemplate('opentopomap')).toContain('opentopomap');
    // Carto требует API-ключ (пункт B аудита) → шаблон указывает на рабочий OSM France
    const carto = tileUrlTemplate('carto');
    expect(carto).not.toContain('cartocdn');
    expect(carto).toContain('openstreetmap.fr');
  });
});

describe('mapProviders: graceful degradation без ключей', () => {
  it('Google без ключа: НЕ падает, возвращает ready:false + понятное сообщение', () => {
    const s = getProviderStatus(noKeys, 'google');
    expect(s.ready).toBe(false);
    expect(s.requiresKey).toBe(true);
    expect(s.message).toMatch(/API-ключ/);
    expect(s.message).toMatch(/OSM|2ГИС/);
  });

  it('Яндекс без ключа: ready:false + сообщение о ключе', () => {
    const s = getProviderStatus(noKeys, 'yandex');
    expect(s.ready).toBe(false);
    expect(s.message).toMatch(/Яндекс/);
  });

  it('Google С валидным включённым ключом: ready:true', () => {
    const s = getProviderStatus(withGoogleKey, 'google');
    expect(s.ready).toBe(true);
    expect(s.message).toBeUndefined();
  });

  it('Google с ключом, но выключенным провайдером: ready:false', () => {
    const s = getProviderStatus(
      { ...withGoogleKey, googleMaps: { ...withGoogleKey.googleMaps!, enabled: false } },
      'google',
    );
    expect(s.ready).toBe(false);
  });

  it('бесплатные провайдеры (osm/2gis/topo/carto) всегда ready без ключа', () => {
    for (const id of ['osm', '2gis', 'opentopomap', 'carto'] as const) {
      const s = getProviderStatus(noKeys, id);
      expect(s.ready).toBe(true);
      expect(providerRequiresKey(id)).toBe(false);
    }
  });
});
