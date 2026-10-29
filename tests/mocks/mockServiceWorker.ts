// ═══════════════════════════════════════════════════════════════
// mockServiceWorker — детерминированные двойники Service Worker / Cache
// для тестов ЭТАПА 1.3 (pwaOffline). Реальный Workbox в happy-dom не
// запускается; вместо этого прогоняем ТУ ЖЕ конфигурацию runtimeCaching
// из vite.config.js через матчер и фейковый кэш-стек.
// ═══════════════════════════════════════════════════════════════

export interface MockCacheEntry { url: string; body: string; status: number }

/** Простейший FIFO-кэш с LRU-вытеснением по maxEntries */
export class MockCache {
  private map = new Map<string, Response>();
  constructor(readonly name: string, readonly maxEntries = 8000) {}

  match(req: Request | string): Promise<Response | undefined> {
    const url = typeof req === 'string' ? req : req.url;
    return Promise.resolve(this.map.get(url));
  }
  put(req: Request | string, res: Response): Promise<void> {
    const url = typeof req === 'string' ? req : req.url;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(url, res.clone());
    return Promise.resolve();
  }
  get size(): number { return this.map.size; }
}

export class MockCacheStorage {
  private caches = new Map<string, MockCache>();
  open(name: string): Promise<MockCache> {
    let c = this.caches.get(name);
    if (!c) { c = new MockCache(name); this.caches.set(name, c); }
    return Promise.resolve(c);
  }
  delete(name: string): Promise<boolean> { return Promise.resolve(this.caches.delete(name)); }
  keys(): Promise<string[]> { return Promise.resolve([...this.caches.keys()]); }
  /** Синхронный доступ для ассертов теста */
  peek(name: string): MockCache | undefined { return this.caches.get(name); }
}

/** Сброс navigator.onLine (в happy-dom свойство read-only только в рантайме браузера) */
export function setOnline(v: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: v, configurable: true });
}

export interface FetchCall { url: string }

/**
 * Мок fetch: успешные ответы на тайлы/API; при offline (navigator.onLine=false)
 * или forceFail — бросает TypeError("Failed to fetch") как реальный браузер.
 */
export function createFetchMock(opts: { fail?: boolean } = {}): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchMock = async (input: Request | string): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url });
    const offline = !globalThis.navigator.onLine || !!opts.fail;
    if (offline) throw new TypeError('Failed to fetch');
    return new Response(`OK ${url}`, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return { fetch: fetchMock as unknown as typeof globalThis.fetch, calls };
}
