// ═══════════════════════════════════════════════════════════════
// eventBus — типобезопасный in-app EventBus (замена window.dispatchEvent).
// Единственный легитимный канал «кросс-компонентных» ephemeral-событий
// (ошибки хранилища, запросы зума из глобальных хоткеев). Никаких
// CustomEvent на window: события не утекают наружу и типизированы.
// ═══════════════════════════════════════════════════════════════

/** Карта имён событий → payload. Расширять только здесь. */
export interface AppEvents {
  /** Запрос масштабирования вокруг центра канваса (factor > 1 — приближение). */
  'map:zoom-request': { factor: number };
  /** Ошибка персистентности (localStorage quota / IndexedDB). */
  'storage:error': { message: string };
}

type Handler<T extends keyof AppEvents> = (payload: AppEvents[T]) => void;

const listeners = new Map<keyof AppEvents, Set<Handler<keyof AppEvents>>>();

export const eventBus = {
  on<K extends keyof AppEvents>(event: K, handler: Handler<K>): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as Handler<keyof AppEvents>);
    return () => this.off(event, handler);
  },

  off<K extends keyof AppEvents>(event: K, handler: Handler<K>): void {
    listeners.get(event)?.delete(handler as Handler<keyof AppEvents>);
  },

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<K>)(payload);
      } catch (err) {
        // обработчик не должен ронять эмиттера
        console.error(`[eventBus] handler error on "${event}":`, err);
      }
    }
  },
} as const;
