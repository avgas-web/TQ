// ═══════════════════════════════════════════════════════════════
// Глобальные моки окружения для тестов (jsdom не умеет canvas,
// Worker и performance-специфичные вещи).
// ═══════════════════════════════════════════════════════════════

// Canvas 2D: jsdom возвращает null из getContext без пакета canvas —
// подменяем no-op контекстом, чтобы компоненты MapCanvas монтировались.
const ctxStub = new Proxy({} as Record<string, unknown>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    if (prop === 'canvas') return undefined;
    // measureText обязан возвращать объект с числовыми метриками: компоненты
    // карты пишут `ctx.measureText(txt).width` — undefined ломал бы рендер в jsdom.
    if (prop === 'measureText') {
      return () => ({ width: 42, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 42 });
    }
    // свойства-значения (fillStyle и т.п.) читаются как undefined — ок
    return (...args: unknown[]) => {
      void args;
      return undefined;
    };
  },
  set(target, prop: string, value: unknown) {
    target[prop] = value;
    return true;
  },
});
HTMLCanvasElement.prototype.getContext = function getContext(): unknown {
  return ctxStub;
};

// Web Worker в jsdom недоступен — заглушка «воркер есть, но молчит»:
// код обязан корректно деградировать на синхронный фолбэк/таймаут.
class WorkerStub {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
  postMessage(data: unknown): void { void data; }
  terminate(): void { /* noop */ }
}
vi.stubGlobal('Worker', WorkerStub);

if (!('structuredClone' in globalThis)) {
  vi.stubGlobal('structuredClone', <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T);
}

// IndexedDB нет в jsdom — storage-утилы должны тихо падать/fallback'ить.
// ─── Полное отключение async-гидрации zustand persist в тестах ───
// Глобальный singleton localStorage в jsdom живёт между тестами одного файла:
// tq-* записи из предыдущего теста гидрируются асинхронно и перетирают
// детерминированный setState следующего теста (источник последних падений).
// getItem для ключей tq-* всегда возвращает null → rehydration нечего читать,
// состояние сторов задаётся только явными setState/clearStorage в beforeEach.
{
  const realGetItem = localStorage.getItem.bind(localStorage);
  const realSetItem = localStorage.setItem.bind(localStorage);
  const realRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.getItem = (key: string): string | null => {
    if (key.startsWith('tq-')) return null;
    return realGetItem(key);
  };
  localStorage.setItem = (key: string, value: string): void => {
    if (key.startsWith('tq-')) return; // persist-записи в тестах игнорируются
    realSetItem(key, value);
  };
  localStorage.removeItem = (key: string): void => {
    if (key.startsWith('tq-')) return;
    realRemoveItem(key);
  };
}
// alert/confirm/prompt в jsdom отсутствуют — React-код зовёт их напрямую.
vi.stubGlobal('alert', () => undefined);
vi.stubGlobal('confirm', () => true);
vi.stubGlobal('prompt', () => null);
// jest-dom: матчеры toBeDisabled/toBeInTheDocument и т.д.
import '@testing-library/jest-dom/vitest';

