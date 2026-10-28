// ─── ЗАГРУЗЧИК ПОЛЬЗОВАТЕЛЬСКИХ ТАКТИЧЕСКИХ КАРТ (Задача 2, асинхронная обёртка) ──
// Принимает File/ArrayBuffer, определяет формат (магические числа + расширение),
// извлекает координатную привязку (EPSG:4326 / EPSG:3857, bounding box) и
// приводит слой к внутреннему представлению:
//   • растр (GeoTIFF/PNG/JPEG) -> PNG data URL + georef (маппинг пикселей WGS-84);
//   • вектор (KML/KMZ/GeoJSON) -> текст + vectors;
//   • MBTiles -> метаданные (bbox/zoomRange) — тайл-хранилище обслуживается отдельно.
// Декодирование GeoTIFF выполняется через createImageBitmap (браузерный декодер);
// DEFLATE-записи KMZ распаковываются DecompressionStream('deflate-raw').
// В node-окружении (тесты) DOM-декодеры отсутствуют — для растров возвращает
// понятную ошибку, векторные парсеры работают полностью (см. tacticalMapParsers).
import type { TacticalOverlayLayer, TacticalOverlayFormat, BBox4 } from '../types';
import {
  detectTacticalMapFormat,
  parseGeoTiffGeoref,
  parseKmlGeoref,
  findKmlInKmz,
  parseGeoJsonGeoref,
  parseMbtilesGeoref,
  extractImageGeorefComment,
  readPngSize,
  readJpegSize,
  buildGeoref,
} from './tacticalMapParsers';

export interface LoadedTacticalOverlay {
  layer: TacticalOverlayLayer;
  /** payload для IndexedDB: base64 data URL растра или текст KML/GeoJSON */
  payload: string;
  kind: 'raster' | 'vector';
}

/** Распаковать DEFLATE-запись zip (KMZ) — браузерный DecompressionStream */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof (globalThis as any).DecompressionStream !== 'function') {
    throw new Error('DecompressionStream недоступен в этом окружении');
  }
  const ds = new (globalThis as any).DecompressionStream('deflate-raw');
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Найти .kml внутри KMZ: сначала stored-записи (синхронно), затем DEFLATE */
async function extractKmlFromKmz(buf: ArrayBuffer): Promise<string> {
  const stored = findKmlInKmz(buf);
  if (stored) return new TextDecoder('utf-8').decode(stored);
  // Полный проход по Local File Header'ам с распаковкой deflate
  const dv = new DataView(buf);
  const dec = new TextDecoder('utf-8');
  let off = 0;
  while (off + 30 <= buf.byteLength && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const compSize = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const name = dec.decode(new Uint8Array(buf, off + 30, nameLen));
    const dataOff = off + 30 + nameLen + extraLen;
    if (/\.kml$/i.test(name)) {
      const raw = new Uint8Array(buf, dataOff, compSize);
      const inflated = method === 8 ? await inflateRaw(raw) : raw;
      return new TextDecoder('utf-8').decode(inflated);
    }
    off = dataOff + compSize;
    if (off + 4 <= buf.byteLength && dv.getUint32(off, true) === 0x08074b50) off += 16;
  }
  throw new Error('KMZ: внутри архива не найден файл .kml');
}

/** Декодировать GeoTIFF в растровое изображение через браузерный ImageDecoder/createImageBitmap */
async function decodeGeoTiffToCanvas(buf: ArrayBuffer): Promise<{ canvas: HTMLCanvasElement; widthPx: number; heightPx: number }> {
  if (typeof (globalThis as any).createImageBitmap !== 'function') {
    throw new Error('GeoTIFF: в этом окружении нет декодера изображений (createImageBitmap)');
  }
  const bitmap = await (globalThis as any).createImageBitmap(new Blob([buf.slice(0)] as any, { type: 'image/tiff' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GeoTIFF: канвас недоступен');
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
  if (typeof (bitmap as any).close === 'function') (bitmap as any).close(); // освобождение GPU-памяти
  return { canvas, widthPx: canvas.width, heightPx: canvas.height };
}

function toDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function nowIso(): string { return new Date().toISOString(); }
function newLayerId(): string {
  return `ovl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

const RASTER_ENCODINGS: Record<string, 'png' | 'jpeg'> = { png: 'png', jpeg: 'jpeg', geotiff: 'png' };

/**
 * Главный вход загрузчика: файл -> готовый слой (метаданные в стор Zustand,
 * payload — в IndexedDB). Бросает Error с человекочитаемым сообщением, если
 * геопривязка не найдена — ЖЁСТКОЕ требование: слой без bounds не импортируется.
 */
export async function loadTacticalMapFile(file: File | { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<LoadedTacticalOverlay> {
  const buf = await file.arrayBuffer();
  const detected = detectTacticalMapFormat(buf, file.name);
  if (detected === 'unknown') throw new Error(`Неизвестный формат файла «${file.name}»`);
  const sizeBytes = buf.byteLength;
  const id = newLayerId();

  // ── GeoTIFF: GDAL-теги + растровое декодирование ──
  if (detected === 'geotiff') {
    const g = parseGeoTiffGeoref(buf);
    if (!g.ok) throw new Error(g.error);
    const { canvas, widthPx, heightPx } = await decodeGeoTiffToCanvas(buf);
    // размер растра из тегов должен совпадать с декодированным — иначе привязка неверна
    const georef = { ...g.georef, widthPx: widthPx || g.georef.widthPx, heightPx: heightPx || g.georef.heightPx };
    const layer: TacticalOverlayLayer = {
      id, blobKey: id, name: file.name, format: 'geotiff', encoding: 'png',
      visible: true, opacity: 0.85, georef, importedAt: nowIso(), sizeBytes,
    };
    return { layer, payload: toDataUrl(canvas), kind: 'raster' };
  }

  // ── PNG/JPEG с world-file комментарием (жёсткая привязка обязательна) ──
  if (detected === 'png' || detected === 'jpeg') {
    const bbox = extractImageGeorefComment(buf);
    if (!bbox) throw new Error(`${detected.toUpperCase()}: не найдена геопривязка (EXIF-GPS/world-file комментарий «WorldFile=w,s,e,n»)`);
    const size = detected === 'png' ? readPngSize(buf) : readJpegSize(buf);
    if (!size) throw new Error('Не удалось прочитать размеры изображения');
    const projection: 'EPSG:4326' | 'EPSG:3857' = Math.max(Math.abs(bbox[0]), Math.abs(bbox[2])) > 180 ? 'EPSG:3857' : 'EPSG:4326';
    const georef = buildGeoref(bbox as BBox4, projection, size.width, size.height);
    const layer: TacticalOverlayLayer = {
      id, blobKey: id, name: file.name, format: 'image', encoding: RASTER_ENCODINGS[detected],
      visible: true, opacity: 0.85, georef, importedAt: nowIso(), sizeBytes,
    };
    // payload — base64 data URL (jsdom-совместимая кодировка без FileReader)
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const payload = `data:image/${detected === 'png' ? 'png' : 'jpeg'};base64,${btoa(bin)}`;
    return { layer, payload, kind: 'raster' };
  }

  // ── KML / KMZ ──
  if (detected === 'kml' || detected === 'kmz') {
    const xml = detected === 'kmz'
      ? await extractKmlFromKmz(buf)
      : new TextDecoder('utf-8').decode(buf);
    const p = parseKmlGeoref(xml);
    if (!p.ok) throw new Error(p.error);
    const format: TacticalOverlayFormat = detected === 'kmz' ? 'kmz' : 'kml';
    const layer: TacticalOverlayLayer = {
      id, blobKey: id, name: file.name, format, encoding: 'png',
      visible: true, opacity: 0.9,
      georef: buildGeoref(p.bbox, 'EPSG:4326', 0, 0),
      vectors: p.vectors, importedAt: nowIso(), sizeBytes,
    };
    return { layer, payload: xml, kind: 'vector' };
  }

  // ── GeoJSON ──
  if (detected === 'geojson') {
    const text = new TextDecoder('utf-8').decode(buf);
    const p = parseGeoJsonGeoref(text);
    if (!p.ok) throw new Error(p.error);
    const layer: TacticalOverlayLayer = {
      id, blobKey: id, name: file.name, format: 'geojson', encoding: 'png',
      visible: true, opacity: 0.9,
      georef: buildGeoref(p.bbox, 'EPSG:4326', 0, 0),
      vectors: p.vectors, importedAt: nowIso(), sizeBytes,
    };
    return { layer, payload: text, kind: 'vector' };
  }

  // ── MBTiles: SQLite-хранилище тайлов — метаданные (bounds/zooms) ──
  if (detected === 'mbtiles') {
    const p = parseMbtilesGeoref(buf);
    if (!p.ok) throw new Error(p.error);
    const layer: TacticalOverlayLayer = {
      id, blobKey: id, name: `${file.name} (${p.name})`, format: 'mbtiles', encoding: 'png',
      visible: true, opacity: 0.85,
      georef: buildGeoref(p.bbox, 'EPSG:4326', 0, 0),
      zoomRange: p.zoomRange, importedAt: nowIso(), sizeBytes,
    };
    return { layer, payload: '', kind: 'raster' };
  }

  throw new Error(`Формат «${detected}» не поддерживается`);
}
