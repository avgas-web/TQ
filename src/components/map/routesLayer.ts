/**
 * routesLayer.ts — слой отрисовки маршрутов (Фаза 5.C, выделен из MapCanvas.tsx).
 * Чистая функция рисования: никаких React-зависимостей и сторов — все входные
 * данные передаются параметрами. Поведение 1:1 совпадает с исходным drawRoutes
 * в MapCanvas (проверено тестами tests/routesLayer.test.ts).
 */
import type { Restriction, Route, ViewState } from "../../types";
import { routeLengthM, zonesCrossedBy } from "../../utils/routing";
import { ROUTE_PALETTE } from "./viewMath";

export interface DragRoutePointRef {
  routeId: string;
  index: number;
}

export interface RoutesLayerContext {
  /** Получение активных зон (кэшировано, без per-frame analyzeRoute) */
  getActiveZones: (restrictions: Restriction[] | undefined) => Restriction[];
}

export interface DrawRoutesParams {
  ctx: CanvasRenderingContext2D;
  vs: ViewState;
  routes: Route[];
  activeRouteId: string | null;
  restrictions: Restriction[] | undefined;
  dragging: DragRoutePointRef | null;
  layerCtx: RoutesLayerContext;
}

/** Отрисовка всех видимых маршрутов: линии (пунктир для авто-обходных
 *  сегментов, Catmull-Rom для shape==='curve'), точки, стрелка направления,
 *  подписи высот, предупреждения о пересечении NFZ и нарушении дальности. */
export function drawRoutesLayer(p: DrawRoutesParams): void {
  const { ctx, vs, routes, activeRouteId, restrictions, dragging, layerCtx } =
    p;
  if (!routes || routes.length === 0) return;

  ctx.save();
  ctx.translate(vs.offsetX, vs.offsetY);
  ctx.scale(vs.scale, vs.scale);
  const s = vs.scale;

  for (let ri = 0; ri < routes.length; ri++) {
    const route = routes[ri];
    if (!route.visible || route.points.length < 2) continue;

    const color = route.color || ROUTE_PALETTE[ri % ROUTE_PALETTE.length];
    const isActive = route.id === activeRouteId;

    // Предупреждения о пересечении зон ограничений.
    // П.7: НЕ вызываем analyzeRoute на каждый кадр — он пересчитывает
    // haversine-длины всех сегментов (O(N)) только ради crossedZones.
    // Активные зоны берутся из кэша (инвалидируется при изменении зон),
    // проверка отрезок↔зона выполняется сразу на пиксельных точках.
    let crossed: { name: string }[] = [];
    try {
      const activeZonesForDraw = layerCtx.getActiveZones(restrictions);
      if (activeZonesForDraw.length > 0) {
        crossed = zonesCrossedBy(
          route.points.map((pt) => ({ x: pt.x, y: pt.y })),
          activeZonesForDraw,
        );
      }
    } catch {
      /* зоны могут быть невалидными — не роняем отрисовку */
    }

    // Ограничение по дальности (max/min) — нарушение помечаем красным
    let rangeViolation = false;
    if (
      route.rangeMode &&
      route.rangeMode !== "off" &&
      route.rangeM &&
      route.rangeM > 0
    ) {
      const len = routeLengthM(
        route.points.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
      );
      rangeViolation =
        route.rangeMode === "max" ? len > route.rangeM : len < route.rangeM;
    }

    // Линии сегментов: авто-обходные сегменты — пунктир, ключевые — сплошные.
    // shape==='curve': рисуем сглаженную кривую Catmull-Rom через все точки
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (route.shape === "curve") {
      ctx.strokeStyle = rangeViolation ? "#ff4d4d" : color;
      ctx.lineWidth = (isActive ? 3.5 : 2.2) / s;
      ctx.setLineDash([]);
      ctx.beginPath();
      const cp = route.points;
      ctx.moveTo(cp[0].x, cp[0].y);
      for (let i = 0; i < cp.length - 1; i++) {
        const p0 = cp[Math.max(0, i - 1)];
        const p1 = cp[i];
        const p2 = cp[i + 1];
        const p3 = cp[Math.min(cp.length - 1, i + 2)];
        const c1x = p1.x + (p2.x - p0.x) / 6,
          c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6,
          c2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
      }
      ctx.stroke();
    } else {
      for (let i = 0; i < route.points.length - 1; i++) {
        const a = route.points[i];
        const b = route.points[i + 1];
        ctx.strokeStyle = rangeViolation ? "#ff4d4d" : color;
        ctx.lineWidth = (isActive ? 3.5 : 2.2) / s;
        if (a.auto || b.auto) ctx.setLineDash([8 / s, 5 / s]);
        else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Точки маршрута: ключевые (ставит пользователь) — цветные и чуть
    // крупнее; авто-обходные (результат обхода ограничений) — мелкие
    // полупрозрачные, их видно как «цепочку» вокруг зон.
    const drawR = (isActive ? 5 : 3.5) / s;
    for (let i = 0; i < route.points.length; i++) {
      const pt = route.points[i];
      const rPt = pt.auto ? drawR * 0.55 : drawR;
      // Drag-обратная связь: захваченная точка маршрута — пульсирующая
      // cyan-подсветка + увеличенный радиус, видно что элемент «схвачен».
      const isDragPt =
        isActive &&
        !!dragging &&
        dragging.routeId === route.id &&
        dragging.index === i;
      if (isDragPt) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, rPt * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 208, 255, 0.30)";
        ctx.fill();
        ctx.setLineDash([4 / s, 3 / s]);
        ctx.strokeStyle = "rgba(0, 208, 255, 0.95)";
        ctx.lineWidth = 2 / s;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isDragPt ? rPt * 1.6 : rPt, 0, Math.PI * 2);
      ctx.fillStyle = pt.auto ? "rgba(255,255,255,0.45)" : color;
      ctx.fill();
      ctx.lineWidth = (isDragPt ? 2.2 : 1.2) / s;
      ctx.strokeStyle = isDragPt ? "#00d0ff" : "rgba(0,0,0,0.6)";
      ctx.stroke();
      // Подписи высот (Open-Elevation): у активного маршрута — рельеф/ABS;
      // ручной AGL на этапе помечается стрелкой ↑
      if (isActive && typeof pt.altitudeAbs === "number") {
        const fsA = Math.max(8, 9 / s);
        ctx.font = `${fsA}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        const manualTag =
          typeof pt.altitudeAGL === "number"
            ? ` ↑${Math.round(pt.altitudeAGL)}`
            : "";
        const tTxt =
          pt.terrainM != null
            ? `${Math.round(pt.altitudeAbs)} м (з ${Math.round(pt.terrainM)})${manualTag}`
            : `${Math.round(pt.altitudeAbs)} м${manualTag}`;
        const twA = ctx.measureText(tTxt).width;
        ctx.fillRect(
          pt.x - twA / 2 - 2 / s,
          pt.y + drawR + 1 / s,
          twA + 4 / s,
          fsA + 3 / s,
        );
        ctx.fillStyle = "#7dd3fc";
        ctx.fillText(tTxt, pt.x, pt.y + drawR + 1 / s + fsA + 1 / s);
        ctx.textAlign = "left";
      }
    }

    // Стрелка направления на финише
    const last = route.points[route.points.length - 1];
    const prev = route.points[route.points.length - 2];
    const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
    const ah = 12 / s;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(
      last.x - ah * Math.cos(ang - 0.4),
      last.y - ah * Math.sin(ang - 0.4),
    );
    ctx.lineTo(
      last.x - ah * Math.cos(ang + 0.4),
      last.y - ah * Math.sin(ang + 0.4),
    );
    ctx.closePath();
    ctx.fill();

    // Подписи показываем только для активного маршрута или при малом числе маршрутов
    if (isActive || routes.length <= 20) {
      const fs = Math.max(10, 12 / s);
      const first = route.points[0];
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = "left";
      const label = `${route.name}${isActive ? " ●" : ""}`;
      const tw = ctx.measureText(label).width;
      const lx = first.x + 8 / s;
      const ly = first.y - 8 / s;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(lx - 3 / s, ly - fs, tw + 6 / s, fs + 5 / s);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly);
    }

    // Предупреждение о зонах ограничений прямо на карте (для активного маршрута)
    if (isActive && crossed.length > 0) {
      const mid = route.points[Math.floor(route.points.length / 2)];
      const fs = Math.max(11, 13 / s);
      const warn = `⚠ Пересекает: ${crossed.map((z) => z.name).join(", ")}`;
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(warn).width;
      ctx.fillStyle = "rgba(120,20,20,0.85)";
      ctx.fillRect(
        mid.x - tw / 2 - 5 / s,
        mid.y - fs - 5 / s,
        tw + 10 / s,
        fs + 9 / s,
      );
      ctx.fillStyle = "#ffd166";
      ctx.textAlign = "center";
      ctx.fillText(warn, mid.x, mid.y - 2 / s);
      ctx.textAlign = "left";
    }

    // Отметка нарушения ограничения по дальности (красный маркер у финиша)
    if (rangeViolation) {
      const len = routeLengthM(
        route.points.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
      );
      const txt = `${route.rangeMode === "max" ? ">" : "<"} лимита: ${Math.round(len)} м / ${Math.round(route.rangeM || 0)} м`;
      const fs = Math.max(10, 12 / s);
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = "rgba(150,20,20,0.9)";
      ctx.fillRect(last.x + 8 / s, last.y + 4 / s, tw + 8 / s, fs + 6 / s);
      ctx.fillStyle = "#ffb3b3";
      ctx.fillText(txt, last.x + 12 / s, last.y + 4 / s + fs + 1 / s);
    }
  }

  ctx.restore();
}
