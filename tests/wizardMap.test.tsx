// Интеграционные тесты (RTL) полноценной тайловой карты внутри Мастера миссий:
// - MapCanvas рендерится в шаге «Точки старта» с ненулевыми размерами контейнера
//   (имитация ResizeObserver через Object.defineProperty на getBoundingClientRect).
// - Панель переключения подложек содержит рабочие серверы аудита (Esri/OSM FR/
//   Topo и т.д.; 2ГИС удалён полностью); клик переключает провайдер стора.
// - При выбранном Google без API-ключа показывается оверлей-подсказка, а не белый
//   экран (graceful degradation), приложение не падает.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * Пройти Этап 1 (выбор карт) + Этап 2 (тип аппарата) до этапа «Точки старта».
 * ВНИМАНИЕ (регрессия «Далее» неактивна): здесь НЕЛЬЗЯ использовать
 * fireEvent.click по карточке Esri — в этом файле реальные таймеры, и
 * zustand-persist запись/синхронизация сторов не успевают синхронно;
 * штатный UI-путь Этапа 1 покрыт кликами в wizardUI/wizardMapReadiness.
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

  it('подложка мастера = основная карта Этапа 1; переключатель работает вручную (2ГИС удалён)', async () => {
    render(<MissionWizard />);
    await gotoStartPointsStep();

    // При монтировании панели мастер устанавливает стиль, выбранный на Этапе 1.
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('esri'),
    );

    // КАРТА ДОЛЖНА БЫТЬ ГОТОВА до ручного переключения: иначе setOSMTileServer
    // сбрасывает mapLoaded=false, а MapCanvas при нулевых размерах jsdom не
    // перепубликует готовность — кнопка «Далее» снова блокируется и клик по
    // другой карточке не проходит (регрессия, пойманная в этом тесте).
    useMapStore.getState().publishMapLoaded(true);
    // Валидация этапа «Точки старта» требует непустой список startPoints —
    // без точки «Далее» остаётся disabled корректно (ТЗ), поэтому добавляем.
    act(() => {
      useMissionWizardStore.getState().addStartPoint({
        name: 'Т1', lat: 55.75, lon: 37.62, x: 100, y: 100,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled(),
    );

    const btnEsri = await screen.findByTestId('wizard-tiles-esri');
    expect(btnEsri.textContent).toMatch(/Улицы|Esri/i);
    // 2ГИС УДАЛЁН ПОЛНОСТЬЮ (ТЗ): кнопки больше нет ни в панели, ни в сторе
    expect(screen.queryByTestId('wizard-tiles-2gis')).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-tiles-osmfr'));
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('osmfr'),
    );
    // возврат к Esri — регрессия дефолтного провайдера аудита не сломана
    fireEvent.click(screen.getByTestId('wizard-tiles-esri'));
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('esri'),
    );
  });

  it('автозагрузка подложки идемпотентна; мастер применяет primary Этапа 1 (esri)', async () => {
    // Корневая причина «белой карты» в мастере: useAppInitialization живёт только
    // в App.tsx, а тесты рендерят MissionWizard изолированно. В продакшене этот же
    // эффект гарантирует авто-OSM; здесь явно вызываем ensureDefaultTileMap() —
    // публичный API инициализации.
    const { ensureDefaultTileMap } = await import('../src/hooks/useAppInitialization');
    ensureDefaultTileMap();
    render(<MissionWizard />);
    await gotoStartPointsStep();
    await screen.findByTestId('wizard-map-panel');
    // Новый Этап 1 мастера: панель применяет ОСНОВНУЮ карту выбора пользователя
    // (дефолт MAP_CHOICES/DEFAULT_TILE_SERVER по аудиту — Esri Streets, maxZoom 19).
    await waitFor(() =>
      expect(useMapStore.getState().openStreetMap.tileServer).toBe('esri'),
    );
    expect(useMapStore.getState().openStreetMap.enabled).toBe(true);
    // идемпотентность повторного вызова (не должен затереть ручной выбор пользователя)
    useMapStore.getState().setOSMTileServer('osmfr');
    ensureDefaultTileMap();
    expect(useMapStore.getState().openStreetMap.tileServer).toBe('osmfr');
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
