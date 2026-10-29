// ═══════════════════════════════════════════════════════════════
// pwaOffline — ЭТАП 1.3: офлайн-поведение PWA.
//  • Таблица рантайм-правил (src/utils/pwaRuntime.ts) обязана совпадать
//    с workbox.runtimeCaching из vite.config.js (CacheFirst для скриптов/
//    стилей/тайлов, NetworkFirst для API);
//  • Кэширование тайлов и корректная отдача кэша при navigator.onLine=false;
//  • Отсутствие Service Worker → понятная блокировка (blocker), НЕ краш.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_RULES, findRule, handleWithRules } from '../src/utils/pwaRuntime';
import { detectOfflineCapability } from '../src/utils/offlineAvailability';
import { MockCacheStorage, createFetchMock, setOnline } from './mocks/mockServiceWorker';

const VITE_CONFIG = readFileSync(path.resolve(__dirname, '../vite.config.js'), 'utf8');

describe('ЭТАП 1.3 — PWA офлайн', () => {
  let cacheStorage: MockCacheStorage;
  let fetchMock: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    cacheStorage = new MockCacheStorage();
    fetchMock = createFetchMock();
    setOnline(true);
    // точный контроль глобальных «браузерных» возможностей
    Object.defineProperty(globalThis, 'caches', { value: cacheStorage, configurable: true, writable: true });
    vi.stubGlobal('fetch', fetchMock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('конфиг Workbox ↔ таблица правил', () => {
    it('vite.config.js содержит VitePWA с CacheFirst для тайлов и NetworkFirst для API', () => {
      expect(VITE_CONFIG).toContain('VitePWA');
      expect(VITE_CONFIG).toMatch(/handler:\s*"CacheFirst"/);
      expect(VITE_CONFIG).toMatch(/handler:\s*"NetworkFirst"/);
      expect(VITE_CONFIG).toContain('globPatterns');
      expect(VITE_CONFIG).toContain('autoUpdate');
    });

    it('runtimeCaching в конфиге = правила pwaRuntime (cacheName/handler/urlPattern)', () => {
      // В vite.config.js порядок полей: handler → options.cacheName, поэтому
      // матчим блоки handler+cacheName и сверяем стратегии с таблицей правил.
      const declared = [...VITE_CONFIG.matchAll(/handler:\s*"(CacheFirst|NetworkFirst)"[\s\S]{0,120}?cacheName:\s*"([^"]+)"/g)]
        .map((m) => ({ handler: m[1], cache: m[2] }));
      expect(declared.length).toBe(RUNTIME_RULES.length);
      for (const r of RUNTIME_RULES) {
        const want = declared.find((d) => d.cache === r.cacheName);
        expect(want, `кэш ${r.cacheName} должен быть объявлен в vite.config.js`).toBeDefined();
        expect(want!.handler.toLowerCase()).toBe(r.strategy.toLowerCase());
      }
      // стратегии: osm/gde — CacheFirst, api — NetworkFirst
      expect(findRule('https://a.tile.openstreetmap.org/3/4/5.png')?.strategy).toBe('cacheFirst');
      // urlPattern GDELT: /^https:\/\/[a-z]+\.basemaps\.gdeltdc\.com\// — поддомен обязателен
      expect(findRule('https://a.basemaps.gdeltdc.com/x/y/z/tile.png')?.strategy).toBe('cacheFirst');
      expect(findRule('https://nominatim.openstreetmap.org/search?q=X')?.strategy).toBe('networkFirst');
      expect(findRule('https://api.open-meteo.com/v1/elevation')?.strategy).toBe('networkFirst');
    });

    it('прекошируются скрипты и стили бандла (globPatterns js/css)', () => {
      expect(VITE_CONFIG).toMatch(/\*\.\{js,css[^}]*\}/);
    });
  });

  describe('рантайм: кэширование и отдача из кэша офлайн', () => {
    const TILE_URL = 'https://b.tile.openstreetmap.org/12/2142/1326.png';

    it('первый запрос тайла идёт в сеть и кладётся в кэш osm-tiles', async () => {
      const res = await handleWithRules(new Request(TILE_URL), { cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => true });
      expect(res?.status).toBe(200);
      expect(fetchMock.calls).toHaveLength(1);
      expect(cacheStorage.peek('osm-tiles')?.size).toBe(1);
    });

    it('повторный запрос тайла обслуживается из кэша БЕЗ сети (CacheFirst)', async () => {
      await handleWithRules(new Request(TILE_URL), { cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => true });
      setOnline(false);
      const res = await handleWithRules(new Request(TILE_URL), { cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => false });
      expect(res?.status).toBe(200);
      expect(fetchMock.calls).toHaveLength(1); // второй раз в сеть не ходили
    });

    it('API (NetworkFirst): онлайн — свежий сетевой ответ; офлайн — последний кэшированный', async () => {
      const API_URL = 'https://nominatim.openstreetmap.org/search?q=Kyiv&format=json';
      const on1 = await handleWithRules(new Request(API_URL), { cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => true });
      expect(on1?.status).toBe(200);
      expect(fetchMock.calls).toHaveLength(1);

      setOnline(false);
      const off = await handleWithRules(new Request(API_URL), { cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => false });
      expect(off?.status).toBe(200); // отдан кэш — приложение работает полностью офлайн
      expect(fetchMock.calls).toHaveLength(1); // в сеть не ходили (offline)
    });

    it('офлайн + тайл отсутствует в кэше → null (понятная ошибка UI, не исключение)', async () => {
      const res = await handleWithRules(new Request('https://c.tile.openstreetmap.org/1/0/0.png'), {
        cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => false,
      });
      expect(res).toBeNull();
    });

    it('запрос без правила не обрабатывается кэшем', async () => {
      const res = await handleWithRules(new Request('https://example.com/random'), {
        cachesObj: cacheStorage, fetchFn: fetchMock.fetch, isOnline: () => true,
      });
      expect(res).toBeNull();
    });
  });

  describe('graceful degradation: нет Service Worker / нет Cache API', () => {
    // В happy-dom нет ни serviceWorker, ни secure-context — подкручиваем
    // окружение так, чтобы детектор прошёл по нужной ветке каждого сценария.
    function withSW(): void {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', { value: {}, configurable: true });
    }

    afterEach(() => {
      delete (globalThis.navigator as unknown as Record<string, unknown>).serviceWorker;
    });

    it('navigator.serviceWorker отсутствует → blocker с человекочитаемым текстом, приложение живо', () => {
      const cap = detectOfflineCapability();
      expect(cap.serviceWorkerSupported).toBe(false);
      expect(cap.blocker).toBeTruthy();
      expect(cap.blocker).toContain('Service Worker');
      expect(cap.blocker!.toLowerCase()).toContain('данные'); // обещаем сохранность данных проекта
    });

    it('небезопасный контекст (http) → понятная подсказка про HTTPS', () => {
      withSW();
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      const cap = detectOfflineCapability();
      expect(cap.secureContext).toBe(false);
      expect(cap.blocker).toContain('HTTPS');
    });

    it('Cache API недоступен → handleWithRules возвращает null вместо краха', async () => {
      const saved = globalThis.caches;
      // @ts-expect-error — намеренная симуляция отсутствия Cache API
      delete globalThis.caches;
      const res = await handleWithRules(new Request('https://a.tile.openstreetmap.org/1/1/1.png'));
      expect(res).toBeNull();
      Object.defineProperty(globalThis, 'caches', { value: saved, configurable: true, writable: true });
    });
  });
});
