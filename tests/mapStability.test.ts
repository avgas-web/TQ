// ═══════════════════════════════════════════════════════════════
// Стабильность загрузки тайлов (P0 «Краш и зависание при загрузке карт»).
// Доказательства отсутствия зависаний:
//  1) loadTileImage с «молчащим» сервером разрешается по внутреннему
//     таймауту, а не висит вечно (circuit breaker нижнего уровня);
//  2) loadTileWithMirrors при 429-шторме перебирает зеркала и ЗАВЕРШАЕТСЯ
//     (maxRetries = число зеркал, экспоненциальных бесконечных ретраев нет);
//  3) URL-шаблон 2ГИС уникален и корректен для XYZ-протокола;
//  4) OSM включён по умолчанию (graceful default без API-ключа).
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadTileImage, loadTileWithMirrors, getOSMTileUrl } from '../src/utils/openStreetMap';
import { useMapStore } from '../src/store/useMapStore';

/** Image-заглушка, который НИКОГДА не стриггерит onload/onerror («висячий CDN»). */
class SilentImage {
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  aborted = false;
  set src(_v: string) { /* сервер молчит: событий нет */ }
  get src(): string { return ''; }
  removeAttribute(_n: string): void { /* noop для abortTileImage */ }
  abort(): void { this.aborted = true; }
}

describe('mapStability — circuit breakers загрузки тайлов', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('loadTileImage разрешается по таймауту при молчащем сервере (нет вечного спиннера)', async () => {
    const instances: SilentImage[] = [];
    class TrackedSilent extends SilentImage {
      constructor() { super(); instances.push(this); }
    }
    vi.stubGlobal('Image', TrackedSilent);
    const p = loadTileImage('https://tile.openstreetmap.org/10/511/340.png', 8000);
    await vi.advanceTimersByTimeAsync(8100);
    const result = await p; // промис ОБЯЗАН резолвиться, а не висеть
    expect(result).toBeNull();
    // зависшая загрузка ОТМЕНЕНА (img.abort()) — соединение освобождено
    expect(instances[0]?.aborted).toBe(true);
  });

  it('loadTileWithMirrors завершается за конечное число попыток при отказе всех зеркал', async () => {
    class FailImage extends SilentImage {
      set src(v: string) { void v; setTimeout(() => this.onerror?.(), 0); }
      get src(): string { return ''; }
    }
    vi.stubGlobal('Image', FailImage);
    const p = loadTileWithMirrors('https://tile.openstreetmap.org/10/511/340.png', 1000);
    // достаточно нескольких тиков: каждая зеркальная попытка падает по onerror
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);
    const result = await p;
    expect(result).toBeNull();
  });

  it('2ГИС заменён рабочим слоем эталона (OSM France) — без мёртвого 2gis.com', () => {
    // Регрессия DNS-шторма: tile-b01.2gis.com не резолвится (ERR_NAME_NOT_RESOLVED),
    // поэтому алиас '2gis' разворачивается в рабочий слой эталона «без ключей».
    const url2gis = getOSMTileUrl(10, 511, 340, '2gis', 'scheme');
    const urlOsm = getOSMTileUrl(10, 511, 340, 'osm', 'scheme');
    expect(url2gis).not.toContain('2gis.com');
    expect(url2gis).toContain('tile.openstreetmap.fr'); // OSM France standard
    expect(url2gis).toMatch(/\/10\/511\/340\.png$/);     // XYZ-схема {z}/{x}/{y}
    expect(urlOsm).toContain('arcgisonline.com');        // Esri World_Street_Map («работает всегда»)
    expect(url2gis).not.toBe(urlOsm);                    // разные слои — разные URL
  });

  it('провайдер по умолчанию — osm, подложка включена (автозагрузка без ключей)', () => {
    const st = useMapStore.getState();
    expect(st.openStreetMap.tileServer ?? 'osm').toBe('osm');
    expect(st.settings.tilesEnabled).toBe(true);
  });
});
