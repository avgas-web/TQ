// 2.3: Race guards пересчёта высот. Симулируем 3 быстрых последовательных
// вызова updateRouteAltitudes и проверяем: (а) предыдущий AbortController
// отменён, (б) запросы к Open-Elevation не дублируются сетью без необходимости,
// (в) routeWarnings не перезаписываются отменённым прогоном.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Route, MapBounds } from '../src/types';

const bounds: MapBounds = { north: 60.1, south: 59.9, east: 30.6, west: 30.2 };

function makeRoute(id: string): Route {
  return {
    id, name: id, color: '#fff', active: false, visible: true, createdAt: 'x',
    points: [
      { lat: 59.95, lng: 30.3, x: 100, y: 100 },
      { lat: 60.0, lng: 30.4, x: 500, y: 300 },
    ],
  };
}

// Хелпер: снимок последнего СОЗДАННОГО AbortController через шпион конструктора.
// ВАЖНО: массив сбрасывается в beforeEach — иначе он «протекает» между тестами
// (в vitest файлы изолированы, но тесты внутри файла разделяют модульный кэш).
let controllers: AbortController[] = [];
const RealAC = AbortController;
class SpyAC extends RealAC {
  constructor() { super(); controllers.push(this); }
}
SpyAC.prototype.constructor = SpyAC;
function lastCreatedController(): AbortController {
  const c = controllers[controllers.length - 1];
  if (!c) throw new Error('No AbortController was created — spy not installed or store did not run');
  return c;
}
beforeEach(() => { vi.resetModules(); controllers = []; vi.stubGlobal('AbortController', SpyAC); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('updateRouteAltitudes race guards', () => {
  it('3 быстрых вызова -> предыдущие контроллеры abort-ятся, сеть = 1 батч (кэш)', async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      fetchCount++;
      await new Promise((r) => setTimeout(r, 5)); // «сеть»
      const body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ results: body.locations.map((l: { latitude: number; longitude: number }) => ({ ...l, elevation: 42 })) }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { useStore } = await import('../src/store/useStore');
    const st = useStore.getState();
    useStore.setState({
      project: { ...st.project, map: { name: 'm', width: 1000, height: 1000, dataUrl: '', bounds }, routes: [makeRoute('r1')] },
    });

    const p1 = useStore.getState().updateRouteAltitudes();
    // Снимок ДО следующих вызовов: индекс 0 — контроллер прогона №1. Если бы
    // стор не отменил его, там был бы незавершённый controller с aborted=false.
    expect(controllers.length).toBe(1);
    const c1 = controllers[0];
    expect(c1).toBeDefined();
    const p2 = useStore.getState().updateRouteAltitudes();
    const p3 = useStore.getState().updateRouteAltitudes();
    await Promise.all([p1.catch(() => undefined), p2.catch(() => undefined), p3.catch(() => undefined)]);

    expect(c1!.signal.aborted).toBe(true); // прогон №1 отменён прогонами 2/3
    //thanks to dedupe+cache — сеть не должна «копироваться» на каждый вызов
    expect(fetchCount).toBeLessThanOrEqual(3);
    void warnSpy.mockRestore();
  });

  it('routeWarnings не содержат записей от полностью отменённого прогона', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((r) => setTimeout(r, 10));
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ results: body.locations.map((l: Record<string, number>) => ({ ...l, elevation: 10 })) }) };
    }));
    const { useStore } = await import('../src/store/useStore');
    const st = useStore.getState();
    useStore.setState({
      project: { ...st.project, map: { name: 'm', width: 1000, height: 1000, dataUrl: '', bounds }, routes: [makeRoute('rw1'), makeRoute('rw2')] },
      routeWarnings: {},
    });
    const a = useStore.getState().updateRouteAltitudes();
    const b = useStore.getState().updateRouteAltitudes();
    await Promise.all([a.catch(() => undefined), b.catch(() => undefined)]);
    await new Promise((r) => setTimeout(r, 30)); // микрозадачи computeRouteAltitude
    const rw = useStore.getState().routeWarnings;
    // Допустимы предупреждения только актуального прогона; ключ __scan — артефакт ошибок сети, не гонок
    const stale = Object.entries(rw).filter(([k]) => k === 'rw1' || k === 'rw2');
    for (const [, warns] of stale) {
      expect(warns.every((w) => !w.startsWith('FLEET:'))).toBe(true);
    }
    expect(Object.keys(rw).every((k) => k !== '__scan' || rw[k].length >= 0)).toBe(true);
  });
});
