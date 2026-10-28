// ─── Загрузка пользовательских тактических карт ──────────────────────────────
// Форматы: GeoJSON (.geojson/.json), KML (.kml), KMZ (.kmz, JSZip),
// GeoTIFF (.tif/.tiff, geotiff.js), MBTiles (.mbtiles, sql.js/WASM SQLite),
// растровые снимки (.png/.jpg) — с ручной привязкой по 4 угловым точкам.
//
// Все слои нормализуются к WGS-84 (lat/lng) и той же Web-Mercator-математике,
// что использует MapCanvas (latToMercatorY / mercatorYToLat), поэтому слой
// «приклеен» к подложке на любом зуме.

import type {
  MapBounds, UserMapFeature, UserMapFormat, UserMapKind, UserMapLayer,
} from '../types';
import {
  EPSG_3857, EPSG_4326, bboxFromPoints, boundsFromCorners, clampBounds,
  normalizeBoundsToWgs84, pixelToGeoByCorners, tiepointMapper,
  transformationMapper, worldRectToBounds, geoToFracInBounds,
  boundsToWorldRect, isValidBounds, lngLatToWorldFrac,
  type CornerCalibration, type ProjectionId,
} from './userMapGeo';

/** Прогресс загрузки больших файлов (GeoTIFF/MBTiles): 0..1 + стадия */
export interface LoadProgress { phase: 'read' | 'parse' | 'decode' | 'encode' | 'done'; ratio: number; note?: string }
export type ProgressCb = (p: LoadProgress) => void;

export interface LoadOptions {
  /** Имя слоя (по умолчанию — имя файла) */
  name?: string;
  /** Автор слоя (метаданные) */
  author?: string;
  /** Привязка для растра без встроенных координат (PNG/JPG) */
  calibration?: CornerCalibration;
  /** Прогресс */
  onProgress?: ProgressCb;
  /** Генератор id (для детерминированных тестов) */
  newId?: () => string;
  /** Максимум элементов вектора (защита от мегафайлов) */
  maxFeatures?: number;
  /** Максимальный размер растра на выходе, px по стороне ( downsampling ) */
  maxRasterSide?: number;
}

let idCounter = 0;
const defaultNewId = (): string => `uml-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

const EXT_FORMAT: Record<string, UserMapFormat> = {
  geojson: 'geojson', json: 'geojson', kml: 'kml', kmz: 'kmz',
  tif: 'geotiff', tiff: 'geotiff', mbtiles: 'mbtiles',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', gif: 'image',
};

/** Определение формата по расширению имени файла */
export function detectFormat(fileName: string): UserMapFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName || '');
  if (!m) return null;
  return EXT_FORMAT[m[1].toLowerCase()] ?? null;
}

/** Поддерживаемые расширения для input[accept] */
export const ACCEPT_EXTENSIONS = '.geojson,.json,.kml,.kmz,.tif,.tiff,.mbtiles,.png,.jpg,.jpeg';

export class UnsupportedMapFormatError extends Error {
  constructor(fileName: string) {
    super(`Неподдерживаемый формат тактической карты: ${fileName}`);
    this.name = 'UnsupportedMapFormatError';
  }
}

// ─── Вектор: GeoJSON ─────────────────────────────────────────────────────────

type Position = [number, number];

const isPos = (p: unknown): p is Position =>
  Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';

/** Кольцо GeoJSON ([lng,lat][]) -> [lat,lng][] */
function ringToLatLng(ring: unknown): [number, number][] {
  const out: [number, number][] = [];
  if (!Array.isArray(ring)) return out;
  for (const p of ring) if (isPos(p)) out.push([p[1], p[0]]);
  return out;
}

/** Координаты одной геометрии -> список колец/точек в [lat,lng] */
export function geoJsonGeometryToFeatures(
  geom: any, id: string, name?: string, color?: string
): UserMapFeature[] {
  if (!geom || typeof geom !== 'object') return [];
  const type = String(geom.type || '').toLowerCase();
  const coords = geom.coordinates;
  const mk = (kind: UserMapFeature['geometry']['kind'], rings: [number, number][][], points?: [number, number][], holes?: number[]): UserMapFeature => ({
    id, geometry: { kind, rings, ...(holes ? { holes } : {}), ...(points ? { points } : {}) },
    ...(name ? { name } : {}), ...(color ? { color } : {}),
  });

  switch (type) {
    case 'point':
      return isPos(coords) ? [mk('point', [], [[coords[1], coords[0]]])] : [];
    case 'multipoint':
      return Array.isArray(coords)
        ? [mk('point', [], coords.filter(isPos).map((p) => [p[1], p[0]] as [number, number]))]
        : [];
    case 'linestring': {
      const r = ringToLatLng(coords);
      return r.length >= 2 ? [mk('line', [r])] : [];
    }
    case 'multilinestring': {
      const rings = (Array.isArray(coords) ? coords : []).map(ringToLatLng).filter((r) => r.length >= 2);
      return rings.length ? [mk('line', rings)] : [];
    }
    case 'polygon': {
      const rings = (Array.isArray(coords) ? coords : []).map(ringToLatLng).filter((r) => r.length >= 3);
      return rings.length ? [mk('polygon', rings, undefined, rings.map((_, i) => i).slice(1))] : [];
    }
    case 'multipolygon': {
      // плоский список колец всех полигонов + индексы дырок
      const rings: [number, number][][] = [];
      const holes: number[] = [];
      for (const poly of Array.isArray(coords) ? coords : []) {
        const rs = (Array.isArray(poly) ? poly : []).map(ringToLatLng).filter((r) => r.length >= 3);
        rs.forEach((r, i) => { rings.push(r); if (i > 0) holes.push(rings.length - 1); });
      }
      return rings.length ? [mk('polygon', rings, undefined, holes)] : [];
    }
    case 'geometrycollection':
      return (Array.isArray(geom.geometries) ? geom.geometries : []).flatMap(
        (g: any, i: number) => geoJsonGeometryToFeatures(g, `${id}-${i}`, name, color)
      );
    case 'feature':
      return geoJsonGeometryToFeatures(geom.geometry, id, name ?? featureName(geom.properties), color);
    case 'featurecollection':
      return (Array.isArray(geom.features) ? geom.features : []).flatMap(
        (f: any, i: number) => geoJsonGeometryToFeatures(f, `${id}-${i}`)
      );
    default:
      return [];
  }
}

function featureName(props: any): string | undefined {
  if (!props || typeof props !== 'object') return undefined;
  for (const k of ['name', 'NAME', 'title', 'label', 'Description', 'description']) {
    if (typeof props[k] === 'string' && props[k]) return props[k];
  }
  return undefined;
}

/** Цвет из свойств GeoJSON/KML (styleUrl/name-эвристика не нужна — берём явный) */
function featureColor(props: any): string | undefined {
  const c = props?.color ?? props?.['marker-color'] ?? props?.fill;
  return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined;
}

/** Парсинг GeoJSON (текст) -> фичи + bbox. Нативный JSON.parse. */
export function parseGeoJsonText(text: string): { features: UserMapFeature[]; bbox: MapBounds | null } {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`GeoJSON повреждён: ${(e as Error).message}`);
  }
  const features: UserMapFeature[] = [];
  const collect = (g: any, id: string, name?: string, color?: string) => {
    for (const f of geoJsonGeometryToFeatures(g, id, name, color)) {
      if (f.geometry.kind === 'polygon' && !f.geometry.rings.some((r) => r.length >= 3)) continue;
      features.push(f);
    }
  };
  if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
    data.features.forEach((f: any, i: number) => {
      collect(f?.geometry, `gj-${i}`, featureName(f?.properties), featureColor(f?.properties));
    });
  } else if (data?.type === 'Feature') {
    collect(data.geometry, 'gj-0', featureName(data.properties), featureColor(data.properties));
  } else if (data?.type) {
    collect(data, 'gj-0');
  } else {
    throw new Error('GeoJSON: не распознан тип верхнего уровня');
  }
  return { features, bbox: bboxFromFeatures(features) };
}

/** Общий bbox всех фич слоя */
export function bboxFromFeatures(features: UserMapFeature[]): MapBounds | null {
  const pts: [number, number][] = [];
  for (const f of features) {
    for (const r of f.geometry.rings) for (const p of r) pts.push(p);
    if (f.geometry.points) pts.push(...f.geometry.points);
  }
  return bboxFromPoints(pts);
}

// ─── Вектор: KML / KMZ ───────────────────────────────────────────────────────

/** XML-парсинг через DOMParser (окружение без DOM — минимальный fallback) */
function parseXml(text: string): Document {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('KML повреждён: ошибка разбора XML');
    return doc;
  }
  throw new Error('DOMParser недоступен в этом окружении');
}

const numList = (s: string | null | undefined): [number, number][] => {
  if (!s) return [];
  const out: [number, number][] = [];
  for (const tuple of s.trim().split(/\s+/)) {
    const parts = tuple.split(',').map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      out.push([parts[1], parts[0]]); // KML: lng,lat[,alt] -> [lat,lng]
    }
  }
  return out;
};

/** Извлечение цвета из KML <Style>/<styleUrl> (aabbggrr → #rrggbb) */
function kmlStyleColors(doc: Document): Map<string, { fill?: string; stroke?: string }> {
  const map = new Map<string, { fill?: string; stroke?: string }>();
  const hex = (argb?: string | null): string | undefined => {
    if (!argb || !/^[0-9a-f]{8}$/i.test(argb)) return undefined;
    return `#${argb.slice(6, 8)}${argb.slice(4, 6)}${argb.slice(2, 4)}`.toLowerCase();
  };
  Array.from(doc.getElementsByTagName('Style')).forEach((st: Element) => {
    const id = st.getAttribute('id');
    if (!id) return;
    const fill = hex(st.getElementsByTagName('color')[0]?.textContent);
    const lineNode = st.getElementsByTagName('LineStyle')[0];
    const stroke = lineNode ? hex(lineNode.getElementsByTagName('color')[0]?.textContent) : undefined;
    map.set(id, { fill, stroke });
  });
  return map;
}

function styleOf(node: Element, styles: Map<string, { fill?: string; stroke?: string }>): { fill?: string; stroke?: string } {
  const inline = node.getElementsByTagName('Style')[0];
  if (inline) {
    const id = inline.getAttribute('id') || '';
    const hex = (v?: string | null) => (v && /^[0-9a-f]{8}$/i.test(v)
      ? `#${v.slice(6, 8)}${v.slice(4, 6)}${v.slice(2, 4)}`.toLowerCase() : undefined);
    return {
      fill: hex(inline.getElementsByTagName('color')[0]?.textContent),
      stroke: hex(inline.getElementsByTagName('LineStyle')[0]?.getElementsByTagName('color')[0]?.textContent),
    };
  }
  const ref = node.getElementsByTagName('styleUrl')[0]?.textContent?.trim().replace(/^#/, '');
  return (ref && styles.get(ref)) || {};
}

/** Парсинг KML-текста -> фичи + bbox + метаданные (name/description/author) */
export function parseKmlText(text: string): {
  features: UserMapFeature[]; bbox: MapBounds | null;
  meta: { name?: string; description?: string; author?: string };
} {
  const doc = parseXml(text);
  const styles = kmlStyleColors(doc);
  const features: UserMapFeature[] = [];
  let fi = 0;

  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  for (const pm of placemarks) {
    const name = pm.getElementsByTagName('name')[0]?.textContent?.trim() || undefined;
    const col = styleOf(pm, styles);
    const push = (kind: UserMapFeature['geometry']['kind'], rings: [number, number][][], points?: [number, number][]) => {
      if (kind === 'point') {
        features.push({ id: `kml-${fi++}`, geometry: { kind, rings: [], points }, ...(name ? { name } : {}), color: col.fill || col.stroke });
      } else if (rings.length) {
        features.push({ id: `kml-${fi++}`, geometry: { kind, rings }, ...(name ? { name } : {}), color: col.stroke || col.fill });
      }
    };
    Array.from(pm.getElementsByTagName('Polygon')).forEach((poly: Element) => {
      const rings = Array.from(poly.getElementsByTagName('outerBoundaryIs'))
        .map((o: Element) => numList(o.getElementsByTagName('coordinates')[0]?.textContent))
        .concat(Array.from(poly.getElementsByTagName('innerBoundaryIs'))
          .map((o: Element) => numList(o.getElementsByTagName('coordinates')[0]?.textContent)))
        .filter((r) => r.length >= 3);
      const holes = rings.map((_, i) => i).slice(1);
      push('polygon', rings, undefined);
      if (holes.length) features[features.length - 1].geometry.holes = holes;
    });
    Array.from(pm.getElementsByTagName('LineString')).forEach((ls: Element) => {
      const r = numList(ls.getElementsByTagName('coordinates')[0]?.textContent);
      if (r.length >= 2) push('line', [r]);
    });
    Array.from(pm.getElementsByTagName('Point')).forEach((pt: Element) => {
      const r = numList(pt.getElementsByTagName('coordinates')[0]?.textContent);
      if (r.length) push('point', [], r);
    });
  }

  const meta = {
    name: doc.getElementsByTagName('Document')[0]?.getElementsByTagName('name')[0]?.textContent?.trim()
      || doc.getElementsByTagName('kml')[0]?.getElementsByTagName('name')[0]?.textContent?.trim()
      || undefined,
    description: doc.getElementsByTagName('description')[0]?.textContent?.trim() || undefined,
    author: doc.getElementsByTagName('Link')[0]?.getAttribute('href')
      || doc.getElementsByTagName('author')[0]?.textContent?.trim()
      || undefined,
  };
  return { features, bbox: bboxFromFeatures(features), meta };
}

// ─── GeoTIFF ─────────────────────────────────────────────────────────────────

/** Теги GeoKeyDirectory: GTModelTypeGeoKey(1024) / GTRasterTypeGeoKey(1025) /
 *  GeographicTypeGeoKey(2048) / ProjectedCSTypeGeoKey(3072) */
export function readGeoKeys(gkd: number[] | undefined): { modelType?: number; rasterType?: number; geographic?: number; projected?: number } {
  if (!Array.isArray(gkd) || gkd.length < 4) return {};
  const out: { modelType?: number; rasterType?: number; geographic?: number; projected?: number } = {};
  const count = gkd[3];
  for (let i = 0; i < count; i++) {
    const base = 4 + i * 4;
    const id = gkd[base], val = gkd[base + 2];
    // По спецификации GeoTIFF (GeoKeyDirectoryTag) каждая запись — это
    // [GTKeyID, GTFlags, NumberOfValues, Value_or_Offset], поэтому идентификатор EPSG
    // всегда берётся из 4-го элемента записи (ValueOrOffset).
    const v = gkd[base + 3];
    void val;
    if (id === 1024) out.modelType = v;
    else if (id === 1025) out.rasterType = v;
    else if (id === 2048) out.geographic = v;
    else if (id === 3072) out.projected = v;
  }
  return out;
}

/** EPSG-код -> проекция слоя (4326 vs 3857; прочее считаем метрическим 3857-подобным) */
export function projectionFromEpsg(epsg?: number): ProjectionId {
  if (epsg === 4326) return EPSG_4326;
  if (epsg === 3857 || epsg === 3395) return EPSG_3857;
  return epsg ? EPSG_3857 : EPSG_4326;
}

/**
 * GeoTIFF WorldFile-совместимая привязка из тегов image:
 * ModelTransformation (34264) либо ModelTiepoint(33922)+ModelPixelScale(33550).
 * Возвращает bbox в CRS исходника + функцию пиксель->CRS.
 */
export function geotiffBounds(
  width: number, height: number, md: {
    ModelTransformation?: number[]; ModelTiepoint?: number[]; ModelPixelScale?: number[];
  }
): { bounds: MapBounds; toCrs: (col: number, row: number) => [number, number] } | null {
  const tr = md?.ModelTransformation;
  if (Array.isArray(tr) && tr.length >= 12) {
    const toCrs = transformationMapper(tr);
    const a = toCrs(0, 0), b = toCrs(width, 0), c = toCrs(0, height), d = toCrs(width, height);
    const xs = [a[0], b[0], c[0], d[0]], ys = [a[1], b[1], c[1], d[1]];
    return { bounds: { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) }, toCrs };
  }
  const tp = md?.ModelTiepoint, ps = md?.ModelPixelScale;
  if (Array.isArray(tp) && tp.length >= 6 && Array.isArray(ps) && ps.length >= 2) {
    const groups: number[][] = [];
    for (let i = 0; i + 5 < tp.length; i += 6) groups.push(tp.slice(i, i + 6));
    if (!groups.length) return null;
    const toCrs = tiepointMapper(groups, [ps[0], ps[1], ps[2] ?? 0]);
    const a = toCrs(0, 0), b = toCrs(width, 0), c = toCrs(0, height), d = toCrs(width, height);
    const xs = [a[0], b[0], c[0], d[0]], ys = [a[1], b[1], c[1], d[1]];
    return { bounds: { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) }, toCrs };
  }
  return null;
}

/** Декодирование GeoTIFF: превью RGBA -> PNG data URL + bbox(WGS-84) + проекция */
export async function loadGeoTiff(buffer: ArrayBuffer, opts: LoadOptions = {}): Promise<Partial<UserMapLayer>> {
  const onProgress = opts.onProgress;
  onProgress?.({ phase: 'parse', ratio: 0.05 });
  // Динамический импорт: geotiff тянет WASM/Node-полифиллы — грузим только по нужде
  const mod: any = await import('geotiff');
  const GeoTIFF = mod.GeoTIFF ?? mod.default?.GeoTIFF;
  const tiff = await GeoTIFF.fromArrayBuffer(buffer);
  onProgress?.({ phase: 'decode', ratio: 0.35 });
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const md: any = {
    ModelTransformation: readTag(image, 34264),
    ModelTiepoint: readTag(image, 33922),
    ModelPixelScale: readTag(image, 33550),
  };
  const geoKeys = readGeoKeys(readTag(image, 34735) as number[] | undefined);
  const proj = projectionFromEpsg(geoKeys.projected ?? (geoKeys.geographic === 4326 ? 4326 : geoKeys.geographic));

  const scaled = fitSize(width, height, opts.maxRasterSide ?? 4096);
  const data = await image.readRasters({ width: scaled.w, height: scaled.h, interleave: true } as any);
  onProgress?.({ phase: 'encode', ratio: 0.75 });

  const rgba = toRgba(data as ArrayLike<number>, scaled.w, scaled.h, image.samplesPerPixel ?? data.length / 4 / 1);
  const imageDataUrl = await encodeRgbaPng(rgba, scaled.w, scaled.h, onProgress);

  const raw = geotiffBounds(width, height, md);
  const bbox = raw ? normalizeBoundsToWgs84(clampBounds(raw.bounds)) : null;
  onProgress?.({ phase: 'done', ratio: 1 });
  return {
    kind: 'raster' as UserMapKind,
    format: 'geotiff' as UserMapFormat,
    projection: proj,
    bbox: bbox ?? undefined,
    imageDataUrl,
    imageWidth: scaled.w,
    imageHeight: scaled.h,
    calibration: raw ? { bounds: bbox!, method: md.ModelTransformation ? 'geotransform' : 'tiepoints' } : undefined,
  } as Partial<UserMapLayer>;
}

/** Чтение GeoTIFF-тега из fileDirectory (geotiff.js отдаёт значения по номеру тега) */
function readTag(image: any, tag: number): any {
  try { return image?.fileDirectory?.[tag]; }
  catch { return undefined; }
}

/** RGB(A)/GRAY массив пикселей -> Uint8ClampedArray RGBA */
export function toRgba(src: ArrayLike<number>, w: number, h: number, samplesHint = 3): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const ch = src.length >= n * 4 ? 4 : src.length >= n * 3 ? 3 : src.length >= n * 2 ? 2 : 1;
  void samplesHint;
  for (let i = 0; i < n; i++) {
    if (ch === 1) {
      const v = src[i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    } else if (ch === 2) {
      const v = src[i * 2]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = src[i * 2 + 1];
    } else if (ch === 3) {
      out[i * 4] = src[i * 3]; out[i * 4 + 1] = src[i * 3 + 1]; out[i * 4 + 2] = src[i * 3 + 2]; out[i * 4 + 3] = 255;
    } else {
      out[i * 4] = src[i * 4]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4 + 2]; out[i * 4 + 3] = src[i * 4 + 3];
    }
  }
  return out;
}

function fitSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  if (w <= maxSide && h <= maxSide) return { w, h };
  const k = maxSide / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** RGBA -> PNG data URL (canvas; вне браузера — base64 сырых данных) */
export async function encodeRgbaPng(
  rgba: Uint8ClampedArray, w: number, h: number, onProgress?: ProgressCb
): Promise<string> {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Новый ArrayBuffer гарантированно совместим с конструктором ImageData
      const data = new Uint8ClampedArray(rgba);
      ctx.putImageData(new ImageData(data, w, h), 0, 0);
      onProgress?.({ phase: 'encode', ratio: 0.9 });
      return canvas.toDataURL('image/png');
    }
  }
  return `data:image/raw;base64,${bytesToBase64(rgba)}`;
}

export function bytesToBase64(input: ArrayLike<number>): string {
  const bytes = input instanceof Uint8Array || input instanceof Uint8ClampedArray
    ? input as Uint8Array | Uint8ClampedArray
    : Uint8Array.from(Array.prototype.slice.call(input) as number[]);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  if (typeof btoa !== 'undefined') return btoa(bin);
  // окружение без DOM/btoa (SSR/тесты): ручной base64 из байтов
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

// ─── MBTiles (sql.js / WASM SQLite) ──────────────────────────────────────────

/** SQL-запросы MBTiles: metadata + границы + число тайлов */
export const MBTILES_SQL = {
  metadata: 'SELECT name, value FROM metadata',
  bounds: 'SELECT bounds FROM metadata WHERE name = "bounds"',
  count: 'SELECT COUNT(*) AS c FROM tiles',
  zooms: 'SELECT MIN(zoom_level) AS minz, MAX(zoom_level) AS maxz FROM tiles',
};

/** Разбор строки bounds MBTiles ("west,south,east,north") */
export function parseMbtilesBounds(s?: string | null): MapBounds | null {
  if (!s) return null;
  const p = s.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  const b = clampBounds({ west: p[0], south: p[1], east: p[2], north: p[3] });
  return isValidBounds(b) ? b : null;
}

export interface MbtilesSummary {
  metadata: Record<string, string>;
  bounds: MapBounds | null;
  tileCount: number;
  minZoom: number;
  maxZoom: number;
  format: string;
  name: string;
  description: string;
}

/** Чтение метаданных MBTiles через sql.js (WASM SQLite) */
export async function readMbtilesSummary(
  buffer: ArrayBuffer,
  initSqlJs?: (config?: any) => Promise<any>,
  onProgress?: ProgressCb
): Promise<MbtilesSummary> {
  const loader = initSqlJs ?? (async () => {
    const mod: any = await import('sql.js');
    const factory = mod.default ?? mod.initSqlJs ?? mod.initSqlJs;
    const wasmPath = wasmUrlFor('sql-wasm.wasm');
    const SQL = await (typeof factory === 'function' ? factory({ locateFile: () => wasmPath }) : factory);
    return SQL;
  });
  onProgress?.({ phase: 'parse', ratio: 0.1 });
  const SQL = await loader();
  onProgress?.({ phase: 'decode', ratio: 0.4 });
  const db = new SQL.Database(new Uint8Array(buffer));
  try {
    const meta: Record<string, string> = {};
    const run = (sql: string) => {
      const res = db.exec(sql);
      return res.length ? res[0].values : [];
    };
    let rows: any[][] = [];
    try { rows = run(MBTILES_SQL.metadata); } catch { rows = []; }
    for (const [k, v] of rows) meta[String(k)] = String(v ?? '');

    let tileCount = 0, minZoom = 0, maxZoom = 0;
    try {
      const c = run(MBTILES_SQL.count);
      tileCount = Number(c[0]?.[0] ?? 0);
      const z = run(MBTILES_SQL.zooms);
      minZoom = Number(z[0]?.[0] ?? 0);
      maxZoom = Number(z[0]?.[1] ?? minZoom);
    } catch { /* пустая БД */ }

    const bounds = parseMbtilesBounds(meta.bounds);
    onProgress?.({ phase: 'done', ratio: 1 });
    return {
      metadata: meta, bounds, tileCount, minZoom, maxZoom,
      format: (meta.format || 'png').toLowerCase(),
      name: meta.name || '', description: meta.description || '',
    };
  } finally {
    db.free?.();
  }
}

/** Путь к WASM-артефакту: из Vite public/ или CDN (только рантайм браузера) */
function wasmUrlFor(file: string): string {
  if (typeof window !== 'undefined') {
    const base = (import.meta as any)?.env?.BASE_URL ?? '/';
    return `${base}vendor/${file}`;
  }
  return file;
}

/** Тайл TMS -> XYZ (flip Y) */
export function tmsToYxyz(zoomLevel: number, tmSy: number): number {
  return Math.pow(2, zoomLevel) - 1 - tmSy;
}

/** Ключ тайла "z/x/y" (XYZ) -> колонка/строка TMS в таблице tiles MBTiles */
export function mbtilesTileRow(key: string): { z: number; x: number; yTms: number } | null {
  const p = key.split('/').map(Number);
  if (p.length !== 3 || p.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const [z, x, y] = p;
  return { z, x, yTms: tmsToYxyz(z, y) };
}

/** data URL для байтов тайла: определяем PNG/JPEG по сигнатуре (magic bytes) */
export function tileBytesToDataUrl(bytes: Uint8Array, fallbackFormat = 'png'): string {
  const isJpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const mime = isJpeg ? 'image/jpeg' : isPng ? 'image/png'
    : (fallbackFormat === 'jpg' || fallbackFormat === 'jpeg') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * Извлечение тайлов MBTiles из БД (sql.js) по ключам "z/x/y" (XYZ).
 * Возвращает map ключ -> data URL. Чистая функция: SQL-текст и flip TMS->XYZ
 * проверяются юнит-тестами без реального WASM.
 */
export function extractMbtilesTiles(
  db: { exec(sql: string): { values: any[][] }[] },
  keys: string[],
  format = 'png',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const rc = mbtilesTileRow(key);
    if (!rc) continue;
    // значения подставляются только после валидации целых чисел — инъекция исключена
    const res = db.exec(
      `SELECT tile_data FROM tiles WHERE zoom_level = ${rc.z} AND tile_column = ${rc.x} AND tile_row = ${rc.yTms}`,
    );
    const raw = res.length ? res[0].values[0]?.[0] : undefined;
    if (raw == null) continue;
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
    if (!bytes.length) continue;
    out[key] = tileBytesToDataUrl(bytes, format);
  }
  return out;
}

/**
 * Декодер тайлов для рендера: открывает SQLite-базу один раз на буфер
 * (кэшируется по ссылке ArrayBuffer), достраивает недостающие тайлы по запросу.
 */
let cachedMbtilesDb: { buffer: ArrayBuffer; db: any } | null = null;

async function openMbtilesDb(buffer: ArrayBuffer): Promise<any> {
  if (cachedMbtilesDb && cachedMbtilesDb.buffer === buffer) return cachedMbtilesDb.db;
  const mod: any = await import('sql.js');
  const factory = mod.default ?? mod.initSqlJs ?? mod.initSqlJs;
  const wasmPath = wasmUrlFor('sql-wasm.wasm');
  const SQL = await (typeof factory === 'function' ? factory({ locateFile: () => wasmPath }) : factory);
  const db = new SQL.Database(new Uint8Array(buffer));
  cachedMbtilesDb?.db?.free?.();
  cachedMbtilesDb = { buffer, db };
  return db;
}

/** Освобождение кэша SQLite (при удалении слоя) */
export function closeMbtilesDbCache(): void {
  cachedMbtilesDb?.db?.free?.();
  cachedMbtilesDb = null;
}

/** Реализация decodeTile для requestMbtilesTiles (MapCanvas -> sql.js) */
export async function decodeMbtilesTilesForRender(
  buffer: ArrayBuffer, keys: string[], format = 'png',
): Promise<Record<string, string>> {
  const db = await openMbtilesDb(buffer);
  return extractMbtilesTiles(db, keys, format);
}

// ─── Растр с ручной привязкой по 4 углам ─────────────────────────────────────

/** Привязка PNG/JPG по четырём угловым точкам (ручная калибровка оператором) */
export function calibrateImageLayer(
  fileName: string, imgW: number, imgH: number, corners: CornerCalibration
): { bbox: MapBounds; projection: ProjectionId } {
  const b = boundsFromCorners(corners);
  // Проверка непротиворечивости: ориентация растра обязана совпадать с
  // географической (север вверх). Если верхние углы южнее нижних, привязка
  // перевёрнута и отрисовка даст зеркальный снимок — такую отклоняем.
  const topMeanLat = (corners.topLeft[0] + corners.topRight[0]) / 2;
  const bottomMeanLat = (corners.bottomLeft[0] + corners.bottomRight[0]) / 2;
  const leftMeanLng = (corners.topLeft[1] + corners.bottomLeft[1]) / 2;
  const rightMeanLng = (corners.topRight[1] + corners.bottomRight[1]) / 2;
  if (!(topMeanLat > bottomMeanLat) || !(rightMeanLng > leftMeanLng)) {
    throw new Error(`Привязка по углам некорректна (${fileName}): снимок перевёрнут, центр вне границ`);
  }
  void imgW; void imgH;
  return { bbox: b, projection: EPSG_4326 };
}

// ─── Единая точка входа ──────────────────────────────────────────────────────

export interface LoadedUserMapLayer extends UserMapLayer {}

/**
 * Загрузка файла тактической карты -> готовый слой (без персистентности).
 * @throws UnsupportedMapFormatError | Error с читаемым описанием
 */
export async function loadUserMapFile(file: File, opts: LoadOptions = {}): Promise<LoadedUserMapLayer> {
  const format = detectFormat(file.name);
  if (!format) throw new UnsupportedMapFormatError(file.name);
  const newId = opts.newId ?? defaultNewId;
  const onProgress = opts.onProgress;
  const size = file.size ?? 0;
  onProgress?.({ phase: 'read', ratio: 0.01, note: file.name });

  const base = (kind: UserMapKind, partial: Partial<UserMapLayer>): LoadedUserMapLayer => ({
    id: newId(),
    kind,
    format,
    bbox: partial.bbox ?? { north: 0, south: 0, east: 0, west: 0 },
    projection: partial.projection ?? EPSG_4326,
    visible: true,
    opacity: 0.85,
    ...partial,
    // meta всегда собирается здесь (partial.meta — только дополнительные поля вроде description)
    meta: {
      name: opts.name || (partial.meta as any)?.name || stripExt(file.name),
      loadedAt: new Date().toISOString(),
      author: opts.author || (partial.meta as any)?.author || '',
      fileName: file.name,
      fileSize: size,
      sourceFormat: format,
      ...((partial.meta as any)?.description ? { description: (partial.meta as any).description } : {}),
    },
  } as unknown as LoadedUserMapLayer);

  if (format === 'geojson') {
    const text = await file.text();
    onProgress?.({ phase: 'parse', ratio: 0.6 });
    const { features, bbox } = parseGeoJsonText(text);
    if (!features.length) throw new Error('GeoJSON не содержит геометрических объектов');
    limitFeatures(features, opts.maxFeatures ?? 5000);
    onProgress?.({ phase: 'done', ratio: 1 });
    return base('vector', { features, ...(bbox ? { bbox } : {}) });
  }

  if (format === 'kml') {
    const text = await file.text();
    onProgress?.({ phase: 'parse', ratio: 0.6 });
    const { features, bbox, meta } = parseKmlText(text);
    if (!features.length) throw new Error('KML не содержит Placemark с геометрией');
    limitFeatures(features, opts.maxFeatures ?? 5000);
    onProgress?.({ phase: 'done', ratio: 1 });
    return base('vector', {
      features, ...(bbox ? { bbox } : {}),
      meta: { name: opts.name || meta.name || stripExt(file.name), author: opts.author || meta.author || '', description: meta.description } as any,
    });
  }

  if (format === 'kmz') {
    const JSZipMod: any = await import('jszip');
    const JSZip = JSZipMod.default ?? JSZipMod.JSZip ?? JSZipMod;
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    onProgress?.({ phase: 'parse', ratio: 0.4 });
    const kmlName = Object.keys(zip.files).find((n) => /\.kml$/i.test(n));
    if (!kmlName) throw new Error('KMZ не содержит .kml внутри архива');
    const text = await zip.file(kmlName).async('string');
    const { features, bbox, meta } = parseKmlText(text);
    if (!features.length) throw new Error('KMZ не содержит Placemark с геометрией');
    limitFeatures(features, opts.maxFeatures ?? 5000);
    onProgress?.({ phase: 'done', ratio: 1 });
    return base('vector', {
      features, ...(bbox ? { bbox } : {}),
      meta: { name: opts.name || meta.name || stripExt(file.name), author: opts.author || meta.author || '', description: meta.description } as any,
    });
  }

  if (format === 'geotiff') {
    const part = await loadGeoTiff(await file.arrayBuffer(), opts);
    if (!part.bbox) throw new Error('GeoTIFF без геопривязки (нет ModelTransformation/ModelTiepoint) — выполните привязку вручную как растр');
    return base('raster', part);
  }

  if (format === 'mbtiles') {
    // Бинарник SQLite храним ЦЕЛИКОМ (sourceBlob): тайлы извлекаются лениво
    // через sql.js только для видимой области (requestMbtilesTiles в MapCanvas).
    const buffer = await file.arrayBuffer();
    const summary = await readMbtilesSummary(buffer, undefined, onProgress);
    if (!summary.tileCount) throw new Error('MBTiles не содержит тайлов');
    const bbox = summary.bounds ?? syntheticMbtilesBounds(summary.minZoom, summary.maxZoom);
    return base('raster', {
      bbox,
      projection: EPSG_4326,
      tileInfo: { minZoom: summary.minZoom, maxZoom: summary.maxZoom, format: summary.format },
      sourceBlob: buffer,
      meta: {
        name: opts.name || summary.name || stripExt(file.name),
        loadedAt: new Date().toISOString(),
        author: opts.author || '',
        fileName: file.name, fileSize: size, sourceFormat: 'mbtiles',
      },
    });
  }

  // image (png/jpg/...) — обязательна ручная привязка по 4 углам
  const dataUrl = await readAsDataUrl(file);
  const dims = await measureImage(dataUrl);
  if (!opts.calibration) {
    throw new Error('Растровой карте нужны 4 угловые точки привязки (ручная калибровка)');
  }
  const { bbox, projection } = calibrateImageLayer(file.name, dims.w, dims.h, opts.calibration);
  onProgress?.({ phase: 'done', ratio: 1 });
  return base('raster', {
    bbox, projection, imageDataUrl: dataUrl, imageWidth: dims.w, imageHeight: dims.h,
    calibration: { bounds: bbox, method: 'manual' },
  });
}

function syntheticMbtilesBounds(minZoom: number, maxZoom: number): MapBounds {
  // Fallback: мир целиком (TMS-схема MBTiles покрывает всюmercator-площадку)
  void minZoom; void maxZoom;
  return worldRectToBounds({ x0: 0, y0: 0, x1: 1, y1: 1 });
}

function limitFeatures(features: UserMapFeature[], max: number): void {
  if (features.length > max) features.length = max;
}

function stripExt(name: string): string {
  return (name || 'Слой').replace(/\.[a-z0-9]+$/i, '');
}

function readAsDataUrl(file: File): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      fr.readAsDataURL(file);
    });
  }
  return file.arrayBuffer().then((b) => `data:${file.type || 'image/png'};base64,${bytesToBase64(new Uint8Array(b))}`);
}

function measureImage(dataUrl: string): Promise<{ w: number; h: number }> {
  if (typeof Image === 'undefined') return Promise.resolve({ w: 0, h: 0 });
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error('Изображение повреждено или не поддерживается браузером'));
    img.src = dataUrl;
  });
}

/** Пересчёт фичи слоя в экранные пиксели (используется рендером MapCanvas) */
export function featureToScreenPts(
  f: UserMapFeature, worldPx: number, offsetX: number, offsetY: number
): { kind: 'polygon' | 'line' | 'point'; rings: { x: number; y: number }[][]; points: { x: number; y: number }[]; holes: number[] } {
  const toPx = ([lat, lng]: [number, number]) => {
    const frac = lngLatFrac(lat, lng);
    return { x: frac.x * worldPx + offsetX, y: frac.y * worldPx + offsetY };
  };
  return {
    kind: f.geometry.kind,
    rings: f.geometry.rings.map((r) => r.map(toPx)),
    points: (f.geometry.points ?? []).map(toPx),
    holes: f.geometry.holes ?? [],
  };
}

function lngLatFrac(lat: number, lng: number): { x: number; y: number } {
  return lngLatToWorldFrac(lng, lat);
}

/** Границы слоя в world-долях (для клиппинга/автовписывания вида) */
export function layerWorldRect(layer: UserMapLayer) {
  return boundsToWorldRect(layer.bbox);
}

/** Доля точки внутри bbox слоя (для растровых оверлеев с вектором поверх) */
export function pointFracInLayer(layer: UserMapLayer, lat: number, lng: number) {
  return geoToFracInBounds(layer.bbox, lat, lng);
}
