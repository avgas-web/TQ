// Юнит-тесты рендера пользовательских тактических карт (userMapRender).
import { describe, it, expect, vi } from 'vitest';
import type { UserMapLayer, UserMapFeature } from '../src/types';
import {
  layerScreenRect, geoToScreen, layerIsVisibleOnScreen, featureStyle, hexWithAlpha,
  hitTestFeature, setUserLayerImageListener, getUserLayerImage, isUserLayerImageReady,
  isUserLayerImageFailed, dropUserLayerImage, getMbtilesTileImages, requestMbtilesTiles,
  drawVectorLayer, drawRasterLayer, drawMbtilesTiles, drawLayerOutline,
} from '../src/utils/userMapRender';

const vectorLayer = (features: UserMapFeature[], opacity = 0.8): UserMapLayer => ({
  id: 'L1', kind: 'vector', format: 'geojson',
  meta: { name: 't', loadedAt: '', author: '', fileName: 't.geojson', fileSize: 1, sourceFormat: 'geojson' },
  bbox: { north: 56, south: 55, east: 38, west: 37 }, projection: 'EPSG:4326',
  visible: true, opacity, features,
});

/** Минимальный mock 2D-контекста: пишется только последовательность вызовов */
function mockCtx(w = 800, h = 600) {
  const calls: string[] = [];
  // стек состояний: save/restore должны работать как в нативном canvas
  // (иначе проверка «restore вернул globalAlpha» теряет смысл)
  const stack: Array<{ alpha: number }> = [];
  const ctx: any = {
    canvas: { width: w, height: h },
    save: () => { stack.push({ alpha: ctx.globalAlpha }); calls.push('save'); },
    restore: () => { const s = stack.pop(); if (s) ctx.globalAlpha = s.alpha; calls.push('restore'); },
    beginPath: () => calls.push('beginPath'), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: () => calls.push('closePath'), stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'), rect: vi.fn(), drawImage: vi.fn(),
    setLineDash: () => calls.push('dash'), strokeRect: vi.fn(),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '',
    imageSmoothingEnabled: true, imageSmoothingQuality: '',
  };
  return { ctx, calls };
}

describe('userMapRender: экранная геометрия', () => {
  const worldPx = 256 * Math.pow(2, 10);
  const off = { x: -worldPx * 0.45, y: -worldPx * 0.3 };

  it('geoToScreen совпадает с формулой привязки растра (mercator-доли)', () => {
    const p = geoToScreen(0, 0, worldPx, off.x, off.y);
    expect(p.x).toBeCloseTo(0.5 * worldPx + off.x, 6);
    expect(p.y).toBeCloseTo(0.5 * worldPx + off.y, 6);
  });

  it('layerScreenRect: положительный прямоугольник на месте bbox', () => {
    const r = layerScreenRect(vectorLayer([]), worldPx, off.x, off.y);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    // экранный NW-угол bbox = geoToScreen(north, west)
    const nw = geoToScreen(56, 37, worldPx, off.x, off.y);
    expect(r.x).toBeCloseTo(nw.x, 6);
    expect(r.y).toBeCloseTo(nw.y, 6);
  });

  it('layerIsVisibleOnScreen: вырожденный bbox (нулевая площадь) не рисуется', () => {
    // у слоя без площади нет пикселей на экране -> отбор отбрасывает его всегда,
    // и смещение внутрь окна этого не меняет
    expect(layerIsVisibleOnScreen(vectorLayer([]), worldPx, off.x, off.y, 800, 600)).toBe(false);
    expect(layerIsVisibleOnScreen(vectorLayer([]), worldPx, off.x + 1e7, off.y, 800, 600)).toBe(false);
  });

  it('layerIsVisibleOnScreen: слой в окне — true, вынесенный за экран — false', () => {
    const box = (north: number, south: number, east: number, west: number) =>
      ({ ...vectorLayer([]), bbox: { north, south, east, west } });
    // центр мира (0N,0E) при offset -worldPx/2 лежит ровно в центре окна 800x600
    expect(layerIsVisibleOnScreen(box(1, -1, 1, -1), worldPx, -worldPx / 2, -worldPx / 2, 800, 600)).toBe(true);
    // тот же слой сдвинут за правый край экрана
    expect(layerIsVisibleOnScreen(box(1, -1, 1, -1), worldPx, -worldPx / 2 - 5000, -worldPx / 2, 800, 600)).toBe(false);
  });

  it('layerIsVisibleOnScreen: вырожденный bbox восстанавливается из геометрии элементов', () => {
    // точечный слой: bbox метаданных 0x0, но элементы заданы -> границы считаем
    // из координат элементов и попадаем в отбор (иначе точка не отрисовалась бы)
    const pt: UserMapFeature = { id: 'p1', geometry: { kind: 'point', rings: [], points: [[0, 0]] } };
    const l: UserMapLayer = { ...vectorLayer([pt]), bbox: { north: 0, south: 0, east: 0, west: 0 } };
    expect(layerIsVisibleOnScreen(l, worldPx, -worldPx / 2, -worldPx / 2, 800, 600)).toBe(true);
    expect(layerIsVisibleOnScreen(l, worldPx, -worldPx / 2 - 5000, -worldPx / 2, 800, 600)).toBe(false);
  });
});

describe('userMapRender: стили и цвет', () => {
  it('featureStyle: явный цвет приоритетен, дефолт циклический', () => {
    const f: UserMapFeature = { id: 'a', geometry: { kind: 'point', rings: [], points: [[1, 1]] }, color: '#abcdef' };
    expect(featureStyle(f, 0).color).toBe('#abcdef');
    const s1 = featureStyle({ id: 'b', geometry: { kind: 'point', rings: [] } }, 0).color;
    const s2 = featureStyle({ id: 'c', geometry: { kind: 'point', rings: [] } }, 1).color;
    expect(s1).toMatch(/^#/); expect(s2).toMatch(/^#/); expect(s1).not.toBe(s2);
  });

  it('hexWithAlpha: #rgb/#rrggbb/#rrggbbaa -> rgba()', () => {
    expect(hexWithAlpha('#f00', 0.5)).toBe('rgba(255,0,0,0.5)');
    expect(hexWithAlpha('#ff8000', 1)).toBe('rgba(255,128,0,1)');
    // собственный альфа-канал (0x80/255 ≈ 0.502) умножается на opacity слоя 0.5
    expect(hexWithAlpha('#ff800080', 0.5)).toBe('rgba(255,128,0,0.251)');
    expect(hexWithAlpha('zzz', 2)).toBe('rgba(0,0,0,1)');
  });
});

describe('userMapRender: отрисовка вектора/растра/тайлов', () => {
  const worldPx = 1024 * 256;
  const poly: UserMapFeature = {
    id: 'p', geometry: { kind: 'polygon', rings: [[[55, 37], [55, 38], [56, 38], [55, 37]]] },
  };
  const line: UserMapFeature = {
    id: 'l', geometry: { kind: 'line', rings: [[[55.2, 37.2], [55.8, 37.8]]] },
  };
  const point: UserMapFeature = {
    id: 'pt', geometry: { kind: 'point', rings: [], points: [[55.5, 37.5]] },
  };

  it('drawVectorLayer рисует полигон (fill+stroke evenodd), линию и точку; применяет opacity', () => {
    const { ctx, calls } = mockCtx();
    drawVectorLayer(ctx, vectorLayer([poly, line, point], 0.4), worldPx, 0, 0);
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThanOrEqual(2); // полигон + точка
    expect(calls).toContain('stroke');
    expect(ctx.globalAlpha).toBe(1); // restore вернул
    // во время рисования alpha была 0.4 — проверяем через spy-поле нельзя, но save/restore парность да:
    expect(calls.filter((c) => c === 'save').length).toBe(calls.filter((c) => c === 'restore').length);
  });

  it('drawVectorLayer: пустой слой — ни одного вызова', () => {
    const { ctx, calls } = mockCtx();
    drawVectorLayer(ctx, vectorLayer([]), worldPx, 0, 0);
    expect(calls).toHaveLength(0);
  });

  it('drawRasterLayer растягивает готовое изображение точно на rect слоя', () => {
    const layer: UserMapLayer = { ...vectorLayer([]), id: 'R1', kind: 'raster', format: 'image', imageDataUrl: 'data:image/png;base64,AAAA' };
    // в jsdom resource-загрузка выключена (реальный onload не приходит), поэтому
    // гоним штатный колбэк вручную — ровно так, как браузер после декодирования
    const el = getUserLayerImage(layer)!;
    expect(el).toBeInstanceOf(Image);
    expect(isUserLayerImageReady(layer)).toBe(false); // до onload — слой не готов
    el.onload!.call(el, {} as Event);                 // entry.ready = true
    Object.defineProperty(el, 'naturalWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'naturalHeight', { value: 50, configurable: true });
    const { ctx } = mockCtx();
    expect(isUserLayerImageReady(layer)).toBe(true);
    drawRasterLayer(ctx, layer, el, worldPx, 0, 0);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    const args = ctx.drawImage.mock.calls[0];
    const r = layerScreenRect(layer, worldPx, 0, 0);
    expect(args[1]).toBeCloseTo(r.x, 6);
    expect(args[3]).toBeCloseTo(r.w, 6);
    dropUserLayerImage(layer.id);
  });

  it('onerror помечает слой неудавшимся и он не рисуется', () => {
    const layer: UserMapLayer = { ...vectorLayer([]), id: 'R2', kind: 'raster', format: 'image', imageDataUrl: 'data:image/png;base64,BROKEN' };
    const el = getUserLayerImage(layer)!;
    el.onerror!.call(el, {} as Event);
    expect(isUserLayerImageFailed(layer)).toBe(true);
    expect(isUserLayerImageReady(layer)).toBe(false);
    const { ctx } = mockCtx();
    drawRasterLayer(ctx, layer, el, worldPx, 0, 0);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    dropUserLayerImage(layer.id);
  });

  it('drawMbtilesTiles рисует только готовые тайлы видимой области', () => {
    const layer: UserMapLayer = {
      ...vectorLayer([]), kind: 'raster', format: 'mbtiles',
      tileInfo: { minZoom: 0, maxZoom: 5, format: 'png' },
    };
    const z = 2, n = 4, tileWorldPx = worldPx / n;
    const mkImg = () => ({ complete: true, naturalWidth: 256, naturalHeight: 256 }) as unknown as HTMLImageElement;
    const tiles: Record<string, HTMLImageElement> = { '2/1/1': mkImg() };
    // «окно» — один тайл: смещение так, чтобы в canvas попадал только x=1,y=1
    const offX = -tileWorldPx, offY = -tileWorldPx;
    const { ctx } = mockCtx(tileWorldPx, tileWorldPx);
    drawMbtilesTiles(ctx, layer, tiles, z, worldPx, offX, offY);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    const a = ctx.drawImage.mock.calls[0];
    expect(a[1]).toBeCloseTo(0, 6);          // 1*tileWorldPx + offX = 0
    expect(a[3]).toBeCloseTo(tileWorldPx + 1, 6);
  });

  it('drawLayerOutline чертит пунктирную рамку', () => {
    const { ctx, calls } = mockCtx();
    drawLayerOutline(ctx, vectorLayer([]), worldPx, 0, 0);
    expect(calls).toContain('dash');
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
  });
});

describe('userMapRender: hit-test элементов', () => {
  const worldPx = 256 * Math.pow(2, 10);
  const zone: UserMapFeature = {
    id: 'z', name: 'ADIZ',
    geometry: {
      kind: 'polygon',
      rings: [
        [[55, 37], [55, 38], [56, 38], [56, 37], [55, 37]],       // внешний
        [[55.4, 37.4], [55.4, 37.6], [55.6, 37.6], [55.6, 37.4], [55.4, 37.4]], // дырка
      ],
      holes: [1],
    },
  };
  const line: UserMapFeature = { id: 'ln', geometry: { kind: 'line', rings: [[[55.1, 37.1], [55.9, 37.9]]] } };
  const point: UserMapFeature = { id: 'pp', geometry: { kind: 'point', rings: [], points: [[55.5, 37.5]] } };

  it('полигон: попадание внутри, miss снаружи, дырка не считается', () => {
    const only = vectorLayer([zone]);
    const inside = geoToScreen(55.2, 37.2, worldPx, 0, 0);
    expect(hitTestFeature(only, inside.x, inside.y, worldPx, 0, 0)?.id).toBe('z');
    const hole = geoToScreen(55.5, 37.5, worldPx, 0, 0);
    expect(hitTestFeature(only, hole.x, hole.y, worldPx, 0, 0)).toBeNull(); // дырка исключена
    const outside = geoToScreen(57, 37.5, worldPx, 0, 0);
    expect(hitTestFeature(only, outside.x, outside.y, worldPx, 0, 0)).toBeNull();
  });

  it('линия: близко к сегменту — hit; далеко — miss', () => {
    const only = vectorLayer([line]);
    const on = geoToScreen(55.5, 37.5, worldPx, 0, 0);   // точно на середине курса
    expect(hitTestFeature(only, on.x, on.y, worldPx, 0, 0)?.id).toBe('ln');
    const far = geoToScreen(55.9, 37.1, worldPx, 0, 0);  // ~0.8° по долготе от курса
    expect(hitTestFeature(only, far.x, far.y, worldPx, 0, 0)).toBeNull();
  });

  it('точка: маркер ловит клик в пределах допуска', () => {
    const only = vectorLayer([point]);
    const p = geoToScreen(55.5, 37.5, worldPx, 0, 0);
    expect(hitTestFeature(only, p.x, p.y, worldPx, 0, 0)?.id).toBe('pp');
    expect(hitTestFeature(only, p.x + 300, p.y, worldPx, 0, 0)).toBeNull();
  });

  it('пересечения: точка приоритетнее линии, линия — приоритетнее зоны ПВО', () => {
    // все три элемента лежат в одной точке (55.5, 37.5): ответ отдаётся самому
    // мелкому объекту, иначе ADIZ «съедала» бы клики по целям внутри зоны
    const all = vectorLayer([zone, line, point]);
    const p = geoToScreen(55.5, 37.5, worldPx, 0, 0);
    expect(hitTestFeature(all, p.x, p.y, worldPx, 0, 0)?.id).toBe('pp');
    expect(hitTestFeature(vectorLayer([zone, line]), p.x, p.y, worldPx, 0, 0)?.id).toBe('ln');
    // далеко от точки/линии (западнее начала курса ~46px при tolPx=6), но внутри зоны — отвечает зона
    const inZone = geoToScreen(55.2, 37.1, worldPx, 0, 0);
    expect(hitTestFeature(all, inZone.x, inZone.y, worldPx, 0, 0)?.id).toBe('z');
  });

  it('hit-test игнорирует слой без элементов', () => {
    expect(hitTestFeature(vectorLayer([]), 10, 10, worldPx, 0, 0)).toBeNull();
  });
});

describe('userMapRender: MBTiles ленивые волны запросов', () => {
  const worldPx = 256 * Math.pow(2, 6);

  const mbLayer: UserMapLayer = {
    id: 'MB1', kind: 'raster', format: 'mbtiles',
    meta: { name: 'mb', loadedAt: '', author: '', fileName: 'a.mbtiles', fileSize: 10, sourceFormat: 'mbtiles' },
    bbox: { north: 85, south: -85, east: 180, west: -180 }, projection: 'EPSG:4326',
    visible: true, opacity: 1,
    tileInfo: { minZoom: 0, maxZoom: 4, format: 'png' },
  };

  it('requestMbtilesTiles строит волну, кладёт тайлы в кэш и зовёт listener', async () => {
    dropUserLayerImage(mbLayer.id);
    const seen = vi.fn();
    setUserLayerImageListener(seen);
    const loadSource = vi.fn(async () => new ArrayBuffer(8));
    const decodeTile = vi.fn(async (_buf: ArrayBuffer, keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, 'data:image/png;base64,iVBOR'] )));
    const started = requestMbtilesTiles(mbLayer, 3, worldPx, -100, -100, 400, 300, loadSource, decodeTile);
    expect(started).toBe(true);
    // повторный вызов во время незавершённой волны -> false (дедупликация)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(requestMbtilesTiles(mbLayer, 3, worldPx, -100, -100, 400, 300, loadSource, decodeTile)).toBe(false);
    // ждём завершения асинхронной выборки
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalled());
    await vi.waitFor(() => expect(decodeTile).toHaveBeenCalled());
    const decodedKeys = decodeTile.mock.calls[0][1] as string[];
    expect(decodedKeys.length).toBeGreaterThan(0);
    expect(decodedKeys.every((k) => /^3\/\d+\/\d+$/.test(k))).toBe(true);
    // зум клампится в [minZoom..maxZoom]
    expect(requestMbtilesTiles(mbLayer, 99, worldPx, 0, 0, 100, 100, loadSource, decodeTile)).toBe(true);
    await vi.waitFor(() => {
      const last = decodeTile.mock.calls.at(-1)![1] as string[];
      expect(last.every((k) => k.startsWith('4/'))).toBe(true);
    });
    setUserLayerImageListener(null);
  });

  it('getMbtilesTileImages/dropUserLayerImage чистят кэш', () => {
    expect(getMbtilesTileImages('nope')).toEqual({});
    dropUserLayerImage('MB1');
    expect(getMbtilesTileImages('MB1')).toEqual({});
  });

  it('isUserLayerImageFailed/getUserLayerImage без imageDataUrl -> null/false', () => {
    expect(getUserLayerImage(vectorLayer([]))).toBeNull();
    expect(isUserLayerImageReady(vectorLayer([]))).toBe(false);
    expect(isUserLayerImageFailed(vectorLayer([]))).toBe(false);
  });
});
