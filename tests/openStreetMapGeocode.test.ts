// Юнит-тесты сетевого слоя openStreetMap.ts: геокодирование Nominatim,
// различение «не найдено / HTTP / сеть», перебор зеркал, отмена по AbortSignal.
// Сеть полностью замокана — тесты не зависят от внешних сервисов.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { osmGeocode, osmReverseGeocode } from '../src/utils/openStreetMap';

/** мок fetch, возвращающий список «ответов на вызов» (по порядку) */
function mockFetch(responses: Array<{ status?: number; ok?: boolean; json?: unknown; throws?: boolean }>) {
  const calls: string[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throws) throw new Error('network down');
    return {
      status: r.status ?? 200,
      ok: r.ok ?? (r.status ?? 200) < 400,
      json: async () => r.json,
    };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  // reserveNominatimSlot использует реальные таймауты (1 сек/запрос) —
  // fake timers переводят их в мгновенные промотки.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** промис + промотка всех таймеров до его завершения */
async function runAll<T>(p: Promise<T>): Promise<T> {
  const t = setTimeout(() => undefined, 0);
  await vi.runAllTimersAsync();
  clearTimeout(t);
  return p;
}

describe('osmGeocode', () => {
  it('успешный ответ -> координаты и kind=ok', async () => {
    mockFetch([{ json: [{ lat: '55.75', lon: '37.61', display_name: 'Москва' }] }]);
    const res = await runAll(osmGeocode('Москва, Тверская'));
    expect(res.kind).toBe('ok');
    expect(res.point).toEqual({ lat: 55.75, lng: 37.61 });
  });

  it('пустой массив -> not_found (не путать с ошибкой сервиса)', async () => {
    mockFetch([{ json: [] }]);
    const res = await runAll(osmGeocode('нет-такого-адреса'));
    expect(res.kind).toBe('not_found');
    expect(res.point).toBeNull();
  });

  it('нечисловые lat/lon в ответе -> not_found', async () => {
    mockFetch([{ json: [{ lat: 'abc', lon: 'def' }] }]);
    const res = await runAll(osmGeocode('плохие данные'));
    expect(res.kind).toBe('not_found');
    expect(res.point).toBeNull();
  });

  it('HTTP 400 -> kind=http', async () => {
    mockFetch([{ status: 400, ok: false }]);
    const res = await runAll(osmGeocode('anything'));
    expect(res.kind).toBe('http');
    expect(res.point).toBeNull();
  });

  it('429 на всех зеркалах -> kind=http (сервис ограничен, а не «не найдено»)', async () => {
    mockFetch([{ status: 429, ok: false }]);
    const res = await runAll(osmGeocode('anything'));
    expect(res.kind).toBe('http');
  });

  it('сетевой сбой на всех попытках -> kind=network', async () => {
    mockFetch([{ throws: true }]);
    const res = await runAll(osmGeocode('anything'));
    expect(res.kind).toBe('network');
    expect(res.point).toBeNull();
  });

  it('внешний AbortSignal до запроса -> network без обращений к fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runAll(osmGeocode('anything', ctrl.signal));
    expect(res.kind).toBe('network');
    expect(spy).not.toHaveBeenCalled();
  });

  it('запрос идёт на зеркало Nominatim с format=json', async () => {
    const calls = mockFetch([{ json: [{ lat: '1', lon: '2' }] }]);
    await runAll(osmGeocode('ул. Тестовая'));
    expect(calls[0]).toContain('format=json');
    expect(calls[0]).toContain('q=');
    expect(/^https:\/\/nominatim\./.test(calls[0])).toBe(true);
  });
});

describe('osmReverseGeocode', () => {
  it('возвращает display_name', async () => {
    mockFetch([{ json: { display_name: 'Тверская ул., Москва' } }]);
    const res = await runAll(osmReverseGeocode(55.75, 37.61));
    expect(res).toBe('Тверская ул., Москва');
  });

  it('ответ без display_name -> null', async () => {
    mockFetch([{ json: {} }]);
    const res = await runAll(osmReverseGeocode(1, 1));
    expect(res).toBeNull();
  });

  it('ошибка сети -> null', async () => {
    mockFetch([{ throws: true }]);
    const res = await runAll(osmReverseGeocode(1, 1));
    expect(res).toBeNull();
  });

  it('lat/lon попадают в query строку', async () => {
    const calls = mockFetch([{ json: { display_name: 'x' } }]);
    await runAll(osmReverseGeocode(55.5, 37.5));
    expect(calls[0]).toContain('lat=55.5');
    expect(calls[0]).toContain('lon=37.5');
  });
});
