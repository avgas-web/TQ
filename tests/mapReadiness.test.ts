// Unit-тесты «готовности карты» — ядро запрета на постановку точек в пустом
// поле без карты (режим Мастера). Чистая функция computeMapReadiness.
import { describe, expect, it } from 'vitest';
import { computeMapReadiness } from '../src/components/wizard/mapReadiness';

const readyProject = {
  settings: { tilesEnabled: true },
  map: { bounds: { west: -180, east: 180, north: 85, south: -85 } },
  openStreetMap: { tileServer: 'osm' as const },
};

describe('computeMapReadiness', () => {
  it('карта НЕ готова, когда тайловая подложка выключена (пустое поле)', () => {
    const r = computeMapReadiness({ ...readyProject, settings: { tilesEnabled: false } }, true);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/Карта ещё не загружена/);
  });

  it('карта НЕ готова, когда у карты нет bounds (подложка не инициализирована)', () => {
    const r = computeMapReadiness({ ...readyProject, map: null }, true);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/Карта ещё не загружена/);
  });

  it('при активном OSM, но незавершённой загрузке — статус «Загрузка тайлов…»', () => {
    const r = computeMapReadiness(readyProject, false);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/Загрузка тайлов/);
  });

  it('готовность включается только при loaded=true и активном провайдере', () => {
    const r = computeMapReadiness(readyProject, true);
    expect(r.ready).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('2ГИС доступен без API-ключа и разблокирует постановку точек', () => {
    const r = computeMapReadiness(
      { ...readyProject, openStreetMap: { tileServer: '2gis' } },
      true,
    );
    expect(r.ready).toBe(true);
  });

  it('Google без API-ключа: НЕ готово, причина — требование ключа с подсказкой (graceful degradation)', () => {
    const r = computeMapReadiness(
      { ...readyProject, openStreetMap: { tileServer: 'google' }, googleMaps: undefined },
      true,
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/API-ключ Google/);
    expect(r.reason).toMatch(/OSM \/ 2ГИС/);
  });

  it('Яндекс без ключа блокирует, с включённым ключом — разблокирует', () => {
    const blocked = computeMapReadiness(
      { ...readyProject, openStreetMap: { tileServer: 'yandex' }, yandexMaps: undefined },
      true,
    );
    expect(blocked.ready).toBe(false);
    expect(blocked.reason).toMatch(/API-ключ Яндекс/);

    const allowed = computeMapReadiness(
      {
        ...readyProject,
        openStreetMap: { tileServer: 'yandex' },
        yandexMaps: { apiKey: 'k', enabled: true },
      },
      true,
    );
    expect(allowed.ready).toBe(true);
  });
});
