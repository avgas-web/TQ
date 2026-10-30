// ═══════════════════════════════════════════════════════════════
// ФАЗА 4.2 (аудит): safeStorage — quota-spill и устойчивость к битому JSON.
// Регрессии:
//  • QuotaExceededError при persist-set → молчаливая потеря данных;
//  • битый JSON в localStorage → падение гидрации стора.
//
// Мок localStorage вешается через vi.stubGlobal на УРОВНЕ ГЛОБАЛА: код
// src/utils/storage.ts обращается к `localStorage` динамически, поэтому мок
// виден всем импортам. Ключ теста вне префикса `tq-` — чтобы перехватчик из
// tests/setup.ts (анти-гидрация zustand) не влиял на поведение мока.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createSafeStorage } from '../src/utils/safeStorage';
import { eventBus } from '../src/utils/eventBus';

interface DummyState {
  items: number[];
}

const KEY = 'safestorage-test-quota';

/** Управляемый localStorage: бросает QuotaExceededError на значения > LIMIT. */
function installQuotaLimitedStorage(limit: number) {
  const store = new Map<string, string>();
  const quotaErr = () =>
    new DOMException('quota exceeded', 'QuotaExceededError');
  const impl = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw quotaErr();
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  vi.stubGlobal('localStorage', impl as unknown as Storage);
  return impl;
}

/** Обычный бесквотный мок localStorage (для тестов чтения). */
function installPlainStorage(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const impl = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  vi.stubGlobal('localStorage', impl as unknown as Storage);
  return impl;
}

describe('Фаза 4.2: createSafeStorage', () => {
  let errors: string[] = [];
  let offBus: () => void;

  beforeEach(() => {
    errors = [];
    offBus = eventBus.on('storage:error', ({ message }) => errors.push(message));
  });

  afterEach(() => {
    offBus();
    vi.unstubAllGlobals();
  });

  it('квота исчерпана → значение уходит в IndexedDB (spill), readback цел', async () => {
    // лимит 100 символов — снапшот заведомо больше → прямой setItem бросает.
    const ls = installQuotaLimitedStorage(100);
    const storage = createSafeStorage<DummyState>(KEY);

    const big: DummyState = { items: Array.from({ length: 500 }, (_, i) => i) };
    // setItem у PersistStorage «огнеупорный»: внутри fire-and-forget safeSetItem,
    // поэтому ждём завершения асинхронного spill-конвейера.
    await storage.setItem(KEY, { state: big, version: 0 });
    for (let i = 0; i < 50 && ls.getItem(KEY) === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // В localStorage — только маленький spill-маркер, не полное значение.
    const raw = ls.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThanOrEqual(100);
    expect(JSON.parse(raw!).__tqSpill).toBeTruthy();

    // Чтение разворачивает spill из IndexedDB — данные НЕ потеряны.
    const back = await storage.getItem(KEY);
    expect(back).not.toBeNull();
    expect(back!.state.items).toHaveLength(500);
    expect(errors).toEqual([]); // spill успешен — пользователю жаловаться не на что
  });

  it('битый JSON → чистый старт (null) + уведомление, без падения', async () => {
    installPlainStorage({ [KEY]: '{oops not json' });
    const storage = createSafeStorage<DummyState>(KEY);

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(errors.join(' ')).toMatch(/повреждены/i);
  });

  it('чужой формат (без envelope state/version) → null + уведомление', async () => {
    installPlainStorage({ [KEY]: JSON.stringify([1, 2, 3]) });
    const storage = createSafeStorage<DummyState>(KEY);

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(errors.join(' ')).toMatch(/формат/i);
  });

  it('санитайзер применяется к прочитанному снапшоту', async () => {
    installPlainStorage({
      [KEY]: JSON.stringify({ state: { items: null }, version: 0 }),
    });
    const storage = createSafeStorage<DummyState>(KEY, {
      sanitize: (raw) => {
        const r = raw as Partial<DummyState>;
        return { items: Array.isArray(r?.items) ? r.items : [] };
      },
    });
    const back = await storage.getItem(KEY);
    expect(back?.state).toEqual({ items: [] });
  });
});
