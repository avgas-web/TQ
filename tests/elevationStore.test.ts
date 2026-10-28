// ═══════════════════════════════════════════════════════════════
// ПРОБЛЕМА 1 (сквозной сценарий стора): updateRouteAltitudes корректно
// проставляет terrainM и altitudeAbs по мок-ответу Open-Elevation,
// пишет warning при недоступном сервисе, а НЕ роняет приложение.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MapData, RoutePoint } from '../src/types';

type Loc = { latitude: number; longitude: number };

const bounds = { north: 56.0, south: 55.9, east: 37.8, west: 37.6 };
const map: MapData = { name: 'test', width: 1000, height: 1000, dataUrl: '', bounds, source: 'osm' };

async function seedRoute(pts: RoutePoint[]): Promise<string> {
  const [{ useMapStore }, { useMissionStore }] = await Promise.all([
    import('../src/store/useMapStore'),
    import('../src/store/useMissionStore'),
  ]);
  useMapStore.setState({ map, restrictions: [] });
  useMissionStore.setState({ routes: [], routeWarnings: {}, activeRouteId: null });
  const id = useMissionStore.getState().addRoute(pts, 'Тест');
  if (!id) throw new Error('addRoute вернул null (нет карты?)');
  return id;
}

function makeFetch(elevOf: (l: Loc) => number | null): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { locations: Loc[] };
    return new Response(
      JSON.stringify({
        results: body.locations.map((l) => ({ ...l, elevation: elevOf(l) })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

beforeEach(() => {
  vi.resetModules(); // изоляция кэша высот/сторов между тестами
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateRouteAltitudes — terrainM / altitudeAbs', () => {
  it('проставляет terrainM из ответа API и altitudeAbs = рельеф + запас', async () => {
    vi.stubGlobal('fetch', makeFetch(() => 100));
    const { useMissionStore } = await import('../src/store/useMissionStore');
    const id = await seedRoute([
      { lat: 55.95, lng: 37.65, x: 100, y: 100 },
      { lat: 55.95, lng: 37.75, x: 500, y: 100 },
    ]);
    await useMissionStore.getState().updateRouteAltitudes(id);
    await new Promise((r) => setTimeout(r, 0)); // отложенный профиль-прогон
    const pts = useMissionStore.getState().routes.find((r) => r.id === id)!.points;
    expect(pts[0].terrainM).toBe(100);
    expect(pts[1].terrainM).toBe(100);
    // clearance по умолчанию 50 → требуемая ABS ≥ 150
    expect(pts[0].altitudeAbs).not.toBeNull();
    expect((pts[0].altitudeAbs as number) >= 150 - 1e-6).toBe(true);
    // предупреждений о недоступности сервиса быть не должно
    expect(useMissionStore.getState().routeWarnings['__elevation']).toBeUndefined();
  });

  it('сервис недоступен (HTTP 500) → terrainM=null + явный warning, без падения', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const { useMissionStore } = await import('../src/store/useMissionStore');
    const id = await seedRoute([
      { lat: 55.92, lng: 37.62, x: 50, y: 50 },
      { lat: 55.98, lng: 37.78, x: 900, y: 900 },
    ]);
    await expect(useMissionStore.getState().updateRouteAltitudes(id)).resolves.toBeUndefined();
    const st = useMissionStore.getState();
    const pts = st.routes.find((r) => r.id === id)!.points;
    expect(pts[0].terrainM).toBeNull();
    expect(st.routeWarnings['__elevation']?.length).toBeGreaterThan(0);
  });

  it('нет карты (bounds) → пересчёт не крашится и объясняет причину в warning', async () => {
    const { useMapStore, } = await import('../src/store/useMapStore');
    const { useMissionStore } = await import('../src/store/useMissionStore');
    useMapStore.setState({ map: null });
    useMissionStore.setState({ routes: [], routeWarnings: {} });
    await expect(useMissionStore.getState().updateRouteAltitudes(null)).resolves.toBeUndefined();
    expect(useMissionStore.getState().routeWarnings['__elevation']?.[0]).toContain('пересчёт высот невозможен');
  });

  it('3 быстрых последовательных вызова: предыдущие прогоны отменяются, финальные данные корректны (race guard)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      const sig = init.signal as AbortSignal | undefined;
      const delay = n === 1 ? 40 : n === 2 ? 20 : 5;
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, delay);
        sig?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      });
      const body = JSON.parse(String(init.body)) as { locations: Loc[] };
      return new Response(
        JSON.stringify({ results: body.locations.map((l) => ({ ...l, elevation: 200 })) }),
        { status: 200 },
      );
    }));
    const { useMissionStore } = await import('../src/store/useMissionStore');
    const id = await seedRoute([
      { lat: 55.94, lng: 37.64, x: 100, y: 100 },
      { lat: 55.96, lng: 37.76, x: 500, y: 500 },
    ]);
    const a = useMissionStore.getState().updateRouteAltitudes(id);
    const b = useMissionStore.getState().updateRouteAltitudes(id);
    const c = useMissionStore.getState().updateRouteAltitudes(id);
    await Promise.all([a, b, c]);
    await new Promise((r) => setTimeout(r, 100));
    const pts = useMissionStore.getState().routes.find((r) => r.id === id)!.points;
    expect(pts[0].terrainM).toBe(200);
    expect(useMissionStore.getState().isProcessing).toBe(false); // блокировка снята после финального прогона
  });
});
