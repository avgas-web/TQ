// Юнит-тесты ЭТАПА 1: стиль карты в getOSMTileUrl + нормализация провайдеров.
import { describe, it, expect } from 'vitest';
import {
  getOSMTileUrl, normalizeTileServer, NATIVE_MAX_ZOOM_BY_SERVER, TileStyle, TileServerId,
} from '../src/utils/openStreetMap';

describe('ЭТАП 1: getOSMTileUrl учитывает style', () => {
  it('критерий приёмки: satellite на esri -> World_Imagery (не World_Street_Map)', () => {
    const url = getOSMTileUrl(10, 512, 340, 'esri', 'satellite');
    expect(url).toContain('server.arcgisonline.com');
    expect(url).toContain('World_Imagery');
    expect(url).not.toContain('World_Street_Map');
    // Esri-схема тайлов: .../{z}/{y}/{x}
    expect(url).toMatch(/World_Imagery\/MapServer\/tile\/10\/340\/512$/);
  });

  it('hybrid тоже принудительно переключает на esri-sat при любом tileServer', () => {
    for (const server of ['osm', 'carto', 'opentopomap', 'esri']) {
      const url = getOSMTileUrl(5, 3, 4, server, 'hybrid');
      expect(url).toContain('World_Imagery');
    }
  });

  it('satellite с legacy tileServer osm/carto -> Esri Imagery', () => {
    expect(getOSMTileUrl(1, 0, 0, 'osm', 'satellite')).toContain('World_Imagery');
    expect(getOSMTileUrl(1, 0, 0, 'carto', 'satellite')).toContain('World_Imagery');
  });

  it('scheme не трогает выбранный провайдер', () => {
    expect(getOSMTileUrl(3, 1, 2, 'osm', 'scheme')).toContain('tile.openstreetmap.org/3/1/2');
    expect(getOSMTileUrl(3, 1, 2, 'carto', 'scheme')).toContain('basemaps.cartocdn.com/dark_all/3/1/2');
    expect(getOSMTileUrl(3, 1, 2, 'esri', 'scheme')).toContain('World_Street_Map/MapServer/tile/3/2/1');
    expect(getOSMTileUrl(3, 1, 2, 'esri-sat', 'scheme')).toContain('World_Imagery/MapServer/tile/3/2/1');
    expect(getOSMTileUrl(3, 1, 2, 'opentopomap', 'scheme')).toContain('tile.opentopomap.org/3/1/2.png');
  });

  it('z ограничивается нативным максимумом провайдера', () => {
    // opentopomap: maxNativeZoom 17 — запрос z20 должен дать уровень 17
    expect(getOSMTileUrl(20, 1, 1, 'opentopomap', 'scheme')).toContain('/17/');
    // esri-sat: до 19
    expect(getOSMTileUrl(25, 1, 1, 'esri', 'satellite')).toContain('/19/');
    // отрицательный зум -> 0
    expect(getOSMTileUrl(-5, 0, 0, 'osm', 'scheme')).toContain('/0/0/0');
  });
});

describe('normalizeTileServer: legacy-значения', () => {
  it('корректно нормализует legacy и алиасы', () => {
    expect(normalizeTileServer('osm')).toBe('osm');
    expect(normalizeTileServer('carto')).toBe('carto');
    expect(normalizeTileServer('opentopomap')).toBe('opentopomap');
    expect(normalizeTileServer('esri')).toBe('esri');
    expect(normalizeTileServer('esri-sat')).toBe('esri-sat');
    expect(normalizeTileServer('ESRI-SAT')).toBe('esri-sat');
    expect(normalizeTileServer(' satellite ')).toBe('esri-sat');
    expect(normalizeTileServer('imagery')).toBe('esri-sat');
    expect(normalizeTileServer('openstreetmap')).toBe('osm');
  });

  it('неизвестное/пустое/null -> osm (безопасный дефолт)', () => {
    expect(normalizeTileServer(undefined)).toBe('osm');
    expect(normalizeTileServer(null)).toBe('osm');
    expect(normalizeTileServer('')).toBe('osm');
    expect(normalizeTileServer('nonsense')).toBe('osm');
  });

  it('NATIVE_MAX_ZOOM_BY_SERVER покрывает все id', () => {
    const ids: TileServerId[] = ['osm', 'carto', 'opentopomap', 'esri', 'esri-sat'];
    for (const id of ids) expect(NATIVE_MAX_ZOOM_BY_SERVER[id]).toBeGreaterThan(10);
  });

  it('тип TileStyle остаётся трёхзначным', () => {
    const styles: TileStyle[] = ['scheme', 'satellite', 'hybrid'];
    expect(styles).toHaveLength(3);
  });
});
