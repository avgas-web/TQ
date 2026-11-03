// ═══════════════════════════════════════════════════════════════
// missionGuard — защита от гонок состояний (ФАЗА 5.D: миграция из
// useStoreShim). Mutate-экшены миссии отклоняются, пока в mission-сторе
// идёт тяжёлая операция (isProcessing: пересчёт высот / загрузка миссии).
// Страж-фолбэк: зависший isProcessing (> MUTATE_GUARD_MS без пропущенных
// экшенов) разблокируется автоматически; resetProject() разблокирует
// принудительно через forceUnlockMissionGuard().
// setRoutePointAltitude / autoFixRoute НЕ блокируются (аварийные кнопки и
// ручная регулировка должны работать всегда).
// ═══════════════════════════════════════════════════════════════
import { useMissionStore } from "./useMissionStore";

const MUTATE_GUARD_MS = 120_000; // страховка: зависший прогон не должен «заморозить» UI навсегда

let lastGuardPassTs = Date.now();

/** Принудительная разблокировка guarded-экшенов (кнопка «Сброс»). */
export function forceUnlockMissionGuard(): void {
  lastGuardPassTs = Date.now() + MUTATE_GUARD_MS;
}

/**
 * Оборачивает mutate-экшен стора в isProcessing-страж. Возвращённая функция
 * имеет ту же сигнатуру, что и исходный экшен (typed generic — без any).
 */
export function withMissionGuard<A extends unknown[], R>(
  key: string,
  fn: (...args: A) => R,
): (...args: A) => R | null {
  return function guarded(...args: A): R | null {
    const st = useMissionStore.getState();
    if (st.isProcessing && Date.now() - lastGuardPassTs < MUTATE_GUARD_MS) {
      console.warn(
        `[mission] экшен «${key}» отклонён: идёт тяжёлая операция (пересчёт высот / загрузка миссии)`,
      );
      return null;
    }
    if (st.isProcessing) {
      console.warn(
        `[mission] isProcessing завис > ${MUTATE_GUARD_MS} мс — принудительная разблокировка guarded-экшенов`,
      );
      useMissionStore.setState({ isProcessing: false });
    }
    lastGuardPassTs = Date.now();
    return fn(...args);
  };
}
