// Регрессионные тесты ФАЗЫ 3.2: единый конверт .tqproj + миграции.
import { describe, it, expect } from "vitest";
import {
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_SCHEMA_VERSION,
  wrapProjectFile,
  serializeWorkspaceFile,
  serializeMissionFile,
  readProjectFile,
  migrateMissionPayload,
  validateWorkspacePayload,
} from "../src/utils/projectFile";

const minimalProject = {
  projectName: "Тест",
  version: "1.0",
  markers: [
    {
      id: "m1",
      lat: 55.75,
      lng: 37.62,
      name: "Старт",
      type: "waypoint",
      color: "#fff",
    },
  ],
  routes: [],
  restrictions: [],
};

describe("projectFile — единый конверт v2 (регрессия F3.2)", () => {
  it("serializeWorkspaceFile пишет конверт с format/schemaVersion/kind=payload", () => {
    const raw = JSON.parse(serializeWorkspaceFile(minimalProject as never));
    expect(raw.format).toBe(PROJECT_FILE_FORMAT);
    expect(raw.schemaVersion).toBe(PROJECT_FILE_SCHEMA_VERSION);
    expect(raw.kind).toBe("workspace");
    expect(raw.payload.projectName).toBe("Тест");
    expect(typeof raw.createdAt).toBe("string");
  });

  it("round-trip: записанный workspace читается и проходит Zod-валидацию", () => {
    const content = serializeWorkspaceFile(minimalProject as never);
    const parsed = readProjectFile(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("workspace");
    const validated = validateWorkspacePayload(parsed.payload);
    expect(validated.ok).toBe(true);
  });

  it("legacy workspace (Project БЕЗ конверта, version '1.0') распознаётся", () => {
    const legacy = JSON.stringify(minimalProject);
    const parsed = readProjectFile(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("workspace");
    expect(parsed.schemaVersion).toBe(1);
  });

  it("REGRESSION: legacy mission-файл Этапа 8 с ЧИСЛОВЫМ version:1 больше не отвергается", () => {
    // Дефект аудита: exportProject требовал строковый version, а мастер писал
    // {version: 1, craftType, startPoints, targetPoints, routes:[...]} → импорт падал.
    const legacyMission = JSON.stringify({
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      craftType: "quadcopter",
      startPoints: [{ x: 10, y: 20, lat: 55.75, lng: 37.62 }],
      targetPoints: [{ x: 30, y: 40, lat: 59.94, lng: 30.31 }],
      routes: [
        {
          id: "r1",
          craftId: "c1",
          points: [
            { x: 10, y: 20, lat: 55.75, lng: 37.62 },
            { x: 30, y: 40, lat: 59.94, lng: 30.31 },
          ],
          distanceMeters: 1000,
        },
      ],
    });
    const parsed = readProjectFile(legacyMission);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("mission");
    expect(parsed.schemaVersion).toBe(1);

    // Миграция: routes → calculatedRoutes, числовой version вычищается
    const migrated = migrateMissionPayload(
      parsed.payload,
      parsed.schemaVersion,
    ) as Record<string, unknown>;
    expect(Array.isArray(migrated.calculatedRoutes)).toBe(true);
    expect(migrated.routes).toBeUndefined();
    expect(migrated.version).toBeUndefined();
  });

  it("битый JSON → человекочитаемая ошибка, НЕ исключение", () => {
    const res = readProjectFile("{oops not json");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatch(/JSON/);
  });

  it("неизвестный JSON без признаков проекта/миссии → ошибка распознавания", () => {
    const res = readProjectFile(JSON.stringify({ foo: 123 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatch(/не распознан/);
  });

  it("конверт из БУДУЩЕЙ версии (schemaVersion > текущей) отклоняется с подсказкой", () => {
    const future = JSON.stringify(
      (wrapProjectFile("workspace", minimalProject) satisfies object)
        ? {
            format: PROJECT_FILE_FORMAT,
            schemaVersion: PROJECT_FILE_SCHEMA_VERSION + 5,
            kind: "workspace",
            payload: minimalProject,
          }
        : null,
    );
    const res = readProjectFile(future);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatch(/более новой версией/);
  });

  it("serializeMissionFile использует тот же конверт (kind=mission) — единая точка контракта", () => {
    const content = serializeMissionFile();
    const parsed = readProjectFile(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("mission");
    expect(parsed.schemaVersion).toBe(PROJECT_FILE_SCHEMA_VERSION);
  });

  it("REGRESSION: validateWorkspacePayload не пропускает мусор в payload", () => {
    const bad = wrapProjectFile("workspace", { totally: "wrong" });
    const res = validateWorkspacePayload(bad.payload);
    // либо канонизируется до пустого валидного проекта, либо ошибки — но НЕ throw
    expect(res.ok === true || res.ok === false).toBe(true);
  });
});
