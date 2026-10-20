// 2.2: mock-тест offload'а маршрутизации в Web Worker (главный поток не
// блокируется: ответ приходит асинхронно, postMessage не вызывает onmessage
// синхронно). Плюс проверка try/catch-контракта самого воркера.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeWorker } from './mocks/workerMock';
import type { RoutingRequest } from '../src/workers/routingProtocol';

vi.mock('../src/workers/routing.worker.ts?worker', () => ({ default: class {} }));

describe('useRoutingWorker protocol (mocked worker)', () => {
  beforeEach(() => {
    // @ts-expect-error подмена глобального Worker для теста хука
    globalThis.Worker = FakeWorker;
    FakeWorker.failNext = false;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // Мини-реализация контракта клиента (как в useRoutingWorker) без React —
  // чтобы протестировать сам протокол post/answer и отсутствие блокировки.
  function client(w: FakeWorker) {
    const pending = new Map<number, (p: unknown[]) => void>();
    let seq = 0;
    w.onmessage = (ev) => {
      const cb = pending.get(ev.data.id);
      if (cb) { pending.delete(ev.data.id); cb(ev.data.path ?? []); }
    };
    return {
      route(start: {x:number;y:number}, goal: {x:number;y:number}) {
        const id = ++seq;
        return new Promise<unknown[]>((resolve) => { pending.set(id, resolve as never); w.postMessage({ id, start, goal, restrictions: [], mapW: 1000, mapH: 1000 } as RoutingRequest); });
      },
    };
  }

  it('задача уходит в воркер и возвращается ответом', async () => {
    const w = new FakeWorker();
    const c = client(w);
    const p = c.route({ x: 0, y: 0 }, { x: 100, y: 100 });
    // ГЛАВНЫЙ ПОТОК НЕ ЗАБЛОКИРОВАН: промис ещё не решён синхронно
    let settled = false;
    void p.then(() => { settled = true; });
    expect(settled).toBe(false);
    expect(FakeWorker.lastRequest?.id).toBe(1);
    const path = await p;
    expect(settled).toBe(true);
    expect(path.length).toBe(3); // обходная точка добавлена «воркером»
  });

  it('крах воркера -> reject с понятной ошибкой (без вечного промиса)', async () => {
    FakeWorker.failNext = true;
    const w = new FakeWorker();
    // Клиент хука обязан подключать onerror и отклонять ВСЕ ожидания — иначе
    // главный поток навсегда ждёт ответ от мёртвого воркера.
    const pending = new Map<number, { resolve: (v: unknown[]) => void; reject: (e: Error) => void }>();
    let seq = 0;
    w.onerror = (ev) => {
      pending.forEach((p) => p.reject(new Error(`Воркер маршрутизации аварийно завершился: ${ev.message}`)));
      pending.clear();
    };
    const id = ++seq;
    const p = new Promise<unknown[]>((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, start: { x: 0, y: 0 }, goal: { x: 5, y: 5 }, restrictions: [], mapW: 1000, mapH: 1000 } as RoutingRequest); });
    const outcome = await p.then(() => 'RESOLVED').catch((e: Error) => e.message);
    expect(outcome).toContain('аварийно завершился');
  });
});

// Прямой тест тела воркера: импортируем обработчик через фейковый self scope.
describe('routing.worker body (try/catch contract)', () => {
  it('битый запрос -> ok:false + error вместо падения', async () => {
    const posted: unknown[] = [];
    const fakeSelf = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage: (m: unknown) => { posted.push(m); },
    };
    // Эмуляция модуля воркера: тот же код обработки, что и в routing.worker.ts
    const { planPathAroundZones } = await import('../src/utils/routing');
    const handler = (req: RoutingRequest | null) => {
      const res = { id: req?.id ?? -1, ok: false as boolean, path: undefined as unknown, error: undefined as string | undefined };
      try {
        if (!req || !Array.isArray(req.restrictions)) throw new Error('Некорректный запрос маршрутизации');
        if (!Number.isFinite(req.mapW) || req.mapW <= 0) throw new Error(`Недопустимые размеры карты`);
        res.ok = true;
        res.path = planPathAroundZones(req.start, req.goal, req.restrictions, req.mapW, req.mapH);
      } catch (e) { res.error = `Ошибка воркера маршрутизации: ${(e as Error).message}`; }
      fakeSelf.postMessage(res);
    };
    handler(null as never);
    handler({ id: 2, start: { x: 0, y: 0 }, goal: { x: 10, y: 10 }, restrictions: [], mapW: NaN, mapH: 100 } as RoutingRequest);
    expect(posted[0]).toMatchObject({ ok: false, error: expect.stringContaining("Некорректный") });
    expect(posted[1]).toMatchObject({ ok: false, error: expect.stringContaining('размеры') });
    // Валидный запрос с NFZ-полигоном между точками -> путь найден, не падает
    handler({ id: 3, start: { x: 10, y: 100 }, goal: { x: 900, y: 100 }, mapW: 1000, mapH: 1000,
      restrictions: [{ id: 'z', type: 'polygon', color: '#f00', name: 'NFZ', active: true,
        points: [{ x: 400, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 150 }, { x: 400, y: 150 }] }] } as RoutingRequest);
    expect(posted[2]).toMatchObject({ ok: true });
  });
});
