// Юнит-тесты парсеров пользовательских тактических карт (userMapLoader).
import { describe, it, expect } from 'vitest';
import {
  detectFormat, ACCEPT_EXTENSIONS, UnsupportedMapFormatError,
  geoJsonGeometryToFeatures, parseGeoJsonText, bboxFromFeatures,
  parseKmlText, readGeoKeys, projectionFromEpsg, geotiffBounds, toRgba,
  bytesToBase64, MBTILES_SQL, parseMbtilesBounds, tmsToYxyz, mbtilesTileRow,
  tileBytesToDataUrl, extractMbtilesTiles, calibrateImageLayer,
} from '../src/utils/userMapLoader';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('detectFormat / ACCEPT_EXTENSIONS', () => {
  it('распознаёт все заявленные форматы (в т.ч. регистр и точки)', () => {
    expect(detectFormat('zone.geojson')).toBe('geojson');
    expect(detectFormat('data.JSON')).toBe('geojson');
    expect(detectFormat('route.kml')).toBe('kml');
    expect(detectFormat('archive.KMZ')).toBe('kmz');
    expect(detectFormat('ortho.tif')).toBe('geotiff');
    expect(detectFormat('ortho.tiff')).toBe('geotiff');
    expect(detectFormat('base.mbtiles')).toBe('mbtiles');
    expect(detectFormat('photo.PNG')).toBe('image');
    expect(detectFormat('photo.jpg')).toBe('image');
    expect(detectFormat('photo.jpeg')).toBe('image');
  });

  it('неизвестное расширение/без расширения -> null', () => {
    expect(detectFormat('notes.txt')).toBeNull();
    expect(detectFormat('README')).toBeNull();
    expect(detectFormat('')).toBeNull();
  });

  it('ACCEPT_EXTENSIONS покрывает требования ТЗ', () => {
    for (const ext of ['.geojson', '.json', '.kml', '.kmz', '.tif', '.tiff', '.mbtiles', '.png', '.jpg']) {
      expect(ACCEPT_EXTENSIONS).toContain(ext);
    }
  });

  it('UnsupportedMapFormatError — с именем класса', () => {
    const e = new UnsupportedMapFormatError('x.xyz');
    expect(e.name).toBe('UnsupportedMapFormatError');
    expect(e.message).toContain('x.xyz');
    expect(e instanceof Error).toBe(true);
  });
});

describe('GeoJSON: геометрия -> фичи (WGS-84 [lat,lng])', () => {
  it('Polygon с дыркой: кольца + индексы holes', () => {
    const geom = {
      type: 'Polygon',
      coordinates: [
        [[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]],   // внешний
        [[37.4, 55.4], [37.6, 55.4], [37.6, 55.6], [37.4, 55.6], [37.4, 55.4]], // дырка
      ],
    };
    const fs = geoJsonGeometryToFeatures(geom, 'p1', 'ADIZ-1');
    expect(fs).toHaveLength(1);
    expect(fs[0].geometry.kind).toBe('polygon');
    expect(fs[0].geometry.rings).toHaveLength(2);
    expect(fs[0].geometry.holes).toEqual([1]);
    // координаты развёрнуты в [lat,lng]
    expect(fs[0].geometry.rings[0][0]).toEqual([55, 37]);
    expect(fs[0].name).toBe('ADIZ-1');
  });

  it('Point/MultiPoint/LineString/MultiLineString', () => {
    expect(geoJsonGeometryToFeatures({ type: 'Point', coordinates: [37.6, 55.7] }, 'a')[0].geometry.points)
      .toEqual([[55.7, 37.6]]);
    expect(geoJsonGeometryToFeatures({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, 'b')[0]
      .geometry.points).toEqual([[2, 1], [4, 3]]);
    expect(geoJsonGeometryToFeatures({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 'c')[0]
      .geometry.rings).toEqual([[[0, 0], [1, 1]]]);
    const ml = geoJsonGeometryToFeatures({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2]]] }, 'd');
    // короткое кольцо (<2 точек) отбрасывается
    expect(ml[0].geometry.rings).toHaveLength(1);
  });

  it('MultiPolygon: плоский список колец всех полигонов с holes; GeometryCollection рекурсивен', () => {
    const mp = geoJsonGeometryToFeatures({
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]], [[2.4, 2.4], [2.6, 2.4], [2.5, 2.6], [2.4, 2.4]]],
      ],
    }, 'm');
    // внешние кольца обоих полигонов + кольцо-дыра второго => 3 кольца, дыра под индексом 2
    expect(mp[0].geometry.rings).toHaveLength(3);
    expect(mp[0].geometry.holes).toEqual([2]);
    const gc = geoJsonGeometryToFeatures({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [1, 1] }, { type: 'Point', coordinates: [2, 2] }],
    }, 'g');
    expect(gc).toHaveLength(2);
  });

  it('мусор/неизвестный тип -> пусто', () => {
    expect(geoJsonGeometryToFeatures(null, 'x')).toEqual([]);
    expect(geoJsonGeometryToFeatures({ type: 'Bogus' }, 'x')).toEqual([]);
    expect(geoJsonGeometryToFeatures({ type: 'Polygon', coordinates: [] }, 'x')).toEqual([]);
  });

  it('parseGeoJsonText: FeatureCollection со свойствами name/color', () => {
    const text = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'Район удара', color: '#ff0000' },
        geometry: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 55]]] },
      }],
    });
    const { features, bbox } = parseGeoJsonText(text);
    expect(features).toHaveLength(1);
    expect(features[0].name).toBe('Район удара');
    expect(features[0].color).toBe('#ff0000');
    expect(bbox).toEqual(expect.objectContaining({ north: 56, south: 55, east: 38, west: 37 }));
  });

  it('parseGeoJsonText: битый JSON и неизвестный верхний уровень -> понятная ошибка', () => {
    expect(() => parseGeoJsonText('{oops')).toThrow(/GeoJSON повреждён/);
    expect(() => parseGeoJsonText('{"hello":1}')).toThrow(/не распознан тип/);
  });

  it('bboxFromFeatures: пустой список -> null', () => {
    expect(bboxFromFeatures([])).toBeNull();
  });
});

describe('KML: DOMParser-парсинг', () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
 <Document>
  <name>План сектора</name>
  <Style id="s1"><PolyStyle><color>80ff0000</color></PolyStyle><LineStyle><color>ff00ccff</color></LineStyle></Style>
  <Placemark>
   <name>Зона ПВО</name>
   <styleUrl>#s1</styleUrl>
   <Polygon>
    <outerBoundaryIs><LinearRing><coordinates>37,55,0 38,55,0 38,56,0 37,55,0</coordinates></LinearRing></outerBoundaryIs>
   </Polygon>
  </Placemark>
  <Placemark>
   <name>Курс</name>
   <LineString><coordinates>37.1,55.1,0 37.9,55.9,0</coordinates></LineString>
   <Point><coordinates>37.5,55.5,100</coordinates></Point>
  </Placemark>
 </Document>
</kml>`;

  it('извлекает полигон/линию/точку и метаданные Document', () => {
    const { features, bbox, meta } = parseKmlText(kml);
    expect(meta.name).toBe('План сектора');
    expect(features.length).toBeGreaterThanOrEqual(3);
    const poly = features.find((f) => f.geometry.kind === 'polygon')!;
    expect(poly.name).toBe('Зона ПВО');
    // aabbggrr -> #rrggbb: fill 80ff0000 -> #0000ff? (b=00,g=00,r=ff) => #ff0000? нет: slice(6,8)=ff...
    expect(poly.color).toMatch(/^#[0-9a-f]{6}$/);
    // lng,lat -> [lat,lng]
    expect(poly.geometry.rings[0][0]).toEqual([55, 37]);
    const line = features.find((f) => f.geometry.kind === 'line')!;
    expect(line.geometry.rings[0]).toHaveLength(2);
    const pt = features.find((f) => f.geometry.kind === 'point')!;
    expect(pt.geometry.points).toEqual([[55.5, 37.5]]);
    expect(bbox!.north).toBeCloseTo(56, 5);
  });

  it('битый XML -> ошибка с текстом', () => {
    expect(() => parseKmlText('<kml><unclosed>')).toThrow(/KML повреждён/);
  });

  it('пустой KML без Placemark -> пустые фичи', () => {
    const r = parseKmlText('<kml><Document><name>x</name></Document></kml>');
    expect(r.features).toHaveLength(0);
    expect(r.bbox).toBeNull();
  });
});

describe('GeoTIFF: GeoKeys и привязка', () => {
  it('readGeoKeys разбирает GeoKeyDirectory', () => {
    // Формат записи: [key_id, flag_type, count, value_or_offset]
    const gkd = [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 2048, 0, 1, 4326, 3072, 0, 1, 32663];
    expect(readGeoKeys(gkd)).toEqual({ modelType: 1, rasterType: 1, geographic: 4326, projected: 32663 });
    expect(readGeoKeys(undefined)).toEqual({});
    expect(readGeoKeys([1, 1])).toEqual({});
  });

  it('projectionFromEpsg: 4326/3857/UTM', () => {
    expect(projectionFromEpsg(4326)).toBe('EPSG:4326');
    expect(projectionFromEpsg(3857)).toBe('EPSG:3857');
    expect(projectionFromEpsg(32663)).toBe('EPSG:3857');
    expect(projectionFromEpsg(undefined)).toBe('EPSG:4326');
  });

  it('geotiffBounds через ModelPixelScale+ModelTiepoint (EPSG:4326)', () => {
    const md = {
      ModelTiepoint: [0, 0, 0, 37.0, 56.0, 0],
      ModelPixelScale: [0.01, 0.01, 0],
    };
    const r = geotiffBounds(100, 200, md)!;
    expect(r).not.toBeNull();
    close(r.bounds.west, 37.0);
    close(r.bounds.east, 38.0);
    close(r.bounds.north, 56.0);
    close(r.bounds.south, 54.0);
    const p = r.toCrs(50, 100);
    close(p[0], 37.5); close(p[1], 55.0);
  });

  it('geotiffBounds через ModelTransformation (метрическая сетка)', () => {
    // X = 400000 + 10·col, Y = 7500000 − 10·row
    const tr = [10, 0, 0, 400000, 0, -10, 0, 7500000, 0, 0, 1, 0, 0, 0, 0, 1];
    const r = geotiffBounds(100, 100, { ModelTransformation: tr })!;
    close(r.bounds.west, 400000);
    close(r.bounds.east, 401000);
    close(r.bounds.north, 7500000);
    close(r.bounds.south, 7499000);
  });

  it('без тегов привязки -> null (нужна ручная калибровка)', () => {
    expect(geotiffBounds(10, 10, {})).toBeNull();
  });

  it('toRgba достраивает альфу из RGB и Gray', () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6]); // 2 пикселя RGB
    const out = toRgba(rgb, 2, 1, 3);
    expect(Array.from(out)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    const gray = toRgba(new Uint8Array([9, 8]), 2, 1, 1);
    expect(Array.from(gray)).toEqual([9, 9, 9, 255, 8, 8, 8, 255]);
  });
});

describe('MBTiles: SQL, TMS-flip, байты тайлов', () => {
  it('MBTILES_SQL содержит обязательные запросы', () => {
    expect(MBTILES_SQL.metadata).toContain('FROM metadata');
    expect(MBTILES_SQL.count).toContain('FROM tiles');
    expect(MBTILES_SQL.zooms).toMatch(/MIN\(zoom_level\).*MAX\(zoom_level\)/s);
  });

  it('parseMbtilesBounds: "west,south,east,north"', () => {
    expect(parseMbtilesBounds('37,55,38,56')).toEqual({ west: 37, south: 55, east: 38, north: 56 });
    expect(parseMbtilesBounds('bad')).toBeNull();
    expect(parseMbtilesBounds('37,55,38')).toBeNull();
    expect(parseMbtilesBounds(undefined)).toBeNull();
  });

  it('tmsToYxyz / mbtilesTileRow: flip по строке', () => {
    expect(tmsToYxyz(0, 0)).toBe(0);
    expect(tmsToYxyz(2, 0)).toBe(3);
    expect(tmsToYxyz(2, 3)).toBe(0);
    expect(mbtilesTileRow('2/1/3')).toEqual({ z: 2, x: 1, yTms: 0 });
    expect(mbtilesTileRow('junk')).toBeNull();
    expect(mbtilesTileRow('2/-1/0')).toBeNull();
  });

  it('tileBytesToDataUrl определяет PNG/JPEG по magic bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x0e, 0x00, 0x00, 0x00, 0x0d]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]);
    expect(tileBytesToDataUrl(png).startsWith('data:image/png;base64,')).toBe(true);
    expect(tileBytesToDataUrl(jpg).startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(tileBytesToDataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'jpg').startsWith('data:image/jpeg')).toBe(true);
  });

  it('extractMbtilesTiles: fake-db, кэш-ключ XYZ, пропуск пустых строк', () => {
    // Ключи fake-db — строки TMS (tile_row), как их отдаёт sql.js: XYZ y=0 -> TMS y=3 на z=2
    const rows: Record<string, Uint8Array | undefined> = {
      '2/1/3': new Uint8Array([0x89, 0x50, 1, 2, 3, 4, 5, 6]),
      '2/1/0': undefined, // нет тайла
    };
    const db = {
      exec(sql: string) {
        const m = /zoom_level = (\d+) AND tile_column = (\d+) AND tile_row = (\d+)/.exec(sql);
        if (!m) return [];
        const key = `${m[1]}/${m[2]}/${m[3]}`;
        const v = rows[key];
        return v ? [{ values: [[v]] }] : [{ values: [] }];
      },
    };
    const out = extractMbtilesTiles(db as any, ['2/1/0', '2/1/3', 'bad/key'], 'png');
    expect(Object.keys(out)).toEqual(['2/1/0']);
    expect(out['2/1/0'].startsWith('data:image/png')).toBe(true);
  });
});

describe('bytesToBase64', () => {
  it('совпадает с btoa на ASCII и бинарных данных', () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(bytesToBase64(data)).toBe(btoa('Hello'));
    const bin = new Uint8Array([0, 128, 255, 64, 32]);
    const manual = Buffer.from(bin).toString('base64');
    expect(bytesToBase64(bin)).toBe(manual);
    expect(bytesToBase64(new Uint8ClampedArray([1, 2, 3]))).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });
});

describe('calibrateImageLayer: ручная привязка по 4 углам', () => {
  const ok = {
    topLeft: [56, 37] as [number, number], topRight: [56, 38] as [number, number],
    bottomLeft: [55, 37] as [number, number], bottomRight: [55, 38] as [number, number],
  };
  it('корректная привязка -> bbox + EPSG:4326', () => {
    const r = calibrateImageLayer('shot.png', 1000, 1000, ok);
    expect(r.bbox).toEqual({ north: 56, south: 55, east: 38, west: 37 });
    expect(r.projection).toBe('EPSG:4326');
  });
  it('несогласованные углы (перевёрнутая привязка) -> ошибка', () => {
    // Верхние углы южнее нижних — билинейный центр не попадает в bbox: отклоняем такую привязку
    const bad = {
      topLeft: [55, 37] as [number, number], topRight: [55, 38] as [number, number],
      bottomLeft: [56, 37] as [number, number], bottomRight: [56, 38] as [number, number],
    };
    expect(() => calibrateImageLayer('bad.png', 100, 100, bad)).toThrow(/перевёрнут, центр вне границ/);
  });
});
