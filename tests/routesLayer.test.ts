/**
 * Регрессионные тесты для вынесенного слоя маршрутов (Фаза 5.C).
 * Проверяют, что после извлечения drawRoutes из MapCanvas.tsx в
 * src/components/map/routesLayer.ts поведение отрисовки сохранено:
 *  - пустой список маршрутов не порождает ни одной команды ctx;
 *  - невидимые и «короткие» маршруты пропускаются;
 *  - трансформация вида (translate+scale) применяется;
 *  - нарушение дальности красит линию в аварийный цвет;
 *  - пересечение NFZ даёт предупреждающую подпись только у активного маршрута.
 */
import { describe, it, expect } from "vitest";
import {
  drawRoutesLayer,
  type DrawRoutesParams,
} from "../src/components/map/routesLayer";
import type { Restriction, Route, ViewState } from "../src/types";

/** Мок canvas-контекста: пишет все вызовы методов в журнал. */
function makeCtx() {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const state: Record<string, unknown> = {};
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop in state) return state[prop];
      if (prop === "measureText") return () => ({ width: 42 });
      return (...args: unknown[]) => {
        calls.push({ m: prop, args });
      };
    },
    set(_t, prop: string, value: unknown) {
      state[prop] = value;
      calls.push({ m: `set:${prop}`, args: [value] });
      return true;
    },
  };
  return {
    ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D,
    calls,
    state,
  };
}

const vs: ViewState = { offsetX: 100, offsetY: 50, scale: 2 };

function mkRoute(over: Partial<Route> = {}): Route {
  return {
    id: "r1",
    name: "Маршрут 1",
    color: "#22d3ee",
    active: true,
    visible: true,
    createdAt: "2026-01-01T00:00:00Z",
    points: [
      { lat: 55.75, lng: 37.62, x: 0, y: 0 },
      { lat: 55.76, lng: 37.63, x: 100, y: 100 },
    ],
    ...over,
  } as Route;
}

function mkCircleZone(name = "NFZ-круг"): Restriction {
  return {
    id: "z1",
    type: "circle",
    points: [{ x: 50, y: 50, lat: 55.755, lng: 37.625 }],
    radius: 80,
    color: "#f00",
    name,
    active: true,
  } as Restriction;
}

const baseParams = (
  over: Partial<DrawRoutesParams> = {},
): DrawRoutesParams => ({
  ctx: makeCtx().ctx,
  vs,
  routes: [],
  activeRouteId: null,
  restrictions: [],
  dragging: null,
  layerCtx: { getActiveZones: () => [] },
  ...over,
});

describe("routesLayer: контракт чистой функции (без сторов и React)", () => {
  it("пустой список маршрутов — ноль обращений к ctx", () => {
    const { ctx, calls } = makeCtx();
    drawRoutesLayer(baseParams({ ctx, routes: [] }));
    expect(calls.length).toBe(0);
  });

  it("невидимый маршрут и маршрут из 1 точки полностью пропускаются", () => {
    const { ctx, calls } = makeCtx();
    drawRoutesLayer(
      baseParams({
        ctx,
        routes: [
          mkRoute({ id: "hidden", visible: false }),
          mkRoute({
            id: "short",
            points: [{ lat: 1, lng: 1, x: 0, y: 0 }],
          }),
        ],
      }),
    );
    // Ни beginPath, ни moveTo — функция даже не начала рисовать
    expect(calls.filter((c) => c.m === "beginPath").length).toBe(0);
    expect(calls.filter((c) => c.m === "moveTo").length).toBe(0);
  });

  it("трансформация вида применяется: translate(offsetX, offsetY) + scale(s, s)", () => {
    const { ctx, calls } = makeCtx();
    drawRoutesLayer(baseParams({ ctx, routes: [mkRoute()] }));
    expect(calls[0]).toEqual({ m: "save", args: [] });
    expect(calls).toContainEqual({ m: "translate", args: [100, 50] });
    expect(calls).toContainEqual({ m: "scale", args: [2, 2] });
    expect(calls[calls.length - 1]).toEqual({ m: "restore", args: [] });
  });

  it("нарушение лимита дальности («max») красит сегменты в #ff4d4d", () => {
    const { ctx, state } = makeCtx();
    // Москва → СПб по координатам ≈ 600 км, лимит 10 км — явное превышение
    drawRoutesLayer(
      baseParams({
        ctx,
        routes: [
          mkRoute({
            rangeMode: "max",
            rangeM: 10_000,
            points: [
              { lat: 55.7558, lng: 37.6173, x: 0, y: 0 },
              { lat: 59.9386, lng: 30.3141, x: 100, y: 100 },
            ],
          }),
        ],
      }),
    );
    // последний записанный strokeStyle должен быть аварийным красным
    const styles = calls
      .filter((c) => c.m === "set:strokeStyle")
      .map((c) => c.args[0]);
    expect(styles).toContain("#ff4d4d");
  });

  it("пересечение NFZ: предупреждение рисуется ТОЛЬКО у активного маршрута", () => {
    const zone = mkCircleZone();
    const getActiveZones = () => [zone];

    const a = makeCtx();
    drawRoutesLayer(
      baseParams({
        ctx: a.ctx,
        routes: [mkRoute({ id: "act" })],
        activeRouteId: "act",
        restrictions: [zone],
        layerCtx: { getActiveZones },
      }),
    );
    const warnA = a.calls.find(
      (c) => c.m === "fillText" && String(c.args[0]).includes("Пересекает"),
    );
    expect(warnA).toBeTruthy();

    const b = makeCtx();
    drawRoutesLayer(
      baseParams({
        ctx: b.ctx,
        routes: [mkRoute({ id: "act" })],
        activeRouteId: "other",
        restrictions: [zone],
        layerCtx: { getActiveZones },
      }),
    );
    const warnB = b.calls.find(
      (c) => c.m === "fillText" && String(c.args[0]).includes("Пересекает"),
    );
    expect(warnB).toBeUndefined();
  });

  it("сбой getActiveZones не роняет отрисовку (try/catch сохранён)", () => {
    const { ctx, calls } = makeCtx();
    expect(() =>
      drawRoutesLayer(
        baseParams({
          ctx,
          routes: [mkRoute()],
          layerCtx: {
            getActiveZones: () => {
              throw new Error("битая зона");
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(calls.some((c) => c.m === "stroke")).toBe(true);
  });

  it("drag-подсветка: захваченная точка активного маршрута получает cyan-обводку", () => {
    const { ctx, calls } = makeCtx();
    drawRoutesLayer(
      baseParams({
        ctx,
        routes: [mkRoute({ id: "r1" })],
        activeRouteId: "r1",
        dragging: { routeId: "r1", index: 1 },
      }),
    );
    const cyan = calls.find(
      (c) => c.m === "set:strokeStyle" && c.args[0] === "#00d0ff",
    );
    expect(cyan).toBeTruthy();
  });
});
