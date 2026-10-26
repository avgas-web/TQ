// ═══════════════════════════════════════════════════════════════
// Регрессия «Краш и зависание при загрузке карт»:
// loadTileImage обязан разрешаться НЕЗАВИСИМО от того, ответит ли
// сервер (onload/onerror/таймаут). Раньше при «висячем» CDN-соединении
// промис не резолвился никогда, слот очереди загрузки не освобождался —
// вся подложка останавливалась («вечный спиннер»).
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadTileImage, loadTileWithMirrors } from '../src/utils/openStreetMap';

/** Мок Image: src в setter'е ничего не делает, события никто не вызывает. */
class HangingImage {
  static instances: HangingImage[] = [];
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abortCalls = 0;
  /** Все URL, когда-либо присвоенные src (включая отменённые — src сбрасывается в '' при abort). */
  srcHistory: string[] = [];
  private _src = '';
  set src(v: string) { if (v) this.srcHistory.push(v); this._src = v; }
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
    const p = loadTileImage('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/10/1/1', 8000);
    await vi.advanceTimersByTimeAsync(5);
    const img = await p;
    expect(img).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0); // timer очищен — нет утечки таймеров
  });

  it('очередь зеркал Esri завершается даже когда оба хоста висят', async () => {
    vi.stubGlobal('Image', HangingImage);
    // tile.openstreetmap.org УДАЛЁН из загрузчика (403 по Referer с github.io);
    // единственный список зеркал теперь — Esri (server/services.arcgisonline.com)
    const p = loadTileWithMirrors(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/10/340/512',
      2000,
    );
    // 2 зеркала × 2 с таймаута = до 4 с; раньше — навсегда
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeNull();
    expect(HangingImage.instances.length).toBe(2);
    // второе зеркало опробовано после зависания первого
    expect(HangingImage.instances[1].srcHistory[0]).toContain('services.arcgisonline.com');
  });

  it('URL не-Esri провайдера грузится одним запросом без перебора зеркал', async () => {
    vi.stubGlobal('Image', HangingImage);
    const p = loadTileWithMirrors('https://a.tile.opentopomap.org/10/512/340.png', 2000);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toBeNull();
    expect(HangingImage.instances.length).toBe(1);
  });
});
