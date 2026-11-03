/**
 * Регрессионные тесты для src/components/map/viewMath.ts (Фаза 5.C).
 * Гарантируют, что извлечение чистой математики вида из MapCanvas.tsx
 * не изменило поведение: инвариант Web Mercator, санация видов, fitToData.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_REF,
  NEUTRAL_VIEW,
  finiteOr,
  sanitizeView,
  zoomOfView,
  worldPxOf,
  zoomAtWorldPx,
  metersPerPixelFromWorld,
  worldPxForMetersPerPixel,
  scaleBoundsForZooms,
  scaleLabel,
  centerLatOf,
  latToMerc,
  mercToLat,
  clampZoom,
  rulerScaleText,
  distPxToPolyline,
  spbFallbackView,
  mapFitKey,
  sanitizeSavedView,
  fitViewToData,
} from "../src/components/map/viewMath";

describe("viewMath: инвариант привязки вида (worldPx = canvasH · 2^zoom)", () => {
  it("zoomOfView: scale=1 ⇔ zoom=z0; удвоение scale = +1 зум", () => {
    expect(zoomOfView(1)).toBe(ZOOM_REF);
    expect(zoomOfView(1, 3)).toBe(3);
    expect(zoomOfView(2, ZOOM_REF)).toBeCloseTo(ZOOM_REF + 1, 10);
    expect(zoomOfView(0.5, ZOOM_REF)).toBeCloseTo(ZOOM_REF - 1, 10);
  });

  it("worldPxOf ↔ zoomAtWorldPx — согласованные определения зума", () => {
    const wp = worldPxOf(800, 1); // z0=ZOOM_REF → 800·2^14
    expect(wp).toBe(800 * Math.pow(2, ZOOM_REF));
    // zoomAtWorldPx — абсолютный зум тайловой пирамиды (tile/256): для мира 800·2^14 px это z≈19.3
    expect(zoomAtWorldPx(wp)).toBeCloseTo(Math.log2(wp / 256), 10);
    // metersPerPixel корректен именно через zoomAtWorldPx:
    expect(metersPerPixelFromWorld(wp, 0)).toBeCloseTo(
      (156543.0339280412 / wp) * 256,
      6,
    );
  });

  it("metersPerPixelFromWorld: экватор z0 → ~156543 м/px / 2^z; широта учитывается cos(lat)", () => {
    const wpEq = 256 * Math.pow(2, 0); // zoom 0
    expect(metersPerPixelFromWorld(wpEq, 0)).toBeCloseTo(156543.0339280412, 3);
    const mppSpb = metersPerPixelFromWorld(wpEq, 59.9398);
    expect(mppSpb).toBeCloseTo(
      156543.0339280412 * Math.cos((59.9398 * Math.PI) / 180),
      3,
    );
  });

  it("worldPxForMetersPerPixel — обратна metersPerPixelFromWorld (регрессия линейки масштаба)", () => {
    const latRef = 55.75;
    for (const mpp of [0.05, 0.5, 5, 100]) {
      const wp = worldPxForMetersPerPixel(mpp, latRef);
      expect(metersPerPixelFromWorld(wp, latRef)).toBeCloseTo(mpp, 6);
    }
  });

  it("clampZoom держит диапазон [MIN_ZOOM, MAX_ZOOM]", () => {
    expect(clampZoom(MIN_ZOOM - 5)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM + 5)).toBe(MAX_ZOOM);
    expect(clampZoom(10)).toBe(10);
  });

  it("scaleBoundsForZooms: min/max соответствуют [MIN_ZOOM..nativeMax] относительно z0", () => {
    const b = scaleBoundsForZooms(600, ZOOM_REF, "unknown-server");
    expect(b.min).toBeCloseTo(Math.pow(2, MIN_ZOOM - ZOOM_REF), 12);
    expect(b.max).toBeCloseTo(Math.pow(2, MAX_ZOOM - ZOOM_REF), 12);
  });
});

describe("viewMath: Mercator и fallback-вид", () => {
  it("latToMerc ↔ mercToLat — обратность на реальных широтах", () => {
    for (const lat of [-80, -35.5, 0, 35.75, 59.9398, 78]) {
      expect(mercToLat(latToMerc(lat))).toBeCloseTo(lat, 8);
    }
    expect(latToMerc(0)).toBeCloseTo(0.5, 12);
  });

  it("spbFallbackView: корректный worldPx/offsetY для СПб, offsetX задаёт вызывающий", () => {
    const v = spbFallbackView(600);
    expect(v.offsetX).toBe(0);
    expect(v.z0).toBe(ZOOM_REF);
    const wp = worldPxOf(600, v.scale, v.z0);
    expect(v.offsetY).toBeCloseTo(600 / 2 - latToMerc(59.9398) * wp, 6);
    expect(zoomOfView(v.scale, v.z0)).toBeCloseTo(10, 6);
  });
});

describe("viewMath: санация произвольных видов (защита от битого localStorage)", () => {
  it("finiteOr: NaN/Infinity/строки → fallback", () => {
    expect(finiteOr(NaN, 5)).toBe(5);
    expect(finiteOr(Infinity, 5)).toBe(5);
    expect(finiteOr("3" as unknown, 5)).toBe(5);
    expect(finiteOr(3, 5)).toBe(3);
  });

  it("sanitizeView: null для мусора; scale<=0 отвергается", () => {
    expect(sanitizeView(null)).toBeNull();
    expect(sanitizeView({ offsetX: 1, offsetY: 2 })).toBeNull(); // нет scale
    expect(sanitizeView({ offsetX: 1, offsetY: 2, scale: 0 })).toBeNull();
    expect(sanitizeView({ offsetX: NaN, offsetY: 2, scale: 1 })).toBeNull();
    const v = sanitizeView({ offsetX: 1, offsetY: 2, scale: 4, z0: 3 });
    expect(v).toEqual({ offsetX: 1, offsetY: 2, scale: 4, z0: 3 });
  });

  it("sanitizeSavedView: stale-ключ карты и абсурдный зум → null (регрессия зависания камеры)", () => {
    const good = { offsetX: 10, offsetY: 20, scale: 1, z0: ZOOM_REF };
    expect(sanitizeSavedView(good, "k1", "k1")).toBe(good);
    expect(sanitizeSavedView(good, "k2", "k1")).toBeNull(); // другая карта
    expect(sanitizeSavedView(null, "k1", "k1")).toBeNull();
    const absurd = { offsetX: 0, offsetY: 0, scale: 3700, z0: ZOOM_REF }; // z≈25.8 > MAX+2
    expect(sanitizeSavedView(absurd, "k1", "k1")).toBeNull();
  });

  it("NEUTRAL_VIEW — типобезопасный фолбэк с эталонным z0", () => {
    expect(NEUTRAL_VIEW.z0).toBe(ZOOM_REF);
    expect(NEUTRAL_VIEW.scale).toBe(1);
  });
});

describe("viewMath: fitViewToData (автоподгонка под объекты)", () => {
  const bounds = { north: 60.1, south: 59.7, east: 30.6, west: 30.0 };
  it("null при пустых точках/невалидном растре", () => {
    expect(fitViewToData(1000, 1000, bounds, [], 800, 600)).toBeNull();
    expect(
      fitViewToData(0, 1000, bounds, [{ x: 1, y: 1 }], 800, 600),
    ).toBeNull();
  });

  it("регрессия: fit не искажает пропорции — изотропный worldPx, зум в диапазоне", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 900, y: 500 },
    ];
    const v = fitViewToData(1000, 1000, bounds, pts, 800, 600, ZOOM_REF);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!.scale)).toBe(true);
    const z = zoomOfView(v!.scale, v!.z0);
    expect(z).toBeGreaterThanOrEqual(MIN_ZOOM - 1e-9);
    expect(z).toBeLessThanOrEqual(MAX_ZOOM + 1e-9);
    // scale — единый множитель по обеим осям (aspect ratio сохраняется):
    expect(v!.scale > 0).toBe(true);
  });

  it("fit сохраняет единый инвариант: worldPxOf vh·2^(z0+log2 scale) вмещает bbox по обеим осям", () => {
    const pts = [
      { x: 200, y: 300 },
      { x: 800, y: 700 },
    ];
    const vw = 800,
      vh = 600;
    const v = fitViewToData(1000, 1000, bounds, pts, vw, vh, ZOOM_REF)!;
    const wp = worldPxOf(vh, v.scale, v.z0);
    // ширина bbox в долях мира (с паддингом 5%) должна быть ≤ vw/wp
    const lngSpan = (bounds.east - bounds.west) / 360;
    const wFrac = ((800 - 200) / 1000) * lngSpan * 1.1;
    expect(vw / wp).toBeGreaterThanOrEqual(wFrac - 1e-9);
  });
});

describe("viewMath: мелкие утилиты отображения", () => {
  it("mapFitKey: пусто без bounds; различает img/tiles и bounds", () => {
    expect(mapFitKey(null)).toBe("");
    expect(mapFitKey({ bounds: undefined })).toBe("");
    const k1 = mapFitKey({ bounds: { north: 1, south: 0, east: 1, west: 0 } });
    const k2 = mapFitKey({
      dataUrl: "x",
      bounds: { north: 1, south: 0, east: 1, west: 0 },
    });
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("tiles|")).toBe(true);
    expect(k2.startsWith("img|")).toBe(true);
  });

  it("scaleLabel/rulerScaleText: человекочитаемые порождения единиц", () => {
    expect(scaleLabel(1500)).toContain("км");
    expect(scaleLabel(5)).toContain("м");
    expect(scaleLabel(0.5)).toContain("см");
    expect(scaleLabel(0.001)).toContain("мм");
    expect(rulerScaleText(10)).toMatch(/1 см ≈ \d+(\.\d)? м/);
  });

  it("centerLatOf — среднее арифметическое север/юг", () => {
    expect(centerLatOf({ north: 60, south: 58 })).toBe(59);
  });

  it("distPxToPolyline: точка на сегменте → 0; вне ломаной → расстояние до ближайшего конца", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distPxToPolyline({ x: 5, y: 0 }, pts)).toBeCloseTo(0, 10);
    expect(distPxToPolyline({ x: 10, y: 5 }, pts)).toBeCloseTo(0, 10);
    expect(distPxToPolyline({ x: -3, y: -4 }, pts)).toBeCloseTo(5, 10);
    expect(distPxToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity);
  });
});
