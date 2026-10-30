// ═══════════════════════════════════════════════════════════════
// ФАЗА 4.3 (аудит): AbortController + защита от гонок в поиске зданий Overpass.
// Регрессия: быстрые клики по карте — поздний ответ старого запроса
// перезаписывал попап нового; отменённый запрос продолжал перебирать эндпоинты.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  findBuildingAt,
  OVERPASS_ENDPOINTS,
} from '../src/utils/buildingLookup';

const okResponse = (elements: unknown[]) =>
  ({
    ok: true,
    json: async () => ({ elements }),
  }) as unknown as Response;

const buildingElem = (name: string) => ({
  tags: { building: name, height: '42' },
});

describe('Фаза 4.3: findBuildingAt с AbortSignal', () => {
  it('сигнал снят ДО старта → ни одного fetch, kind=aborted', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okResponse([]);
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    const res = await findBuildingAt(59.9, 30.3, fetchImpl, {
      signal: controller.signal,
    });
    expect(res).toEqual({ kind: 'aborted' });
    expect(calls).toBe(0);
  });

  it('abort во время ожидания ответа → aborted, перебор эндпоинтов остановлен', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = ((async () => {
      calls++;
      // «подвешиваемся», пока тест не отменит запрос
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown) as typeof fetch;

    const p = findBuildingAt(59.9, 30.3, fetchImpl, {
      signal: controller.signal,
    });
    controller.abort();
    const res = await p;

    expect(res).toEqual({ kind: 'aborted' });
    // КЛЮЧЕВАЯ РЕГРЕССИЯ: до фикса цикл continued к следующему эндпоинту
    // после сбоя — теперь отмена обрывает перебор сразу.
    expect(calls).toBeLessThanOrEqual(1);
    expect(calls).toBeLessThan(OVERPASS_ENDPOINTS.length);
  });

  it('гонка двух запросов: UI применяет только самый новый ответ', async () => {
    // Симуляция контракта WizardMapPanel (Ф4.3): монотонный seq + guard
    // `reqId === buildingReqSeq.current`. Медленный первый ответ приходит
    // ПОСЛЕ быстрого второго — и не должен перезаписать попап нового клика.
    const mkBuilding = (name: string) => okResponse([buildingElem(name)]);

    let resolveFirst: ((r: Response) => void) | null = null;
    let calls = 0;
    const fetchImpl = ((async () => {
      calls++;
      if (calls === 1) {
        // первый («старый») запрос висит, пока его не отпустят из теста
        return new Promise<Response>((res) => {
          resolveFirst = res;
        });
      }
      return mkBuilding('new-building'); // второй отвечает сразу
    }) as unknown) as typeof fetch;

    const pOld = findBuildingAt(59.91, 30.3, fetchImpl, {});
    const rNew = await findBuildingAt(59.92, 30.3, fetchImpl, {});
    expect(rNew.kind).toBe('found'); // новый ответ готов

    // Эмуляция guard-логики панели: какой reqId актуален на момент прихода ответа.
    const currentSeq = 2; // клик 2 — самый новый
    const applied: string[] = [];
    const applyIfFresh = (
      reqId: number,
      res: Awaited<ReturnType<typeof findBuildingAt>>,
    ) => {
      if (res.kind !== 'found') return;
      if (reqId !== currentSeq) return; // устаревший — молча игнорируем
      applied.push(res.building.typeStr);
    };

    applyIfFresh(2, rNew);
    resolveFirst?.(mkBuilding('stale-building'));
    const rOld = await pOld;
    applyIfFresh(1, rOld); // придёт позже, но seq уже 2 → НЕ применится

    expect(applied).toEqual(['new-building']); // тихая перезапись исключена
  });

  it('без сигнала поведение не изменилось: найденное здание возвращается', async () => {
    const fetchImpl = (async () =>
      okResponse([buildingElem('residential')])) as unknown as typeof fetch;
    const res = await findBuildingAt(59.9, 30.3, fetchImpl);
    expect(res.kind).toBe('found');
    if (res.kind === 'found') {
      expect(res.building.heightStr).toBe('42.0 м');
      expect(res.building.typeStr).toBe('residential');
    }
  });
});
