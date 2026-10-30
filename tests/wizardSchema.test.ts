// Регрессионные тесты ФАЗЫ 3.3: Zod-схема мастера на границе persist/импорта.
import { describe, it, expect } from "vitest";
import {
  WizardPersistSchema,
  sanitizeWizardData,
  validateMissionPayload,
} from "../src/utils/wizardSchema";

const validPoint = {
  id: "p1",
  name: "Старт",
  lat: 55.7558,
  lon: 37.6173,
  x: 100,
  y: 200,
};

describe("wizardSchema — граница валидации Zustand (регрессия F3.3)", () => {
  it("REGRESSION: undefined/null/массив вместо state → чистое состояние + warning, НЕ throw", () => {
    for (const bad of [undefined, null, 42, "str", []]) {
      const r = sanitizeWizardData(bad);
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(r.data.startPoints).toEqual([]);
      expect(r.data.currentStep).toBe("map-selection");
    }
  });

  it("битые точки отфильтровываются, валидные сохраняются (element-level фильтрация)", () => {
    const raw = {
      startPoints: [
        validPoint,
        { id: "bad", name: "X", lat: "abc", lon: NaN, x: 1, y: 1 }, // невалидный lat
        null,
        { id: "no-coords" },
      ],
      targetPoints: [],
    };
    const r = sanitizeWizardData(raw);
    expect(r.data.startPoints).toHaveLength(1);
    expect(r.data.startPoints[0].id).toBe("p1");
    expect(r.warnings.join(" ")).toMatch(/startPoints/i);
  });

  it("координаты вне диапазона (999°) не проходят схему", () => {
    const res = WizardPersistSchema.safeParse({
      startPoints: [{ id: "p1", name: "N", lat: 999, lon: 200, x: 0, y: 0 }],
    });
    expect(res.success).toBe(false);
  });

  it("неизвестный currentStep/exportFormat/craftType → дефолт, а не падение parse", () => {
    const res = WizardPersistSchema.safeParse({
      currentStep: "step-from-future",
      craftType: "spaceship",
      exportFormat: "exe",
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.currentStep).toBe("map-selection");
    expect(res.data.craftType).toBeNull();
    expect(res.data.exportFormat).toBeNull();
  });

  it("enum-значения из legacy-снапшотов ('drone'/'uav', шаги) принимаются", () => {
    const res = WizardPersistSchema.safeParse({
      currentStep: "altitude-profile",
      completedSteps: ["map-selection", "altitude-profile"],
      craftType: "uav",
      exportFormat: "gpx",
    });
    expect(res.success).toBe(true);
  });

  it("routes с crossesNfz=true сериализуются и валидируются round-trip", () => {
    const route = {
      id: "r1",
      groupId: "g1",
      startPointId: "s1",
      targetPointId: "t1",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      lengthMeters: 120.5,
      crossesNfz: true,
    };
    const parsed = WizardPersistSchema.parse({ calculatedRoutes: [route] });
    expect(parsed.calculatedRoutes[0].crossesNfz).toBe(true);
    expect(parsed.calculatedRoutes[0].blockedByNfz).toBe(false); // default
  });

  it("deploymentLog остаётся персистимым (контракт partialize v2)", () => {
    const parsed = WizardPersistSchema.parse({
      deploymentLog: ["deployed r1", "deployed r2"],
    });
    expect(parsed.deploymentLog).toHaveLength(2);
  });

  it("validateMissionPayload (импорт mission-файла) никогда не бросает и возвращает warnings", () => {
    const r = validateMissionPayload({
      craftType: "drone",
      startPoints: [validPoint],
      fleetGroups: [{ id: "g1", garbage: true }], // битая группа
    });
    expect(r.data.startPoints).toHaveLength(1);
    expect(r.data.fleetGroups).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("primaryMap: неизвестный тайл-сервер нормализуется, null допустим", () => {
    const a = WizardPersistSchema.parse({ primaryMap: "made-up-tiles" });
    expect(typeof a.primaryMap).toBe("string"); // нормализован через normalizeTileServer
    const b = WizardPersistSchema.parse({ primaryMap: null });
    expect(b.primaryMap).toBeNull();
  });
});
