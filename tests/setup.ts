// Глобальная подготовка тестовой среды: IndexedDB (fake), localStorage-заглушки.
import 'fake-indexeddb/auto';

const store = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
  });
}
