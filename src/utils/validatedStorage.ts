// ═══════════════════════════════════════════════════════════════
// validatedStorage — Zod-валидируемое хранилище для zustand persist (ФАЗА 3.3)
//
// Граница приложения: ANY состояние, читаемое из localStorage/IndexedDB,
// проходит через схему ДО попадания в стор. Битые снапшоты не роняют
// приложение и не «тихо» портят стейт — они санитизируются, а факт починки
// публикуется в eventBus ('storage:error') → toast пользователю (Фаза 4).
//
// Поток чтения:
//   getItem → safeGetItem (spill IndexedDB) → JSON.parse → envelope {state,version}
//            → migrate → schema.safeParse → очищенное значение или null;
//   setItem → JSON.stringify(envelope) → safeSetItem (quota → spill, уведомления);
//   removeItem → safeRemoveItem (вместе со spill-записью).
// ═══════════════════════════════════════════════════════════════
import { z } from "zod";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import {
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  notifyStorageError,
} from "./storage";
import { eventBus } from "./eventBus";

export interface ValidatedStorageOptions<T = unknown> {
  /** Миграция старого снапшота перед валидацией (версия из envelope persist). */
  migrate?: (persistedState: unknown, version: number) => T | Promise<T>;
  /** Вызывается, если схема что-то отбросила/починила или снапшот нечитаем. */
  onSanitized?: (warnings: string[]) => void;
}

/**
 * Создать PersistStorage, который гарантирует: наружу (в persist-middleware)
 * уходит только значение, прошедшее `schema` (или null — чистый старт).
 * Исключения не пробрасываются никогда: hydrate не должен ронять UI.
 *
 * Реализует zustand `PersistStorage<S>` напрямую: сериализация/парсинг
 * envelope {state, version} выполняются здесь же, что даёт контроль над
 * обработкой битого JSON на границе (createJSONStorage такой точки не имеет).
 */
export function createValidatedStorage<S>(
  name: string,
  schema: z.ZodType<S>,
  opts: ValidatedStorageOptions = {},
): PersistStorage<S> {
  const fail = (message: string): void => {
    notifyStorageError(message);
    eventBus.emit("storage:error", { message });
  };

  return {
    async getItem(key): Promise<StorageValue<S> | null> {
      // Читаем через safeGetItem: он разворачивает spill-записи (quota →
      // IndexedDB) и возвращает null при недоступном хранилище. Битый JSON —
      // отдельная ветка: storage:error + чистый старт, без throw.
      let raw: string | null;
      try {
        raw = await safeGetItem(key);
      } catch {
        fail(
          `Хранилище недоступно (${key}) — приложение запустилось с чистыми данными.`,
        );
        return null;
      }
      if (raw === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(
          `Сохранённые данные повреждены (${key}) — загружено чистое состояние.`,
        );
        return null;
      }
      if (!parsed || typeof parsed !== "object" || !("state" in parsed)) {
        fail(
          `Некорректный формат сохранения (${key}) — загружено чистое состояние.`,
        );
        return null;
      }
      const envelope = parsed as { state: unknown; version?: number };
      const version =
        typeof envelope.version === "number" ? envelope.version : 0;

      let candidate: unknown = envelope.state;
      if (opts.migrate) {
        try {
          candidate = await opts.migrate(candidate, version);
        } catch (e) {
          fail(
            `Миграция данных не удалась (${key}): ${e instanceof Error ? e.message : String(e)}. Применяется базовая санация.`,
          );
        }
      }

      const strict = schema.safeParse(candidate);
      if (strict.success) {
        return { state: strict.data, version };
      }
      // Схема с transform-санитайзером (например WizardPersistSchema) обязана
      // принимать произвольный вход; если и канонизация не помогла — чистый старт.
      fail(
        `Сохранённое состояние (${key}) не прошло проверку целостности — загружено чистое.`,
      );
      return null;
    },
    setItem(key, value): void {
      // safeSetItem сам обрабатывает quota/spill и уведомляет об ошибках.
      void safeSetItem(key, JSON.stringify(value));
    },
    removeItem(key): void {
      void safeRemoveItem(key);
    },
  };
}

/** Прежнее имя из плана Фазы 3 — теперь это прямой PersistStorage
 *  (оборачивать createJSONStorage больше не нужно; алиас сохранён, чтобы
 *  вызывающий код читался как «валидированное JSON-хранилище»). */
export const createValidatedJSONStorage = createValidatedStorage;
