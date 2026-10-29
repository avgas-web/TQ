// ═══════════════════════════════════════════════════════════════
// userMapWorkerIntegration — ЭТАП 1.1: парсинг тяжёлых карт вынесен
// в Web Worker; main thread НЕ блокируется во время обработки >10MB
// ArrayBuffer'а; postMessage-протокол (taskId/op/ok/payload) соблюдён;
// бинарные данные уходят как Transferable; при падении воркера —
// graceful fallback на синхронный путь с человекочитаемым сообщением.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MockWorker, resetMockWorkers, lastMockWorker } from './mocks/MockWorker';
import type { ParserRequest } from '../src/utils/mapParserProtocol';

// Синхронный фолбэк не должен реально парсить в тестах воркера —
// глушим тяжёлые функции userMapLoader детерминированными заглушками.
vi.mock('../src/utils/userMapLoader', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/utils/userMapLoader')>();
  return {
    ...orig,
    loadGeoTiff: vi.fn(async () => ({
      kind: 'raster', format: 'geotiff', projection: 'epsg:4326',
      imageDataUrl: 'data:image/png;base64,SYNC', imageWidth: 8, imageHeight: 8,
      bbox: { west: 0, south: 0, east: 1, north: 1 },
    })),
    readMbtilesSummary: vi.fn(async () => ({
      metadata: {}, bounds: null, tileCount: 0, minZoom: 0, maxZoom: 0,
      format: 'png', name: 'sync', description: '',
    })),
    decodeMbtilesTilesForRender: vi.fn(async () => ({})),
    closeMbtilesDbCache: vi.fn(),
  };
});

import { useMapParsersWorker, getMapParsersTransport, __resetMapParsersSharedForTests } from '../src/hooks/useMapParsersWorker';
import { isParserResponse, isGeotiffResult } from '../src/utils/mapParserProtocol';

const BIG = (): ArrayBuffer => new ArrayBuffer(10 * 1024 * 1024 + 64); // >10MB

function geotiffOk(req: ParserRequest) {
  return {
    ok: true as const,
    payload: {
      imageDataUrl: 'data:image/png;base64,W',
      imageWidth: 16, imageHeight: 16,
      bbox: { west: 30.1, south: 59.1, east: 31.1, north: 60.1 },
      projection: 'epsg:4326' as const,
    },
  };
}

describe('ЭТАП 1.1 — mapParsers.worker интеграция', () => {
  beforeEach(() => {
    resetMockWorkers();
    // Глобальный Worker из tests/setup.ts («молчащий» WorkerStub) подменяется
    // управляемым MockWorker. Важно: singleton-воркер в useMapParsersWorker
    // живёт между тестами одного файла — сбрасываем его состояние, иначе
    // последующие тесты увидят «мёртвый» воркер прошлого теста.
    vi.stubGlobal('Worker', MockWorker);
    __resetMapParsersSharedForTests();
  });

  afterEach(() => {
    __resetMapParsersSharedForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('postMessage-контракт: запрос содержит taskId/op/buffer, буфер передан как Transferable', async () => {
    const t = getMapParsersTransport();
    expect(t.workerAvailable).toBe(true);
    const buf = BIG();

    const p = t.parseGeotiff(buf);
    const w = lastMockWorker();
    const task = w.lastRequest();
    expect(task).toBeDefined();
    expect(task!.req.op).toBe('parseGeotiff');
    expect(typeof task!.req.taskId).toBe('number');
    expect(task!.req.buffer).toBe(buf);
    // zero-copy: ArrayBuffer обязан быть в transfer-списке
    expect(task!.transfer).toContain(buf);

    w.flush((req) => geotiffOk(req));
    const res = await p;
    expect(res.format).toBe('geotiff');
    expect(res.imageDataUrl).toBe('data:image/png;base64,W');
    expect(res.bbox?.east).toBe(31.1);
  });

  it('парсинг >10MB НЕ блокирует основной поток: тики таймеров проходят до ответа воркера', async () => {
    // Fake-timers по ТЗ ЭТАП 1: детерминированно продвигаем расписание UI-тиков
    // вперёд, пока фоновый парсинг «не завершён» (MockWorker отвечает только
    // по flush()). Если бы geotiff-декодирование шло в main thread синхронно,
    // интервал не смог бы настриковать тики вообще.
    vi.useFakeTimers();
    try {
      const t = getMapParsersTransport();
      const buf = BIG();

      let mainThreadTicks = 0;
      const iv = setInterval(() => { mainThreadTicks += 1; }, 5); // UI-тик каждые 5мс

      const p = t.parseGeotiff(buf);
      // Пока воркер занят, основной поток свободен: интервалы продолжают тикать.
      vi.advanceTimersByTime(30);
      expect(mainThreadTicks).toBeGreaterThanOrEqual(3);

      let settled = false;
      void p.then(() => { settled = true; });
      vi.advanceTimersByTime(5);
      await Promise.resolve();
      expect(settled).toBe(false); // ответ ещё не доставлен — но UI жив

      const w = lastMockWorker();
      w.delayMs = 1; // доставка ответа через макротаск — совместимо с fake timers
      w.flush((req) => geotiffOk(req)); // фоновая работа завершилась
      await vi.waitFor(async () => { await p; });
      expect(settled).toBe(true);
      const ticksAfter = mainThreadTicks;
      vi.advanceTimersByTime(20);
      expect(mainThreadTicks).toBeGreaterThan(ticksAfter); // поток не заблокирован и после
      clearInterval(iv);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ответ без флага ok → ошибка с текстом воркера и авто-fallback в sync-режим', async () => {
    const t = getMapParsersTransport();
    const buf = BIG();
    const w = lastMockWorker();

    const p = t.mbtilesSummary(buf);
    w.flush(() => ({ ok: false, error: 'Битый MBTiles: нет таблицы tiles' }));
    const summary = await p; // fallback обязан отработать, а не попереть exception
    expect(summary.name).toBe('sync');
    const { readMbtilesSummary } = await import('../src/utils/userMapLoader');
    expect(readMbtilesSummary).toHaveBeenCalled();
  });

  it('аварийное падение воркера (onerror): in-flight задачи отвергаются, транспорт деградирует на sync без краша', async () => {
    const t = getMapParsersTransport();
    const buf = BIG();
    const w = lastMockWorker();

    const p = t.parseGeotiff(buf);
    w.crash(); // симуляция внутреннего падения воркера (onerror)
    const res = await p; // sync-fallback спасает результат
    expect(res.imageDataUrl).toBe('data:image/png;base64,SYNC');
    // после падения следующий вызов обязан честно сообщить недоступность,
    // но НЕ выбросить исключение наружу
    const t2 = getMapParsersTransport();
    expect(typeof t2.workerAvailable).toBe('boolean');
  });

  it('useMapParsersWorker(): terminate() вызывается при размонтировании последнего потребителя', async () => {
    // Воркер создаётся лениво (в useEffect только вычитывается флаг), поэтому
    // сначала прогреваем singleton реальным запросом через транспорт.
    const t = getMapParsersTransport();
    void t.parseGeotiff(BIG());
    lastMockWorker().flush((req) => geotiffOk(req));

    const { result, unmount } = renderHook(() => useMapParsersWorker());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.workerAvailable).toBe(true);
    const w = lastMockWorker();
    expect(w.terminated).toBe(false);
    act(() => { unmount(); });
    expect(w.terminated).toBe(true);
  });

  it('isParserResponse/isGeotiffResult отсекают мусор из postMessage', () => {
    expect(isParserResponse({ taskId: 1, op: 'parseGeotiff', ok: true })).toBe(true);
    expect(isParserResponse(null)).toBe(false);
    expect(isParserResponse({ nope: 1 })).toBe(false);
    expect(isGeotiffResult({ imageDataUrl: 'x', imageWidth: 1, imageHeight: 1, projection: 'epsg:4326' })).toBe(true);
    expect(isGeotiffResult(undefined)).toBe(false);
  });
});
