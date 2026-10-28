// ═══════════════════════════════════════════════════════════════
// ПРОБЛЕМА 1: связь с Open-Elevation. Мок fetch: успешный ответ,
// 429 Too Many Requests (retry + graceful fallback), отмена
// устаревших запросов через AbortController, мягкая деградация при
// недоступном сервисе (null-высоты, без throw).
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchElevations } from '../src/utils/elevation';

type Loc = { latitude: number; longitude: number };

function okResponse(locations: Loc[], elevOf: (l: Loc) => number): Response {
  return new Response(
    JSON.stringify({
      results: locations.map((l) => ({ ...l, elevation: elevOf(l) })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers(); // форсируем backoff-паузу 429 мгновенно
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchElevations — запрос к api.open-elevation.com', () => {
  it('POST на правильный URL и проставляет высоты по координатам', async () => {
    const call = fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { locations: Loc[] };
      return okResponse(body.locations, () => 123.4);
    });
    void call;
    const pts = [{ lat: 55.75, lng: 37.61 }, { lat: 55.76, lng: 37.62 }];
    const p = fetchElevations(pts);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual([123.4, 123.4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.open-elevation.com/api/v1/lookup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).locations).toHaveLength(2);
  });

  it('дубликаты точек дедуплицируются в один батч (щадим троттлящийся API)', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { locations: Loc[] };
      return okResponse(body.locations, () => 10);
    });
    const p = fetchElevations([
      { lat: 55.1, lng: 37.1 },
      { lat: 55.1, lng: 37.1 },
      { lat: 55.2, lng: 37.2 },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual([10, 10, 10]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { locations: Loc[] };
    expect(body.locations).toHaveLength(2);
  });

  it('HTTP 500 → мягкая деградация: null вместо выброса (приложение не падает)', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));
    const p = fetchElevations([{ lat: 1, lng: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual([null]);
  });

  it('битый JSON ответа → null, без throw', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const p = fetchElevations([{ lat: 2, lng: 2 }]);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual([null]);
  });
});

describe('fetchElevations — 429 Too Many Requests', () => {
  it('после 429 выполняет повторную попытку (backoff) и получает данные', async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      const body = JSON.parse(String(init.body)) as { locations: Loc[] };
      return okResponse(body.locations, () => 55);
    });
    const p = fetchElevations([{ lat: 3, lng: 3 }]);
    await vi.advanceTimersByTimeAsync(10_000); // разблокировать backoff-таймер
    const r = await p;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(r).toEqual([55]);
  });

  it('повторный 429 → graceful fallback: null-высота, приложение живо', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const p = fetchElevations([{ lat: 4, lng: 4 }]);
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r).toEqual([null]); // НЕ throw — вызывающий код поставит warning
  });
});

describe('fetchElevations — AbortController (устаревшие прогоны)', () => {
  it('abort внешнего сигнала отменяет fetch и бросает AbortError наверх', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      return new Promise<Response>((_res, rej) => {
        sig.addEventListener('abort', () => {
          const e = new Error('The user aborted a request.');
          e.name = 'AbortError';
          rej(e);
        });
      });
    });
    const ctrl = new AbortController();
    const pr = fetchElevations([{ lat: 5, lng: 5 }], ctrl.signal);
    const caught = pr.catch((err: unknown) => err as Error);
    ctrl.abort(); // имитация запуска более нового прогона пересчёта
    await vi.advanceTimersByTimeAsync(0);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
  });

  it('не-aborted ошибки сети не превращаются в AbortError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const p = fetchElevations([{ lat: 6, lng: 6 }]);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual([null]);
  });
});
