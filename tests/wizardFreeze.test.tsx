// Интеграционные тесты стабильности Мастера миссий (P0 «зависания/краши»):
//  1) MapCanvas с НУЛЕВЫМИ размерами контейнера не крашится и не уходит в
//     бесконечный цикл перерисовок — вместо вечного спиннера показывается
//     явная ошибка «Не удалось определить размер контейнера карты».
//  2) Быстрое переключение шагов Мастера (монтирование/размонтирование карты)
//     НЕ оставляет незавершённых загрузок тайлов: cleanup при unmount обязан
//     отменить все in-flight загрузки (img.abort()) — иначе утечка памяти и
//     setState на размонтированном компоненте.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MissionWizard } from '../src/components/wizard/MissionWizard';
import { useMissionWizardStore } from '../src/store/useMissionWizardStore';
import { useMapStore } from '../src/store/useMapStore';

// ── Мок Image со счётчиком активных/отменённых загрузок ─────────────────────
class TrackedImage {
  static active = 0;
  static abortedCount = 0;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _live = true;
  set src(_v: string) { /* никогда не отвечает — имитируем медленный CDN */ }
  get src(): string { return ''; }
  removeAttribute(_n: string): void { /* noop */ }
  abort(): void {
    if (this._live) { this._live = false; TrackedImage.abortedCount++; TrackedImage.active--; }
  }
  constructor() { TrackedImage.active++; }
}

/** ResizeObserver-заглушка: НИКОГДА не вызывает callback → размеры останутся 0. */
class SilentROShim {
  observe(): void { /* молчим: первый замер тоже mock'аем через getBoundingClientRect=0 */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

/** RO-заглушка с немедленной доставкой ненулевых размеров (нормальный путь). */
class DeliveringROShim {
  private cb: (entries: ResizeObserverEntry[]) => void;
  /** Все живые экземпляры — чтобы тест мог форсить доставку колбэков. */
  static instances: DeliveringROShim[] = [];
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    this.cb = cb;
    DeliveringROShim.instances.push(this);
  }
  observe(el: Element): void {
    DeliveringROShim.deliver(this.cb, el);
  }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
  private static deliver(cb: (entries: ResizeObserverEntry[]) => void, el: Element): void {
    cb([{ target: el, contentRect: { x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry]);
  }
  /** Принудительная повторная доставка размеров на все наблюдаемые элементы. */
  static forceDeliver(): void {
    for (const inst of DeliveringROShim.instances) {
      const els = Array.from(document.querySelectorAll('#map-container, canvas'));
      for (const el of els) DeliveringROShim.deliver(inst.cb, el);
    }
  }
}

/**
 * Пройти Этап 1 (выбор карт) + Этап 2 (тип аппарата) до этапа «Точки старта».
 * ВНИМАНИЕ (регрессия «Далее» неактивна): здесь НЕЛЬЗЯ использовать
 * fireEvent.click по карточке Esri — в этом файле реальные таймеры, и
 * zustand-persist запись/синхронизация сторов не успевают синхронно;
 * штатный UI-путь Этапа 1 покрыт кликами в wizardMapReadiness/wizardUI.
 */
async function gotoStartPointsStep(): Promise<void> {
  act(() => { useMissionWizardStore.getState().toggleMapChoice('esri'); });
  await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Далее/ })); // → craft-selection
  fireEvent.click(screen.getByTestId('craft-card-drone'));
  fireEvent.click(await screen.findByRole('button', { name: 'Продолжить' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  await waitFor(() =>
    expect(useMissionWizardStore.getState().currentStep).toBe('start-points'),
  );
}

beforeEach(() => {
  TrackedImage.active = 0;
  TrackedImage.abortedCount = 0;
  useMissionWizardStore.getState().resetWizard();
  useMapStore.setState(useMapStore.getInitialState());
  try { localStorage.clear(); } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('wizardFreeze — защита от зависаний в Мастере', () => {
  it('нулевые размеры контейнера: без краша, вместо вечной загрузки — явная ошибка с кнопкой повтора', async () => {
    vi.stubGlobal('ResizeObserver', SilentROShim);
    vi.stubGlobal('Image', TrackedImage);
    // happy-dom может иметь нативный rAF с реальным дренажом — подменяем no-op,
    // чтобы гарантировать «RO никогда не доставил размеры».
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    render(<MissionWizard />);
    await gotoStartPointsStep();

    // П0-детерминизм: гарантируем, что подложка НЕ активна до патчинга размеров.
    // Иначе автозагрузка OSM (ensureDefaultTileMap в WizardMapPanel) успевает
    // стартовать на синхронном первичном замере реальных размеров jsdom — до
    // того, как тест обнулит контейнер, — и начнёт качать тайлы «в пустоту».
    useMapStore.setState({ map: null });

    const panel = await screen.findByTestId('wizard-map-panel');
    // Контейнер КАРТЫ (map-container внутри панели) обнуляем до 0×0 — имитация
    // «display:none у родителя» / сломанного layout. Именно его измеряет MapCanvas.
    const mapContainer = panel.querySelector('#map-container') ?? panel;
    mapContainer.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 0, height: 0, x: 0, y: 0, right: 0, bottom: 0, toJSON: () => ({}),
    });
    Object.defineProperty(mapContainer, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(mapContainer, 'clientHeight', { value: 0, configurable: true });

    // Карта НЕ должна грузить тайлы при нулевом размере (защита от NaN-математики)
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(TrackedImage.active).toBe(0);

    // Явная детерминированная активация подложки ПОСЛЕ обнуления размеров:
    // с этого момента любые попытки загрузки возможны только из колбэков RO/rAF,
    // которые в этом тесте заглушены (SilentROShim + no-op rAF). Если бы MapCanvas
    // читал размеры асинхронно «на живую», он бы начал качать тайлы при 0×0.
    act(() => {
      useMapStore.getState().loadActiveTileMap({ lat: 55.7558, lng: 37.6173 }, 10);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(TrackedImage.active).toBe(0);

    // И НЕ должна висеть вечно: circuit breaker показывает ошибку + кнопку повтора
    const overlay = await screen.findByTestId('map-size-error-overlay', {}, { timeout: 3000 });
    expect(overlay.textContent).toMatch(/размер контейнера/i);
    expect(screen.getByTestId('map-retry-measure')).toBeTruthy();
  });

  it('быстрое переключение шагов: unmount карты отменяет ВСЕ in-flight загрузки тайлов (нет утечек)', async () => {
    vi.stubGlobal('ResizeObserver', DeliveringROShim);
    vi.stubGlobal('Image', TrackedImage);

    render(<MissionWizard />);
    await gotoStartPointsStep();
    await screen.findByTestId('wizard-map-panel');

    // Детерминизм (та же причина, что и в тесте №1): первичный замер размеров в
    // MapCanvas выполняется в серии отложенных повторов [0,60,...,1300] мс, а
    // gotoStartPointsStep отрабатывает быстрее — на момент явной активации
    // подложки canvasSize ещё может быть нулевым, и syncTileDom по «гейту
    // размера» не создаст ни одного Image (started=0). Форсируем штатную
    // публикацию ненулевых размеров синхронным вызовом колбэка RO.
    act(() => { DeliveringROShim.forceDeliver(); });
    // Тайловая подложка активна: карта с ненулевыми размерами начнёт качать
    // тайлы, которые НИКОГДА не завершатся (медленный CDN) — стресс-тест cleanup.
    act(() => {
      useMapStore.getState().loadActiveTileMap({ lat: 55.7558, lng: 37.6173 }, 10);
    });

    // Даём карте поставить загрузки в очередь
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const started = TrackedImage.active;
    expect(started).toBeGreaterThan(0); // загрузка реально стартовала

    // Быстрый выход с этапа: прямой экшен стора goToPreviousStep() — deliberate
    // navigation (инвариант теста — cleanup MapCanvas при unmount, а не клики).
    // Клик по «← Назад» из footer здесь НЕ годится: валидация этапа «Точки
    // старта» требует непустой startPoints, кнопка disabled, и клик молча
    // ничего не делает → unmount не происходит → in-flight остаются живыми.
    act(() => { useMissionWizardStore.getState().goToPreviousStep(); });
    await waitFor(() =>
      expect(useMissionWizardStore.getState().currentStep).toBe('craft-selection'),
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // Ключевое утверждение P0: после unmount НЕ осталось ни одной живой загрузки —
    // все отменены (img.abort()), слоты очереди освобождены, память не течёт.
    expect(TrackedImage.active).toBe(0);
    expect(TrackedImage.abortedCount).toBeGreaterThanOrEqual(started);
  });
});
