// Безопасный shim доступа к Zustand v5 persist-сторам.
// ПРОБЛЕМА, которую решает: zustand/middleware/persist гидрирует localStorage
// асинхронно (microtask). Код, вызывающий api.getState() «в лоб» на первом
// рендере (или из колбэков Leaflet/worker'ов), может получить состояние ДО
// гидрации либо поймать краш, если стор ещё не создан (HMR, модульные циклы).
// РЕШЕНИЕ: геттер стора + опциональное ожидание `onFinishHydration` с таймаутом;
// никогда не бросает — возвращает null, и вызывающий мягко деградирует.
import { useStore } from '../store/useStore';

export type StoreGetter<T> = () => T | null;

/**
 * Возвращает синхронный безопасный геттер состояния стора. Если стор уже
 * гидрирован — getState() немедленно; иначе — после onFinishHydration (или по
 * таймауту fallback'ом на текущее состояние). Никаких исключений наружу.
 */
export function makeStoreShim<T>(api: {
  getState: () => T;
  persist?: { hasHydrated?: () => boolean; onFinishHydration?: (fn: () => void) => () => void };
}, timeoutMs = 1000): StoreGetter<T> {
  let ready = false;
  const isReady = (): boolean => {
    try {
      return api.persist?.hasHydrated ? api.persist.hasHydrated() : true;
    } catch {
      // Стор без persist-обёртки или ещё не проинициализирован — считаем готовым,
      // getState ниже защищён try/catch.
      return true;
    }
  };
  if (!isReady()) {
    let unsub: (() => void) | undefined;
    const mark = (): void => { ready = true; unsub?.(); };
    try {
      unsub = api.persist?.onFinishHydration?.(mark);
    } catch { /* noop */ }
    window.setTimeout(mark, timeoutMs);
  } else {
    ready = true;
  }
  return () => {
    try {
      // Даже до готовности getState валиден (дефолты стора) — но может бросить
      // при повреждённых данных гидрации; глотаем и отдаём null.
      void ready;
      return api.getState();
    } catch {
      return null;
    }
  };
}

/** Готовый shim основного стора приложения. */
export const getAppStateSafe = makeStoreShim(useStore);
