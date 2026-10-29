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
  wpx: number;    // мир в экранных px по X — ЕДИНЫЙ изотропный масштаб (см. viewBox)
  hpx: number;    // мир в экранных px по Y — всегда равен wpx (Web-Mercator квадратный)
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
 * aspect = canvasWidth / canvasHeight; изотропный мир viewBox задаётся
 * ВЫСОТОЙ окна: worldPx = canvasHeight·2^z (эталон Leaflet/OSM/MapCanvas),
 * ширина окна в тех же world-px равна aspect·canvasHeight. Условия вписания:
 *   X: needW·worldPx ≤ W ⇔ 2^z ≤ aspect/needW
 *   Y: needH·worldPx ≤ H ⇔ 2^z ≤ 1/needH
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
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min(Math.log2(aspect / needW), Math.log2(1 / needH))));
  const latC = mercFracToGeo((minX + maxX) / 2, (minY + maxY) / 2).lat;
  // НЕ крупнее эталонного масштаба 1 см = 2 км (иначе «весь маршрут» был бы слишком приближён)
  const zoomFixed = Math.max(minZoom, Math.min(maxZoom, Math.min(zoom, zoomForGroundMpp(GROUND_MPP_1CM_2KM, latC))));
  return { zoom: zoomFixed, fx: (minX + maxX) / 2, fy: (minY + maxY) / 2 };
}

/** View вида в world-пиксели канваса (для прямой отрисовки тайлов на canvas).
 *  ФИКС «карта не отображается / отображается криво» (режим мастера):
 *  ПРЕДЫДУЩАЯ версия (d64604d) брала базу мира по БОЛЬШЕЙ стороне окна —
 *  worldPx = max(W, H)·2^zoom. Это «fit-by-max-side»: гео-область, подобранная
 *  под стартовый зум (эталон — высота окна, как в Leaflet/OSM и MapCanvas),
 *  оказывалась ВЫРЕЗАНОЙ по короткой оси — в узкой высокой мастерской панели
 *  исчезали крайние точки маршрута, а сетка тайлов строилась с расходящимся
 *  scale и панель выглядела «кривой загрузкой».
 *  Теперь — ЕДИНЫЙ инвариант обоих режимов (MapCanvas.worldPxOf,
 *  positionTileLayer, syncTileDom, mapGeoPick.screenToGeo):
 *      worldPx = canvasHeight · 2^zoom   (эталон — ВЫСОТА окна),
 *  обе оси получают ОДИНАКОВЫЙ изотропный масштаб ⇒ тайлы остаются квадратами
 *  при любом аспекте окна, а формула screen = fx·worldPx + centerOffset строго
 *  обратима (geoToScreenPx ⇔ screenPxToGeo, zoomPanelAt, panPanelBy). */
export function viewBox(v: PanelView, canvasW: number, canvasH: number): PanelViewBox {
  void canvasW; // изотропный мир: масштаб задаётся высотой окна (эталон OSM/Leaflet)
  const px = Math.max(256, canvasH) * Math.pow(2, v.zoom);
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
