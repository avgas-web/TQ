// Mock Web Worker для Vitest: эмулирует асинхронный postMessage/onmessage через
// setTimeout(0) — так же, как настоящий worker, НЕ вызывая обработчик синхронно.
import type { RoutingRequest, RoutingResponse } from '../../src/workers/routingProtocol';

export class FakeWorker {
  onmessage: ((ev: MessageEvent<RoutingResponse>) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  static failNext = false; // тест «воркер упал при сложном NFZ»
  static lastRequest: RoutingRequest | null = null;

  postMessage(req: RoutingRequest): void {
    FakeWorker.lastRequest = req;
    const shouldFail = FakeWorker.failNext;
    setTimeout(() => {
      if (shouldFail) {
        if (this.onerror) this.onerror({ message: 'simulated worker crash' });
        return;
      }
      // Ответ «из воркера»: обход-путь с одной дополнительной точкой
      const res: RoutingResponse = {
        id: req.id,
        ok: true,
        path: [req.start, { x: (req.start.x + req.goal.x) / 2, y: Math.min(req.start.y, req.goal.y) - 50 }, req.goal],
      };
      this.onmessage?.(new MessageEvent('message', { data: res }));
    }, 0);
  }

  terminate(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
}
