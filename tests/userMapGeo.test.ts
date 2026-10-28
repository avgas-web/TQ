// Юнит-тесты Mercator-геометрии пользовательских тактических карт.
import { describe, it, expect } from 'vitest';
import {
  tileBounds, lngToWorldX, worldXToLng, lngLatToWorldFrac,
  wgs84ToEpsg3857, epsg3857ToWgs84, detectProjection, normalizeBoundsToWgs84,
  clampBounds, isValidBounds, boundsToWorldRect, worldRectToBounds, bboxFromPoints,
  geoToFracInBounds, fracInBoundsToGeo, geoToCanvasPx, canvasPxToGeo,
  boundsFromCorners, pixelToGeoByCorners, tiepointMapper, transformationMapper,
  MAX_MERC_LAT, EPSG_3857, EPSG_4326,
} from '../src/utils/userMapGeo';
import { latToMercatorY } from '../src/utils/googleMaps';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('userMapGeo: базовые Mercator-преобразования', () => {
  it('lngToWorldX/worldXToLng — обратные', () => {
    close(lngToWorldX(-180), 0);
    close(lngToWorldX(0), 0.5);
    close(lngToWorldX(180), 0); // оборачивается на 0 (замкнутый мир)
    close(worldXToLng(0.25), -90);
    for (const lng of [-175.3, -42.1, 7.9, 123.4]) close(worldXToLng(lngToWorldX(lng)), lng, 1e-9);
  });

  it('lngLatToWorldFrac использует ту же формулу, что MapCanvas (latToMercatorY)', () => {
    const f = lngLatToWorldFrac(37.6, 55.75); // Москва
    close(f.x, (37.6 + 180) / 360);
    close(f.y, latToMercatorY(55.75));
    close(latToMercatorY(0), 0.5);
  });

  it('wgs84 <-> epsg3857 обратимы и совпадают с эталоном', () => {
    const p = wgs84ToEpsg3857(55.75, 37.6);
    // Эталон: x = R·λ_rad, y = R·ln(tan(π/4 + φ/2)), R = 6378137
    close(p.x, 4185612.85, 1);
    close(p.y, 7508807.85, 1);
    const back = epsg3857ToWgs84(p.x, p.y);
    close(back.lat, 55.75, 1e-6);
    close(back.lng, 37.6, 1e-6);
  });
});

describe('userMapGeo: проекция и границы', () => {
  it('detectProjection различает градусы и метры', () => {
    expect(detectProjection({ north: 56, south: 55, east: 38, west: 37 })).toBe(EPSG_4326);
    expect(detectProjection({ north: 7e6, south: 6.8e6, east: 4.5e6, west: 4.3e6 })).toBe(EPSG_3857);
  });

  it('normalizeBoundsToWgs84 переводит 3857-метры в lat/lng без смещения центра', () => {
    // bbox Москвы (55.6..55.9 N, 37.5..37.7 E) в метрах EPSG:3857
    const src = { north: 7536177, south: 7484367, east: 4196825, west: 4174600 };
    const w = normalizeBoundsToWgs84(src);
    close((w.north + w.south) / 2, 55.75, 0.01);
    close((w.east + w.west) / 2, 37.6, 0.01);
    expect(w.north).toBeGreaterThan(w.south);
    expect(w.east).toBeGreaterThan(w.west);
  });

  it('clampBounds режет запредельные значения, isValidBounds ловит мусор', () => {
    const c = clampBounds({ north: 200, south: -200, east: 500, west: -500 });
    expect(c.north).toBeLessThanOrEqual(MAX_MERC_LAT);
    expect(c.south).toBeGreaterThanOrEqual(-MAX_MERC_LAT);
    expect(isValidBounds(c)).toBe(true);
    expect(isValidBounds({ north: 10, south: 20, east: 1, west: 2 })).toBe(false);
    expect(isValidBounds(null)).toBe(false);
    expect(isValidBounds({ north: NaN, south: 1, east: 2, west: 0 })).toBe(false);
  });

  it('boundsToWorldRect/worldRectToBounds — круг', () => {
    const b = { north: 56, south: 55, east: 38, west: 37 };
    const r = boundsToWorldRect(b);
    expect(r.x1).toBeGreaterThan(r.x0);
    expect(r.y1).toBeGreaterThan(r.y0); // y растёт к югу в mercator
    const back = worldRectToBounds(r);
    close(back.north, b.north, 1e-6);
    close(back.south, b.south, 1e-6);
    close(back.east, b.east, 1e-6);
    close(back.west, b.west, 1e-6);
  });

  it('bboxFromPoints: пустой -> null; вырожденный расширяется', () => {
    expect(bboxFromPoints([])).toBeNull();
    const p = bboxFromPoints([[55.7, 37.6], [55.7, 37.6]]);
    expect(p).not.toBeNull();
    expect(p!.north - p!.south).toBeGreaterThan(0);
    expect(p!.east - p!.west).toBeGreaterThan(0);
  });
});

describe('userMapGeo: доли внутри слоя и экран', () => {
  const bbox = { north: 56, south: 55, east: 38, west: 37 };

  it('geoToFracInBounds/fracInBoundsToGeo — обратные, fy по меркатору', () => {
    close(geoToFracInBounds(bbox, 56, 37).fx, 0);
    close(geoToFracInBounds(bbox, 56, 37).fy, 0);
    close(geoToFracInBounds(bbox, 55, 38).fx, 1);
    close(geoToFracInBounds(bbox, 55, 38).fy, 1);
    const mid = geoToFracInBounds(bbox, 55.5, 37.5);
    // центр по широте НЕ 0.5 в меркаторе (проекция искажает) — проверяем обратимость
    const g = fracInBoundsToGeo(bbox, mid.fx, mid.fy);
    close(g.lat, 55.5, 1e-9);
    close(g.lng, 37.5, 1e-9);
  });

  it('geoToCanvasPx/canvasPxToGeo — круг при произвольном offset/zoom', () => {
    const worldPx = 256 * Math.pow(2, 12);
    const off = { x: -12345.6, y: 6789.4 };
    const p = geoToCanvasPx(48.85, 2.35, worldPx, off.x, off.y);
    const g = canvasPxToGeo(p.x, p.y, worldPx, off.x, off.y);
    close(g.lat, 48.85, 1e-6);
    close(g.lng, 2.35, 1e-6);
  });
});

describe('userMapGeo: ручная привязка по 4 углам', () => {
  const corners = {
    topLeft: [56.0, 37.0] as [number, number],
    topRight: [56.0, 38.0] as [number, number],
    bottomLeft: [55.0, 37.0] as [number, number],
    bottomRight: [55.0, 38.0] as [number, number],
  };

  it('boundsFromCorners даёт bbox углов', () => {
    const b = boundsFromCorners(corners);
    expect(b).toEqual({ north: 56, south: 55, east: 38, west: 37 });
  });

  it('pixelToGeoByCorners: углы и центр изображения', () => {
    const tl = pixelToGeoByCorners(0, 0, 1000, 800, corners);
    close(tl.lat, 56); close(tl.lng, 37);
    const br = pixelToGeoByCorners(1000, 800, 1000, 800, corners);
    close(br.lat, 55); close(br.lng, 38);
    const c = pixelToGeoByCorners(500, 400, 1000, 800, corners);
    close(c.lat, 55.5); close(c.lng, 37.5);
  });
});

describe('userMapGeo: GeoTIFF-привязка', () => {
  it('tiepointMapper: ModelTiepoint+PixelScale (EPSG:4326, север вверх)', () => {
    // пиксель (0,0) = (30.0, 60.0) в CRS; scale 0.01 град/px
    const toCrs = tiepointMapper([[0, 0, 0, 30.0, 60.0, 0]], [0.01, 0.01, 0]);
    const a = toCrs(0, 0);
    close(a[0], 30.0); close(a[1], 60.0);
    const b = toCrs(100, 200);
    close(b[0], 31.0);   // x растёт с колонкой
    close(b[1], 58.0);   // y падает со строкой (север вверх)
  });

  it('transformationMapper читает ModelTransformation 4x4 row-major', () => {
    // X = 1000·col + 0·row + 400000 ; Y = 0·col − 1000·row + 7500000
    const m = [1000, 0, 0, 400000, 0, -1000, 0, 7500000, 0, 0, 1, 0, 0, 0, 0, 1];
    const toCrs = transformationMapper(m);
    const a = toCrs(0, 0);
    close(a[0], 400000); close(a[1], 7500000);
    const b = toCrs(10, 20);
    close(b[0], 410000); close(b[1], 7480000);
  });

  it('tileBounds: тайл z1/x0/y0 — западное полушарие, корректный mercator flip', () => {
    const b = tileBounds(1, 0, 0)!;
    close(b.west, -180); close(b.east, 0);
    close(b.north, MAX_MERC_LAT, 1e-6);
    // y=1 (нумерация сверху вниз) -> lat = 0 ровно (экватор)
    close(b.south, 0, 1e-9);
    expect(b.north).toBeGreaterThan(b.south);
    // второй ряд тайлов того же квадранта уходит в южное полушарие
    close(tileBounds(1, 0, 1)!.north, 0, 1e-9);
    expect(tileBounds(1, 0, 1)!.south).toBeLessThan(0);
    expect(tileBounds(1, 2, 0)).toBeNull();  // x вне диапазона уровня
    expect(tileBounds(-1, 0, 0)).toBeNull(); // недопустимый z
    expect(tileBounds(NaN, 0, 0)).toBeNull();
  });
});
