// ═══════════════════════════════════════════════════════════════
// projectFile — единый конверт формата .tqproj (ФАЗА 3.2)
//
// Дефекты аудита, закрытые здесь:
//  • под одним расширением .tqproj жили ДВА несовместимых формата:
//    `exportProject()` писал Project с `version: "1.0"` (строка), а Этап 8
//    мастера — объект с `version: 1` (число). importProject() требовал
//    строковый version/projectName и ЧИСЛОВОЙ файл отвергал («Ошибка импорта»);
//  • ветка импорта «.json с data.version» в Sidebar грузила НЕВАЛИДИРОВАННЫЙ
//    JSON прямо в стейт (обход схемы);
//  • saveProject сериализовал стор целиком (`JSON.stringify({ wizard: s })`) —
//    функции молча вырезались, формат не имел версии и миграций.
//
// Контракт: любой .tqproj — это ProjectFileEnvelope v2
//   { format: 'totalquadro-project', schemaVersion: 2, kind: 'workspace'|'mission', payload }
// Импорт принимает legacy-файлы (без конверта) через канонизацию/migrate,
// ошибки возвращает человекочитыми строками (не throw, не boolean).
// ═══════════════════════════════════════════════════════════════
import { z } from "zod";
import type { Project } from "../types";
import { parseProject, sanitizeProjectData } from "./projectSchema";
import { useMissionWizardStore } from "../store/useMissionWizardStore";

export const PROJECT_FILE_FORMAT = "totalquadro-project";
/** Текущая версия конверта файла проекта. */
export const PROJECT_FILE_SCHEMA_VERSION = 2;

export type ProjectFileKind = "workspace" | "mission";

export interface ProjectFileEnvelope<T = unknown> {
  format: typeof PROJECT_FILE_FORMAT;
  schemaVersion: number;
  kind: ProjectFileKind;
  createdAt?: string;
  payload: T;
}

const EnvelopeSchema = z.object({
  format: z.literal(PROJECT_FILE_FORMAT),
  schemaVersion: z.number().int().positive(),
  kind: z.enum(["workspace", "mission"]),
  createdAt: z.string().optional(),
  payload: z.unknown(),
});

/** Оборачивает данные в конверт v2. */
export function wrapProjectFile<T>(
  kind: ProjectFileKind,
  payload: T,
): ProjectFileEnvelope<T> {
  return {
    format: PROJECT_FILE_FORMAT,
    schemaVersion: PROJECT_FILE_SCHEMA_VERSION,
    kind,
    createdAt: new Date().toISOString(),
    payload,
  };
}

/** Сериализация проекта рабочего стола в .tqproj (payload — без секретов:
 *  redact вызывается на уровне utils/export.exportProject). */
export function serializeWorkspaceFile(project: Project): string {
  return JSON.stringify(wrapProjectFile("workspace", project), null, 2);
}

/** Данные миссии мастера для файла (только персистимые поля, без методов стора). */
export function getWizardMissionPayload() {
  const s = useMissionWizardStore.getState();
  return {
    craftType: s.craftType,
    startPoints: s.startPoints,
    targetPoints: s.targetPoints,
    fleetGroups: s.fleetGroups,
    totalCraft: s.totalCraft,
    noFlyZones: s.noFlyZones,
    calculatedRoutes: s.calculatedRoutes,
    altitudeProfiles: s.altitudeProfiles,
  };
}

/** Единая точка записи «сохранённой миссии» (localStorage + экспорт .tqproj):
 *  ЭТАП 8 больше не дублирует структуру payload — контракт формата здесь. */
export function serializeMissionFile(indented = false): string {
  return JSON.stringify(
    wrapProjectFile("mission", getWizardMissionPayload()),
    null,
    indented ? 2 : undefined,
  );
}

export type ProjectFileParseResult =
  | { ok: true; kind: ProjectFileKind; payload: unknown; schemaVersion: number }
  | { ok: false; errors: string[] };

/** Распознать/прочитать содержимое .tqproj любого поколения.
 *  Не бросает исключений: битый JSON → список ошибок. */
export function readProjectFile(content: string): ProjectFileParseResult {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return {
      ok: false,
      errors: ["Файл повреждён: не является корректным JSON."],
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      errors: ["Файл повреждён: ожидался JSON-объект проекта."],
    };
  }
  const obj = data as Record<string, unknown>;

  // v2+: единый конверт
  const env = EnvelopeSchema.safeParse(obj);
  if (env.success) {
    if (env.data.schemaVersion > PROJECT_FILE_SCHEMA_VERSION) {
      return {
        ok: false,
        errors: [
          `Файл создан более новой версией приложения (schemaVersion ${env.data.schemaVersion}). Обновите TotalQuadro.`,
        ],
      };
    }
    return {
      ok: true,
      kind: env.data.kind,
      payload: env.data.payload,
      schemaVersion: env.data.schemaVersion,
    };
  }

  // legacy workspace: Project без конверта (version "1.0"/"1.1" или projectName)
  const looksLegacyWorkspace =
    typeof obj.projectName === "string" ||
    (typeof obj.version === "string" &&
      (obj.markers !== undefined || obj.restrictions !== undefined));
  if (looksLegacyWorkspace) {
    return { ok: true, kind: "workspace", payload: obj, schemaVersion: 1 };
  }

  // legacy mission (Этап 8 до Фазы 3): числовой version + поля мастера
  const looksLegacyMission =
    typeof obj.craftType !== "undefined" &&
    (Array.isArray(obj.startPoints) ||
      Array.isArray(obj.targetPoints) ||
      Array.isArray(obj.routes));
  if (looksLegacyMission) {
    return { ok: true, kind: "mission", payload: obj, schemaVersion: 1 };
  }

  return {
    ok: false,
    errors: [
      "Файл не распознан: отсутствует конверт totalquadro-project и признаки проекта/миссии.",
    ],
  };
}

/** Миграции payload миссии по schemaVersion. Возвращает payload, готовый к Zod-валидации. */
export function migrateMissionPayload(
  payload: unknown,
  fromVersion: number,
): unknown {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  if (fromVersion < 2) {
    // legacy Этап 8 писал маршруты под ключом `routes`, текущая схема — `calculatedRoutes`.
    if (out.calculatedRoutes === undefined && Array.isArray(out.routes)) {
      out.calculatedRoutes = out.routes;
      delete out.routes;
    }
    // числовой version из legacy-файла не относится к payload — убираем
    if (typeof out.version === "number") delete out.version;
  }
  return out;
}

/** Валидация workspace-payload (канонизация + строгая схема). */
export function validateWorkspacePayload(
  payload: unknown,
): { ok: true; project: Project } | { ok: false; errors: string[] } {
  let canon: Record<string, unknown>;
  try {
    canon = sanitizeProjectData(payload);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `Структура проекта некорректна: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }
  const res = parseProject(canon);
  if (res.ok) return { ok: true, project: res.project as unknown as Project };
  return { ok: false, errors: res.errors };
}
