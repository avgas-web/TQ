// ═══════════════════════════════════════════════════════════════
// Тесты реестра провайдеров карт и дефолтов (аудит audit/index.fixed.html +
// ТЗ «Этап 1 — выбор карт»: 2ГИС удалён полностью).
// - Дефолтный провайдер при инициализации стора — 'osm' (рендерится как Esri).
// - Legacy-'2gis' больше не принимается типом TileProviderId (удалён из реестра).
// - Отсутствие API-ключа Google/Яндекс => состояние ошибки, без краша.
// - Регрессия: osm/opentopomap/carto работают без ключей.
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

  it('переключение провайдера обновляет состояние стора (2ГИС удалён из реестра)', () => {
    useMapStore.getState().setOSMTileServer('osmfr');
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('osmfr');
    useMapStore.getState().setOSMTileServer('osm');
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('osm');
  });
});

describe('mapProviders: URL-шаблоны тайлов', () => {
  it('legacy osm рендерит рабочую подложку Esri (tile.openstreetmap.org даёт 403 с github.io)', () => {
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
    expect(s.message).toMatch(/OSM|Esri/);
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

  it('бесплатные провайдеры (osm/topo/carto) всегда ready без ключа', () => {
    for (const id of ['osm', 'opentopomap', 'carto'] as const) {
      const s = getProviderStatus(noKeys, id);
      expect(s.ready).toBe(true);
      expect(providerRequiresKey(id)).toBe(false);
    }
  });
});
