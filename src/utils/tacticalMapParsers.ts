// ─── ПАРСЕРЫ ПОЛЬЗОВАТЕЛЬСКИХ ТАКТИЧЕСКИХ КАРТ (Задача 2) ──────────────────
// Извлечение проекции (EPSG:4326 / EPSG:3857) и bounding box из форматов:
//   • GeoTIFF — чтение GDAL-тегов ModelPixelScale(33550)/ModelTiepoint(33922)/
//     ModelTransformation(34264)/GeoKeyDirectory(34735), в т.ч. GeoTIFF ASCII
//     tags (GDAL_GEOTIFF_TAGS) для тестов/легаси-файлов;
//   • KML/KMZ — <LatLonBox>/<gx:LatLonQuad>/<ExtendedData bounds>, полигоны;
//   • GeoJSON — bbox / обход координат;
//   • MBTiles — SQLite header + metadata (bounds/minzoom/maxzoom);
//   • растровые изображения — EXIF-GPS / JFGCIE-комментарий (world file).
// Все функции ЧИСТО синхронные над ArrayBuffer/строкой — без DOM, чтобы
// математика привязки покрывалась юнит-тестами (Vitest) в node-окружении.
import type { BBox4, TacticalOverlayGeoref, TacticalOverlayProjection, TacticalOverlayVector, GeoPoint } from '../types';

export const EARTH_RADIUS_M = 6378137; // WGS-84 экваториальный радиус (сфера Web Mercator)
const DEG = Math.PI / 180;
/** Максимальная долгота при широте ±85.051129 (предел Projected Bounds EPSG:3857) */
export const MAX_MERC_LAT = 85.0511287798066;

/** lat(°) -> нормализованная Mercator Y ∈ [0..1] (0 = северный предел) */
export function latToMercY(lat: number): number {
  const s = Math.sin(Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Нормализованная Mercator Y -> lat(°) */
export function mercYToLat(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
}

/** EPSG:3857 (метры) -> {lat, lng} */
export function webMercatorToWgs84(xMeters: number, yMeters: number): GeoPoint {
  return {
    lng: xMeters / 20037508.34 * 180,
    lat: mercYToLat(0.5 - yMeters / 40075016.68),
  };
}

/** {lat,lng} -> EPSG:3857 метры */
export function wgs84ToWebMercator(lat: number, lng: number): { x: number; y: number } {
  return {
    x: lng / 180 * 20037508.34,
    y: (0.5 - latToMercY(lat)) * 40075016.68,
  };
}

/** bbox в EPSG:3857 -> MapBounds (lon/lat, градусы) */
export function mercBBoxToWgs84Bounds(bbox: BBox4): { north: number; south: number; east: number; west: number } {
  const sw = webMercatorToWgs84(bbox[0], bbox[1]);
  const ne = webMercatorToWgs84(bbox[2], bbox[3]);
  return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
}

/** Собрать georef из bbox (любой поддерживаемой проекции) и размера растра */
export function buildGeoref(bbox: BBox4, projection: TacticalOverlayProjection, widthPx: number, heightPx: number): TacticalOverlayGeoref {
  const boundsWgs84 = projection === 'EPSG:3857' ? mercBBoxToWgs84Bounds(bbox) : { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] };
  return { boundsWgs84, projection, widthPx, heightPx };
}

/**
 * МАППИНГ ПИКСЕЛЕЙ РАСТРА -> КООРДИНАТЫ WGS-84 (аффинное преобразование поверх
 * Web Mercator — та же математика, что у слоя тайлов OSM):
 *   col ∈ [0..widthPx] -> lng линейно (lon — равноразмерен в Mercator);
 *   row ∈ [0..heightPx] -> Mercator Y линейно -> lat через обратную проекцию.
 * Возвращает замыкание-функцию; используется и для рендера (обратный вызов
 * geo->px через overlayGeoToPixel).
 */
export function pixelToWgs84Mapper(georef: TacticalOverlayGeoref): (colPx: number, rowPx: number) => GeoPoint {
  const { boundsWgs84: b, widthPx, heightPx } = georef;
  const topY = latToMercY(b.north);
  const botY = latToMercY(b.south);
  return (colPx: number, rowPx: number): GeoPoint => ({
    lat: mercYToLat(topY + (botY - topY) * (rowPx / heightPx)),
    lng: b.west + (b.east - b.west) * (colPx / widthPx),
  });
}

/** Обратная задача: гео -> пиксель растра оверлея (для кликов/привязки объектов) */
export function wgs84ToOverlayPixel(georef: TacticalOverlayGeoref): (geo: GeoPoint) => { x: number; y: number } {
  const { boundsWgs84: b, widthPx, heightPx } = georef;
  const topY = latToMercY(b.north);
  const botY = latToMercY(b.south);
  return (geo: GeoPoint) => ({
    x: ((geo.lng - b.west) / (b.east - b.west)) * widthPx,
    y: ((latToMercY(geo.lat) - topY) / (botY - topY)) * heightPx,
  });
}

// ─── GeoTIFF ────────────────────────────────────────────────────────────────

export interface GeoTiffTags {
  widthPx: number;
  heightPx: number;
  modelPixelScale?: [number, number, number];
  modelTiepoint?: [number, number, number, number, number, number];
  modelTransformation?: number[]; // 4x4 row-major
  geoKeys: Record<string, number>;
  asciiTags: Record<number, string>;
}

/** Прочитать IFD-теги GeoTIFF (little/big endian) из ArrayBuffer */
export function readGeoTiffTags(buf: ArrayBuffer): GeoTiffTags | null {
  try {
    const dv = new DataView(buf);
    const b0 = dv.getUint8(0), b1 = dv.getUint8(1);
    let little: boolean;
    let ifdOffset: number;
    if (b0 === 0x49 && b1 === 0x49) { little = true; ifdOffset = dv.getUint32(4, little); }
    else if (b0 === 0x4d && b1 === 0x4d) { little = false; ifdOffset = dv.getUint32(4, little); }
    else return null;
    if (dv.getUint16(2, little) !== 42) return null;
    const out: GeoTiffTags = { widthPx: 0, heightPx: 0, geoKeys: {}, asciiTags: {} };
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
        const sizeOf = (t: number) => ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 } as Record<number, number>)[t] || 0;
        const total = sizeOf(type) * count;
        const dataOff = total > 4 ? valueOffset : e + 8;
        const u16at = (k: number) => dv.getUint16(dataOff + k * 2, little);
        const dblAt = (k: number) => dv.getFloat64(dataOff + k * 8, little);
        switch (tag) {
          case 256: out.widthPx = count === 3 ? dv.getUint32(e + 12 - 4, little) : dv.getUint32(dataOff, little); break;
          case 257: out.heightPx = dv.getUint32(dataOff, little); break;
          case 33550: if (type === 12 && count >= 3) out.modelPixelScale = [dblAt(0), dblAt(1), dblAt(2)]; break;
          case 33922: if (type === 12 && count >= 6) out.modelTiepoint = [dblAt(0), dblAt(1), dblAt(2), dblAt(3), dblAt(4), dblAt(5)]; break;
          case 34264: if (type === 12 && count >= 16) { out.modelTransformation = []; for (let k = 0; k < 16; k++) out.modelTransformation.push(dblAt(k)); } break;
          case 34735: {
            // GeoKeyDirectory: uint16[4*(n+1)] — GTModelType(1024), GeographicType(2048)/ProjectedCSType(3072)
            for (let k = 0; k + 3 < count; k += 4) {
              const keyId = u16at(k), loc = u16at(k + 2), val = u16at(k + 3);
              out.geoKeys[String(keyId)] = loc === 0 ? val : 0;
            }
            break;
          }
          case 34737: { // GeoAsciiParams
            const len = Math.min(count, 512);
            let s = '';
            for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(dataOff + k));
            out.asciiTags[tag] = s;
            break;
          }
          case 42112: { // GDAL_GEOTIFF_ASCII_TAGS (легаси/тестовый канал передачи тегов)
            const len = Math.min(count, 4096);
            let s = '';
            for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(dataOff + k));
            out.asciiTags[tag] = s;
            break;
          }
          default: break;
        }
      }
      off = dv.getUint32(off + 2 + n * 12, little); // next IFD (не обязателен)
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Определить проекцию и bbox GeoTIFF по тегам.
 * Приоритет: ModelTransformation > Tiepoint+PixelScale; GTModelType 1=гео
 * (EPSG:4326, значения в градусах), 2=проекция (по ProjectedCSType: 3857 —
 * Web Mercator, иначе считаем метрическую систему с осью Y на север несовместимой
 * и возвращаем ошибку). Дополнительно распознаётся ASCII-блок формата
 * "MODELPIXELSCALE a b c; MODELTIEPOINT i j k X Y Z; GTYPE 1|2; CS 4326|3857".
 */
export function parseGeoTiffGeoref(buf: ArrayBuffer, widthPxHint?: number, heightPxHint?: number):
  { ok: true; georef: TacticalOverlayGeoref } | { ok: false; error: string } {
  const tags = readGeoTiffTags(buf);
  if (!tags) return { ok: false, error: 'Некорректный заголовок TIFF (II/MM/42)' };
  const w = tags.widthPx || widthPxHint || 0;
  const h = tags.heightPx || heightPxHint || 0;
  if (!w || !h) return { ok: false, error: 'GeoTIFF: не найдены теги ImageWidth/ImageHeight' };

  // 1) ASCII-теги GDAL (тестовый/легаси канал)
  const ascii = tags.asciiTags[42112];
  if (ascii) {
    const g = parseGeoTiffAsciiTags(ascii, w, h);
    if (g) return { ok: true, georef: g };
  }

  // 2) Бинарные теги
  let projMeters: number[] | null = null;
  if (tags.modelTransformation && tags.modelTransformation.length >= 16) {
    const m = tags.modelTransformation;
    // row-major 4x4: X = m0*i + m1*j + m3; Y = m4*i + m5*j + m7 (ось Y на север, m5 < 0)
    projMeters = [Math.min(m[3], m[3] + m[0] * w), Math.min(m[7] + m[5] * h, m[7]), Math.max(m[3], m[3] + m[0] * w), Math.max(m[7] + m[5] * h, m[7])];
  } else if (tags.modelPixelScale && tags.modelTiepoint) {
    const [i, j, , X, Y] = tags.modelTiepoint;
    const sx = tags.modelPixelScale[0]; const sy = tags.modelPixelScale[1];
    const cornerX = X - i * sx;
    const cornerYTop = Y + j * sy; // tiepoint row j: Y соответствует ЦЕНТРУ пикселя ~ row j
    projMeters = [cornerX, cornerYTop - sy * h, cornerX + sx * w, cornerYTop];
  }
  if (!projMeters) return { ok: false, error: 'GeoTIFF: отсутствуют теги геопривязки (ModelPixelScale/ModelTiepoint/ModelTransformation)' };

  const gtModelType = tags.geoKeys['1024'] ?? 0;
  const geographicType = tags.geoKeys['2048'] ?? 0;
  const projectedCs = tags.geoKeys['3072'] ?? 0;
  let projection: TacticalOverlayProjection;
  if (gtModelType === 1 || geographicType === 4326) projection = 'EPSG:4326';
  else if (projectedCs === 3857 || projectedCs === 0) projection = 'EPSG:3857';
  else return { ok: false, error: `GeoTIFF: неподдерживаемая проекция EPSG:${projectedCs} (только 4326/3857)` };

  const bbox: BBox4 = [projMeters[0], projMeters[1], projMeters[2], projMeters[3]];
  // sanity: для 3857 ожидаем |x| ≤ 20037508
  if (projection === 'EPSG:3857' && (Math.abs(bbox[0]) > 2.1e7 || Math.abs(bbox[2]) > 2.1e7)) {
    return { ok: false, error: 'GeoTIFF: значения привязки вне пределов EPSG:3857' };
  }
  return { ok: true, georef: buildGeoref(bbox, projection, w, h) };
}

/** Разбор ASCII-блока тегов: "GTYPE 2; CS 3857; MODELPIXELSCALE 2.4 2.4 0; MODELTIEPOINT 0 0 0 E N 0" */
export function parseGeoTiffAsciiTags(text: string, w: number, h: number): TacticalOverlayGeoref | null {
  const upper = text.toUpperCase();
  const scaleM = upper.match(/MODELPIXELSCALE\s+([-\d.eE+]+)\s+([-\d.eE+]+)(?:\s+[-\d.eE+]+)?/);
  const tieM = upper.match(/MODELTIEPOINT\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/);
  if (!scaleM || !tieM) return null;
  const gtypeM = upper.match(/GTYPE\s+(\d+)/);
  const csM = upper.match(/CS\s+(\d+)/);
  const sx = parseFloat(scaleM[1]), sy = parseFloat(scaleM[2]);
  const i = parseFloat(tieM[1]), j = parseFloat(tieM[2]), X = parseFloat(tieM[4]), Y = parseFloat(tieM[5]);
  const cornerX = X - i * sx;
  const topY = Y + j * sy;
  const bbox: BBox4 = [cornerX, topY - sy * h, cornerX + sx * w, topY];
  const isGeo = gtypeM ? gtypeM[1] === '1' : csM ? csM[1] === '4326' : false;
  const projection: TacticalOverlayProjection = isGeo ? 'EPSG:4326' : 'EPSG:3857';
  return buildGeoref(bbox, projection, w, h);
}

// ─── KML / KMZ ──────────────────────────────────────────────────────────────

/** Извлечь bbox и векторы из KML. LatLonBox (north/south/east/west) задаёт
 *  жёсткую привязку ground-overlay; при его отсутствии — bbox по всем координатам. */
export function parseKmlGeoref(xml: string):
  { ok: true; bbox: BBox4; vectors: TacticalOverlayVector[]; hasGroundBox: boolean } |
  { ok: false; error: string } {
  if (!/<kml[\s>]/i.test(xml)) return { ok: false, error: 'Не KML-документ (нет корня <kml>)' };
  const vectors: TacticalOverlayVector[] = [];
  let bbox: BBox4 | null = null;
  let hasGroundBox = false;
  const take = (b: BBox4) => {
    if (!bbox) bbox = b;
    else { bbox[0] = Math.min(bbox[0], b[0]); bbox[1] = Math.min(bbox[1], b[1]); bbox[2] = Math.max(bbox[2], b[2]); bbox[3] = Math.max(bbox[3], b[3]); }
  };
  const llbox = xml.match(/<(?:gx:)?LatLonBox[^>]*>([\s\S]*?)<\/(?:gx:)?LatLonBox>/i);
  if (llbox) {
    const num = (t: string, tag: string) => {
      const m = t.match(new RegExp(`<${tag}>([-\\d.eE+]+)</${tag}>`, 'i'));
      return m ? parseFloat(m[1]) : NaN;
    };
    const n = num(llbox[1], 'north'), s = num(llbox[1], 'south');
    const east = num(llbox[1], 'east'), west = num(llbox[1], 'west');
    if ([n, s, east, west].every(Number.isFinite)) {
      hasGroundBox = true;
      take([west, s, east, n]);
    }
  }
  // Polygons / LineStrings: coordinates "lng,lat[,alt] lng,lat ..."
  const coordRe = /<(?:Polygon|outerBoundaryIs|LineString)[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let m: RegExpExecArray | null;
  while ((m = coordRe.exec(xml))) {
    const pts: GeoPoint[] = m[1].trim().split(/\s+/).map((tok) => {
      const [lng, lat] = tok.split(',').map(parseFloat);
      return { lat, lng };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2) continue;
    const nameM = xml.slice(Math.max(0, m.index - 600), m.index).match(/<name>([^<]*)<\/name>/i);
    vectors.push({ kind: 'polygon', name: nameM?.[1] || 'Зона KML', color: '#f59e0b', ring: pts });
    let mn: BBox4 = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) { mn = [Math.min(mn[0], p.lng), Math.min(mn[1], p.lat), Math.max(mn[2], p.lng), Math.max(mn[3], p.lat)]; }
    if (!hasGroundBox) take(mn);
  }
  if (!bbox) return { ok: false, error: 'KML: нет ни LatLonBox, ни координат полигонов' };
  return { ok: true, bbox: bbox, vectors, hasGroundBox };
}

/** KMZ → распаковка stored (method=0, без сжатия) записей zip и поиск .kml
 *  внутри. Сжатые DEFLATE-записи декодируются в рантайме через
 *  DecompressionStream('deflate-raw') (см. loadTacticalMapFile) — здесь только
 *  разбор структуры, чтобы парсер был тестируемым в node. */
export function findKmlInKmz(buf: ArrayBuffer): Uint8Array | null {
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
    if (/\.kml$/i.test(name) && method === 0) return new Uint8Array(buf, dataOff, compSize);
    off = dataOff + compSize;
    // skip data descriptor если есть
    if (off + 4 <= buf.byteLength && dv.getUint32(off, true) === 0x08074b50) off += 16;
  }
  return null;
}

// ─── GeoJSON ────────────────────────────────────────────────────────────────

/** Обход всех Position в GeoJSON (Point..MultiPolygon, GeometryCollection, Features) */
export function walkGeoJsonPositions(obj: any, cb: (lng: number, lat: number) => void): void {
  const walkCoords = (c: any) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') { if (Number.isFinite(c[0]) && Number.isFinite(c[1])) cb(c[0], c[1]); return; }
    for (const sub of c) walkCoords(sub);
  };
  const walkGeom = (g: any) => {
    if (!g || typeof g !== 'object') return;
    if (g.type === 'GeometryCollection') { for (const gg of g.geometries || []) walkGeom(gg); return; }
    if (g.coordinates) walkCoords(g.coordinates);
  };
  if (obj?.type === 'FeatureCollection') { for (const f of obj.features || []) { walkGeom(f?.geometry); } return; }
  if (obj?.type === 'Feature') { walkGeom(obj.geometry); return; }
  walkGeom(obj);
}

export function parseGeoJsonGeoref(text: string):
  { ok: true; bbox: BBox4; vectors: TacticalOverlayVector[] } | { ok: false; error: string } {
  let obj: any;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: 'GeoJSON: невалидный JSON' }; }
  let bbox: BBox4 | null = Array.isArray(obj?.bbox) && obj.bbox.length >= 4
    ? [obj.bbox[0], obj.bbox[1], obj.bbox[2], obj.bbox[3]] : null;
  const vectors: TacticalOverlayVector[] = [];
  const feats = obj?.type === 'FeatureCollection' ? obj.features : obj?.type === 'Feature' ? [obj] : [];
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates?.[0])) {
      vectors.push({ kind: 'polygon', name: f?.properties?.name || 'Объект GeoJSON', color: '#22d3ee', ring: g.coordinates[0].map((c: number[]) => ({ lat: c[1], lng: c[0] })) });
    } else if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      vectors.push({ kind: 'line', name: f?.properties?.name || 'Линия GeoJSON', color: '#22d3ee', ring: g.coordinates.map((c: number[]) => ({ lat: c[1], lng: c[0] })) });
    }
  }
  if (!bbox) {
    let mn: BBox4 = [Infinity, Infinity, -Infinity, -Infinity];
    let any = false;
    walkGeoJsonPositions(obj, (lng, lat) => { any = true; mn = [Math.min(mn[0], lng), Math.min(mn[1], lat), Math.max(mn[2], lng), Math.max(mn[3], lat)]; });
    if (!any) return { ok: false, error: 'GeoJSON: нет ни bbox, ни координат' };
    bbox = mn;
  }
  return { ok: true, bbox, vectors };
}

// ─── MBTiles (SQLite) ───────────────────────────────────────────────────────

/** Минимальный читалка SQLite: страница 1 → header + таблица metadata (ключ→значение TEXT) */
export function readMbtilesMetadata(buf: ArrayBuffer): Record<string, string> | null {
  try {
    const u8 = new Uint8Array(buf);
    const sig = String.fromCharCode(...u8.slice(0, 16));
    if (!sig.startsWith('SQLite format 3')) return null;
    const pageSize = new DataView(buf).getUint16(16, false) || 4096;
    const meta: Record<string, string> = {};
    // Прямой поиск пар ключ/значение в pages таблицы metadata
    // (полный B-tree parser избыточен: metadata хранит короткие ASCII-строки).
    const text = new TextDecoder('latin1').decode(u8.slice(0, Math.min(u8.length, pageSize * 8)));
    const known = ['name', 'version', 'type', 'format', 'bounds', 'minzoom', 'maxzoom', 'description', 'attribution'];
    for (const k of known) {
      const idx = text.indexOf(k);
      if (idx < 0) continue;
      // значение следует сразу за ключом в записи cell (varint length перед каждым TEXT)
      const after = text.slice(idx + k.length, idx + k.length + 200);
      const m = after.match(/^([\x20-\x7e]{1,180})/);
      if (m && m[1].length > 0 && !known.includes(m[1])) meta[k] = m[1];
    }
    return Object.keys(meta).length ? meta : null;
  } catch {
    return null;
  }
}

export function parseMbtilesGeoref(buf: ArrayBuffer):
  { ok: true; bbox: BBox4; zoomRange: { min: number; max: number }; name: string } |
  { ok: false; error: string } {
  const meta = readMbtilesMetadata(buf);
  if (!meta) return { ok: false, error: 'MBTiles: не найден заголовок "SQLite format 3"' };
  const b = (meta.bounds || '').split(',').map(parseFloat);
  if (b.length !== 4 || !b.every(Number.isFinite)) return { ok: false, error: 'MBTiles: отсутствует/битый metadata bounds (min_lon,min_lat,max_lon,max_lat)' };
  const min = parseInt(meta.minzoom ?? '0', 10);
  const max = parseInt(meta.maxzoom ?? '14', 10);
  return { ok: true, bbox: [b[0], b[1], b[2], b[3]], zoomRange: { min: isNaN(min) ? 0 : min, max: isNaN(max) ? 14 : max }, name: meta.name || 'MBTiles слой' };
}

// ─── Растровые изображения (PNG/JPEG/TIFF) + EXIF-GPS / world-file ─────────

/** JFGCIE/EXIF-style world comment: "WorldFile=[w, s, e, n]" или "bounds=w,s,e,n" */
export function extractImageGeorefComment(buf: ArrayBuffer): BBox4 | null {
  try {
    const u8 = new Uint8Array(buf);
    const head = new TextDecoder('latin1').decode(u8.slice(0, Math.min(u8.length, 65536)));
    const m = head.match(/(?:WorldFile|GEOTIFF_BOUNDS|BOUNDS)\s*=\s*([-\d.eE+]+)[,\s]+([-\d.eE+]+)[,\s]+([-\d.eE+]+)[,\s]+([-\d.eE+]+)/i);
    if (!m) return null;
    const v = m.slice(1, 5).map(parseFloat);
    return v.every(Number.isFinite) ? [v[0], v[1], v[2], v[3]] as BBox4 : null;
  } catch { return null; }
}

/** PNG IHDR размер */
export function readPngSize(buf: ArrayBuffer): { width: number; height: number } | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 24) return null;
  if (dv.getUint32(0, false) !== 0x89504e47) return null;
  return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
}

/** JPEG SOF0/SOF2 размер */
export function readJpegSize(buf: ArrayBuffer): { width: number; height: number } | null {
  const u8 = new Uint8Array(buf);
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < u8.length) {
    if (u8[off] !== 0xff) { off++; continue; }
    const marker = u8[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (u8[off + 5] << 8) | u8[off + 6], width: (u8[off + 7] << 8) | u8[off + 8] };
    }
    const len = (u8[off + 2] << 8) | u8[off + 3];
    off += 2 + len;
  }
  return null;
}

/** Авто-детект формата по содержимому (магические числа / текст) */
export function detectTacticalMapFormat(buf: ArrayBuffer, fileName = ''): 'geotiff' | 'png' | 'jpeg' | 'kml' | 'kmz' | 'geojson' | 'mbtiles' | 'unknown' {
  const u8 = new Uint8Array(buf.slice(0, 64));
  const dv = new DataView(buf);
  const name = fileName.toLowerCase();
  if (u8[0] === 0x49 && u8[1] === 0x49 && dv.getUint16(2, true) === 42) return 'geotiff';
  if (u8[0] === 0x4d && u8[1] === 0x4d && dv.getUint16(2, false) === 42) return 'geotiff';
  if (u8[0] === 0x89 && u8[1] === 0x50) return 'png';
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'jpeg';
  if (u8[0] === 0x50 && u8[1] === 0x4b) return 'kmz';
  if (String.fromCharCode(...u8.slice(0, 15)).startsWith('SQLite format 3')) return 'mbtiles';
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(u8).trimStart();
  if (headText.startsWith('<')) return /<kml/i.test(headText) ? 'kml' : 'unknown';
  if (headText.startsWith('{') || headText.startsWith('[')) {
    try { const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 1 << 20))))); if (j?.type) return 'geojson'; } catch { /* partial */ }
    if (headText.includes('"type"') || headText.includes('"features"')) return 'geojson';
  }
  if (name.endsWith('.tif') || name.endsWith('.tiff')) return 'geotiff';
  if (name.endsWith('.kml')) return 'kml';
  if (name.endsWith('.kmz')) return 'kmz';
  if (name.endsWith('.geojson') || name.endsWith('.json')) return 'geojson';
  if (name.endsWith('.mbtiles')) return 'mbtiles';
  if (name.endsWith('.png')) return 'png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpeg';
  return 'unknown';
}
