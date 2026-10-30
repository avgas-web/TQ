// ═══════════════════════════════════════════════════════════════
// safeStorage — ФАЗА 4.2: единое «безопасное» хранилище для zustand persist.
//
// Заменяет прямой `createJSONStorage(() => localStorage)` во всех доменных
// сторах (tq-map / tq-mission / tq-fleet). Гарантии границы:
//  • ЗАПИСЬ: сериализация никогда не бросает; сохранение идёт через
//    safeSetItem → при переполнении квоты тяжёлое значение вытесняется
//    (spill) в IndexedDB, а при невозможности — публикуется 'storage:error'
//    (toast пользователю, см. Фазу 4.1). Молчаливая потеря данных исключена.
//  • ЧТЕНИЕ: битый JSON / чужой формат → null (чистый старт) + 'storage:error',
//    без падения гидрации; envelope {state, version} разбирается здесь же.
//  • ВАЛИДАЦИЯ: опциональный санитайзер секций (soft, best-effort) применяется
//    к снапшоту ПЕРЕД отдачей в persist-middleware — дефектные поля чинятся
//    дефолтами, приложение получает только схемобезопасные данные.
//  • removeItem: через safeRemoveItem — вместе со spill-записью IndexedDB.
//
// Отличие от createValidatedStorage (Ф3.3): там строгая Zod-схема может
// отвергнуть снапшот целиком (wizard), здесь — мягкая санация с сохранением
// легаси-полей (domain-сторы богаты расширениями, которые схема бы вырезала).
// ═══════════════════════════════════════════════════════════════
import type { PersistStorage, StorageValue } from "zustand/middleware";
import {
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  notifyStorageError,
} from "./storage";

/** Мягкий санитайзер снапшота стора: unknown → «починенный» объект. */
export type StateSanitizer<S> = (raw: unknown) => S;

export interface SafeStorageOptions<S> {
  /** Санация прочитанного state перед отдачей в persist (best-effort, не бросает). */
  sanitize?: StateSanitizer<S>;
  /** Вызывается, если снапшот пришлось починить/отвергнуть (для warnings/логов). */
  onSanitized?: (warnings: string[]) => void;
}

/**
 * Создать PersistStorage<S> поверх localStorage с quota-spill (IndexedDB),
 * обработкой ошибок через канал 'storage:error' и мягкой Zod-санацией на чтении.
 * Исключения наружу не пробрасываются никогда: гидрация не должна ронять UI.
 */
export function createSafeStorage<S>(
  name: string,
  opts: SafeStorageOptions<S> = {},
): PersistStorage<S> {
  const fail = (message: string): void => {
    // notifyStorageError — единая точка публикации (eventBus + legacy window-канал).
    notifyStorageError(message);
  };

  return {
    async getItem(key): Promise<StorageValue<S> | null> {
      let raw: string | null = null;
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

      let state = envelope.state as S;
      if (opts.sanitize) {
        const warnings: string[] = [];
        try {
          state = opts.sanitize(envelope.state);
        } catch (e) {
          // Санитайзер обязан быть мягким; если всё же бросил — чистый старт.
          warnings.push(e instanceof Error ? e.message : String(e));
          state = envelope.state as S;
        }
        if (warnings.length > 0) {
          opts.onSanitized?.(warnings);
          fail(
            `Данные (${key}) требовали восстановления: ${warnings.join(" ")} Часть значений сброшена к дефолтам.`,
          );
        }
      }
      return { state, version };
    },
    setItem(key, value): void {
      // safeSetItem сам обрабатывает quota → cleanup → spill в IndexedDB и
      // уведомляет об ошибках через 'storage:error' (см. Фазу 4.1).
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch {
        // Циклические ссылки/неизвестные типы в снапшоте — не роняем стор.
        fail(
          `Не удалось сериализовать состояние (${key}) — изменения НЕ сохранены.`,
        );
        return;
      }
      void safeSetItem(key, serialized);
    },
    removeItem(key): void {
      // Через safeRemoveItem: удаляется и spill-запись IndexedDB (иначе после
      // reset в хранилище оставалась «мусорная» тяжёлая запись).
      void safeRemoveItem(key);
    },
  };
}
