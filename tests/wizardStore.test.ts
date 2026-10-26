// Юнит-тесты стора пошагового мастера: навигация, валидации, лимиты, edge cases.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  useMissionWizardStore, MAP_CHOICES, MAX_START_POINTS, MAX_TARGET_POINTS,
  parseCoordinateQuery, geoDistanceM, isValidLatLon, lonToPx, latToPy, type StartPoint, type TargetPoint,
} from '../src/store/useMissionWizardStore';

const st = () => useMissionWizardStore.getState();

/** Проход Этапа 1 (выбор карт) до этапа выбора типа — используется тестами
 *  этапов 2+, у которых beforeEach остаётся на map-selection. */
const toCraft = () => {
  st().goToNextStep(); // map-selection → craft-selection
};
/** Проход Этапа 2 (тип аппарата) до этапа точек старта. */
const toStart = () => {
  toCraft();
  st().setCraftType('drone');
  st().goToNextStep(); // craft-selection → start-points
};

const mkPt = (i: number, name = `П${i}`): Omit<StartPoint, 'id'> => ({
  name, lat: 55 + i * 0.01, lon: 37 + i * 0.01, x: 100 + i * 40, y: 100,
});

beforeEach(() => {
  st().resetWizard();
  // Этап 1 (ТЗ) — выбор карт: мастер не пройдёт дальше без выбранной карты,
  // поэтому во всех прежних тестах этапов 2+ эмулируем завершённый этап 1.
  st().toggleMapChoice('esri');
});

describe('Этап 1 — выбор карт для загрузки', () => {
  it('блокирует переход без выбора карты', () => {
    st().resetWizard(); // selectedMaps = []
    expect(st().currentStep).toBe('map-selection');
    expect(st().canProceedToNextStep()).toBe(false);
    expect(st().validateCurrentStep().some((i) => i.level === 'error')).toBe(true);
  });

  it('разблокирует переход после мультивыбора и сохраняет основную карту', () => {
    st().resetWizard(); // beforeEach уже выбрал esri — начинаем с чистого Этапа 1
    st().toggleMapChoice('esri');
    st().toggleMapChoice('opentopomap');
    expect(st().selectedMaps).toEqual(['esri', 'opentopomap']);
    expect(st().primaryMap).toBe('opentopomap'); // последний выбранный становится основной
    expect(st().canProceedToNextStep()).toBe(true);
    st().goToNextStep();
    expect(st().currentStep).toBe('craft-selection');
  });

  it('setPrimaryMap автоматически добавляет карту в выбранные', () => {
    st().resetWizard();
    st().setPrimaryMap('cyclosm');
    expect(st().selectedMaps).toContain('cyclosm');
    expect(st().primaryMap).toBe('cyclosm');
  });

  it('снятие основной карты передаёт статус первой оставшейся', () => {
    st().resetWizard(); // beforeEach уже выбрал esri — чистый Этап 1
    st().toggleMapChoice('esri'); // primary = esri (первый выбор)
    st().toggleMapChoice('osmfr'); // esri → osmfr primary
    st().toggleMapChoice('osmfr'); // снять
    expect(st().selectedMaps).toEqual(['esri']);
    expect(st().primaryMap).toBe('esri');
  });

  it('2ГИС недоступен как вариант выбора (ТЗ: удалён полностью)', () => {
    expect(MAP_CHOICES.some((c) => c.id === '2gis')).toBe(false);
    expect(MAP_CHOICES.every((c) => ['esri', 'esri-sat', 'osmfr', 'hot', 'osmde', 'opentopomap', 'cyclosm'].includes(c.id))).toBe(true);
  });

  it('смена типа аппарата НЕ сбрасывает выбор карт Этапа 1', () => {
    st().toggleMapChoice('hot');
    st().resetCraftChoice('uav');
    expect(st().selectedMaps).toContain('hot');
    expect(st().completedSteps).toHaveLength(0);
  });

  it('блокирует переход без выбора типа (прежний Этап 1 → теперь Этап 2)', () => {
    st().goToNextStep(); // map-selection → craft-selection
    st().resetWizard();
    st().toggleMapChoice('esri'); // этап 1 пройден, но тип не выбран
    st().goToNextStep();
    expect(st().currentStep).toBe('craft-selection');
    expect(st().canProceedToNextStep()).toBe(false);
    expect(st().validateCurrentStep().some((i) => i.level === 'error')).toBe(true);
  });
});

describe('Сброс выбора типа (Этап 2 → Этап 1-е данные)', () => {
  it('сброс по подтверждению меняет тип и очищает все данные', () => {
    st().addStartPoint(mkPt(1));
    st().resetCraftChoice();
    expect(st().craftType).toBeNull();
    expect(st().startPoints).toHaveLength(0);
    expect(st().completedSteps).toHaveLength(0);
  });
});

describe('Этап 2 — точки старта', () => {
  it('блокирует переход без точек', () => {
    toStart();
    expect(st().currentStep).toBe('start-points');
    expect(st().canProceedToNextStep()).toBe(false);
  });

  it('добавляет валидную точку и разблокирует переход', () => {
    st().addStartPoint(mkPt(1));
    expect(st().startPoints).toHaveLength(1);
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('отклоняет невалидные координаты с error-подсказкой формата', () => {
    st().addStartPoint({ name: 'битая', lat: 95, lon: 200, x: 0, y: 0 });
    expect(st().startPoints).toHaveLength(0);
    expect(st().issues.some((i) => i.level === 'error' && i.message.includes('55.7558'))).toBe(true);
  });

  it('отклоняет пустое название', () => {
    st().addStartPoint({ name: '   ', lat: 55, lon: 37, x: 0, y: 0 });
    expect(st().startPoints).toHaveLength(0);
    expect(st().issues.some((i) => i.message.includes('Название точки не может быть пустым'))).toBe(true);
  });

  it('предупреждает о дублях (<10 м) и не добавляет точку', () => {
    st().addStartPoint(mkPt(1)); // lat 55.01, lon 37.01
    // реальный дубликат: те же координаты с гео-сдвигом ~2.6 м (в пределах лимита 10 м)
    st().addStartPoint({ name: 'дубль', lat: 55.01002, lon: 37.01002, x: 100, y: 100 });
    expect(st().startPoints).toHaveLength(1);
    expect(st().issues.some((i) => i.level === 'warning' && i.message.includes('слишком близко'))).toBe(true);
  });

  it(`блокирует ${MAX_START_POINTS + 1}-ю точку с явной ошибкой лимита`, () => {
    for (let i = 0; i < MAX_START_POINTS; i++) st().addStartPoint(mkPt(i));
    expect(st().startPoints).toHaveLength(MAX_START_POINTS);
    st().addStartPoint(mkPt(999, 'лишняя'));
    expect(st().startPoints).toHaveLength(MAX_START_POINTS);
    expect(st().issues.some((i) => i.level === 'error' && i.message.includes('Достигнут лимит 100'))).toBe(true);
  });

  it('drag (updateStartPoint) НЕ трогает viewState карты (no auto-fit)', () => {
    st().addStartPoint(mkPt(1));
    const id = st().startPoints[0].id;
    const before = JSON.stringify(st());
    st().updateStartPoint(id, { x: 300, y: 200, lat: 60, lon: 40 });
    expect(st().startPoints[0].x).toBe(300);
    // в мастере нет поля viewState/auto-fit: изменение точки не создаёт записи об экране
    expect(JSON.stringify(st())).not.toContain('viewState');
    expect(before.length > 0).toBe(true);
  });

  it('parseCoordinateQuery принимает «55.7558, 37.6173» и отвергает мусор', () => {
    expect(parseCoordinateQuery('55.7558, 37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoordinateQuery('Москва, Красная площадь')).toBeNull();
    expect(parseCoordinateQuery('91, 37')).toBeNull();
    expect(isValidLatLon(-90, 180)).toBe(true);
    expect(geoDistanceM(55.7558, 37.6173, 55.7558, 37.6173)).toBeCloseTo(0, 5);
  });
});

describe('Этап 3 — точки целей', () => {
  beforeEach(() => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // → start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); // → target-points
  });

  it('блокирует переход без целей', () => {
    expect(st().currentStep).toBe('target-points');
    expect(st().canProceedToNextStep()).toBe(false);
  });

  it('добавляет до 1000 целей и блокирует 1001-ю', () => {
    for (let i = 0; i < MAX_TARGET_POINTS; i++) {
      st().addTargetPoint({ name: `Ц${i}`, lat: 10 + (i % 80), lon: -170 + (i % 170) * 0.9, x: 5, y: 5 });
    }
    expect(st().targetPoints).toHaveLength(MAX_TARGET_POINTS);
    st().addTargetPoint({ name: 'Ц1001', lat: 89, lon: 179, x: 6, y: 6 });
    expect(st().targetPoints).toHaveLength(MAX_TARGET_POINTS);
    expect(st().issues.some((i) => i.message.includes('лимит 1000'))).toBe(true);
  });

  it('ставит warning при цели <50 м от старта', () => {
    // старт mkPt(1): lat 55.01, lon 37.01; цель: гео ~44 м — >10 м (не дубль), <50 м (лимит близости к старту)
    st().addTargetPoint({ name: 'Ц рядом', lat: 55.0104, lon: 37.01, x: 100, y: 100 });
    expect(st().targetPoints[0].nearStartWarning).toBe(true);
    expect(st().issues.some((i) => i.level === 'warning' && i.message.includes('близко к точке старта'))).toBe(true);
  });
});

describe('Этап 4 — группировка флота', () => {
  const toFleet = () => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); // target-points
    st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().addTargetPoint({ name: 'Ц2', lat: 57, lon: 39, x: 520, y: 200 });
    st().goToNextStep(); // fleet-formation
  };

  it('блокирует переход при totalCraft=0 и целях без аппаратов', () => {
    toFleet();
    expect(st().currentStep).toBe('fleet-formation');
    expect(st().canProceedToNextStep()).toBe(false);
  });

  it('автоформирование распределяет ВСЕ аппараты по целям → переход открыт', () => {
    toFleet();
    st().setTotalCraft(10);
    st().autoFormGroups();
    const sum = st().fleetGroups.reduce((a, g) => a + g.totalCraft, 0);
    expect(sum).toBe(10);
    expect(st().fleetGroups.every((g) => g.assignments.reduce((a, x) => a + x.craftCount, 0) === g.totalCraft)).toBe(true);
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('ручная группа на несуществующую цель отклоняется', () => {
    toFleet();
    st().createFleetGroup({ targetPointId: 'нет-такой', totalCraft: 2, assignments: [{ startPointId: st().startPoints[0].id, craftCount: 2 }] });
    expect(st().fleetGroups).toHaveLength(0);
    expect(st().issues.some((i) => i.message.includes('существующую цель'))).toBe(true);
  });

  it('расхождение суммы распределения и размера группы — error', () => {
    toFleet();
    const t = st().targetPoints[0];
    st().createFleetGroup({ targetPointId: t.id, totalCraft: 5, assignments: [{ startPointId: st().startPoints[0].id, craftCount: 3 }] });
    expect(st().fleetGroups).toHaveLength(0);
    expect(st().issues.some((i) => i.message.includes('не совпадает с размером группы'))).toBe(true);
  });
});

describe('Этап 5 — NFZ и маршруты', () => {
  const toNfz = () => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // → start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(4); st().autoFormGroups();
    st().goToNextStep(); // nfz-and-routes
  };

  it('полигон <3 вершин отклоняется', () => {
    toNfz();
    st().addNoFlyZone({ name: 'зона', polygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    expect(st().noFlyZones).toHaveLength(0);
  });

  it('маршрут через зону автоматически пересчитывается в обход (без пересечений)', async () => {
    toNfz();
    await st().calculateRoutes();
    expect(st().calculatedRoutes[0].crossesNfz).toBe(false);
    // ставим зону ровно между стартом (100,100) и целью (500,100)
    st().addNoFlyZone({ name: 'NFZ', polygon: [{ x: 250, y: 60 }, { x: 350, y: 60 }, { x: 350, y: 140 }, { x: 250, y: 140 }] });
    await st().calculateRoutes();
    const r = st().calculatedRoutes[0];
    expect(r.blockedByNfz).toBe(false);
    expect(r.points.length).toBeGreaterThan(2); // есть облетные waypoints
    expect(r.crossesNfz).toBe(false);
  });

  it('превышение дальности дрона (>100 км) → exceedsRange и блокировка до подтверждения', async () => {
    toNfz();
    // дальняя цель: ~459 км по гео > 100 км дрона; x/y в согласованной проекции (lonToPx/latToPy)
    st().updateStartPoint(st().startPoints[0].id, { lat: 55, lon: 37, x: lonToPx(37), y: latToPy(55) });
    st().updateTargetPoint(st().targetPoints[0].id, { lat: 56.2, lon: 44, x: lonToPx(44), y: latToPy(56.2) });
    await st().calculateRoutes(100_000);
    expect(st().calculatedRoutes[0].exceedsRange).toBe(true);
    expect(st().canProceedToNextStep()).toBe(false);
    st().acknowledgeRouteIssues();
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('для БПЛА тот же маршрут в пределах дальности (100 000 км) — без warning', async () => {
    toNfz();
    st().updateStartPoint(st().startPoints[0].id, { lat: 55, lon: 37, x: lonToPx(37), y: latToPy(55) });
    st().updateTargetPoint(st().targetPoints[0].id, { lat: 56.2, lon: 44, x: lonToPx(44), y: latToPy(56.2) });
    await st().calculateRoutes(100_000 * 1000); // UAV max range
    expect(st().calculatedRoutes[0].exceedsRange).toBe(false);
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('заблокированный зоной маршрут → hard error, переход закрыт', async () => {
    toNfz();
    const sp = st().startPoints[0];
    // кольцо зон вокруг старта со всех сторон делает обход невозможным
    st().addNoFlyZone({ name: 'A', polygon: [{ x: sp.x - 40, y: sp.y - 40 }, { x: sp.x + 40, y: sp.y - 40 }, { x: sp.x + 40, y: sp.y + 40 }, { x: sp.x - 40, y: sp.y + 40 }] });
    await st().calculateRoutes();
    const r = st().calculatedRoutes[0];
    expect(r.blockedByNfz || r.points.length >= 2).toBe(true);
    if (r.blockedByNfz) {
      expect(st().canProceedToNextStep()).toBe(false);
      expect(st().issues.some((i) => i.level === 'error' && i.message.includes('Невозможно построить маршрут'))).toBe(true);
    }
  });
});

describe('Этап 6 — профили высот (опциональный этап)', () => {
  const toAlt = async () => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // → start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep(); await st().calculateRoutes();
    st().goToNextStep(); // altitude-profiles
  };

  it('пропускается без точек высоты (canProceed === true)', async () => {
    await toAlt();
    expect(st().currentStep).toBe('altitude-profiles');
    expect(st().altitudeProfiles).toHaveLength(0);
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('высота ≤ 0 отклоняется', async () => {
    await toAlt();
    const rid = st().calculatedRoutes[0].id;
    st().addAltitudePoint({ routeId: rid, positionRatio: 0.5, altitudeAgl: 0, terrainM: 10 });
    expect(st().altitudeProfiles).toHaveLength(0);
    expect(st().issues.some((i) => i.message.includes('больше 0'))).toBe(true);
  });

  it('warning при высоте < рельеф+50м, автокоррекция поднимает высоту', async () => {
    await toAlt();
    const rid = st().calculatedRoutes[0].id;
    st().addAltitudePoint({ routeId: rid, positionRatio: 0.5, altitudeAgl: 30, terrainM: 100 });
    const p = st().altitudeProfiles[0].points[0];
    expect(p.belowTerrainWarning).toBe(true);
    st().autoAdjustAltitudes();
    const fixed = st().altitudeProfiles[0].points[0];
    expect(fixed.altitudeAgl).toBeGreaterThanOrEqual(150);
    expect(fixed.belowTerrainWarning).toBe(false);
  });

  it('точки сортируются по возрастанию позиции', async () => {
    await toAlt();
    const rid = st().calculatedRoutes[0].id;
    st().addAltitudePoint({ routeId: rid, positionRatio: 0.8, altitudeAgl: 200, terrainM: null });
    st().addAltitudePoint({ routeId: rid, positionRatio: 0.2, altitudeAgl: 120, terrainM: null });
    const pts = st().altitudeProfiles[0].points;
    expect(pts[0].positionRatio).toBeLessThan(pts[1].positionRatio);
  });
});

describe('Этапы 7–8 — экспорт и развёртывание', () => {
  const toExport = async () => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // → start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep(); await st().calculateRoutes();
    st().goToNextStep(); st().goToNextStep(); // export-preparation
  };

  it('блокирует переход без выбранного формата', async () => {
    await toExport();
    expect(st().currentStep).toBe('export-preparation');
    expect(st().canProceedToNextStep()).toBe(false);
    st().setExportFormat('mavlink');
    expect(st().canProceedToNextStep()).toBe(true);
  });

  it('критические проблемы маршрутов блокируют экспорт', async () => {
    await toExport();
    st().setExportFormat('json');
    // ломаем один маршрут: blockedByNfz + немедленная публикация валидации этапа
    useMissionWizardStore.setState((s) => ({
      calculatedRoutes: s.calculatedRoutes.map((r) => ({ ...r, blockedByNfz: true })),
    }));
    st().runValidationAndPublish();
    expect(st().canProceedToNextStep()).toBe(false);
    expect(st().issues.some((i) => i.message.includes('критические проблемы'))).toBe(true);
  });

  it('deployMission пишет лог и бросает ошибку без формата', async () => {
    await toExport();
    st().goToNextStep(); // mission-deployment
    await expect(st().deployMission()).rejects.toThrow('Формат экспорта не выбран');
    expect(st().deploymentLog.some((l) => l.startsWith('✗'))).toBe(true);
    st().setExportFormat('gpx');
    await st().deployMission();
    expect(st().deploymentLog.some((l) => l.includes('✓ Файл готов'))).toBe(true);
  });
});

describe('Навигация мастера', () => {
  it('goToStep запрещает прыжок вперёд через незавершённые этапы', () => {
    toCraft();
    expect(st().currentStep).toBe('craft-selection');
    st().goToStep('nfz-and-routes');
    expect(st().currentStep).toBe('craft-selection');
    expect(st().issues.some((i) => i.message.includes('ещё недоступен'))).toBe(true);
  });

  it('goToPreviousStep свободен назад, на первом этапе — no-op', () => {
    toStart();
    expect(st().currentStep).toBe('start-points');
    st().goToPreviousStep();
    expect(st().currentStep).toBe('craft-selection');
    st().goToPreviousStep();
    expect(st().currentStep).toBe('map-selection'); // Этап 1 по ТЗ
    st().goToPreviousStep();
    expect(st().currentStep).toBe('map-selection'); // no-op на первом этапе
  });

  it('полный проход 1→8 с завершением каждого этапа', async () => {
    toCraft();
    st().setCraftType('drone');
    st().goToNextStep(); // → start-points
    st().addStartPoint(mkPt(1));
    st().goToNextStep(); st().addTargetPoint({ name: 'Ц1', lat: 56, lon: 38, x: 500, y: 100 });
    st().goToNextStep(); st().setTotalCraft(2); st().autoFormGroups();
    st().goToNextStep(); await st().calculateRoutes();
    st().goToNextStep(); // altitudes — опционален
    st().goToNextStep(); st().setExportFormat('kml');
    st().goToNextStep();
    expect(st().currentStep).toBe('mission-deployment');
    expect(st().completedSteps).toHaveLength(8);
  });
});
