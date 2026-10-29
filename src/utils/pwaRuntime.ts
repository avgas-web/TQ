// ═══════════════════════════════════════════════════════════════
// pwaRuntime — ЭТАП 1.3: рантайм-ядро офлайн-кэширования.
//
// В продакшене эти же правила исполняет Service Worker (Workbox),
// сгенерированный vite-plugin-pwa из vite.config.js (runtimeCaching).
// Здесь правила живут как ЕДИНСТВЕННЫЙ источник истины в типизированном
// виде: конфиг Workbox проверяется тестами против этой таблицы, а сам
// механизм (CacheFirst / NetworkFirst) реализован на стандартном
// Cache API — его можно запустить и в тестовой среде с мок-кэшами,
// и в браузере до/без регистрации SW (graceful degradation).
// ═══════════════════════════════════════════════════════════════

export type CacheStrategy = 'cacheFirst' | 'networkFirst';

export interface RuntimeRule {
  /** Имя кэша (совпадает с cacheName в workbox.runtimeCaching) */
  cacheName: string;
  strategy: CacheStrategy;
  /** Матчер URL (эквивалент RegExp из конфига Workbox) */
  match: RegExp;
  networkTimeoutMs?: number;
}

/**
 * Таблица правил — зеркало vite.config.js → VitePWA.workbox.runtimeCaching.
 * Любое расхождение ловит тест tests/pwaOffline.test.ts.
 */
export const RUNTIME_RULES: readonly RuntimeRule[] = [
  {
    cacheName: 'osm-tiles',
    strategy: 'cacheFirst',
    match: /^https:\/\/[a-z]\.tile\.openstreetmap\.org\//,
  },
  {
    cacheName: 'gde-tiles',
    strategy: 'cacheFirst',
    match: /^https:\/\/[a-z]+\.basemaps\.gdeltdc\.com\//,
  },
  {
    cacheName: 'api-cache',
    strategy: 'networkFirst',
    match: /\/api\/|nominatim\.openstreetmap\.org|api\.open-meteo\.com/,
    networkTimeoutMs: 8000,
  },
] as const;

/** Подобрать правило для URL (первое совпадение, как у Workbox). */
export function findRule(url: string): RuntimeRule | undefined {
  return RUNTIME_RULES.find((r) => r.match.test(url));
}

interface CacheLikeEntry {
  clone(): Response;
}
interface CacheLike {
  match(req: Request | string): Promise<CacheLikeEntry | undefined>;
  put(req: Request | string, res: CacheLikeEntry): Promise<void>;
}
interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface HandleOptions {
  fetchFn?: (req: Request) => Promise<Response>;
  cachesObj?: CacheStorageLike;
  isOnline?: () => boolean;
}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms || ms <= 0) return p;
  return await new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('network-timeout')), ms);
    p.then(
      (v) => { clearTimeout(to); resolve(v); },
      (e) => { clearTimeout(to); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/**
 * Обработка запроса по таблице правил. Возвращает:
 *  • Response — из кэша или сети;
 *  • null — нет подходящего правила / сеть недоступна и кэш пуст
 *    (вызывающий обязан показать человекочитаемую ошибку, не краш).
 */
export async function handleWithRules(req: Request, opts: HandleOptions = {}): Promise<Response | null> {
  const rule = findRule(req.url);
  if (!rule) return null;
  const cacheStorage = opts.cachesObj ?? (typeof caches !== 'undefined' ? caches : undefined);
  if (!cacheStorage) return null; // Cache API недоступен → graceful: без кэша
  const doFetch = opts.fetchFn ?? ((r: Request) => globalThis.fetch(r));
  const online = opts.isOnline ?? (() => navigator.onLine);
  const cache = await cacheStorage.open(rule.cacheName);

  if (rule.strategy === 'cacheFirst') {
    const hit = await cache.match(req);
    if (hit) return hit.clone() as Response;
    if (!online()) return null; // полностью офлайн и тайла нет в кэше
    try {
      const fresh = await doFetch(req.clone());
      if (fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return null;
    }
  }

  // networkFirst: свежий ответ приоритетен, при сете/таймауте — кэш
  if (online()) {
    try {
      const fresh = await withTimeout(doFetch(req.clone()), rule.networkTimeoutMs);
      if (fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch { /* уходим в кэш */ }
  }
  const cached = await cache.match(req);
  return cached ? (cached.clone() as Response) : null;
}
