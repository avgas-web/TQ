// ─── Три отдельных окна карты: СТАРТ / МАРШРУТ / ЦЕЛЬ ────────────────────────
// Общая математика строгой Web-Mercator привязки «экран ⇔ координаты» для всех
// окон. Все три панели используют ОДНУ формулу вида:
//   worldPx = canvasHeight · 2^zoom,  screenX = fx·worldPx + offsetX (fx — mercator-доля мира)
// поэтому координатная привязка строга на любом масштабе и при любой панораме.

export interface PanelView {
  zoom: number;   // непрерывный зум OSM (3..19+)
  fx: number;     // mercator X [0..1] центра вида
  fy: number;     // mercator Y [0..1] центра вида
}

/** Создание вида панели из гео-координат центра (mercator-доли — через geoToMercFrac) */
export function panelViewOf(lat: number, lng: number, zoom: number): PanelView {
  const { fx, fy } = geoToMercFrac(lat, lng);
  return { zoom, fx, fy };
}

export interface PanelViewBox extends PanelView {
  wpx: number;    // мир в экранных px по ширине канваса (canvasWidth·2^zoom)
  hpx: number;    // мир в экранных px по высоте канваса (canvasHeight·2^zoom) — ЭТАЛОН масштаба
}

/** Масштаб «1 см экрана = 2 км местности» как target ground meters-per-pixel:
 *  при CSS DPI 96 пикселей на дюйм 1 см экрана = 96/2.54 ≈ 37.795 css-px,
 *  значит на этих 37.795 px должно приходиться ровно 2000 м ⇒
 *  mpp = 2000 м / 37.795 px ≈ 52.917… м/css-px. */
export const CSS_PX_PER_CM = 96 / 2.54;            // ≈ 37.795 css-px в 1 см
export const GROUND_MPP_1CM_2KM = 2000 / CSS_PX_PER_CM; // ≈ 52.917 м/css-px

/** Зум OSM, при котором ground mpp = заданному (учёт широты).
 *  ground mpp = 156543.03392·cos(lat)/2^z ⇒ z = log2(156543.03392·cos(lat)/mpp).
 *  worldPx = canvasHeight·2^zoom — эталон по высоте, как в Leaflet/OSM и основном канвасе. */
export function zoomForGroundMpp(groundMpp: number, latDeg: number): number {
  const g = Math.max(1e-9, groundMpp);
  return Math.log2((156543.0339280412 * Math.max(0.05, Math.cos((latDeg * Math.PI) / 180))) / g);
}

/** Метров на пиксель на данном зуме (учёт широты обязателен) */
export function metersPerPixel(zoom: number, latDeg: number): number {
  return 156543.0339280412 / Math.pow(2, zoom) * Math.max(0.05, Math.cos((latDeg * Math.PI) / 180));
}

/** Mercator-доли мира из гео-координат */
export function geoToMercFrac(lat: number, lng: number): { fx: number; fy: number } {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return { fx: (lng + 180) / 360, fy: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/** Обратное преобразование долейmercator -> гео */
export function mercFracToGeo(fx: number, fy: number): { lat: number; lng: number } {
  const lng = fx * 360 - 180;
  const n = Math.PI - 2 * Math.PI * fy;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/**
 * Расчёт вида «всё умещается в окно»: покрываем bbox точек с запасом,
 * но НЕ крупнее масштаба-эталона (1 см = 2 км) и не дальше maxZoom.
 * aspect = canvasWidth / canvasHeight; worldPx = canvasHeight·2^zoom (квадратный мир).
 */
export function fitView(pts: { lat: number; lng: number }[], aspect: number, minZoom: number, maxZoom: number, pad = 0.12): PanelView | null {
  if (pts.length === 0 || !(aspect > 0)) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const { fx, fy } = geoToMercFrac(p.lat, p.lng);
    if (fx < minX) minX = fx; if (fx > maxX) maxX = fx;
    if (fy < minY) minY = fy; if (fy > maxY) maxY = fy;
  }
  const spanFx = Math.max(maxX - minX, 1e-9), spanFy = Math.max(maxY - minY, 1e-9);
  const needW = spanFx * (1 + pad), needH = spanFy * (1 + pad);
  // bounds вписываются: spanFx·worldPx ≤ canvasW ⇒ worldPx ≤ canvasW/spanFx;
  // worldPx = canvasH·2^z ⇒ z ≤ log2(aspect/needW) и z ≤ log2(1/needH)
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min(Math.log2(aspect / needW), Math.log2(1 / needH))));
  const latC = mercFracToGeo((minX + maxX) / 2, (minY + maxY) / 2).lat;
  // НЕ крупнее эталонного масштаба 1 см = 2 км (иначе «весь маршрут» был бы слишком приближён)
  const zoomFixed = Math.max(minZoom, Math.min(maxZoom, Math.min(zoom, zoomForGroundMpp(GROUND_MPP_1CM_2KM, latC))));
  return { zoom: zoomFixed, fx: (minX + maxX) / 2, fy: (minY + maxY) / 2 };
}

/** View вида в world-пиксели канваса (для прямой отрисовки тайлов на canvas).
 *  ЭТАЛОН — высота: hpx = canvasHeight·2^zoom; по X мир масштабируется так же
 *  (wpx = hpx) — квадратные mercator-доли, как в Leaflet/OSM и основном канвасе. */
export function viewBox(v: PanelView, _canvasW: number, canvasH: number): PanelViewBox {
  const px = Math.max(256, canvasH * Math.pow(2, v.zoom));
  return { ...v, wpx: px, hpx: px };
}

/** Гео -> экранные px канваса (строгая привязка) */
export function geoToScreenPx(lat: number, lng: number, vb: PanelViewBox, canvasW: number, canvasH: number): { x: number; y: number } {
  const { fx, fy } = geoToMercFrac(lat, lng);
  return { x: (fx - vb.fx) * vb.wpx + canvasW / 2, y: (fy - vb.fy) * vb.hpx + canvasH / 2 };
}

/** Экранные px -> гео (для панорамы перетаскиванием) */
export function screenPxToGeo(x: number, y: number, vb: PanelViewBox, canvasW: number, canvasH: number): { lat: number; lng: number } {
  return mercFracToGeo(vb.fx + (x - canvasW / 2) / vb.wpx, vb.fy + (y - canvasH / 2) / vb.hpx);
}

/** Непрерывный зум вокруг точки канваса (колесо мыши).
 *  Инвариант: гео-точка под курсором остаётся под курсором после смены зума. */
export function zoomPanelAt(v: PanelView, factor: number, cx: number, cy: number, canvasW: number, canvasH: number, minZoom: number, maxZoom: number): PanelView {
  const vb = viewBox(v, canvasW, canvasH);
  // какая доля мира смещена от центра к курсору (в mercator-долях)
  const dFx = (cx - canvasW / 2) / vb.wpx;
  const dFy = (cy - canvasH / 2) / vb.hpx;
  const zoom = Math.max(minZoom, Math.min(maxZoom, v.zoom + Math.log2(Math.max(factor, 1e-6))));
  const nvb = viewBox({ ...v, zoom }, canvasW, canvasH);
  // новый центр: fx_new = fx_geo(курсор) − dF_new, где dF_new = dF·wpx_old/wpx_new
  const scale = vb.wpx / nvb.wpx;
  return { zoom, fx: v.fx + dFx * (1 - scale), fy: v.fy + dFy * (1 - scale) };
}

/** Панорама перетаскиванием: delta px экрана -> новый центр вида */
export function panPanelBy(v: PanelView, dx: number, dy: number, canvasW: number, canvasH: number): PanelView {
  const vb = viewBox(v, canvasW, canvasH);
  return { zoom: v.zoom, fx: v.fx - dx / vb.wpx, fy: v.fy - dy / vb.hpx };
}
