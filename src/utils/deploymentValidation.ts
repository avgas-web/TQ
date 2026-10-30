// ═══════════════════════════════════════════════════════════════
// ФАЗА 4.4 (аудит): единая функция валидации миссии перед развёртыванием.
//
// Дефект: проверки NFZ/exceedsRange были «зашиты» внутри deployMission и
// дублировались чек-листом в ExportPreparationStep — две реализации одного
// правила могли разойтись (UI показывал «зелёно», а экспорт падал, или
// наоборот). Теперь единственный источник истины — validateMissionForDeployment:
// чистая функция, возвращающая структурированный список проблем; её используют
// и стор (блокировка deployMission), и UI (чек-лист / disabled кнопки).
// ═══════════════════════════════════════════════════════════════
import type { CalculatedRoute } from "../store/useMissionWizardStore";

export type DeploymentIssueSeverity = "critical" | "warning";

export interface DeploymentIssue {
  /** стабильный код для тестов и маппинга в UI */
  code:
    | "NO_ROUTES"
    | "NFZ_BLOCKED"
    | "RANGE_EXCEEDED_UNACKNOWLEDGED"
    | "ROUTE_CROSSES_NFZ";
  severity: DeploymentIssueSeverity;
  message: string;
  routeIds: string[];
}

export interface DeploymentValidationResult {
  ok: boolean;
  issues: DeploymentIssue[];
  /** только критические проблемы (блокируют экспорт/развёртывание) */
  criticalIssues: DeploymentIssue[];
}

/**
 * Валидирует набор рассчитанных маршрутов перед экспортом/развёртыванием.
 * Чистая функция без побочных эффектов — безопасна для useMemo в UI и unit-тестов.
 */
export function validateMissionForDeployment(
  routes: readonly CalculatedRoute[],
): DeploymentValidationResult {
  const issues: DeploymentIssue[] = [];

  if (routes.length === 0) {
    issues.push({
      code: "NO_ROUTES",
      severity: "critical",
      message: "Нет рассчитанных маршрутов для экспорта.",
      routeIds: [],
    });
  }

  // КРИТИЧНО (Ф1.3): маршрут сквозь NFZ, обход не построен → потеря дрона.
  const nfzBlocked = routes.filter((r) => r.blockedByNfz);
  if (nfzBlocked.length > 0) {
    issues.push({
      code: "NFZ_BLOCKED",
      severity: "critical",
      message: `Экспорт заблокирован: ${nfzBlocked.length} маршрут(ов) проходят через NFZ (обход не построен). Измените зоны или точки.`,
      routeIds: nfzBlocked.map((r) => r.id),
    });
  }

  // Блокировка (Ф4.4): превышение дальности без подтверждения оператора.
  const unack = routes.filter(
    (r) => r.exceedsRange && !r.blockedByNfz && !r.acknowledged,
  );
  if (unack.length > 0) {
    issues.push({
      code: "RANGE_EXCEEDED_UNACKNOWLEDGED",
      severity: "critical",
      message: `Экспорт заблокирован: ${unack.length} маршрут(ов) превышают дальность аппарата без подтверждения.`,
      routeIds: unack.map((r) => r.id),
    });
  }

  // WARNING: остаточное пересечение NFZ при построенном обходе (например,
  // зона была изменена после расчёта) — не блокирует, но требует внимания.
  const crossing = routes.filter((r) => r.crossesNfz && !r.blockedByNfz);
  if (crossing.length > 0) {
    issues.push({
      code: "ROUTE_CROSSES_NFZ",
      severity: "warning",
      message: `Внимание: ${crossing.length} маршрут(ов) помечены как пересекающие NFZ — проверьте обход.`,
      routeIds: crossing.map((r) => r.id),
    });
  }

  const criticalIssues = issues.filter((i) => i.severity === "critical");
  return { ok: criticalIssues.length === 0, issues, criticalIssues };
}

/** Однострочное сообщение для throw/log: первая критическая проблема. */
export function deploymentBlockingMessage(
  result: DeploymentValidationResult,
): string {
  return (
    result.criticalIssues[0]?.message ??
    "Развёртывание заблокировано неизвестной критической проблемой."
  );
}
