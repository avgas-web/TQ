// ═══════════════════════════════════════════════════════════════
// mapParserBridge — клиент mapParsers.worker (ЭТАП 1.1).
// Единая точка входа для тяжёлого парсинга GeoTIFF/MBTiles:
//   • основной путь — выделенный module-воркер (main thread свободен);
//   • graceful degradation — при недоступности воркера (SSR/тесты/жёсткие CSP)
//     или его падении задача выполняется legacy-путём в main thread
//     (dyn-import userMapLoader -> geotiff/sql.js — чанки грузятся только по нужде);
//   • ответы чужих taskId/clientId отбрасываются (защита от гонок);
//   • «зависшую» задачу воркера ограничиваем таймаутом и фолбэчимся.
// Обмен строго типизированными DTO (structured clone), без any в публичном API.
//
// ЗАЩИТА ОТ ЦИКЛОВ (регрессия после PR#117): userMapLoader НЕ импортируется
// статически — иначе возникает цикл userMapLoader -> mapParserBridge ->
// userMapLoader, при котором загрузчик карт не инициализируется и загрузка
// пользовательских карт полностью выходит из строя. Типы DTO объявлены локально,
// main-thread фолбэки подгружаются динамическим import() только при необходимости.
// ═══════════════════════════════════════════════════════════════

/** DTO: ответ воркера на parse-geotiff (зеркало workers/mapParsers.worker) */
export interface ParseGeoTiffResponseData {
  imageDataUrl: string;
  widthPx: number;
  heightPx: number;
  bounds: [number, number, number, number];
  projection: 'EPSG:4326' | 'EPSG:3857';
  method: number;
}

/** DTO: метаданные MBTiles (зеркало workers/mapParsers.worker) */
export interface MbtilesSummaryData {
  tileCount: number;
  bounds: [number, number, number, number] | null;
  minZoom: number;
  maxZoom: number;
  format: string;
  name: string;
  description: string;
}

type MapWorkerKind = 'parse-geotiff' | 'parse-mbtiles-summary' | 'decode-mbtiles-tiles';

interface MapWorkerRequest {
  kind: MapWorkerKind;
  taskId: number;
  clientId: string;
  buffer?: ArrayBuffer;
  fileName?: string;
  maxSide?: number;
  keys?: string[];
  format?: string;
}

interface MapWorkerResponse {
  taskId: number;
  clientId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

/** Таймаут ожидания ответа воркера (парсинг гигантских GeoTIFF + WASM-инит) */
const WORKER_TASK_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let workerBroken = false;
let taskId = 0;
/** id инстанса клиента — игнорируем «эхо» от старых экземпляров воркера */
const clientId = `mpb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Pending = {
  resolve: (data: MapWorkerResponse['data']) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null; // SSR / node-тесты
  try {
    const w = new Worker(new URL('../workers/mapParsers.worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (e: MessageEvent<MapWorkerResponse>) => {
      const res = e.data;
      if (!res || typeof res.taskId !== 'number' || res.clientId !== clientId) return;
      const p = pending.get(res.taskId);
      if (!p) return;
      pending.delete(res.taskId);
      clearTimeout(p.timer);
      if (res.ok) p.resolve(res.data);
      else p.reject(new Error(res.error ?? 'mapParsers worker вернул ошибку'));
    });
    w.addEventListener('error', () => {
      markBroken(w);
    });
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Воркер упал/недоступен: все in-flight задачи уходят на main-thread фолбэк */
function markBroken(w: Worker): void {
  if (w === worker) {
    worker = null;
    workerBroken = true;
    try { w.terminate(); } catch { /* уже мёртв */ }
  }
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    // reject не кидаем — вызывающий код сам выполнит синхронный фолбэк
    void p;
  }
}

function post<T>(
  kind: MapWorkerRequest['kind'],
  payload: Omit<MapWorkerRequest, 'taskId' | 'clientId' | 'kind'> & { kind?: MapWorkerRequest['kind'] },
  fallback: () => Promise<T>,
): Promise<T> {
  const w = ensureWorker();
  if (!w) return fallback();
  const id = ++taskId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // зависшая задача: снимаем и выполняим фолбэк (дублирующий ответ воркера
      // будет проигнорирован — записи в pending уже нет)
      if (pending.delete(id)) void fallback().then(resolve, reject);
    }, WORKER_TASK_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (d: MapWorkerResponse['data']) => void, reject, timer });
    try {
      w.postMessage({ ...payload, kind, taskId: id, clientId } satisfies MapWorkerRequest);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      // structured clone не прошёл (маловероятно) или воркер умер — фолбэк
      void err;
      void fallback().then(resolve, reject);
    }
  });
}

// ─── Main-thread фолбэки (legacy-путь, dyn-import тех же библиотек) ──────────
// ВАЖНО: импортируем именно *MainThread-функции userMapLoader — они НЕ зовут
// мост обратно (иначе получим рекурсию worker→fallback→worker).

async function parseGeoTiffMainThread(buffer: ArrayBuffer, maxSide: number): Promise<ParseGeoTiffResponseData> {
  const m = await import('./userMapLoader');
  return m.parseGeoTiffMainThreadFallback(buffer, maxSide);
}

async function mbtilesSummaryMainThread(buffer: ArrayBuffer): Promise<MbtilesSummaryData> {
  const m = await import('./userMapLoader');
  return m.readMbtilesSummaryMainThread(buffer);
}

async function decodeMbtilesMainThread(buffer: ArrayBuffer, keys: string[], format: string): Promise<Record<string, string>> {
  const m = await import('./userMapLoader');
  return m.decodeMbtilesTilesMainThread(buffer, keys, format);
}

// ─── Публичный API ───────────────────────────────────────────────────────────

/** Парсить GeoTIFF (геопривязка + PNG-превью). Воркер → main-thread фолбэк. */
export function parseGeoTiffViaWorker(buffer: ArrayBuffer, fileName: string, maxSide = 4096): Promise<ParseGeoTiffResponseData> {
  return post<ParseGeoTiffResponseData>(
    'parse-geotiff',
    { buffer, fileName, maxSide },
    () => parseGeoTiffMainThread(buffer.slice(0), maxSide),
  );
}

/** Прочитать метаданные MBTiles через sql.js в воркере (с фолбэком). */
export function readMbtilesSummaryViaWorker(buffer: ArrayBuffer): Promise<MbtilesSummaryData> {
  return post<MbtilesSummaryData>(
    'parse-mbtiles-summary',
    { buffer },
    () => mbtilesSummaryMainThread(buffer),
  );
}

/** Декод волны тайлов MBTiles "z/x/y" (XYZ) в воркере (с фолбэком). */
export function decodeMbtilesTilesViaWorker(buffer: ArrayBuffer, keys: string[], format = 'png'): Promise<Record<string, string>> {
  return post<Record<string, string>>(
    'decode-mbtiles-tiles',
    { buffer: buffer.slice(0), keys, format },
    () => decodeMbtilesMainThread(buffer, keys, format),
  );
}

/** Освобождение ресурсов (для тестов/выгрузки слоя) */
export function disposeMapParserWorker(): void {
  if (worker) {
    try { worker.terminate(); } catch { /* noop */ }
    worker = null;
  }
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('map parser worker disposed'));
    pending.delete(id);
  }
  workerBroken = false;
}

/** Для диагностики/тестов: используется ли сейчас воркер */
export function isMapParserWorkerActive(): boolean {
  return worker !== null && !workerBroken;
}
