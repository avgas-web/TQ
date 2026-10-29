// ═══════════════════════════════════════════════════════════════
// useMapParsersWorker — мост Main Thread ↔ mapParsers.worker (ЭТАП 1.1).
// Паттерн сознательно повторяет useRoutingWorker: ленивое создание,
// try/catch вокруг new Worker → graceful degradation на синхронный
// фолбэк (тот же код userMapLoader в основном потоке) + человекочитаемая
// ошибка в UI вместо «белого экрана» / зависшего интерфейса.
// Бинарные ArrayBuffer передаются как Transferable (нулевое копирование),
// поэтому парсинг файлов >50MB не блокирует рендер и ввод.
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserMapLayer } from '../types';
import { EPSG_3857, EPSG_4326 } from '../utils/userMapGeo';
import {
  loadGeoTiff, readMbtilesSummary, decodeMbtilesTilesForRender, closeMbtilesDbCache,
  type LoadOptions, type MbtilesSummary,
} from '../utils/userMapLoader';
import type {
  ParserRequest, ParserResponse, GeotiffResult, MbtilesTilesResult,
} from '../utils/mapParserProtocol';
import { isParserResponse, isGeotiffResult, isMbtilesSummary, isMbtilesTiles } from '../utils/mapParserProtocol';

/** Промис-обёртка над postMessage/onmessage с защитой от гонок по taskId. */
export interface MapParsersTransport {
  /** Доступен ли фоновый воркер (false ⇒ идёт синхронный фолбэк) */
  readonly workerAvailable: boolean;
  parseGeotiff(buffer: ArrayBuffer, opts?: LoadOptions): Promise<Partial<UserMapLayer>>;
  mbtilesSummary(buffer: ArrayBuffer): Promise<MbtilesSummary>;
  mbtilesTiles(buffer: ArrayBuffer, keys: string[], format?: string): Promise<Record<string, string>>;
  /** Освободить ресурсы (кэш SQLite в воркере). Вызывать при удалении слоя. */
  release(bufferRef?: ArrayBuffer): void;
}

export type ParserRunner = MapParsersTransport;

let taskSeq = 0;
const nextTaskId = (): number => ++taskSeq;

/** Кэш «буфер -> результат» для повторных волн тайлов одного файла */
const tilesPromiseCache = new WeakMap<ArrayBuffer, Map<string, Promise<Record<string, string>>>>();

function cachedTiles(
  buffer: ArrayBuffer, keys: string[], fmt: string,
  fetcher: (keys: string[]) => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  let byKeys = tilesPromiseCache.get(buffer);
  if (!byKeys) { byKeys = new Map(); tilesPromiseCache.set(buffer, byKeys); }
  const ck = `${fmt}|${keys.slice().sort().join(',')}`;
  const hit = byKeys.get(ck);
  if (hit) return hit;
  const p = fetcher(keys);
  byKeys.set(ck, p);
  p.catch(() => byKeys.delete(ck)); // ошибку не кэшируем
  return p;
}

// ─── Фолбэк: те же тяжёлые операции, но в основном потоке ──────────────────
// Используем ТОЛЬКО когда воркер недоступен (старый браузер/жёсткая CSP/SSR).
function syncTransport(onWarn: (msg: string) => void): MapParsersTransport {
  onWarn('Фоновая обработка карт недоступна — парсинг выполняется в основном потоке (UI может подтормаживать на больших файлах).');
  return {
    workerAvailable: false,
    parseGeotiff: (buffer, opts) => loadGeoTiff(buffer, opts ?? {}),
    mbtilesSummary: (buffer) => readMbtilesSummary(buffer),
    mbtilesTiles: (buffer, keys, format) => decodeMbtilesTilesForRender(buffer, keys, format ?? 'png'),
    release: () => closeMbtilesDbCache(),
  };
}

/** Создание singleton-воркера с graceful fallback. Возвращает null, если Worker недоступен. */
function createWorker(): Worker | null {
  try {
    if (typeof Worker === 'undefined') return null;
    // В браузере/Vite-сборке — стандартный module-worker. В тестовом рантайме
    // (node/vitest) `new URL(..., import.meta.url)` бросает ERR_INVALID_URL —
    // тогда падаем на простой конструктор: тесты подменяют глобальный Worker
    // управляемым MockWorker (см. tests/mocks/MockWorker.ts).
    try {
      return new Worker(new URL('../workers/mapParsers.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return new Worker('mapParsers.worker.js');
    }
  } catch {
    return null;
  }
}

interface SharedWorkerState {
  worker: Worker | null;
  refCount: number;
  pending: Map<number, { resolve: (r: ParserResponse) => void; reject: (e: Error) => void }>;
  listenersBound: boolean;
  unavailableReason: string | null;
}

const shared: SharedWorkerState = { worker: null, refCount: 0, pending: new Map(), listenersBound: false, unavailableReason: null };

function bindListeners(): void {
  if (shared.listenersBound || !shared.worker) return;
  shared.listenersBound = true;
  const w = shared.worker;
  w.onmessage = (event: MessageEvent<unknown>): void => {
    const res = event.data;
    if (!isParserResponse(res)) return;
    const slot = shared.pending.get(res.taskId);
    if (!slot) return; // устаревший/чужой ответ
    shared.pending.delete(res.taskId);
    slot.resolve(res);
  };
  w.onerror = (): void => {
    // Воркер упал «внутри»: все in-flight задачи отвергаем с читаемой причиной
    shared.unavailableReason = 'Фоновый обработчик карт аварийно завершился — включён синхронный режим.';
    for (const [, slot] of shared.pending) slot.reject(new Error(shared.unavailableReason));
    shared.pending.clear();
    try { shared.worker?.terminate(); } catch { /* noop */ }
    shared.worker = null;
    shared.listenersBound = false;
  };
}

function ensureWorker(): Worker | null {
  if (shared.worker) return shared.worker;
  shared.worker = createWorker();
  if (!shared.worker && !shared.unavailableReason) {
    shared.unavailableReason = 'Браузер не поддерживает Web Workers — карты обрабатываются в основном потоке.';
  }
  bindListeners();
  return shared.worker;
}

/** Часть запроса без служебных полей (op подставляется рантаймом request()) */
export type ParserRequestBuild = Omit<ParserRequest, 'taskId' | 'op'>;

function request<T>(
  op: ParserRequest['op'], build: (taskId: number) => ParserRequestBuild,
  transfer: (req: ParserRequest) => Transferable[],
  parse: (res: ParserResponse) => T,
): Promise<T> {
  const w = shared.worker;
  if (!w) return Promise.reject(new Error('worker-unavailable'));
  const taskId = nextTaskId();
  // op задаётся явно (не через spread), чтобы TS не считал его перезаписываемым
  const req: ParserRequest = { ...build(taskId), taskId, op };
  return new Promise<T>((resolve, reject) => {
    shared.pending.set(taskId, {
      resolve: (res: ParserResponse) => {
        if (res.ok) resolve(parse(res));
        else reject(new Error(res.error ?? `Ошибка обработки (${op})`));
      },
      reject,
    });
    try {
      w.postMessage(req, transfer(req));
    } catch (err) {
      shared.pending.delete(taskId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Хук-мост. Один физический воркер на приложение (reference-counted):
 * terminate() вызывается только когда последний потребитель отписался.
 */
export function useMapParsersWorker(): ParserRunner & { warning: string | null } {
  const [warning, setWarning] = useState<string | null>(null);
  const fallbackRef = useRef<MapParsersTransport | null>(null);

  useEffect(() => {
    shared.refCount += 1;
    const w = ensureWorker();
    if (!w) setWarning(shared.unavailableReason);
    return () => {
      shared.refCount -= 1;
      if (shared.refCount <= 0 && shared.worker) {
        try { shared.worker.terminate(); } catch { /* noop */ }
        shared.worker = null;
        shared.listenersBound = false;
        closeMbtilesDbCache();
      }
    };
  }, []);

  const getFallback = useCallback((): MapParsersTransport => {
    if (!fallbackRef.current) fallbackRef.current = syncTransport((m) => setWarning(m));
    return fallbackRef.current;
  }, []);

  const parseGeotiff = useCallback(async (buffer: ArrayBuffer, opts?: LoadOptions): Promise<Partial<UserMapLayer>> => {
    if (shared.worker) {
      try {
        const r = await request<GeotiffResult>(
          'parseGeotiff',
          () => ({ buffer }),
          () => [buffer],
          (res) => { if (!isGeotiffResult(res.payload)) throw new Error('Некорректный ответ воркера GeoTIFF'); return res.payload; },
        );
        return {
          kind: 'raster', format: 'geotiff',
          projection: r.projection === 'epsg:3857' ? EPSG_3857 : EPSG_4326,
          bbox: r.bbox, imageDataUrl: r.imageDataUrl,
          imageWidth: r.imageWidth, imageHeight: r.imageHeight,
          calibration: r.bbox ? { bounds: r.bbox, method: r.calibrationMethod ?? 'geotransform' } : undefined,
        } as Partial<UserMapLayer>;
      } catch (err) {
        setWarning(err instanceof Error && err.message !== 'worker-unavailable'
          ? `Фоновая обработка не удалась (${err.message}). Повтор в основном потоке…`
          : 'Фоновая обработка недоступна. Повтор в основном потоке…');
      }
    }
    return getFallback().parseGeotiff(buffer, opts);
  }, [getFallback]);

  const mbtilesSummary = useCallback(async (buffer: ArrayBuffer): Promise<MbtilesSummary> => {
    if (shared.worker) {
      try {
        return await request<MbtilesSummary>(
          'mbtilesSummary',
          () => ({ buffer }),
          () => [buffer],
          (res) => { if (!isMbtilesSummary(res.payload)) throw new Error('Некорректный ответ воркера MBTiles'); return res.payload; },
        );
      } catch (err) {
        setWarning(err instanceof Error && err.message !== 'worker-unavailable'
          ? `Фоновая обработка не удалась (${err.message}). Повтор в основном потоке…`
          : 'Фоновая обработка недоступна. Повтор в основном потоке…');
      }
    }
    return getFallback().mbtilesSummary(buffer);
  }, [getFallback]);

  const mbtilesTiles = useCallback(async (buffer: ArrayBuffer, keys: string[], format = 'png'): Promise<Record<string, string>> => {
    if (shared.worker) {
      try {
        return await cachedTiles(buffer, keys, format, (ks) =>
          request<MbtilesTilesResult>(
            'mbtilesTiles',
            () => ({ buffer, keys: ks, format }),
            // буфер НЕ переносим: он нужен для последующих волн тайлов того же файла
            () => [],
            (res) => { if (!isMbtilesTiles(res.payload)) throw new Error('Некорректный ответ воркера тайлов'); return res.payload; },
          ),
        );
      } catch (err) {
        setWarning(err instanceof Error && err.message !== 'worker-unavailable'
          ? `Фоновая обработка не удалась (${err.message}). Повтор в основном потоке…`
          : 'Фоновая обработка недоступна. Повтор в основном потоке…');
      }
    }
    return getFallback().mbtilesTiles(buffer, keys, format);
  }, [getFallback]);

  const release = useCallback((_bufferRef?: ArrayBuffer): void => {
    // В воркере кэш SQLite чистится сам по ключу буфера (WeakMap-семантика внутри
    // openMbtilesDb); здесь сбрасываем только локальный кэш промисов волны.
    void _bufferRef;
  }, []);

  return {
    workerAvailable: !!shared.worker,
    parseGeotiff, mbtilesSummary, mbtilesTiles, release, warning,
  };
}

/** Немодальный доступ к транспорту вне React (сторы/утилы). */
export function getMapParsersTransportSync(): { workerAvailable: boolean } {
  return { workerAvailable: !!ensureWorker() };
}

/**
 * Немодальная фабрика транспорта для стор-вызовов (вне React-дерева):
 * все операции идут через воркер, при его недоступности — sync-фолбэк с
 * человекочитаемым console.warn вместо «зависшего» UI.
 */
export function getMapParsersTransport(): MapParsersTransport {
  const w = ensureWorker();
  if (!w) {
    return syncTransport((msg) => console.warn('[maps]', msg));
  }
  return {
    workerAvailable: true,
    parseGeotiff: async (buffer, opts) => {
      try {
        const r = await request<GeotiffResult>(
          'parseGeotiff',
          () => ({ buffer }),
          () => [buffer],
          (res) => { if (!isGeotiffResult(res.payload)) throw new Error('Некорректный ответ воркера GeoTIFF'); return res.payload; },
        );
        return {
          kind: 'raster', format: 'geotiff',
          projection: r.projection === 'epsg:3857' ? EPSG_3857 : EPSG_4326,
          bbox: r.bbox, imageDataUrl: r.imageDataUrl,
          imageWidth: r.imageWidth, imageHeight: r.imageHeight,
          calibration: r.bbox ? { bounds: r.bbox, method: r.calibrationMethod ?? 'geotransform' } : undefined,
        } as Partial<UserMapLayer>;
      } catch (err) {
        console.warn('[maps] Фоновый GeoTIFF не удался, повтор в основном потоке:', errMessage(err));
        return loadGeoTiff(buffer, opts ?? {});
      }
    },
    mbtilesSummary: async (buffer) => {
      try {
        return await request<MbtilesSummary>(
          'mbtilesSummary',
          () => ({ buffer }),
          () => [buffer],
          (res) => { if (!isMbtilesSummary(res.payload)) throw new Error('Некорректный ответ воркера MBTiles'); return res.payload; },
        );
      } catch (err) {
        console.warn('[maps] Фоновый MBTiles не удался, повтор в основном потоке:', errMessage(err));
        return readMbtilesSummary(buffer);
      }
    },
    mbtilesTiles: async (buffer, keys, format = 'png') => {
      try {
        return await cachedTiles(buffer, keys, format, (ks) =>
          request<MbtilesTilesResult>(
            'mbtilesTiles',
            () => ({ buffer, keys: ks, format }),
            () => [], // буфер НЕ переносим: нужен для последующих волн тайлов
            (res) => { if (!isMbtilesTiles(res.payload)) throw new Error('Некорректный ответ воркера тайлов'); return res.payload; },
          ),
        );
      } catch (err) {
        console.warn('[maps] Фоновые тайлы не удались, повтор в основном потоке:', errMessage(err));
        return decodeMbtilesTilesForRender(buffer, keys, format);
      }
    },
    release: () => closeMbtilesDbCache(),
  };
}

/** Последняя причина деградации воркера (для UI-баннеров). null — воркер жив. */
export function lastWorkerNotice(): string | null {
  return shared.unavailableReason;
}

/**
 * Сброс singleton-состояния между тестами ( Vitest: модуль живёт в пределах
 * файла, а «мёртвый» после crash() воркер ломал бы последующие спеки ).
 * В продакшене не вызывается.
 */
export function __resetMapParsersSharedForTests(): void {
  try { shared.worker?.terminate(); } catch { /* noop */ }
  shared.worker = null;
  shared.refCount = 0;
  shared.pending.clear();
  shared.listenersBound = false;
  shared.unavailableReason = null;
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message !== 'worker-unavailable' ? err.message : 'воркер недоступен';
}
