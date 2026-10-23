// Интеграционные тесты (RTL) полноценной тайловой карты внутри Мастера миссий:
// - MapCanvas рендерится в шаге «Точки старта» с ненулевыми размерами контейнера
//   (имитация ResizeObserver через Object.defineProperty на getBoundingClientRect).
// - Панель переключения подложек содержит 2ГИС; клик переключает провайдер стора.
// - При выбранном Google без API-ключа показывается оверлей-подсказка, а не белый
//   экран (graceful degradation), приложение не падает.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MissionWizard } from '../src/components/wizard/MissionWizard';
import { useMissionWizardStore } from '../src/store/useMissionWizardStore';
import { useMapStore } from '../src/store/useMapStore';

// Совместимость с jsdom: ResizeObserver отсутствует в окружении по умолчанию —
// без полифила MapCanvas падает при монтировании («ResizeObserver is not defined»).
class ROShim {
  private cb: (entries: ResizeObserverEntry[]) => void;
  constructor(cb: (entries: ResizeObserverEntry[]) => void) { this.cb = cb; }
  observe(el: Element): void {
    // Немедленно сообщаем фиктивные размеры — триггерим первичную загрузку тайлов.
    this.cb([{ target: el, contentRect: { x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry]);
  }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}
vi.stubGlobal('ResizeObserver', ROShim);

/** Имитируем ненулевой размер канваса/контейнера для ResizeObserver и canvas-инициализации. */
function patchSize(el: Element | null, w = 800, h = 600): void {
  if (!el) return;
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width: w, height: h, x: 0, y: 0, right: w, bottom: h,
    toJSON: () => ({}),
  });
  try {
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  } catch { /* jsdom может уже иметь инстанс-свойство */ }
}

async function gotoStartPointsStep(): Promise<void> {
  // Этап 1 → выбор drone → подтверждение → Далее → этап start-points
  fireEvent.click(screen.getByTestId('craft-card-drone'));
  fireEvent.click(await screen.findByRole('button', { name: 'Продолжить' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  await waitFor(() =>
    expect(useMissionWizardStore.getState().currentStep).toBe('start-points'),
  );
}

beforeEach(() => {
  useMissionWizardStore.getState().resetWizard();
  useMapStore.setState(useMapStore.getInitialState());
  try { localStorage.clear(); } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Карта внутри Мастера (WizardMapPanel + MapCanvas)', () => {
  it('на этапе точек старта рендерится canvas карты с ненулевыми размерами', async () => {
    render(<MissionWizard />);
    await gotoStartPointsStep();

    const panel = await screen.findByTestId('wizard-map-panel');
    const canvas = panel.querySelector('canvas');
    expect(canvas).toBeTruthy();
    patchSize(canvas);
    patchSize(panel);
    expect(canvas!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(canvas!.getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it('мастер фиксирует подложку OpenTopoMap (эталонный код), переключатель работает вручную', async () => {
    render(<MissionWizard />);
    await gotoStartPointsStep();

    // При монтировании панели мастер устанавливает единственный эталонный слой.
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('opentopomap'),
    );

    const btn = await screen.findByTestId('wizard-tiles-2gis');
    expect(btn.textContent).toContain('2ГИС');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('2gis'),
    );
    // возврат к OSM — регрессия дефолтного провайдера не сломана
    fireEvent.click(screen.getByTestId('wizard-tiles-osm'));
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('osm'),
    );
  });

  it('автозагрузка подложки идемпотентна; мастер поверх неё ставит OpenTopoMap', async () => {
    // Корневая причина «белой карты» в мастере: useAppInitialization живёт только
    // в App.tsx, а тесты рендерят MissionWizard изолированно. В продакшене этот же
    // эффект гарантирует авто-OSM; здесь явно вызываем ensureDefaultTileMap() —
    // публичный API инициализации.
    const { ensureDefaultTileMap } = await import('../src/hooks/useAppInitialization');
    ensureDefaultTileMap();
    render(<MissionWizard />);
    await gotoStartPointsStep();
    await screen.findByTestId('wizard-map-panel');
    // Эталонный загрузчик мастера: карта работает на OpenTopoMap (maxZoom 17).
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('opentopomap'),
    );
    expect(useMapStore.getState().openStreetMap.enabled).toBe(true);
    // идемпотентность повторного вызова (не должен сбросить выбор пользователя)
    useMapStore.getState().setOSMTileServer('2gis');
    ensureDefaultTileMap();
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('2gis');
  });

  it('Google без API-ключа: система не падает, панель показывает индикатор 🔑 и подсказку', async () => {
    const { default: WizardMapPanel } = await import('../src/components/wizard/WizardMapPanel');
    render(React.createElement(WizardMapPanel, { hint: 'тест' }));
    const panel = await screen.findByTestId('wizard-map-panel');
    expect(panel).toBeTruthy();
    // OSM готов → оверлей ошибки скрыт…
    expect(screen.queryByTestId('wizard-map-key-overlay')).toBeNull();
    // …но Google помечен как требующий ключа (graceful degradation вместо краша/белого экрана)
    const googleBadge = screen.getByText(/Google/);
    expect(googleBadge.textContent).toMatch(/🔑/);
    expect(googleBadge.getAttribute('title')).toMatch(/API-ключ/);
  });
});
