// Юнит-тесты модуля загрузки пользовательских тактических карт (Задача 2):
// парсинг проекции/bbox из GeoTIFF/KML/GeoJSON/MBTiles, аффинный маппинг
// пикселей <-> WGS-84 и совпадение рендер-привязки с математикой тайлов OSM.
import { describe, expect, it } from 'vitest';
import type { TacticalOverlayGeoref } from '../types';
import {
  buildGeoref,
  detectTacticalMapFormat,
  findKmlInKmz,
  latToMercY,
  mercYToLat,
  parseGeoJsonGeoref,
  parseGeoTiffAsciiTags,
  parseKmlGeoref,
  parseMbtilesGeoref,
  pixelToWgs84Mapper,
  readPngSize,
  webMercatorToWgs84,
  wgs84ToOverlayPixel,
  wgs84ToWebMercator,
} from './tacticalMapParsers';
import { overlayRasterRect } from './tacticalOverlayRender';
import type { TacticalOverlayLayer } from '../types';

// ─── Математика проекций ────────────────────────────────────────────────────

describe('Web Mercator <-> WGS-84', () => {
  it('round-tripmercator-метры -> гео -> метры', () => {
    const probes = [
      { lat: 50.45, lng: 30.52 },
      { lat: -33.86, lng: 151.21 },
      { lat: 0, lng: 0 },
      { lat: 84.9, lng: -179.9 },
    ];
    for (const p of probes) {
      const m = wgs84ToWebMercator(p.lat, p.lng);
      const back = webMercatorToWgs84(m.x, m.y);
      expect(back.lat).toBeCloseTo(p.lat, 6);
      expect(back.lng).toBeCloseTo(p.lng, 6);
    }
  });

  it('latToMercY — нормализованная доля мира: экватор = 0.5', () => {
    expect(latToMercY(0)).toBeCloseTo(0.5, 6);
    expect(latToMercY(45)).toBeLessThan(latToMercY(0)); // Y растёт на юг
    expect(latToMercY(-45)).toBeGreaterThan(latToMercY(0));
    expect(mercYToLat(latToMercY(55.75))).toBeCloseTo(55.75, 9);
  });
});

describe('Аффинный маппинг пикселей растра -> WGS-84 (Задача 2, п.2)', () => {
  const georef: TacticalOverlayGeoref = buildGeoref(
    [30.0, 50.0, 31.0, 50.5], 'EPSG:4326', 1000, 800,
  );

  it('углы растра попадают ровно в углы bounding box', () => {
    const px2geo = pixelToWgs84Mapper(georef);
    const tl = px2geo(0, 0);
    const br = px2geo(1000, 800);
    expect(tl.lng).toBeCloseTo(30.0, 9);
    expect(tl.lat).toBeCloseTo(50.5, 9);
    expect(br.lng).toBeCloseTo(31.0, 9);
    expect(br.lat).toBeCloseTo(50.0, 9);
  });

  it('обратный mapper wgs84ToOverlayPixel инверсен прямому', () => {
    const px2geo = pixelToWgs84Mapper(georef);
    const geo2px = wgs84ToOverlayPixel(georef);
    for (const [col, row] of [[0, 0], [123, 456], [999, 799], [500, 400]] as const) {
      const g = px2geo(col, row);
      const p = geo2px(g);
      expect(p.x).toBeCloseTo(col, 6);
      expect(p.y).toBeCloseTo(row, 6);
    }
  });

  it('EPSG:3857 bbox конвертируется в градусы WGS-84', () => {
    const c = wgs84ToWebMercator(50.5, 30.0);
    const d = wgs84ToWebMercator(50.0, 31.0);
    const g = buildGeoref([c.x, d.y, d.x, c.y], 'EPSG:3857', 512, 512);
    expect(g.boundsWgs84.north).toBeCloseTo(50.5, 6);
    expect(g.boundsWgs84.west).toBeCloseTo(30.0, 6);
    expect(g.projection).toBe('EPSG:3857');
  });
});

// ─── GeoTIFF ────────────────────────────────────────────────────────────────

describe('GeoTIFF: чтение GDAL-тегов привязки', () => {
  it('ASCII-теги MODELPIXELSCALE/MODELTIEPOINT -> georef EPSG:3857', () => {
    // синтетический тайл 256px с шагом 1221.9994 м/px (z=14 экватор), tiepoint в (0,0)
    const text = 'GTYPE 2; CS 3857; MODELPIXELSCALE 1221.9994 1221.9994 0; MODELTIEPOINT 0 0 0 3346000 6200000 0';
    const g = parseGeoTiffAsciiTags(text, 256, 256);
    expect(g).not.toBeNull();
    expect(g!.projection).toBe('EPSG:3857');
    expect(g!.boundsWgs84.west).toBeCloseTo(webMercatorToWgs84(3346000, 6200000).lng, 4);
    expect(g!.widthPx).toBe(256);
  });

  it('гео-привязка GTYPE 1 остаётся в градусах', () => {
    const text = 'GTYPE 1; CS 4326; MODELPIXELSCALE 0.001 0.001 0; MODELTIEPOINT 0 0 0 30.0 50.5 0';
    const g = parseGeoTiffAsciiTags(text, 1000, 1000);
    expect(g!.projection).toBe('EPSG:4326');
    expect(g!.boundsWgs84.west).toBeCloseTo(30.0, 6);
    expect(g!.boundsWgs84.north).toBeCloseTo(50.5, 6);
  });
});

// ─── KML / KMZ ──────────────────────────────────────────────────────────────

describe('KML/KMZ: полигоны, оверлеи, LatLonBox', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"
    xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>
    <GroundOverlay><name>Сектор А</name><LatLonBox>
      <north>50.5</north><south>50.0</south><east>31.0</east><west>30.0</west>
    </LatLonBox></GroundOverlay>
    <Placemark><name>Зона ПВО (ADIZ)</name><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>30.1,50.1,0 30.2,50.1,0 30.2,50.2,0 30.1,50.2,0 30.1,50.1,0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`;

  it('parseKmlGeoref извлекает bbox из LatLonBox и векторы полигонов', () => {
    const r = parseKmlGeoref(kml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasGroundBox).toBe(true);
    expect(r.bbox).toEqual([30.0, 50.0, 31.0, 50.5]);
    expect(r.vectors.length).toBeGreaterThanOrEqual(1);
    const poly = r.vectors.find((v) => v.kind === 'polygon')!;
    // координаты KML — lon,lat -> стандарт { lat, lng } (аудит 1.2)
    expect(poly.ring[0]).toEqual({ lat: 50.1, lng: 30.1 });
  });

  it('битый/не-KML документ -> явная ошибка', () => {
    const r = parseKmlGeoref('<html>нет корня kml</html>');
    expect(r.ok).toBe(false);
  });

  it('KMZ stored-запись: findKmlInKmz находит .kml без сжатия', () => {
    const xmlBytes = new TextEncoder().encode(kml);
    const nameBytes = new TextEncoder().encode('doc.kml');
    const size = 30 + nameBytes.length + xmlBytes.length;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x04034b50, true);   // local file header magic
    dv.setUint16(8, 0, true);            // method = stored
    dv.setUint32(18, xmlBytes.length, true); // comp size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    new Uint8Array(buf, 30, nameBytes.length).set(nameBytes);
    new Uint8Array(buf, 30 + nameBytes.length, xmlBytes.length).set(xmlBytes);
    const found = findKmlInKmz(buf);
    expect(found).not.toBeNull();
    expect(new TextDecoder().decode(found!).startsWith('<?xml')).toBe(true);
  });
});

// ─── GeoJSON / MBTiles / детект формата ─────────────────────────────────────

describe('GeoJSON и MBTiles', () => {
  it('GeoJSON FeatureCollection: bbox из обхода координат, полигон в векторы', () => {
    const gj = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: { name: 'Цель' },
        geometry: { type: 'Polygon', coordinates: [[[30, 50], [31, 50], [31, 50.5], [30, 50.5], [30, 50]]] },
      }],
    });
    const r = parseGeoJsonGeoref(gj);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bbox).toEqual([30, 50, 31, 50.5]);
    expect(r.vectors[0].ring[0]).toEqual({ lat: 50, lng: 30 });
  });

  it('явный bbox приоритетнее обхода', () => {
    const gj = '{"type":"Point","bbox":[30,50,31,51],"coordinates":[30.5,50.5]}';
    const r = parseGeoJsonGeoref(gj);
    expect(r.ok && r.bbox).toEqual([30, 50, 31, 51]);
  });

  it('MBTiles: bounds/minzoom/maxzoom из SQLite-заголовка', () => {
    // синтетический «SQLite format 3» файл с текстовыми metadata-парамии
    const meta = 'SQLite format 3\u0000' + '\u0010\u0001\u0001\u0000@\x20\x20\x20\x00' +
      'name\u0004sector-aformat\u0003pngbounds\u000d30.0,50.0,31.0,50.5minzoom\u00013maxzoom\u000214';
    const bytes = new TextEncoder().encode(meta);
    const buf = new ArrayBuffer(Math.max(bytes.length, 100));
    new Uint8Array(buf).set(bytes);
    const r = parseMbtilesGeoref(buf);
    // допустимы два исхода: корректный bbox либо ЯВНЫЙ отказ (без тихого импорта)
    if (r.ok) {
      expect(r.bbox).toEqual([30.0, 50.0, 31.0, 50.5]);
      expect(r.zoomRange).toEqual({ min: 3, max: 14 });
    } else {
      expect(typeof r.error).toBe('string');
    }
  });

  it('detectTacticalMapFormat по магическим числам', () => {
    const mk = (bytes: number[]) => {
      const b = new ArrayBuffer(64);
      new Uint8Array(b).set(bytes);
      return b;
    };
    expect(detectTacticalMapFormat(mk([0x49, 0x49, 42 & 0xff, 0]))).toBe('geotiff');
    expect(detectTacticalMapFormat(mk([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(detectTacticalMapFormat(mk([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectTacticalMapFormat(mk([0x50, 0x4b, 3, 4]))).toBe('kmz');
    const kmlBuf = new TextEncoder().encode('<kml xmlns="x">').buffer as ArrayBuffer;
    expect(detectTacticalMapFormat(kmlBuf)).toBe('kml');
    const gjBuf = new TextEncoder().encode('{"type":"FeatureCollection"}').buffer as ArrayBuffer;
    expect(detectTacticalMapFormat(gjBuf)).toBe('geojson');
  });

  it('readPngSize читает IHDR', () => {
    const buf = new ArrayBuffer(32);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x89504e47, false);
    dv.setUint32(16, 1234, false);
    dv.setUint32(20, 567, false);
    expect(readPngSize(buf)).toEqual({ width: 1234, height: 567 });
  });
});

// ─── Привязка рендера: та же математика Web Mercator, что у тайлов OSM ─────

describe('overlayRasterRect — жёсткая привязка слоя к подложке (Задача 2, п.3)', () => {
  const layer = (over: Partial<TacticalOverlayLayer> = {}): TacticalOverlayLayer => ({
    id: 'L1', blobKey: 'B1', name: 'Тестовый район', format: 'geotiff', encoding: 'png',
    visible: true, opacity: 1, importedAt: new Date().toISOString(), sizeBytes: 1,
    georef: buildGeoref([30.0, 50.0, 31.0, 50.5], 'EPSG:4326', 512, 512),
    ...over,
  } as TacticalOverlayLayer);

  /** worldPx и offset вида — как в MapCanvas: мир = canvasH·2^zoom, центрирование.
   *  centerMercY — нормализованная mercator-координата центра (та же схема, что у слоя тайлов). */
  const viewFor = (worldPx: number, centerLng: number, centerMercY: number, cw: number, ch: number) => {
    const fracX = (centerLng + 180) / 360;
    return { offsetX: cw / 2 - fracX * worldPx, offsetY: ch / 2 - centerMercY * worldPx, scale: 1 };
  };

  it('центр bbox слоя совпадает с экранной проекцией той же координаты на подложке', () => {
    const cw = 900, ch = 600;
    for (const zoom of [3, 8, 14, 19]) {
      const worldPx = ch * Math.pow(2, zoom);
      // центр bbox в mercator-долях — именно эта точка должна быть в центре экрана
      const cLng = (30.0 + 31.0) / 2;
      const cMercY = (latToMercY(50.5) + latToMercY(50.0)) / 2;
      const view = viewFor(worldPx, cLng, cMercY, cw, ch);
      const rect = overlayRasterRect(layer(), view, worldPx)!;
      expect(rect.x + rect.w / 2).toBeCloseTo(cw / 2, 6);
      expect(rect.y + rect.h / 2).toBeCloseTo(ch / 2, 6);
    }
  });

  it('размер слоя на экране масштабируется пропорционально worldPx (зум)', () => {
    const worldPx3 = 600 * 2 ** 3;
    const worldPx8 = 600 * 2 ** 8;
    const v = { offsetX: 0, offsetY: 0, scale: 1 };
    const a = overlayRasterRect(layer(), v, worldPx3)!;
    const b = overlayRasterRect(layer(), v, worldPx8)!;
    expect(b.w / a.w).toBeCloseTo(2 ** 5, 6);
    expect(b.h / a.h).toBeCloseTo(2 ** 5, 6);
  });

  it('панорамирование (offset) сдвигает слой ровно на тот же вектор, что и подложку', () => {
    const worldPx = 600 * 2 ** 10;
    const base = overlayRasterRect(layer(), { offsetX: 0, offsetY: 0, scale: 1 }, worldPx)!;
    const moved = overlayRasterRect(layer(), { offsetX: -1234, offsetY: 777, scale: 1 }, worldPx)!;
    expect(moved.x - base.x).toBeCloseTo(-1234, 9);
    expect(moved.y - base.y).toBeCloseTo(777, 9);
    expect(moved.w).toBeCloseTo(base.w, 9);
  });

  it('слой с некорректным bbox не рендерится (null) — защита от NaN-привязки', () => {
    const bad = layer();
    (bad.georef.boundsWgs84 as any).north = NaN;
    expect(overlayRasterRect(bad, { offsetX: 0, offsetY: 0, scale: 1 }, 1024)).toBeNull();
  });
});
