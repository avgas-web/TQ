// Интеграционные тесты единой точки входа loadUserMapFile и смежных хелперов.
// geotiff.js и sql.js мокаются (WASM в jsdom недоступен), форматы файлов
// собираются реальными байтами/архивами (JSZip для KMZ).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import {
  loadUserMapFile, loadGeoTiff, readMbtilesSummary, decodeMbtilesTilesForRender,
  closeMbtilesDbCache, featureToScreenPts, layerWorldRect, pointFracInLayer,
  parseGeoJsonText, bboxFromFeatures, geoJsonGeometryToFeatures,
} from '../src/utils/userMapLoader';
import * as loader from '../src/utils/userMapLoader';

// geotiff.js (WASM/Node-полифиллы) полностью мокается на уровне модуля
vi.mock('geotiff', () => ({
  GeoTIFF: {
    fromArrayBuffer: async (_buf: ArrayBuffer) => ({
      getImage: async () => ({
        getWidth: () => 4,
        getHeight: () => 2,
        samplesPerPixel: 3,
        fileDirectory: {
          34735: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 3857],
          34264: [1, 0, 0, 37, 0, 1, 0, 56, 0, 0, 1, 0],
        },
        readRasters: async () => new Uint8Array(4 * 2 * 3),
      }),
    }),
  },
}));

/** Файл-двойник с text()/arrayBuffer() — jsdom-File в этом окружении их не предоставляет */
function mkFile(name: string, data: BlobPart): File {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  return {
    name, size: bytes.length, type: '',
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Мини-реализация sql.js API для fake-БД */
function makeFakeSql() {
  const calls: string[] = [];
  class FakeDb {
    constructor(public data: Uint8Array) {}
    exec(sql: string): { values: any[][] }[] {
      calls.push(sql);
      if (/FROM metadata WHERE name/.test(sql)) return [{ values: [['37,55,38,56']] }];
      if (/SELECT name, value FROM metadata/.test(sql)) {
        return [{ values: [['name', 'sat-base'], ['bounds', '37,55,38,56'], ['format', 'png']] }];
      }
      if (/COUNT\(\*\)/.test(sql)) return [{ values: [[7]] }];
      if (/MIN\(zoom_level\)/.test(sql)) return [{ values: [[0, 5]] }];
      if (/tile_data/.test(sql)) return [{ values: [[PNG_BYTES]] }];
      return [];
    }
    free() { calls.push('FREE'); }
  }
  return { SQL: { Database: FakeDb }, calls };
}

function mbArrayBuffer(): ArrayBuffer {
  return new Uint8Array([1, 2, 3, 4]).buffer;
}

/** Мок canvas/ImageData: putImageData/toDataURL без реального кодирования PNG */
function mockCanvas() {
  class Ctx {
    putImageData() {}
  }
  HTMLCanvasElement.prototype.getContext = function () { return new Ctx(); } as any;
  HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };
  if (typeof (globalThis as any).ImageData === 'undefined') {
    (globalThis as any).ImageData = class ImageDataMock {
      data: Uint8ClampedArray; width: number; height: number;
      constructor(data: Uint8ClampedArray, w: number, h: number) { this.data = data; this.width = w; this.height = h; }
    };
  }
}

/** FileReader-двойник: jsdom не принимает наш File-дабл как Blob */
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    void file;
    setTimeout(() => { this.result = 'data:image/png;base64,AAAA'; this.onload?.(); }, 0);
  }
}

/** Мок sql.js на уровне модуля (для путей без инъекции initSqlJs) */
function mockSqlModule(SQL: any) {
  vi.doMock('sql.js', () => ({ default: async () => SQL, initSqlJs: async () => SQL }));
}

beforeEach(() => {
  mockCanvas();
  vi.stubGlobal('FileReader', FakeFileReader);
  // Image в jsdom не загружает data URL — эмулируем мгновенный onload с размерами
  vi.spyOn(globalThis, 'Image').mockImplementation(function (this: any) {
    const img: any = {
      naturalWidth: 8, naturalHeight: 4, width: 8, height: 4, onload: null, onerror: null,
    };
    Object.defineProperty(img, 'src', {
      set(v: string) { void v; setTimeout(() => img.onload?.(), 0); },
      get() { return ''; },
    });
    return img;
  } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeMbtilesDbCache();
});

describe('loadUserMapFile: GeoJSON / KML', () => {
  const gj = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { name: 'ADIZ-1' }, geometry: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]]] } }],
  });

  it('geojson -> векторный слой с bbox и meta', async () => {
    const layer = await loadUserMapFile(mkFile('zone.geojson', gj), { author: 'штаб', newId: () => 'ID1' });
    expect(layer.kind).toBe('vector');
    expect(layer.format).toBe('geojson');
    expect(layer.id).toBe('ID1');
    expect(layer.features).toHaveLength(1);
    expect(layer.bbox).toEqual({ west: 37, south: 55, east: 38, north: 56 });
    expect(layer.meta.name).toBe('zone');
    expect(layer.meta.author).toBe('штаб');
    expect(layer.meta.sourceFormat).toBe('geojson');
    expect(layer.visible).toBe(true);
    expect(layer.opacity).toBe(0.85);
  });

  it('maxFeatures ограничивает число элементов', async () => {
    const many = JSON.stringify({
      type: 'FeatureCollection',
      features: Array.from({ length: 10 }, (_, i) => ({
        type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [37 + i * 0.01, 55] },
      })),
    });
    const layer = await loadUserMapFile(mkFile('pts.json', many), { maxFeatures: 3 });
    expect(layer.features!.length).toBeLessThanOrEqual(3);
  });

  it('пустой FeatureCollection -> ошибка', async () => {
    const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
    await expect(loadUserMapFile(mkFile('empty.geojson', empty))).rejects.toThrow(/не содержит геометрических объектов/);
  });

  it('битый JSON -> понятная ошибка', async () => {
    await expect(loadUserMapFile(mkFile('bad.geojson', '{oops'))).rejects.toThrow();
  });

  it('kml -> векторный слой, meta из Document', async () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Разведка</name><author>Оператор</author>
      <Placemark><name>Цель</name><Point><coordinates>37.5,55.5,0</coordinates></Point></Placemark></Document></kml>`;
    const layer = await loadUserMapFile(mkFile('recon.kml', kml));
    expect(layer.kind).toBe('vector');
    expect(layer.features).toHaveLength(1);
    expect(layer.meta.name).toBe('Разведка');
    expect(layer.meta.author).toBe('Оператор');
  });

  it('kml без Placemark -> ошибка', async () => {
    await expect(loadUserMapFile(mkFile('x.kml', '<kml><Document/></kml>')))
      .rejects.toThrow(/KML не содержит/);
  });

  it('kmz -> распаковка JSZip и разбор внутреннего KML', async () => {
    const zip = new JSZip();
    zip.file('doc.kml', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>KMZ-слой</name>'
      + '<Placemark><LineString><coordinates>37,55,0 38,56,0</coordinates></LineString></Placemark></Document></kml>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const layer = await loadUserMapFile(mkFile('pack.kmz', bytes));
    expect(layer.format).toBe('kmz');
    expect(layer.features![0].geometry.kind).toBe('line');
    expect(layer.meta.name).toBe('KMZ-слой');
  });

  it('kmz без .kml внутри -> ошибка', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'нет карты');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(loadUserMapFile(mkFile('junk.kmz', bytes))).rejects.toThrow(/не содержит \.kml/);
  });

  it('неподдерживаемое расширение -> UnsupportedMapFormatError', async () => {
    await expect(loadUserMapFile(mkFile('notes.txt', 'x'))).rejects.toThrow(/Неподдерживаемый формат/);
  });
});

describe('loadUserMapFile: GeoTIFF (geotiff.js замокан)', () => {
  it('встроенная привязка -> растр с bbox WGS-84, EPSG:3857, calibration', async () => {
    const progress: any[] = [];
    const part = await loadGeoTiff(new Uint8Array([1, 2, 3]).buffer, { onProgress: (p) => progress.push(p) });
    expect(part.kind).toBe('raster');
    expect(part.format).toBe('geotiff');
    expect(part.projection).toBe('EPSG:3857');
    expect(part.imageWidth).toBe(4);
    expect(part.imageHeight).toBe(2);
    expect(part.calibration?.method).toBe('geotransform');
    // encode может сообщаться дважды: общий прогресс декодирования + финальная упаковка PNG
    expect(progress.map((p) => p.phase)).toEqual(['parse', 'decode', 'encode', 'encode', 'done']);
    // GeoTIFF отдаёт bbox уже в WGS-84 (EPSG:3857 -> 4326 при чтении привязки).
    // Матрица 34264 задаёт шаг 1 ед. CRS на пиксель, размер превью 4x2 px:
    // west/south = origin (37, 56), east = west + width, north = south + height.
    expect(part.bbox!.west).toBeCloseTo(37, 10);
    expect(part.bbox!.south).toBeCloseTo(56, 10);
    expect(part.bbox!.east).toBeCloseTo(37 + 4, 10);
    expect(part.bbox!.north).toBeCloseTo(56 + 2, 10);
  });

  it('сквозной путь loadUserMapFile(.tif)', async () => {
    const layer = await loadUserMapFile(mkFile('ortho.tif', new Uint8Array([1])), { name: 'Снимок-7' });
    expect(layer.kind).toBe('raster');
    expect(layer.meta.name).toBe('Снимок-7');
    expect(layer.imageDataUrl).toBeTruthy();
  });
});

describe('loadUserMapFile: MBTiles (sql.js инъектируется/мокается)', () => {
  it('readMbtilesSummary через fake initSqlJs: meta/bounds/zooms/format', async () => {
    const { SQL } = makeFakeSql();
    const progress: any[] = [];
    const s = await readMbtilesSummary(mbArrayBuffer(), async () => SQL, (p) => progress.push(p));
    expect(s.tileCount).toBe(7);
    expect(s.minZoom).toBe(0);
    expect(s.maxZoom).toBe(5);
    expect(s.format).toBe('png');
    expect(s.name).toBe('sat-base');
    expect(s.bounds).toEqual({ west: 37, south: 55, east: 38, north: 56 });
    expect(progress.length).toBeGreaterThanOrEqual(2);
  });

  it('битая БД (exec бросает) -> пустые метаданные, без падения', async () => {
    class BadDb {
      exec() { throw new Error('no such table'); }
      free() {}
    }
    const s = await readMbtilesSummary(mbArrayBuffer(), async () => ({ Database: BadDb }));
    expect(s.tileCount).toBe(0);
    expect(s.bounds).toBeNull();
  });

  it('сквозной путь loadUserMapFile(.mbtiles): sourceBlob + tileInfo + ленивый декодер', async () => {
    const { SQL } = makeFakeSql();
    mockSqlModule(SQL);
    const mod = await import('../src/utils/userMapLoader');
    const layer = await mod.loadUserMapFile(mkFile('base.mbtiles', new Uint8Array([1, 2])), { name: 'Легенда' });
    expect(layer.kind).toBe('raster');
    expect(layer.format).toBe('mbtiles');
    expect(layer.tileInfo).toEqual({ minZoom: 0, maxZoom: 5, format: 'png' });
    expect(layer.sourceBlob).toBeInstanceOf(ArrayBuffer);
    expect(layer.meta.name).toBe('Легенда');
    // декод тайлов по требованию (тот же кэш-буфер)
    const decoded = await mod.decodeMbtilesTilesForRender(layer.sourceBlob!, ['2/1/1']);
    expect(decoded['2/1/1'].startsWith('data:image/png;base64,')).toBe(true);
    vi.doUnmock('sql.js');
  });

  it('MBTiles без тайлов -> ошибка загрузки', async () => {
    class EmptyDb {
      exec(sql: string) {
        if (/COUNT\(\*\)/.test(sql)) return [{ values: [[0]] }];
        if (/MIN\(zoom_level\)/.test(sql)) return [{ values: [[0, 0]] }];
        if (/FROM metadata WHERE name/.test(sql)) return [];
        if (/SELECT name, value FROM metadata/.test(sql)) return [{ values: [['name', 'empty']] }];
        return [];
      }
      free() {}
    }
    mockSqlModule({ Database: EmptyDb });
    const mod = await import('../src/utils/userMapLoader');
    await expect(mod.loadUserMapFile(mkFile('empty.mbtiles', new Uint8Array([1])), { name: 'X' }))
      .rejects.toThrow(/не содержит тайлов/);
  });

  it('decodeMbtilesTilesForRender переиспользует кэш БД по ссылке буфера', async () => {
    const { SQL, calls } = makeFakeSql();
    mockSqlModule(SQL);
    const buf = mbArrayBuffer();
    const r1 = await decodeMbtilesTilesForRender(buf, ['0/0/0']);
    const r2 = await decodeMbtilesTilesForRender(buf, ['1/1/1']);
    expect(Object.keys(r1)).toEqual(['0/0/0']);
    expect(Object.keys(r2)).toEqual(['1/1/1']);
    expect(calls.filter((c) => c !== 'FREE').length).toBe(2); // два запроса на одном db
    closeMbtilesDbCache();
    expect(calls).toContain('FREE');
    vi.doUnmock('sql.js');
  });
});

describe('loadUserMapFile: растр PNG/JPG с ручной привязкой', () => {
  const corners = {
    topLeft: [56, 37] as [number, number], topRight: [56, 38] as [number, number],
    bottomLeft: [55, 37] as [number, number], bottomRight: [55, 38] as [number, number],
  };

  it('без calibration -> требование 4 углов', async () => {
    await expect(loadUserMapFile(mkFile('shot.png', PNG_BYTES)))
      .rejects.toThrow(/4 угловые точки/);
  });

  it('с calibration -> bbox + method manual + imageDataUrl', async () => {
    const layer = await loadUserMapFile(mkFile('shot.jpg', PNG_BYTES), { calibration: corners });
    expect(layer.kind).toBe('raster');
    expect(layer.format).toBe('image');
    expect(layer.imageWidth).toBe(8);
    expect(layer.imageHeight).toBe(4);
    expect(layer.calibration?.method).toBe('manual');
    expect(layer.imageDataUrl.startsWith('data:')).toBe(true);
  });

  it('перевёрнутая привязка отклоняется', async () => {
    const flipped = {
      topLeft: [55, 37] as [number, number], topRight: [55, 38] as [number, number],
      bottomLeft: [56, 37] as [number, number], bottomRight: [56, 38] as [number, number],
    };
    await expect(loadUserMapFile(mkFile('flip.png', PNG_BYTES), { calibration: flipped }))
      .rejects.toThrow(/перевёрнут/);
  });
});

describe('Хелперы слоя: экранные пересчёты', () => {
  it('featureToScreenPts: кольца и точки -> пиксели канваса', () => {
    const f = geoJsonGeometryToFeatures(
      { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]]] }, 'p', 'X')[0];
    const worldPx = 256 * Math.pow(2, 6);
    const pts = featureToScreenPts(f, worldPx, 0, 0);
    expect(pts.kind).toBe('polygon');
    expect(pts.rings[0]).toHaveLength(5);
    expect(pts.rings[0][0].x).toBeGreaterThan(0);
    expect(Number.isFinite(pts.rings[0][0].y)).toBe(true);
  });

  it('layerWorldRect / pointFracInLayer согласованы с bbox', () => {
    const { features, bbox } = parseGeoJsonText(JSON.stringify({
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56], [37, 55]]] },
    }));
    const layer: any = { id: 'L', kind: 'vector', format: 'geojson', visible: true, opacity: 1, features, bbox: bbox! };
    const rect = layerWorldRect(layer);
    expect(rect.x0).toBeLessThan(rect.x1);
    expect(rect.y0).toBeLessThan(rect.y1);
    const frac = pointFracInLayer(layer, 55.5, 37.5);
    expect(frac.fx).toBeCloseTo(0.5, 6);
    expect(frac.fy).toBeGreaterThan(0);
    expect(frac.fy).toBeLessThan(1);
  });

  it('bboxFromFeatures: пустой список -> null', () => {
    expect(bboxFromFeatures([])).toBeNull();
  });
});
