// ═══════════════════════════════════════════════════════════════
// MockWorker — управляемый дубль Web Worker для тестов ЭТАПА 1.1.
// Эмулирует асинхронный postMessage/onmessage контракт mapParsers.worker:
//  • запросы кладутся в очередь; ответ доставляется только когда тест
//    явно вызывает flush()/flushNext() (или через setTimeout при delayMs) —
//    это позволяет проверить, что пока воркер «парсит» >10MB файла,
//    основной поток свободен (таймеры/ререндеры проходят).
//  • фиксирует переданные Transferable-списки (проверка zero-copy).
// ═══════════════════════════════════════════════════════════════
import type { ParserRequest, ParserResponse } from '../../src/utils/mapParserProtocol';

interface QueuedTask {
  req: ParserRequest;
  transfer: Transferable[];
}

export interface MockWorkerHandlers {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

export class MockWorker extends EventTarget implements Partial<Worker> {
  static instances: MockWorker[] = [];

  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  terminated = false;
  /** Все принятые запросы с их transfer-списками */
  readonly requests: QueuedTask[] = [];
  private queue: QueuedTask[] = [];
  /** Задержка доставки ответа, мс (эмуляция долгого парсинга) */
  delayMs = 0;

  constructor(_url?: string | URL, _opts?: WorkerOptions) {
    super();
    MockWorker.instances.push(this);
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    if (this.terminated) throw new Error('worker is terminated');
    this.requests.push({ req: data as ParserRequest, transfer: transfer ?? [] });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message', handler: (ev: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', handler: (ev: Event) => void): void;
  addEventListener(type: string, handler: (ev: unknown) => void): void {
    if (type === 'message') this.onmessage = handler as (ev: MessageEvent<unknown>) => void;
    if (type === 'error') this.onerror = handler as (ev: Event) => void;
  }

  removeEventListener(): void { /* noop for tests */ }

  // ─── Управление из теста ──────────────────────────────────────────────
  pendingCount(): number { return this.queue.length + this.requests.length - this.delivered(); }
  private deliveredCount = 0;
  private delivered(): number { return this.deliveredCount; }

  /** Доставить ответы на все принятые запросы (асинхронно, как реальный worker) */
  flush(responder: (req: ParserRequest) => Omit<ParserResponse, 'taskId' | 'op'>): void {
    const batch = this.requests.slice(this.deliveredCount);
    this.deliveredCount += batch.length;
    for (const task of batch) {
      const base = responder(task.req);
      const res: ParserResponse = { taskId: task.req.taskId, op: task.req.op, ...base };
      const deliver = (): void => {
        const ev = new MessageEvent<unknown>('message', { data: res });
        this.onmessage?.(ev);
        this.dispatchEvent(ev);
      };
      if (this.delayMs > 0) setTimeout(deliver, this.delayMs);
      else queueMicrotask(deliver);
    }
  }

  /** Симуляция аварийного падения воркера (onerror) */
  crash(): void {
    const ev = new Event('error');
    this.onerror?.(ev);
    this.dispatchEvent(ev);
  }

  /** Последний запрос + его transfer-список */
  lastRequest(): QueuedTask | undefined {
    return this.requests[this.requests.length - 1];
  }
}

export function resetMockWorkers(): void {
  MockWorker.instances = [];
}

/** Взять воркер, созданный под тестом (последний инстанс) */
export function lastMockWorker(): MockWorker {
  const w = MockWorker.instances[MockWorker.instances.length - 1];
  if (!w) throw new Error('MockWorker не был создан — проверьте stub глобального Worker');
  return w;
}
