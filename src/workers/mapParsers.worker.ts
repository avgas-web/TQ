// ═══════════════════════════════════════════════════════════════
// mapParsers.worker — ТЯЖЁЛЫЙ парсинг карт ВНЕ Main Thread (ЭТАП 1.1).
//   • GeoTIFF (geotiff.js): теги геопривязки + декод пикселей → PNG data URL;
//   • MBTiles (sql.js / WASM SQLite): метаданные + ленивое извлечение тайлов.
// Обмен только сериализуемыми DTO (structured clone; ArrayBuffer клиента
// копируется в воркер, оригинал остаётся доступен для переиспользования БД).
// DOM (canvas/Image) в воркере недоступен — PNG кодируется через
// OffscreenCanvas.convertToBlob (стандарт Dedicated Worker, Chrome/Firefox/Safari 16.4+).
// Vite-формат: new Worker(new URL('./mapParsers.worker.ts', import.meta.url), { type: 'module' }).
// graceful degradation: если воркер не создан/упал, клиент (mapParserBridge)
// выполняет ту же работу синхронно в main thread.
// ═══════════════════════════════════════════════════════════════

// ─── DTO протокола ───────────────────────────────────────────────────────────

export interface MapWorkerRequestBase {
  taskId: number;
  /** Идентификатор инстанса клиента — ответы чужих клиентов отбрасываются */
  clientId: string;
}

/** Парсинг GeoTIFF: геопривязка + превью PNG (downsampling до maxSide px) */
export interface ParseGeoTiffRequest extends MapWorkerRequestBase {
  kind: 'parse-geotiff';
  buffer: ArrayBuffer;
  fileName: string;
  maxSide: number;
}

/** Чтение метаданных MBTiles (bounds/zooms/format/count) через sql.js */
export interface ParseMbtilesSummaryRequest extends MapWorkerRequestBase {
  kind: 'parse-mbtiles-summary';
  buffer: ArrayBuffer;
}

/** Декод волны тайлов "z/x/y" (XYZ) из MBTiles-базы */
export interface DecodeMbtilesTilesRequest extends MapWorkerRequestBase {
  kind: 'decode-mbtiles-tiles';
  buffer: ArrayBuffer;
  keys: string[];
  format: string;
}

export type MapWorkerRequest =
  | ParseGeoTiffRequest
  | ParseMbtilesSummaryRequest
  | DecodeMbtilesTilesRequest;

/** Результат GeoTIFF: georef (EPSG:4326/3857 bbox) + PNG data URL превью */
export interface ParseGeoTiffResponseData {
  widthPx: number;
  heightPx: number;
  projection: 'EPSG:4326' | 'EPSG:3857';
  bounds: { west: number; south: number; east: number; north: number };
  method: 'geotransform' | 'tiepoints';
  imageDataUrl: string;
}

export interface MbtilesSummaryData {
  metadata: Record<string, string>;
  bounds: { west: number; south: number; east: number; north: number } | null;
  tileCount: number;
  minZoom: number;
  maxZoom: number;
  format: string;
  name: string;
  description: string;
}

export interface MapWorkerResponse {
  taskId: number;
  clientId: string;
  ok: boolean;
  data?: ParseGeoTiffResponseData | MbtilesSummaryData | Record<string, string>;
  error?: string;
}

// ─── Гео-математика (координатная привязка) ─────────────────────────────────

const EARTH_RADIUS_M = 6378137; // WGS-84 экв. радиус сферы Web Mercator
const DEG = Math.PI / 180;
const MAX_MERC_LAT = 85.0511287798066;

function latToMercY(lat: number): number {
  const s = Math.sin(Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function mercYToLat(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
}

function webMercatorToWgs84(xMeters: number, yMeters: number): { lat: number; lng: number } {
  return {
    lng: (xMeters / 20037508.34) * 180,
    lat: mercYToLat(0.5 - yMeters / 40075016.68),
  };
}

interface RawBounds { west: number; south: number; east: number; north: number }

function clampBounds(b: RawBounds): RawBounds {
  return {
    west: Math.max(-180, Math.min(180, b.west)),
    east: Math.max(-180, Math.min(180, b.east)),
    south: Math.max(-90, Math.min(90, b.south)),
    north: Math.max(-90, Math.min(90, b.north)),
  };
}

function normalizeBoundsToWgs84(b: RawBounds): RawBounds {
  if (Math.abs(b.west) <= 180 && Math.abs(b.east) <= 180 && Math.abs(b.south) <= 90 && Math.abs(b.north) <= 90) {
    return clampBounds(b);
  }
  const sw = webMercatorToWgs84(b.west, b.south);
  const ne = webMercatorToWgs84(b.east, b.north);
  return clampBounds({ west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat });
}

// ─── GeoTIFF: чтение IFD-тегов (port функциональный из tacticalMapParsers) ──

interface GeoTiffTags {
  widthPx: number;
  heightPx: number;
  modelPixelScale?: [number, number, number];
  modelTiepoint?: [number, number, number, number, number, number];
  modelTransformation?: number[];
  geoKeys: Record<string, number>;
}

function readGeoTiffTags(buf: ArrayBuffer): GeoTiffTags | null {
  try {
    const dv = new DataView(buf);
    const b0 = dv.getUint8(0), b1 = dv.getUint8(1);
    let little: boolean;
    let ifdOffset: number;
    if (b0 === 0x49 && b1 === 0x49) { little = true; ifdOffset = dv.getUint32(4, true); }
    else if (b0 === 0x4d && b1 === 0x4d) { little = false; ifdOffset = dv.getUint32(4, false); }
    else return null;
    if (dv.getUint16(2, little) !== 42) return null;
    const out: GeoTiffTags = { widthPx: 0, heightPx: 0, geoKeys: {} };
    let off = ifdOffset;
    for (let guard = 0; guard < 8 && off > 0 && off + 2 <= buf.byteLength; guard++) {
      const n = dv.getUint16(off, little);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > buf.byteLength) break;
        const tag = dv.getUint16(e, little);
        const type = dv.getUint16(e + 2, little);
        const count = dv.getUint32(e + 4, little);
        const valueOffset = dv.getUint32(e + 8, little);
        const sizeOf = (t: number): number =>
          (({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 } as Record<number, number>)[t] ?? 0);
        const total = sizeOf(type) * count;
        const dataOff = total > 4 ? valueOffset : e + 8;
        const dblAt = (k: number): number => dv.getFloat64(dataOff + k * 8, little);
        const u16at = (k: number): number => dv.getUint16(dataOff + k * 2, little);
        switch (tag) {
          case 256: out.widthPx = dv.getUint32(dataOff, little); break;
          case 257: out.heightPx = dv.getUint32(dataOff, little); break;
          case 33550: if (type === 12 && count >= 3) out.modelPixelScale = [dblAt(0), dblAt(1), dblAt(2)]; break;
          case 33922: if (type === 12 && count >= 6) out.modelTiepoint = [dblAt(0), dblAt(1), dblAt(2), dblAt(3), dblAt(4), dblAt(5)]; break;
          case 34264:
            if (type === 12 && count >= 16) {
              out.modelTransformation = [];
              for (let k = 0; k < 16; k++) out.modelTransformation.push(dblAt(k));
            }
            break;
          case 34735:
            for (let k = 0; k + 3 < count; k += 4) {
              const keyId = u16at(k), loc = u16at(k + 2), val = u16at(k + 3);
              out.geoKeys[String(keyId)] = loc === 0 ? val : 0;
            }
            break;
          default: break;
        }
      }
      off = dv.getUint32(off + 2 + n * 12, little);
    }
    return out;
  } catch {
    return null;
  }
}

function georefFromTags(tags: GeoTiffTags):
  { projection: 'EPSG:4326' | 'EPSG:3857'; bounds: RawBounds; method: 'geotransform' | 'tiepoints' } | null {
  const w = tags.widthPx, h = tags.heightPx;
  if (!w || !h) return null;
  let raw: RawBounds | null = null;
  let method: 'geotransform' | 'tiepoints' = 'tiepoints';
  const tr = tags.modelTransformation;
  if (tr && tr.length >= 16) {
    method = 'geotransform';
    // row-major 4x4: X = m0*i + m1*j + m3; Y = m4*i + m5*j + m7 (ось Y на север)
    raw = {
      west: Math.min(tr[3], tr[3] + tr[0] * w),
      east: Math.max(tr[3], tr[3] + tr[0] * w),
      south: Math.min(tr[7] + tr[5] * h, tr[7]),
      north: Math.max(tr[7] + tr[5] * h, tr[7]),
    };
  } else if (tags.modelPixelScale && tags.modelTiepoint) {
    const [i, j, , X, Y] = tags.modelTiepoint;
    const sx = tags.modelPixelScale[0], sy = tags.modelPixelScale[1];
    raw = { west: X - i * sx, east: X - i * sx + sx * w, south: Y + j * sy - sy * h, north: Y + j * sy };
  }
  if (!raw) return null;
  const gtModelType = tags.geoKeys['1024'] ?? 0;
  const geographicType = tags.geoKeys['2048'] ?? 0;
  const projectedCs = tags.geoKeys['3072'] ?? 0;
  let projection: 'EPSG:4326' | 'EPSG:3857';
  if (gtModelType === 1 || geographicType === 4326) projection = 'EPSG:4326';
  else if (projectedCs === 3857 || projectedCs === 0) projection = 'EPSG:3857';
  else return null;
  return { projection, bounds: normalizeBoundsToWgs84(raw), method };
}

// ─── PNG-кодирование через OffscreenCanvas (без DOM в воркере) ───────────────

/** RGBA → PNG data URL через OffscreenCanvas.convertToBlob */
async function encodeRgbaToPngDataUrl(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('GeoTIFF: OffscreenCanvas недоступен в этом браузере (нет поддержки воркеров рендера)');
  }
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext('2d');
  if (!ctx) throw new Error('GeoTIFF: контекст OffscreenCanvas недоступен в воркере');
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await off.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH))) as string;
    }
    return `data:image/png;base64,${btoa(bin)}`;
  });
}

function fitSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  if (w <= maxSide && h <= maxSide) return { w, h };
  const k = Math.min(maxSide / w, maxSide / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Planar-каналы geotiff.js → единый RGBA-массив (Uint8ClampedArray для ImageData) */
function toRgbaFromChannels(channels: ArrayLike<unknown>, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  const chs = Array.from(channels) as ArrayLike<number>[];
  const nc = chs.length;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (nc === 1) {
      const v = chs[0][i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    } else if (nc === 2) {
      const v = chs[0][i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = chs[1][i];
    } else if (nc === 3) {
      out[i * 4] = chs[0][i]; out[i * 4 + 1] = chs[1][i]; out[i * 4 + 2] = chs[2][i]; out[i * 4 + 3] = 255;
    } else {
      out[i * 4] = chs[0][i]; out[i * 4 + 1] = chs[1][i]; out[i * 4 + 2] = chs[2][i]; out[i * 4 + 3] = chs[3][i];
    }
  }
  return out;
}

// ─── GeoTIFF задача ──────────────────────────────────────────────────────────

/** Фолбэк-канал: main-thread парсинг в userMapLoader просит bridge (см. ниже) */
let mainThreadGeoTiffFallback: ((buffer: ArrayBuffer, maxSide: number) => Promise<ParseGeoTiffResponseData>) | null = null;

/** Регистрация main-thread фолбэка (делает mapParserBridge при импорте модуля) */
export function registerMainThreadGeoTiffFallback(
  fn: (buffer: ArrayBuffer, maxSide: number) => Promise<ParseGeoTiffResponseData>,
): void {
  mainThreadGeoTiffFallback = fn;
}

async function handleParseGeoTiff(req: ParseGeoTiffRequest): Promise<ParseGeoTiffResponseData> {
  if (mainThreadGeoTiffFallback) return mainThreadGeoTiffFallback(req.buffer, req.maxSide);
  // Динамический импорт внутри воркера: geotiff не попадает в main-чанк вообще
  const mod = await import('geotiff');
  const GeoTIFF = mod.GeoTIFF ?? mod.default?.GeoTIFF;
  if (!GeoTIFF) throw new Error('GeoTIFF: модуль geotiff не загрузился в воркере');
  const tiff = await GeoTIFF.fromArrayBuffer(req.buffer);
  const image = await tiff.getImage();
  const width = image.getWidth() as number;
  const height = image.getHeight() as number;

  const tags = readGeoTiffTags(req.buffer);
  const geo = tags ? georefFromTags(tags) : null;
  if (!geo) throw new Error('GeoTIFF: отсутствуют теги геопривязки (ModelPixelScale/ModelTiepoint/ModelTransformation)');

  const scaled = fitSize(width, height, req.maxSide);
  // Downsampling выполняет сам geotiff.js (window+level) — каналы приходят уже
  // уменьшенными; интерливид-каналы собираются в один RGBA для ImageData.
  const data = await image.readRasters({ width: scaled.w, height: scaled.h, interleave: false });
  const rgba = toRgbaFromChannels(data, scaled.w, scaled.h);
  const imageDataUrl = await encodeRgbaToPngDataUrl(rgba, scaled.w, scaled.h);

  return {
    widthPx: scaled.w,
    heightPx: scaled.h,
    projection: geo.projection,
    bounds: geo.bounds,
    method: geo.method,
    imageDataUrl,
  };
}

// ─── MBTiles задачи (sql.js/WASM в воркере) ─────────────────────────────────

interface SqlJsDatabaseLike {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  free?(): void;
}

async function initSqlWorker(): Promise<{ Database: (data?: Uint8Array) => SqlJsDatabaseLike }> {
  const mod = await import('sql.js');
  const factory = mod.initSqlJs;
  const base = typeof self.location !== 'undefined' ? self.location.href : '/';
  const wasmUrl = new URL('vendor/sql-wasm.wasm', base).href;
  const SQL = await factory({ locateFile: () => wasmUrl });
  return { Database: (data?: Uint8Array) => new SQL.Database(data) as unknown as SqlJsDatabaseLike };
}

function parseMbtilesBoundsString(s?: string | null): RawBounds | null {
  if (!s) return null;
  const p = s.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  const b = clampBounds({ west: p[0], south: p[1], east: p[2], north: p[3] });
  return b;
}

function tmsToXyz(zoomLevel: number, tmSy: number): number {
  return Math.pow(2, zoomLevel) - 1 - tmSy;
}

function tileBytesToDataUrl(bytes: Uint8Array, fallbackFormat: string): string {
  const isJpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const mime = isJpeg ? 'image/jpeg' : isPng ? 'image/png'
    : (fallbackFormat === 'jpg' || fallbackFormat === 'jpeg') ? 'image/jpeg' : 'image/png';
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as unknown as number[]) as string;
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

async function handleParseMbtilesSummary(req: ParseMbtilesSummaryRequest): Promise<MbtilesSummaryData> {
  const SQL = await initSqlWorker();
  const db = SQL.Database(new Uint8Array(req.buffer));
  try {
    const run = (sql: string): unknown[][] => {
      const res = db.exec(sql);
      return res.length ? res[0].values : [];
    };
    const meta: Record<string, string> = {};
    let rows: unknown[][] = [];
    try { rows = run('SELECT name, value FROM metadata'); } catch { rows = []; }
    for (const r of rows) meta[String(r[0])] = String(r[1] ?? '');
    let tileCount = 0, minZoom = 0, maxZoom = 0;
    try {
      const c = run('SELECT COUNT(*) AS c FROM tiles');
      tileCount = Number(c[0]?.[0] ?? 0);
      const z = run('SELECT MIN(zoom_level) AS minz, MAX(zoom_level) AS maxz FROM tiles');
      minZoom = Number(z[0]?.[0] ?? 0);
      maxZoom = Number(z[0]?.[1] ?? minZoom);
    } catch { /* пустая БД */ }
    return {
      metadata: meta,
      bounds: parseMbtilesBoundsString(meta.bounds),
      tileCount, minZoom, maxZoom,
      format: (meta.format || 'png').toLowerCase(),
      name: meta.name || '', description: meta.description || '',
    };
  } finally {
    db.free?.();
  }
}

async function handleDecodeMbtilesTiles(req: DecodeMbtilesTilesRequest): Promise<Record<string, string>> {
  const SQL = await initSqlWorker();
  const db = SQL.Database(new Uint8Array(req.buffer));
  try {
    const out: Record<string, string> = {};
    for (const key of req.keys) {
      const p = key.split('/').map(Number);
      if (p.length !== 3 || p.some((v) => !Number.isFinite(v) || v < 0)) continue;
      const [z, x, y] = p;
      const yTms = tmsToXyz(z, y);
      // значения подставляются только после валидации целых чисел — инъекция исключена
      const res = db.exec(
        `SELECT tile_data FROM tiles WHERE zoom_level = ${z} AND tile_column = ${x} AND tile_row = ${yTms}`,
      );
      const raw = res.length ? res[0].values[0]?.[0] : undefined;
      if (raw == null) continue;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
      if (!bytes.length) continue;
      out[key] = tileBytesToDataUrl(bytes, req.format);
    }
    return out;
  } finally {
    db.free?.();
  }
}

// ─── Диспетчер сообщений ─────────────────────────────────────────────────────

const wc = self as unknown as Worker;

self.addEventListener('message', (event: MessageEvent<MapWorkerRequest>): void => {
  const req = event.data;
  if (!req || typeof req.taskId !== 'number' || typeof req.clientId !== 'string') return;
  const respond = (ok: boolean, data?: MapWorkerResponse['data'], error?: string): void => {
    const res: MapWorkerResponse = { taskId: req.taskId, clientId: req.clientId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) };
    wc.postMessage(res);
  };
  const task: Promise<unknown> =
    req.kind === 'parse-geotiff' ? handleParseGeoTiff(req)
      : req.kind === 'parse-mbtiles-summary' ? handleParseMbtilesSummary(req)
        : req.kind === 'decode-mbtiles-tiles' ? handleDecodeMbtilesTiles(req)
          : Promise.reject(new Error(`Неизвестная задача воркера: ${(req as { kind: string }).kind}`));
  task
    .then((data) => respond(true, data as MapWorkerResponse['data']))
    .catch((err: unknown) => respond(false, undefined, err instanceof Error ? err.message : String(err)));
});
