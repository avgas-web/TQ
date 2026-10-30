// Интеграционные тесты (React Testing Library) этапов мастера: клики по
// мини-карте, поиск с моком Nominatim, confirmation-диалоги, прогресс-бар,
// горячие клавиши Alt+←/→, индикатор пересчёта NFZ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWizard } from '../src/components/wizard/MissionWizard';
import { useMissionWizardStore } from '../src/store/useMissionWizardStore';

const st = () => useMissionWizardStore.getState();

beforeEach(() => {
  st().resetWizard();
  // Новый Этап 1 «Выбор карт»: мастер стартует на map-selection; хелперы toCraft/toStart
  // ниже проходят его сами (st().toggleMapChoice('esri') + goToNextStep).
  // чистим localStorage между тестами: zustand persist гидрируется при старте
  // модуля, а ручные setState в тестах перекрывают состояние — но если какой-то
  // тест оставил «прогресс», следующий resetWizard() его стирает; localStorage
  // чистим для детерминизма автосохранений
  try { localStorage.clear(); } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals(); // снимаем mock'и fetch/Worker после каждого теста,
  // чтобы глобальный stub из одного теста не «съедал» моки следующего
  vi.restoreAllMocks();
});

// Инфраструктурный кэш высот (module-level Map в src/utils/elevation) живёт
// всю жизнь воркера тестов; без очистки мок-fetch из одного теста мог
// «прижить» значение для координат другого теста и лишить его сетевого запроса.
async function clearElevationCache() {
  const mod = await import('../src/utils/elevation');
  mod.__resetElevationCacheForTests?.();
}
beforeEach(clearElevationCache);

/** Ставим точку кликом по SVG-мини-карте (jsdom: getBoundingClientRect нулевой → координаты 0; поэтому используем fireEvent c clientX и моком rect). */
function clickMap(kind: 'start' | 'target', clientX: number, clientY: number) {
  const svg = document.querySelector(`svg[data-testid="minimap-${kind}"]`) as SVGSVGElement;
  expect(svg).toBeTruthy();
  // фиксированный rect 640x480 для детерминированной конвертации экранных координат
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, x: 0, y: 0, right: 640, bottom: 480, toJSON: () => ({}) });
  fireEvent.click(svg, { clientX, clientY });
}

/** Проход Этапа 1 «Выбор карт» → этап выбора типа. */
const toCraft = () => {
  st().toggleMapChoice('esri');
  st().goToNextStep(); // map-selection → craft-selection
};
/** Проход Этапов 1–2 → этап точек старта. */
const toStart = () => {
  toCraft();
  st().setCraftType('drone');
  st().goToNextStep(); // craft-selection → start-points
};

async function waitForNextEnabled(btn: HTMLElement) {
  await waitFor(() => expect(btn).toBeEnabled());
}

describe('Этап 1 UI — MapSelectionStep', () => {
  it('стартовый этап — выбор карт: «Далее» disabled без выбранной карты', async () => {
    render(<MissionWizard />);
    expect(screen.getByText(/Этап 1\/9/)).toBeTruthy();
    const next = screen.getByRole('button', { name: /Далее/ });
    expect(next).toBeDisabled();
    // отметка Esri разблокирует переход
    fireEvent.click(screen.getByTestId('map-choice-esri'));
    await waitForNextEnabled(next);
  });

  it('карточка основной карты помечена, счётчик выбранных обновляется', async () => {
    render(<MissionWizard />);
    fireEvent.click(screen.getByTestId('map-choice-esri'));
    fireEvent.click(screen.getByTestId('map-choice-opentopomap'));
    expect((screen.getByTestId('map-selection-count') as HTMLElement).textContent?.trim()).toMatch(/2/);
    // кнопка «основная» активна только для выбранных карт (инвариант primary ∈ selected)
    expect((screen.getByTestId('map-primary-osmfr') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('map-choice-osmfr'));
    fireEvent.click(screen.getByTestId('map-primary-osmfr'));
    expect(st().primaryMap).toBe('osmfr');
    expect(st().selectedMaps).toContain('osmfr');
    expect(screen.getByTestId('map-selection-primary').textContent).toContain('OSM France');
  });

  it('2ГИС отсутствует среди вариантов выбора', () => {
    render(<MissionWizard />);
    expect(screen.queryByTestId('map-choice-2gis')).toBeNull();
  });
});

describe('Этап 2 UI — CraftSelectionStep', () => {
  it('кнопка «Далее» disabled без выбора типа', () => {
    toCraft();
    render(<MissionWizard />);
    const next = screen.getByRole('button', { name: /Далее/ });
    expect(next).toBeDisabled();
  });

  it('показывает confirmation dialog при выборе и разблокирует «Далее» после подтверждения', async () => {
    toCraft();
    render(<MissionWizard />);
    fireEvent.click(screen.getByTestId('craft-card-drone'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Вы выбрали');
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
    expect(st().craftType).toBe('drone');
  });

  it('повторный выбор того же типа не создаёт ложного диалога и не сбрасывает данные', async () => {
    toCraft();
    render(<MissionWizard />);
    fireEvent.click(screen.getByTestId('craft-card-drone'));
    // первый клик открывает confirmation-диалог — подтверждаем фиксацию типа
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
    // повторный клик по уже выбранной карточке — диалога нет, выбор сохранён
    fireEvent.click(screen.getByTestId('craft-card-drone'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(st().craftType).toBe('drone');
  });

  it('смена зафиксированного типа сбрасывает последующие данные, но сохраняет выбор карт Этапа 1', () => {
    st().toggleMapChoice('esri'); // Этап 1 пройден
    st().setCraftType('drone');   // Этап 2 зафиксирован
    st().goToNextStep();          // → start-points
    st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 10, y: 10 });
    // UI подтверждённой смены типа (ConfirmDialog в CraftSelectionStep) вызывает ровно resetCraftChoice(newType)
    st().resetCraftChoice('uav');
    // сброс: точки удалены, новый тип зафиксирован; карты Этапа 1 СОХРАНЁНЫ (инвариант ТЗ)
    expect(st().currentStep).toBe('craft-selection');
    expect(st().startPoints).toHaveLength(0);
    expect(st().craftType).toBe('uav');
    expect(st().selectedMaps).toContain('esri');
  });
});

describe('Этап 3 UI — StartPointsStep', () => {
  beforeEach(toStart); // Этапы 1–2 пройдены → стартуем на точках старта

  it('клик по карте добавляет маркер с номером и точкой в сторе', () => {
    render(<MissionWizard />);
    clickMap('start', 160, 120);
    expect(st().startPoints).toHaveLength(1);
    expect(screen.getByTestId('marker-start-1')).toBeTruthy();
    expect(screen.getByText('1/100 точек')).toBeTruthy();
  });

  it('поиск по координатам «55.7558, 37.6173» добавляет точку', () => {
    render(<MissionWizard />);
    const input = screen.getByLabelText('Поиск точки старта');
    fireEvent.change(input, { target: { value: '55.7558, 37.6173' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(st().startPoints).toHaveLength(1);
    expect(st().startPoints[0].lat).toBeCloseTo(55.7558);
  });

  it('поиск по названию использует геокодер (мок fetch Nominatim)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '55.7539', lon: '37.6208', display_name: 'Красная площадь, Москва' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MissionWizard />);
    const input = screen.getByLabelText('Поиск точки старта');
    fireEvent.change(input, { target: { value: 'Москва, Красная площадь' } });
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
    await waitFor(() => expect(st().startPoints).toHaveLength(1));
    // Первый запрос — зеркало Nominatim (не основной блокируемый хост).
    expect(fetchMock.mock.calls[0][0]).toContain('nominatim');
    vi.unstubAllGlobals();
  });

  it('при недоступности Nominatim поиск падает на Photon (fallback)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('photon.komoot.io')) {
        return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [37.6208, 55.7539] } }] }) };
      }
      throw new TypeError('network down'); // все зеркала Nominatim недоступны
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MissionWizard />);
    const input = screen.getByLabelText('Поиск точки старта');
    fireEvent.change(input, { target: { value: 'Москва, Красная площадь' } });
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
    // Очередь Nominatim «1 запрос/с» + ротация зеркал: успех Photon наступает
    // через ~6–7 с реального времени — ждём с запасом.
    await waitFor(() => expect(st().startPoints).toHaveLength(1), { timeout: 15000 });
    const p = st().startPoints[0];
    expect(p.lat).toBeCloseTo(55.7539, 3);
    expect(p.lon).toBeCloseTo(37.6208, 3);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('photon.komoot.io'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('при недоступных геокодерах показывается статус-ошибка, точка НЕ добавляется', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down'); });
    vi.stubGlobal('fetch', fetchMock);
    render(<MissionWizard />);
    const input = screen.getByLabelText('Поиск точки старта');
    fireEvent.change(input, { target: { value: 'Что-то' } });
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
    await waitFor(() =>
      expect(screen.getByText(/Геокодер недоступен/)).toBeInTheDocument(),
      { timeout: 15000 },
    );
    expect(st().startPoints).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('drag маркера обновляет координаты БЕЗ изменения вида карты', () => {
    render(<MissionWizard />);
    clickMap('start', 160, 120);
    const marker = document.querySelector('circle') as Element;
    const svg = document.querySelector('svg[data-testid="minimap-start"]')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, x: 0, y: 0, right: 640, bottom: 480, toJSON: () => ({}) });
    fireEvent.pointerDown(marker);
    fireEvent.pointerMove(svg, { clientX: 320, clientY: 240 });
    fireEvent.pointerUp(svg);
    const p = st().startPoints[0];
    expect(p.x).toBeCloseTo(320);
    expect(p.y).toBeCloseTo(240);
  });

  it('«Далее» disabled без точек и enabled с одной точкой', async () => {
    render(<MissionWizard />);
    expect(screen.getByRole('button', { name: /Далее/ })).toBeDisabled();
    clickMap('start', 160, 120);
    await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  });

  it('удаление точки кнопкой ✛ в списке', () => {
    render(<MissionWizard />);
    clickMap('start', 160, 120);
    fireEvent.click(screen.getByLabelText('Удалить точку Старт 1'));
    expect(st().startPoints).toHaveLength(0);
  });
});

describe('Этап 4 UI — TargetPointsStep', () => {
  beforeEach(() => {
    toStart(); // Этапы 1–2 (выбор карт + тип) пройдены
    st().setCraftType('drone');
    st().goToNextStep();
    st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 100, y: 100 });
    st().goToNextStep();
  });

  it('маркеры целей отличаются от стартовых (kind=target)', () => {
    render(<MissionWizard />);
    expect(document.querySelector('svg[data-testid="minimap-target"]')).toBeTruthy();
    expect(screen.getByText(/\/1000/)).toBeTruthy();
  });

  it('цель рядом со стартом (<50 м) даёт warning в DOM', async () => {
    render(<MissionWizard />);
    st().addTargetPoint({ name: 'Ц', lat: 55.00001, lon: 37.00001, x: 100, y: 100 });
    await waitFor(() => {
      // В DOM теперь два role="status": баннер шага (StepIssues) и индикатор
      // состояния слоя подложки (пункт C аудита) — ищем текст среди всех.
      const statuses = screen.getAllByRole('status').map((el) => el.textContent ?? '');
      expect(statuses.join(' ')).toContain('слишком близко к точке старта');
    });
  });
});

describe('Этап 5 UI — FleetFormationStep', () => {
  beforeEach(() => {
    toStart(); // Этапы 1–2 пройдены
    st().setCraftType('drone');
    st().goToNextStep(); st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 100, y: 100 });
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep();
  });

  it('toggle режимов Авто/Вручную присутствует', () => {
    render(<MissionWizard />);
    expect(screen.getByTestId('mode-auto')).toBeTruthy();
    expect(screen.getByTestId('mode-manual')).toBeTruthy();
  });

  it('автозаполнение создаёт группы и открывает переход', async () => {
    render(<MissionWizard />);
    fireEvent.change(screen.getByTestId('total-craft'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('autofill-btn'));
    expect(st().fleetGroups.reduce((a, g) => a + g.totalCraft, 0)).toBe(3);
    await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  });
});

describe('Этап 6 UI — NFZAndRoutesStep', () => {
  const toNfz = async () => {
    toStart(); // Этапы 1–2 пройдены
    st().setCraftType('drone');
    st().goToNextStep(); st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 100, y: 100 });
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep();
    await st().calculateRoutes();
  };

  it('подсказка рисования полигона присутствует в DOM', async () => {
    await toNfz();
    render(<MissionWizard />);
    expect(screen.getByRole('note').textContent).toContain('двойной клик или Enter');
  });

  it('3 клика + двойной клик завершают полигон; Esc отменяет черновик', async () => {
    await toNfz();
    render(<MissionWizard />);
    const svg = document.querySelector('svg[data-testid="nfz-map"]')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, x: 0, y: 0, right: 640, bottom: 480, toJSON: () => ({}) });
    fireEvent.click(svg, { clientX: 200, clientY: 50 });
    fireEvent.click(svg, { clientX: 300, clientY: 50 });
    fireEvent.click(svg, { clientX: 250, clientY: 150 });
    // превью-линия и номера вершин в процессе рисования
    expect(svg.querySelector('polyline')).toBeTruthy();
    fireEvent.doubleClick(svg, { clientX: 250, clientY: 150 });
    await waitFor(() => expect(st().noFlyZones).toHaveLength(1));
    // Esc на новом черновике — отмена
    fireEvent.click(svg, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(st().noFlyZones).toHaveLength(1); // не завершился мусорным полигоном
  });

  it('добавление NFZ автоматически пересчитывает маршруты (индикатор + обход)', async () => {
    await toNfz();
    render(<MissionWizard />);
    st().addNoFlyZone({ name: 'Z', polygon: [{ x: 250, y: 60 }, { x: 350, y: 60 }, { x: 350, y: 140 }, { x: 250, y: 140 }] });
    await waitFor(() => {
      const r = st().calculatedRoutes[0];
      expect(r.blockedByNfz).toBe(false);
      expect(r.points.length).toBeGreaterThan(2);
    });
  });

  it('превышение дальности показывает баннер и кнопку подтверждения', async () => {
    await toNfz();
    render(<MissionWizard />);
    useMissionWizardStore.setState((s) => ({
      calculatedRoutes: s.calculatedRoutes.map((r) => ({ ...r, exceedsRange: true, acknowledged: false })),
    }));
    await waitFor(() => expect(screen.getByTestId('range-warning-banner')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить игнорирование/ }));
    expect(st().calculatedRoutes[0].acknowledged).toBe(true);
  });
});

describe('Этап 7 UI — AltitudeProfilesStep', () => {
  const toAlt = async () => {
    toStart(); // Этапы 1–2 пройдены
    st().setCraftType('drone');
    st().goToNextStep(); st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 100, y: 100 });
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep(); await st().calculateRoutes();
    st().goToNextStep();
  };

  it('запрашивает рельеф (мок Open-Elevation) и отображает значение', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ elevation: 152 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await toAlt();
    render(<MissionWizard />);
    await waitFor(() => expect(screen.getByTestId('terrain-readout').textContent).toContain('152'));
    expect(String(fetchMock.mock.calls[0][0])).toContain('open-elevation');
    vi.unstubAllGlobals();
  });

  it('при недоступном API показывает warning и позволяет продолжить', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await toAlt();
    render(<MissionWizard />);
    await waitFor(() => expect(screen.getByTestId('elevation-api-warning')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled(); // этап опционален
    vi.unstubAllGlobals();
  });

  it('добавление точки AGL ниже запаса 50м → красный статус в таблице', async () => {
    await toAlt();
    render(<MissionWizard />);
    const rid = st().calculatedRoutes[0].id;
    useMissionWizardStore.setState(() => ({}));
    st().addAltitudePoint({ routeId: rid, positionRatio: 0.5, altitudeAgl: 30, terrainM: 100 });
    await waitFor(() => expect(screen.getByText('✗ AGL < запаса 50м')).toBeTruthy());
    fireEvent.click(screen.getByTestId('auto-adjust'));
    // Регрессия Ф1.2 (аудит): автокоррекция поднимает AGL ровно до запаса 50 м,
    // НЕ прибавляя высоту рельефа (было: terrainM + 50 = 150 «AGL» ≈ 250 м MSL).
    expect(st().altitudeProfiles[0].points[0].altitudeAgl).toBe(50);
  });
});

describe('Этапы 8–9 UI', () => {
  const toExport = async () => {
    toStart(); // Этапы 1–2 пройдены
    st().setCraftType('drone');
    st().goToNextStep(); st().addStartPoint({ name: 'С1', lat: 55, lon: 37, x: 100, y: 100 });
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep(); await st().calculateRoutes();
    st().goToNextStep(); st().goToNextStep();
  };

  it('чек-лист и форматы экспорта рендерятся; выбор формата открывает переход', async () => {
    await toExport();
    render(<MissionWizard />);
    expect(screen.getByTestId('final-checklist')).toBeTruthy();
    expect(screen.getByTestId('format-mavlink')).toBeTruthy();
    fireEvent.click(screen.getByTestId('format-json'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled());
  });

  it('финальный этап: лог операций и confirmation перед сбросом миссии', async () => {
    await toExport();
    st().setExportFormat('json');
    st().goToNextStep(); // mission-deployment
    render(<MissionWizard />);
    fireEvent.click(screen.getByTestId('download-file'));
    await waitFor(() => expect(screen.getByTestId('deployment-log').textContent).toContain('✓'));
    fireEvent.click(screen.getByTestId('new-mission'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/уверены|сброс/i);
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    // resetWizard теперь возвращает на Этап 1 «Выбор карт» (9 этапов)
    expect(st().currentStep).toBe('map-selection');
    expect(st().startPoints).toHaveLength(0);
  });
});

describe('Оболочка мастера', () => {
  it('прогресс-бар показывает 9 этапов и текущий подсвечен', () => {
    render(<MissionWizard />);
    for (let i = 1; i <= 9; i++) expect(screen.getByTestId(`wizard-step-${i}`)).toBeTruthy();
    expect(screen.getByText(/Этап 1\/9/)).toBeTruthy();
  });

  it('горячие клавиши Alt+→ блокируются при незавершённом этапе и работают после завершения', () => {
    render(<MissionWizard />);
    // Этап 1 (выбор карт) незавершён → переход заблокирован
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(st().currentStep).toBe('map-selection');
    st().toggleMapChoice('esri');
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(st().currentStep).toBe('craft-selection');
    // Этап 2 незавершён (тип не выбран) → снова заблокирован
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(st().currentStep).toBe('craft-selection');
    st().setCraftType('drone');
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(st().currentStep).toBe('start-points');
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    expect(st().currentStep).toBe('craft-selection');
  });

  it('сохранение persist: состояние мастера пишется в localStorage (включая выбор карт)', () => {
    st().toggleMapChoice('esri');
    st().setCraftType('uav');
    const raw = localStorage.getItem('tq-mission-wizard');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.craftType).toBe('uav');
    expect(JSON.parse(raw as string).state.selectedMaps).toEqual(['esri']);
  });
});
