// Регрессионный тест ФАЗА 2 (деструктивная очистка localStorage):
// cleanupLocalStorage/freeLocalStorageSpace обязаны удалять ТОЛЬКО ключи из
// собственного allow-list приложения. Чужие данные того же origin удалять запрещено.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  APP_OWN_STORAGE_KEYS,
  isAppOwnStorageKey,
  cleanupLocalStorage,
  checkLocalStorageQuota,
} from '../src/utils/storage';

/** Перечисляемый мок localStorage (как реальный Storage для for..in/Object.keys). */
function installMockStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  const api: Record<string, unknown> = {};
  // Реальный Storage объявляет данные перечислимыми свойствами — воспроизводим это.
  for (const [k, v] of map) {
    Object.defineProperty(api, k, { enumerable: true, configurable: true, writable: true, value: v });
  }
  const fn = (name: string, impl: (...a: unknown[]) => unknown) =>
    Object.defineProperty(api, name, { value: impl, enumerable: false, configurable: true, writable: true });
  fn('getItem', (k: string) => (map.has(k) ? map.get(k)! : null));
  fn('setItem', (k: string, v: string) => {
    map.set(k, String(v));
    Object.defineProperty(api, k, { enumerable: true, configurable: true, writable: true, value: String(v) });
  });
  fn('removeItem', (k: string) => { map.delete(k); delete api[k]; });
  fn('clear', () => { for (const k of [...map.keys()]) delete api[k]; map.clear(); });
  fn('key', (i: number) => Array.from(map.keys())[i] ?? null);
  Object.defineProperty(api, 'length', { get: () => map.size, enumerable: false, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: api });
  return map;
}

describe('cleanupLocalStorage: безопасность данных (allow-list)', () => {
  const real = globalThis.localStorage;
  let warnCount = 0;
  const origWarn = console.warn;

  beforeEach(() => {
    warnCount = 0;
    console.warn = (...args: unknown[]) => { if (args[0] === 'localStorage заполнен на') warnCount++; };
  });
  afterEach(() => {
    console.warn = origWarn;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
  });

  it('не удаляет чужие ключи даже огромного размера (регрессия «удалить всё, кроме основного»)', () => {
    const map = installMockStorage({
      'totalquadro-storage': 'state',
      'other-site:data': 'X'.repeat(4 * 1024 * 1024), // чужие тяжёлые данные
      'extension-cache': 'Y'.repeat(3 * 1024 * 1024), // ещё чужое (>80% квоты)
      'mission-launch-1700000000000': 'A'.repeat(500), // своё временное
      'totalquadro-backup-v1': 'B'.repeat(300),        // свой бэкап стора
    });
    const res = cleanupLocalStorage();

    // Удалены только собственные ephemeral/spill-записи
    expect(res.removedKeys.sort()).toEqual(['mission-launch-1700000000000', 'totalquadro-backup-v1']);
    // Чужие ключи и активный стор — целы
    expect(map.has('other-site:data')).toBe(true);
    expect(map.has('extension-cache')).toBe(true);
    expect(map.get('totalquadro-storage')).toBe('state');
    expect(res.freedBytes).toBeGreaterThan(500);
    expect(res.percentage).toBeGreaterThan(80);
    expect(warnCount).toBe(1); // предупреждение о заполнении осталось
  });

  it('идемпотентна: повторный вызов ничего не удаляет и не бросает', () => {
    installMockStorage({ 'totalquadro-storage': 'state', 'mission-launch-1700000000001': 'B'.repeat(100) });
    const first = cleanupLocalStorage();
    expect(first.removedKeys).toEqual(['mission-launch-1700000000001']);
    const second = cleanupLocalStorage();
    expect(second.removedKeys).toEqual([]);
    expect(second.freedBytes).toBe(0);
  });

  it('allow-list покрывает все ключи сторов приложения', () => {
    for (const key of ['totalquadro-storage', 'tq-map', 'tq-mission', 'tq-fleet',
      'tq-mission-wizard', 'tq-mission-saved', 'tq-ui-mode', 'tq-wizard-maps-open', 'tq-view']) {
      expect(isAppOwnStorageKey(key)).toBe(true);
      expect(APP_OWN_STORAGE_KEYS).toContain(key);
    }
    expect(isAppOwnStorageKey('totalquadro-backup-v1')).toBe(true);
    expect(isAppOwnStorageKey('somebody-else-key')).toBe(false);
  });

  it('quota-метрики считаются по всем ключам (и чужим тоже — только чтение)', () => {
    installMockStorage({ 'other-app': 'Z'.repeat(1000) });
    const q = checkLocalStorageQuota();
    expect(q.used).toBeGreaterThanOrEqual(1000 + 'other-app'.length);
    expect(q.percentage).toBeLessThan(1);
  });
});
