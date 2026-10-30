// Юнит-тесты «legacy»-части хранилища: снимки подложки в IndexedDB,
// безопасная запись в localStorage (quota), очистка, события ошибок.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initMapDatabase, isIndexedDbAvailable, StorageUnavailableError,
  saveMapToIndexedDB, loadMapFromIndexedDB, deleteMapFromIndexedDB,
  clearAllMapsFromIndexedDB, getIndexedDBSize,
  checkLocalStorageQuota, cleanupLocalStorage, safeSetItem, notifyStorageError,
  safeGetItem, safeRemoveItem, migratePersistedState, LEGACY_STATE_KEYS,
  formatBytes,
} from '../src/utils/storage';

describe('IndexedDB: снимки подложки (maps store)', () => {
  beforeEach(async () => {
    await clearAllMapsFromIndexedDB();
  });

  it('initMapDatabase открывает БД с нужными object stores', async () => {
    const db = await initMapDatabase();
    expect(db.objectStoreNames.contains('maps')).toBe(true);
    // v2 — store пользовательских тактических карт
    expect(db.objectStoreNames.contains('userlayers')).toBe(true);
    db.close();
  });

  it('save -> load -> delete: полный цикл', async () => {
    expect(await saveMapToIndexedDB('m1', 'data:image/png;base64,AAA')).toBe(true);
    expect(await loadMapFromIndexedDB('m1')).toBe('data:image/png;base64,AAA');
    expect(await deleteMapFromIndexedDB('m1')).toBe(true);
    expect(await loadMapFromIndexedDB('m1')).toBeNull();
  });

  it('load несуществующего id -> null', async () => {
    expect(await loadMapFromIndexedDB('nope')).toBeNull();
  });

  it('повторное сохранение того же id перезаписывает данные', async () => {
    await saveMapToIndexedDB('m2', 'data:image/png;base64,ONE');
    await saveMapToIndexedDB('m2', 'data:image/png;base64,TWO');
    expect(await loadMapFromIndexedDB('m2')).toBe('data:image/png;base64,TWO');
    expect(await getIndexedDBSize()).toBe('data:image/png;base64,TWO'.length);
  });

  it('getIndexedDBSize суммирует длины dataUrl всех снимков', async () => {
    await saveMapToIndexedDB('a', 'X'.repeat(10));
    await saveMapToIndexedDB('b', 'Y'.repeat(15));
    expect(await getIndexedDBSize()).toBe(25);
  });

  it('clearAllMapsFromIndexedDB удаляет всё', async () => {
    await saveMapToIndexedDB('a', 'data:1');
    await saveMapToIndexedDB('b', 'data:2');
    expect(await clearAllMapsFromIndexedDB()).toBe(true);
    expect(await getIndexedDBSize()).toBe(0);
    expect(await loadMapFromIndexedDB('a')).toBeNull();
  });

  it('isIndexedDbAvailable true в тестовой среде', () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });

  it('при недоступном IndexedDB — StorageUnavailableError и тихий false в API', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    // Safari private mode: обращение к indexedDB бросает синхронно
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    try {
      expect(isIndexedDbAvailable()).toBe(false);
      await expect(initMapDatabase()).rejects.toBeInstanceOf(StorageUnavailableError);
      expect(await saveMapToIndexedDB('x', 'y')).toBe(false);
      expect(await loadMapFromIndexedDB('x')).toBeNull();
      expect(await deleteMapFromIndexedDB('x')).toBe(false);
      expect(await clearAllMapsFromIndexedDB()).toBe(false);
      expect(await getIndexedDBSize()).toBe(0);
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });

  it('onerror при открытии с SecurityError -> StorageUnavailableError', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const fakeReq: any = {};
    const openSpy = vi.fn(() => fakeReq);
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true, value: { open: openSpy },
    });
    try {
      const p = initMapDatabase();
      // имитируем отказ доступа на уровне события открытия
      fakeReq.error = { name: 'SecurityError' };
      fakeReq.onerror?.();
      await expect(p).rejects.toBeInstanceOf(StorageUnavailableError);
      expect(openSpy).toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });

  it('onblocked (старая версия держит другая вкладка) -> явная ошибка, не вечный promise', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const fakeReq: any = {};
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true, value: { open: () => fakeReq },
    });
    try {
      const p = initMapDatabase();
      fakeReq.onblocked?.();
      await expect(p).rejects.toThrow(/заблокирована другой открытой вкладкой/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });

  it('onerror без SecurityError -> общая ошибка открытия с именем причины', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const fakeReq: any = {};
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true, value: { open: () => fakeReq },
    });
    try {
      const p = initMapDatabase();
      fakeReq.error = { name: 'UnknownError' };
      fakeReq.onerror?.();
      await expect(p).rejects.toThrow(/Не удалось открыть IndexedDB \(UnknownError\)/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });
});

describe('localStorage: quota и безопасная запись', () => {
  const real = globalThis.localStorage;

  /**
   * Мок localStorage, совместимый с перебором `for..in` (как в реальном браузере):
   * каждая запись становится перечисляемым свойством объекта, поэтому
   * checkLocalStorageQuota / cleanupLocalStorage видят ключи корректно.
   */
  const fn_ = (target: Record<string, any>, name: string, impl: (...a: any[]) => any) =>
    Object.defineProperty(target, name, { value: impl, enumerable: false, configurable: true, writable: true });

  /**
   * Мок с «неизлечимой» квотой: очистка не освобождает место (removeItem
   * ничего не удаляет), поэтому единственный способ записать значение —
   * spill в IndexedDB. Используется для проверки честного отказа, когда
   * недоступен и localStorage, и IndexedDB.
   */
  function storageMockUncleanable(limitBytes: number) {
    const api = storageMock(limitBytes);
    fn_(api, 'removeItem', () => undefined);
    return api;
  }

  function storageMock(limitBytes: number, keepKeys: string[] = []) {
    const map = new Map<string, string>();
    const size = () => [...map.entries()].reduce((s, [k, v]) => s + k.length + v.length, 0);
    // Служебные методы храним НЕперечисляемыми, а данные — перечисляемыми
    // свойствами: так mock совпадает с реальным Storage по `for..in` /
    // Object.keys и не «подсвечивает» свои функции как ключи.
    const fn = (name: string, impl: (...a: any[]) => any) =>
      Object.defineProperty(api, name, { value: impl, enumerable: false, configurable: true, writable: true });
    const api: Record<string, any> = {};
    fn('getItem', (k: string) => (map.has(k) ? map.get(k)! : null));
    fn('setItem', (k: string, v: string) => {
      if (size() + k.length + String(v).length > limitBytes) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      map.set(k, String(v));
      Object.defineProperty(api, k, { enumerable: true, configurable: true, writable: true, value: String(v) });
    });
    fn('removeItem', (k: string) => {
      // keepKeys имитируют «ключ нельзя освободить обычным удалением»: место
      // освобождается только принудительно (__force) — так работает cleanup
      // внутри safeSetItem, которому запрещён снос собственного значения.
      if (keepKeys.includes(k)) return;
      map.delete(k);
      delete api[k];
    });
    fn('__force', (k: string) => {
      map.delete(k);
      delete api[k];
    });
    fn('clear', () => {
      for (const k of [...map.keys()]) delete api[k];
      map.clear();
    });
    fn('key', (i: number) => Array.from(map.keys())[i] ?? null);
    fn('hasOwnProperty', (k: string) => map.has(k));
    Object.defineProperty(api, 'length', { get: () => map.size, enumerable: false, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: api });
    return api;
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
    vi.restoreAllMocks();
  });

  it('safeSetItem пишет значение и возвращает true', async () => {
    storageMock(10_000);
    expect(await safeSetItem('k', 'v')).toBe(true);
    expect(localStorage.getItem('k')).toBe('v');
  });

  it('safeSetItem при неизлечимом переполнении spill-ит значение в IndexedDB вместо потери', async () => {
    // Квота localStorage исчерпана «навсегда»: освобождать нечего (единственный
    // ключ защищён как основной). Объём уходит в IndexedDB, а в localStorage
    // остаётся лишь маленький маркер — данные НЕ теряются из-за браузерной квоты.
    // Ключ защищён от очистки (keepKeys) -> повторная запись невозможна -> spill
    storageMock(60, ['locked']);
    const value = JSON.stringify({ routes: ['x'.repeat(4000)] });
    expect(await safeSetItem('locked', value)).toBe(true);
    const marker = localStorage.getItem('locked')!;
    expect(marker).toMatch(/^\{"__tqSpill":/);
    expect(marker.length).toBeLessThan(80);
    expect(await safeGetItem('locked')).toBe(value);
    // Принудительное удаление (мока «защищённых» ключей достаточно для теста spill)
    await safeRemoveItem('locked');
    (localStorage as any).__force?.('locked');
    expect(localStorage.getItem('locked')).toBeNull();
    expect(await safeGetItem('locked')).toBeNull();
  });

  it('safeGetItem читает обычные значения без разворота spill', async () => {
    storageMock(10_000);
    localStorage.setItem('plain', 'hello');
    expect(await safeGetItem('plain')).toBe('hello');
    expect(await safeGetItem('missing')).toBeNull();
  });

  it('safeSetItem при переполнении освобождает место, НЕ трогая чужие ключи', async () => {
    const events: string[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail as string);
    window.addEventListener('tq:storage-error', handler);
    try {
      // Хранилище заполнено одноразовым мусором -> запись не проходит с первого раза.
      // freeLocalStorageSpace обязан вычистить `mission-launch-<ts>` и освободить место.
      const ls = storageMock(10_000);
      ls.setItem('mission-launch-1700000000000', 'A'.repeat(9_000));
      // Чужой большой ключ: старая реализация удаляла «всё кроме основного» —
      // регрессия Фазы 2: он обязан выжить даже при освобождении места.
      ls.setItem('other-app-cache', 'X'.repeat(400));
      expect(await safeSetItem('fresh', 'C'.repeat(2_000))).toBe(true);
      expect(localStorage.getItem('fresh')).toBe('C'.repeat(2_000));
      expect(localStorage.getItem('mission-launch-1700000000000')).toBeNull();
      expect(localStorage.getItem('other-app-cache')).toBe('X'.repeat(400));
      expect(events.length).toBe(0);
    } finally {
      window.removeEventListener('tq:storage-error', handler);
    }
  });

  it('cleanupLocalStorage выше порога удаляет только собственные временные записи (allow-list)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    //лимит мока заведомо больше объёма данных, поэтому setItem не бросает:
    //проверяем результат CleanupResult и сохранность чужих/активных ключей
    //(ФАЗА 2: старое поведение «удалить всё, кроме основного» признано деструктивным)
    const ls = storageMock(8 * 1024 * 1024);
    ls.setItem('totalquadro-storage', 'keep');
    ls.setItem('mission-launch-1700000000000', 'A'.repeat(1000));
    ls.setItem('totalquadro-backup-old', 'B'.repeat(300));
    ls.setItem('other-app-data', 'C'.repeat(4.2 * 1024 * 1024));
    ls.setItem('junk2', 'D'.repeat(300));
    const res = cleanupLocalStorage();
    expect(warn).toHaveBeenCalledWith('localStorage заполнен на', expect.any(String), '%');
    expect(res.removedKeys.sort()).toEqual(['mission-launch-1700000000000', 'totalquadro-backup-old']);
    expect(res.freedBytes).toBeGreaterThan(1000);
    expect(ls.getItem('mission-launch-1700000000000')).toBeNull();
    expect(ls.getItem('totalquadro-backup-old')).toBeNull();
    expect(ls.getItem('totalquadro-storage')).toBe('keep');
    // Чужие ключи origin-а не удаляются НИКОГДА — даже при переполнении.
    expect(ls.getItem('other-app-data')).not.toBeNull();
    expect(ls.getItem('junk2')).toBe('D'.repeat(300));
  });

  it('safeSetItem возвращает false и уведомляет, если spill тоже невозможен', async () => {
    // Хранилище ЗАВЕДОМО переполнено (объём больше лимита): освобождать нечего
    // (removeItem-мок ничего не удаляет), повторная запись невозможна, а
    // IndexedDB недоступен -> единственный честный исход: false + уведомление.
    const ls = storageMockUncleanable(2_000);
    // Заполняем хранилище «под завязку», но так, чтобы первая запись всё же
    // прошла: переполнение должно проявиться именно на значении `huge`.
    ls.setItem('filler', 'F'.repeat(1_900));
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    const events: string[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail as string);
    window.addEventListener('tq:storage-error', handler);
    try {
      expect(await safeSetItem('huge', 'D'.repeat(500))).toBe(false);
      // Два уведомления: 1) хранилище переполнено, данные НЕ сохранены;
      // 2) предупреждение cleanupLocalStorage о заполнении >80%.
      expect(events.length).toBe(2);
      expect(events.some((m) => /переполнено/.test(m))).toBe(true);
      // маркер не должен остаться, если spill не выполнен
      expect(localStorage.getItem('huge')).toBeNull();
    } finally {
      window.removeEventListener('tq:storage-error', handler);
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });

  it('safeSetItem при малом объёме пишет напрямую даже с заблокированным IndexedDB', async () => {
    // Сценарий приватного режима: IndexedDB недоступен, но localStorage свободен.
    // Значение обязано сохраниться обычным путём — без spill и без паники.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    try {
      storageMock(2_000);
      expect(await safeSetItem('small', 'A'.repeat(100))).toBe(true);
      expect(localStorage.getItem('small')).toBe('A'.repeat(100));
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as any).indexedDB;
    }
  });

  it('safeSetItem при неизвестной ошибке -> false + уведомление общего вида', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error('доступ запрещён политикой сайта'); },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      },
    });
    const spy = vi.fn();
    window.addEventListener('tq:storage-error', spy);
    try {
      expect(await safeSetItem('k', 'v')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('tq:storage-error', spy);
    }
  });

  it('checkLocalStorageQuota считает заполнение и доступный остаток', () => {
    storageMock(100_000);
    localStorage.setItem('totalquadro-storage', 'Z'.repeat(1000));
    const q = checkLocalStorageQuota();
    expect(q.used).toBe(1000 + 'totalquadro-storage'.length);
    expect(q.available).toBe(5 * 1024 * 1024 - q.used);
    expect(q.percentage).toBeGreaterThan(0);
    expect(q.percentage).toBeLessThan(1);
  });

  it('cleanupLocalStorage ниже 80% ничего не удаляет', () => {
    storageMock(100_000);
    localStorage.setItem('tmp', '1');
    cleanupLocalStorage();
    expect(localStorage.getItem('tmp')).toBe('1');
  });


  it('cleanupLocalStorage глотает исключение из localStorage', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        get length() { throw new Error('заблокировано'); },
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => cleanupLocalStorage()).not.toThrow();
    expect(err).toHaveBeenCalled();
  });

  it('notifyStorageError диспетчеризует событие с текстом', () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('tq:storage-error', handler);
    try {
      notifyStorageError('проверка события');
      expect(seen).toEqual(['проверка события']);
    } finally {
      window.removeEventListener('tq:storage-error', handler);
    }
  });

  it('formatBytes: единицы и округление', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(999)).toBe('999 Б');
    expect(formatBytes(1024 ** 3)).toBe('1 ГБ');
    expect(formatBytes(1536)).toBe('1.5 КБ');
  });
});

describe('Миграция легаси-ключей хранилища (боевая терминология)', () => {
  it('переносит старые имена полей в новые', () => {
    const migrated = migratePersistedState({
      droneAssignments: [{ assetId: 'a1' }],
      nfzList: [{ id: 'z1' }],
      routeDraft: [{ lat: 1, lng: 2 }],
      gameLoop: 'running',
    } as any);
    expect(migrated.combatAssetAssignments).toEqual([{ assetId: 'a1' }]);
    expect(migrated.adizList).toEqual([{ id: 'z1' }]);
    expect(migrated.tacticalProjection).toEqual([{ lat: 1, lng: 2 }]);
    expect(migrated.combatCycle).toBe('running');
    expect('droneAssignments' in migrated).toBe(false);
    expect('nfzList' in migrated).toBe(false);
    expect('routeDraft' in migrated).toBe(false);
    expect('gameLoop' in migrated).toBe(false);
  });

  it('идемпотентна: повторный вызов ничего не меняет', () => {
    const once = migratePersistedState({ droneCount: 4 } as any);
    const twice = migratePersistedState(once);
    expect(twice).toEqual(once);
    expect(twice.assetCount).toBe(4);
  });

  it('новое поле приоритетнее старого, если оно непустое', () => {
    const migrated = migratePersistedState({
      strikeObjectives: [{ old: true }],
      droneGoals: [{ newer: true }],
    } as any);
    // strikeObjectives уже записан текущей версией стора -> легаси просто выбрасывается
    expect(migrated.strikeObjectives).toEqual([{ old: true }]);
    expect('droneGoals' in migrated).toBe(false);
  });

  it('пустой массив в новом поле заполняется из легаси', () => {
    const migrated = migratePersistedState({
      tacticalNodes: [],
      waypoints: [{ lat: 55, lng: 37 }],
    } as any);
    expect(migrated.tacticalNodes).toEqual([{ lat: 55, lng: 37 }]);
    expect('waypoints' in migrated).toBe(false);
  });

  it('null/undefined состояние -> пустой объект без бросания', () => {
    expect(migratePersistedState(null)).toEqual({});
    expect(migratePersistedState(undefined)).toEqual({});
  });

  it('легаси waypointParams в маршрутах мигрирует в tacticalNodeParams', () => {
    const migrated = migratePersistedState({
      project: {
        routes: [
          { id: 'r1', waypointParams: { altitude: 120, speed: 30 } },
          { id: 'r2' },
          null,
        ],
      },
    } as any);
    expect(migrated.project.routes[0].tacticalNodeParams).toEqual({ altitude: 120, speed: 30 });
    expect('waypointParams' in migrated.project.routes[0]).toBe(false);
    expect(migrated.project.routes[1].tacticalNodeParams).toBeUndefined();
  });

  it('непустое новое поле маршрута имеет приоритет над легаси', () => {
    const migrated = migratePersistedState({
      project: {
        routes: [
          { id: 'r1', waypointParams: { altitude: 1 }, tacticalNodeParams: { altitude: 99 } },
          { id: 'r2', waypointParams: { altitude: 5 }, tacticalNodeParams: {} },
        ],
      },
    } as any);
    expect(migrated.project.routes[0].tacticalNodeParams).toEqual({ altitude: 99 });
    expect('waypointParams' in migrated.project.routes[0]).toBe(false);
    expect(migrated.project.routes[1].tacticalNodeParams).toEqual({ altitude: 5 });
    expect('waypointParams' in migrated.project.routes[1]).toBe(false);
  });

  it('миграция форм маршрутов идемпотентна и не ломает отсутствие project/routes', () => {
    const once = migratePersistedState({
      project: { routes: [{ waypointParams: { x: 1 } }] },
    } as any);
    const twice = migratePersistedState(once);
    expect(twice.project.routes[0]).toEqual({ tacticalNodeParams: { x: 1 } });
    expect(() => migratePersistedState({ project: {} } as any)).not.toThrow();
    expect(() => migratePersistedState({ project: { routes: 'oops' } } as any)).not.toThrow();
  });

  it('таблица миграции покрывает все переименованные доменные поля', () => {
    expect(Object.keys(LEGACY_STATE_KEYS)).toContain('droneAssignments');
    expect(Object.values(LEGACY_STATE_KEYS)).toContain('combatAssetAssignments');
  });
});
