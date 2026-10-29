// ═══════════════════════════════════════════════════════════════
// mapParsers.worker — тяжёлый парсинг тактических карт ВНЕ Main Thread.
// GeoTIFF (geotiff.js) и MBTiles (sql.js / WASM SQLite) полностью
// разблокируют UI при загрузке файлов >50MB: ArrayBuffer передаётся
// через postMessage как Transferable (нулевое копирование), ответ —
// сериализуемый DTO (mapParserProtocol).
// Vite-формат: new Worker(new URL('./mapParsers.worker.ts', import.meta.url), { type: 'module' }).
// ═══════════════════════════════════════════════════════════════
/// <reference lib="webworker" />
import type { UserMapLayer } from '../types';
import { EPSG_3857, isValidBounds } from '../utils/userMapGeo';
import {
  loadGeoTiff, readMbtilesSummary, decodeMbtilesTilesForRender, closeMbtilesDbCache,
} from '../utils/userMapLoader';
import type { ParserRequest, ParserResponse } from '../utils/mapParserProtocol';

const ctx = self as unknown as Worker & { postMessage(m: ParserResponse, t?: Transferable[]): void };

/** Ответ с опциональным переносом буферов (payload у нас data-URL, но оставляем канал) */
function reply(res: ParserResponse): void {
  ctx.postMessage(res);
}

async function handle(req: ParserRequest): Promise<void> {
  if (req.op === 'parseGeotiff') {
    const buf = req.buffer;
    if (!buf) throw new Error('Нет ArrayBuffer для GeoTIFF');
    // Парсим «как в браузере»: geotiff модуль воркер сам дотянет динамическим импортом
    const partial: Partial<UserMapLayer> = await loadGeoTiff(buf, {});
    const bbox = partial.bbox && isValidBounds(partial.bbox) ? partial.bbox : undefined;
    reply({
      taskId: req.taskId, ok: true, op: req.op,
      payload: {
        imageDataUrl: String(partial.imageDataUrl ?? ''),
        imageWidth: Number(partial.imageWidth ?? 0),
        imageHeight: Number(partial.imageHeight ?? 0),
        bbox,
        projection: partial.projection === EPSG_3857 ? 'epsg:3857' : 'epsg:4326',
        calibrationMethod: partial.calibration?.method === 'tiepoints' ? 'tiepoints' : 'geotransform',
      },
    });
    return;
  }

  if (req.op === 'mbtilesSummary') {
    const buf = req.buffer;
    if (!buf) throw new Error('Нет ArrayBuffer для MBTiles');
    const s = await readMbtilesSummary(buf);
    reply({
      taskId: req.taskId, ok: true, op: req.op,
      payload: {
        metadata: s.metadata, bounds: s.bounds, tileCount: s.tileCount,
        minZoom: s.minZoom, maxZoom: s.maxZoom, format: s.format, name: s.name, description: s.description,
      },
    });
    return;
  }

  if (req.op === 'mbtilesTiles') {
    const buf = req.buffer;
    const keys = req.keys;
    if (!buf || !Array.isArray(keys)) throw new Error('Нет ArrayBuffer/keys для тайлов MBTiles');
    const tiles = await decodeMbtilesTilesForRender(buf, keys, req.format ?? 'png');
    reply({ taskId: req.taskId, ok: true, op: req.op, payload: tiles });
    return;
  }

  throw new Error(`Неизвестная операция воркера: ${String((req as { op?: string }).op)}`);
}

self.addEventListener('message', (event: MessageEvent<ParserRequest>) => {
  const req = event.data;
  if (!req || typeof req.taskId !== 'number' || typeof req.op !== 'string') return;
  void handle(req).catch((err: unknown) => {
    reply({
      taskId: req.taskId, ok: false, op: req.op,
      error: err instanceof Error ? err.message : 'Ошибка фоновой обработки карты',
    });
  });
});

// Завершение воркера — освобождаем кэш SQLite-БД внутри воркера.
// 'close' в DedicatedWorker не гарантирован после terminate(), поэтому
// чистим и по явному control-сообщению от моста (см. useMapParsersWorker).
self.addEventListener('close', () => { closeMbtilesDbCache(); });
