// ═══════════════════════════════════════════════════════════════
// ФАЗА 4.4 (аудит): validateMissionForDeployment — блокирующий экспорт
// при NFZ/exceedsRange. Регрессия: правила были продублированы в сторе и
// UI-чеклисте; расхождение копий позволяло «зелёному» чеклисту экспортировать
// маршрут сквозь NFZ. Тест проверяет ЕДИНЫЙ источник истины на обоих уровнях.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateMissionForDeployment,
  deploymentBlockingMessage,
} from '../src/utils/deploymentValidation';
import type { CalculatedRoute } from '../src/store/useMissionWizardStore';
import { useMissionWizardStore } from '../src/store/useMissionWizardStore';

const route = (over: Partial<CalculatedRoute>): CalculatedRoute => ({
  id: Math.random().toString(36).slice(2),
  groupId: 'g1',
  startPointId: 's1',
  targetPointId: 't1',
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  lengthMeters: 1000,
  crossesNfz: false,
  blockedByNfz: false,
  exceedsRange: false,
  acknowledged: false,
  ...over,
});

describe('Фаза 4.4: validateMissionForDeployment (чистая функция)', () => {
  it('пустой список маршрутов → критическая проблема NO_ROUTES', () => {
    const v = validateMissionForDeployment([]);
    expect(v.ok).toBe(false);
    expect(v.criticalIssues.map((i) => i.code)).toContain('NO_ROUTES');
  });

  it('маршрут сквозь NFZ (обход не построен) → блокировка NFZ_BLOCKED', () => {
    const r = route({ blockedByNfz: true });
    const v = validateMissionForDeployment([r]);
    expect(v.ok).toBe(false);
    const issue = v.criticalIssues.find((i) => i.code === 'NFZ_BLOCKED');
    expect(issue).toBeTruthy();
    expect(issue!.routeIds).toEqual([r.id]);
    expect(deploymentBlockingMessage(v)).toMatch(/NFZ/);
  });

  it('превышение дальности без подтверждения → блокировка', () => {
    const v = validateMissionForDeployment([route({ exceedsRange: true })]);
    expect(v.ok).toBe(false);
    expect(v.criticalIssues.map((i) => i.code)).toContain(
      'RANGE_EXCEEDED_UNACKNOWLEDGED',
    );
  });

  it('превышение дальности ПОДТВЕРЖДЕНО оператором → ok (warning-сценарий)', () => {
    const v = validateMissionForDeployment([
      route({ exceedsRange: true, acknowledged: true }),
    ]);
    expect(v.ok).toBe(true);
    expect(v.criticalIssues).toHaveLength(0);
  });

  it('остаточное пересечение NFZ при обходе → только warning, не блокирует', () => {
    const v = validateMissionForDeployment([route({ crossesNfz: true })]);
    expect(v.ok).toBe(true);
    expect(v.issues.map((i) => i.code)).toContain('ROUTE_CROSSES_NFZ');
    expect(v.issues.find((i) => i.code === 'ROUTE_CROSSES_NFZ')!.severity).toBe(
      'warning',
    );
  });

  it('корректная миссия → ok без проблем', () => {
    const v = validateMissionForDeployment([route({})]);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
  });
});

describe('Фаза 4.4: deployMission блокируется единой валидацией', () => {
  beforeEach(() => {
    useMissionWizardStore.setState({
      exportFormat: 'json',
      calculatedRoutes: [],
      deploymentLog: [],
    });
  });

  it('NFZ-блокированный маршрут → throw с сообщением валидации', async () => {
    useMissionWizardStore.setState({
      calculatedRoutes: [route({ blockedByNfz: true })],
    });
    await expect(
      useMissionWizardStore.getState().deployMission(),
    ).rejects.toThrow(/NFZ/);
  });

  it('неподтверждённое превышение дальности → throw', async () => {
    useMissionWizardStore.setState({
      calculatedRoutes: [route({ exceedsRange: true })],
    });
    await expect(
      useMissionWizardStore.getState().deployMission(),
    ).rejects.toThrow(/дальност/i);
  });

  it('нет маршрутов → throw (NO_ROUTES)', async () => {
    await expect(
      useMissionWizardStore.getState().deployMission(),
    ).rejects.toThrow(/Нет рассчитанных маршрутов/);
  });

  it('валидная миссия → deployMission проходит и пишет лог успеха', async () => {
    useMissionWizardStore.setState({
      calculatedRoutes: [route({ exceedsRange: true, acknowledged: true })],
    });
    await useMissionWizardStore.getState().deployMission();
    const log = useMissionWizardStore.getState().deploymentLog;
    expect(log.some((l) => l.startsWith('✓'))).toBe(true);
    expect(log.some((l) => l.startsWith('✗'))).toBe(false);
  });
});
