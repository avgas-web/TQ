// ═══════════════════════════════════════════════════════════════
// mapParserProtocol — единый типизированный контракт Main Thread ↔ mapParsers.worker.
// Тяжёлый парсинг GeoTIFF (geotiff.js/WASM) и MBTiles (sql.js/WASM SQLite)
// выполняется ВНЕ основного потока; бинарные данные передаются через
// postMessage с transferable ArrayBuffer (нулевое копирование).
// Никаких DOM/Zustand-зависимостей — модуль пригоден и для worker, и для теста.
// ═══════════════════════════════════════════════════════════════
import type { MapBounds } from '../types';

/** Идентификаторы операций воркера */
export type MapParserOp = 'parseGeotiff' | 'mbtilesSummary' | 'mbtilesTiles';

/** Запрос к воркеру. `buffer` обязан передаваться как Transferable. */
export interface ParserRequest {
  taskId: number;
  op: MapParserOp;
  /** Бинарное содержимое файла (.tif / .mbtiles) */
  buffer?: ArrayBuffer;
  /** Ключи тайлов "z/x/y" (XYZ) — только для op='mbtilesTiles' */
  keys?: string[];
  /** Fallback-MIME тайлов MBTiles ('png' | 'jpg') */
  format?: string;
}

/** Результат GeoTIFF: превью PNG data URL + геопривязка */
export interface GeotiffResult {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  bbox?: MapBounds;
  projection: 'epsg:4326' | 'epsg:3857';
  calibrationMethod?: 'geotransform' | 'tiepoints';
}

/** Метаданные MBTiles (без payload тайлов) */
export interface MbtilesSummaryResult {
  metadata: Record<string, string>;
  bounds: MapBounds | null;
  tileCount: number;
  minZoom: number;
  maxZoom: number;
  format: string;
  name: string;
  description: string;
}

/** Декодированная волна тайлов: ключ "z/x/y" -> data URL */
export type MbtilesTilesResult = Record<string, string>;

/** Payload успешного ответа зависит от op запроса */
export type ParserPayload = GeotiffResult | MbtilesSummaryResult | MbtilesTilesResult;

/** Ответ воркера (structured clone; buffers уже перенесены copy-on-write) */
export interface ParserResponse {
  taskId: number;
  ok: boolean;
  op: MapParserOp;
  payload?: ParserPayload;
  error?: string;
}

/** Type guard ответа (данные из postMessage — внешний вход, проверяем runtime) */
export function isParserResponse(d: unknown): d is ParserResponse {
  return (
    typeof d === 'object' && d !== null &&
    typeof (d as ParserResponse).taskId === 'number' &&
    typeof (d as ParserResponse).op === 'string' &&
    typeof (d as ParserResponse).ok === 'boolean'
  );
}

/** Type guard GeoTIFF-результата */
export function isGeotiffResult(p: ParserPayload | undefined): p is GeotiffResult {
  return typeof p === 'object' && p !== null && typeof (p as GeotiffResult).imageDataUrl === 'string';
}

/** Type guard MBTiles-summary */
export function isMbtilesSummary(p: ParserPayload | undefined): p is MbtilesSummaryResult {
  return typeof p === 'object' && p !== null && typeof (p as MbtilesSummaryResult).tileCount === 'number';
}

/** Type guard волны тайлов */
export function isMbtilesTiles(p: ParserPayload | undefined): p is MbtilesTilesResult {
  return typeof p === 'object' && p !== null && !('tileCount' in p) && !('imageDataUrl' in p);
}
