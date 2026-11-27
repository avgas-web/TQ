/**
 * Модульный LRU-кэш изображений тайлов (T2).
 *
 * Живёт ВНЕ компонентов: переживает remount MapCanvas при переходах между
 * этапами мастера (3→4→3), поэтому уже загруженные тайлы не качаются заново.
 *
 * Гарантии:
 *  - LRU-cap (по умолчанию 600 записей, включая отрицательный кэш ошибок);
 *  - дедупликация in-flight запросов между всеми инстансами (общий Set url);
 *  - refcount-отмена: cancel() одного потребителя НЕ прерывает общую загрузку,
 *    если на неё есть другие подписчики; отменяется только последний потребитель;
 *  - crossOrigin='anonymous' сохраняется (загрузка идёт через startTileLoad из
 *    openStreetMap.ts) — canvas-экспорт exportTriplePng не taint'ится;
 *  - cache-hit возвращает готовый Image мгновенно, без ожидания повторного onload.
 *
 * Используется и MapCanvas (DOM-слой <img>-тайлов), и MiniMapPanel (canvas-слой
 * трёх окон) — общий фундамент загрузки без изменения проекционной математики.
 */
import { startTileLoad, type TileLoadHandle } from "./openStreetMap";

/** url -> изображение (null = отрицательный кэш: загрузка не удалась) */
const cache = new Map<string, HTMLImageElement | null>();
let cacheCap = 600;

/** Настройки лимита (тесты могут уменьшать; прод использует дефолт 600). */
export function setTileCacheCap(n: number): void {
  cacheCap = Math.max(1, n);
}

/** Текущий размер кэша (диагностика/тесты). */
export function tileCacheSize(): number {
  return cache.size;
}

/** Прямой read (для canvas-отрисовки MiniMapPanel): img | null | undefined. */
export function peekTile(url: string): HTMLImageElement | null | undefined {
  return cache.get(url);
}

/** Запись в кэш с LRU-вытеснением самых старых записей. */
export function putTile(url: string, img: HTMLImageElement | null): void {
  cache.set(url, img);
  // Перелистываем «свежую» запись в конец (Map хранит порядок вставки)
  if (cache.size > cacheCap) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Полная очистка кэша (тесты / смена проекта). Не трогает in-flight. */
export function clearTileCache(): void {
  cache.clear();
}

type InflightEntry = {
  handle: TileLoadHandle;
  /** число активных подписчиков (refcount) */
  refs: number;
  settled: boolean;
};

/** Общие незавершённые загрузки: url -> entry (дедуп между инстансами) */
const inflight = new Map<string, InflightEntry>();

/** Подписка на результат общей загрузки. Возвращает промис и функцию отписки. */
export type TileSubscription = {
  done: Promise<HTMLImageElement | null>;
  /** Отписка потребителя: освобождает слот очереди; последний cancel()
   *  отменяет сетевую загрузку (refcount-отмена). Идемпотентна. */
  release: () => void;
};

/**
 * Получить тайл: мгновенно из кэша либо через общую in-flight/новую загрузку.
 * `timeoutMs` — внутренний таймаут зависшего CDN (как в MapCanvas — 10 c).
 */
export function acquireTile(url: string, timeoutMs = 10000): TileSubscription {
  const cached = cache.get(url);
  if (cached !== undefined) {
    // cache-hit: мгновенно, без сети и без нового Image
    return {
      done: Promise.resolve(cached),
      release: () => {},
    };
  }

  let entry = inflight.get(url);
  if (!entry) {
    const handle = startTileLoad(url, timeoutMs);
    entry = { handle, refs: 0, settled: false };
    inflight.set(url, entry);
    const e = entry;
    handle.done.then((img) => {
      e.settled = true;
      // Если к моменту завершения подписцев нет (все release()'нули загрузку
      // заранее — отменённую handle уже не «кэшируем»), запись не нужна.
      if (e.refs <= 0 && img === null) {
        inflight.delete(url);
        return;
      }
      inflight.delete(url);
      if (img) {
        putTile(url, img);
      } else {
        // Ошибочные тайлы храним как null (отрицательный кэш): MiniMapPanel
        // полагается на null для «пропустить слот», а MapCanvas перезапрашивает
        // недостающие при следующей синхронизации DOM-слоя.
        putTile(url, null);
      }
    });
  }
  const bound = entry;
  bound.refs += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    bound.refs -= 1;
    if (bound.refs <= 0 && !bound.settled) {
      // Последний потребитель ушёл ДО завершения — отменяем общую загрузку
      // (settled-флаг startTileLoad гарантирует отсутствие resolve после cancel).
      inflight.delete(url);
      bound.handle.cancel();
    }
  };
  return { done: bound.handle.done, release };
}

/** Есть ли общая незавершённая загрузка для url (тесты/диагностика). */
export function isTileInflight(url: string): boolean {
  return inflight.has(url);
}

/** Число активных in-flight загрузок (тесты/диагностика). */
export function inflightCount(): number {
  return inflight.size;
}
