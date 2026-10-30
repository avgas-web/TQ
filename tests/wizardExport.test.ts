// ФАЗА 3.1 (регрессия): экспорт мастера миссий — полные файлы, реальные
// гео-координаты, безопасный CSV, превью = префикс реального файла.
//
// Исходные дефекты аудита:
//  • buildPreview писал ПИКСЕЛЬНЫЕ координаты мини-карты в lat/lon GPX/KML;
//  • скачивался обрезанный preview (первые 8/5/6/3 точки) вместо полной миссии;
//  • CSV собирался ручным конкатом — без RFC 4180 и Formula Injection защиты.
import { describe, it, expect } from "vitest";
import {
  buildFullExport,
  buildPreview,
  serializeJson,
  serializeCsv,
  serializeGpx,
  serializeKml,
  serializeMavlink,
  escapeXml,
  isValidGeo,
  type WizardExportData,
} from "../src/utils/wizardExport";
import {
  lonToPx,
  latToPy,
  type AltitudeProfile,
} from "../src/store/useMissionWizardStore";

/** Точка мастер-мара из гео-координат (x/y — проекция мини-карты). */
const gp = (id: string, name: string, lat: number, lon: number) => ({
  id,
  name,
  lat,
  lon,
  x: lonToPx(lon),
  y: latToPy(lat),
});

const routePoint = (lat: number, lon: number) => ({
  x: lonToPx(lon),
  y: latToPy(lat),
});

function makeState(
  overrides: Partial<WizardExportData> = {},
): WizardExportData {
  const profile: AltitudeProfile = {
    routeId: "r1",
    points: [
      {
        id: "a1",
        routeId: "r1",
        positionRatio: 0,
        altitudeAgl: 120,
        terrainM: 50,
        belowTerrainWarning: false,
      },
      {
        id: "a2",
        routeId: "r1",
        positionRatio: 1,
        altitudeAgl: 90,
        terrainM: 60,
        belowTerrainWarning: false,
      },
    ],
  };
  return {
    craftType: "drone",
    startPoints: [gp("s1", "Старт 1", 55.7558, 37.6173)],
    targetPoints: [gp("t1", "=CMD()", 59.9386, 30.3141)],
    fleetGroups: [
      {
        id: "g1",
        targetPointId: "t1",
        totalCraft: 3,
        assignments: [{ startPointId: "s1", craftCount: 3 }],
      },
    ],
    noFlyZones: [],
    calculatedRoutes: [
      {
        id: "r1",
        groupId: "g1",
        startPointId: "s1",
        targetPointId: "t1",
        // 12 путевых точек — раньше в экспорт попадали только первые 3–8
        points: Array.from({ length: 12 }, (_, i) =>
          routePoint(
            55.7558 + ((59.9386 - 55.7558) * i) / 11,
            37.6173 + ((30.3141 - 37.6173) * i) / 11,
          ),
        ),
        lengthMeters: 633000,
        crossesNfz: false,
        blockedByNfz: false,
        exceedsRange: false,
        acknowledged: false,
      },
    ],
    altitudeProfiles: [profile],
    ...overrides,
  };
}

describe("wizardExport — гео-координаты вместо пикселей (регрессия F3.1)", () => {
  it("GPX: все lat в диапазоне [-90;90], lon в [-180;180]; Москва-СПб записаны географией", () => {
    const gpx = serializeGpx(makeState());
    const coords = [...gpx.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(
      (m) => ({ lat: Number(m[1]), lon: Number(m[2]) }),
    );
    expect(coords.length).toBeGreaterThan(0);
    for (const c of coords) expect(isValidGeo(c.lat, c.lon)).toBe(true);
    // Первая точка трека = старт (Москва), последняя = цель (СПб)
    expect(coords[0].lat).toBeCloseTo(55.7558, 4);
    expect(coords[coords.length - 1].lat).toBeCloseTo(59.9386, 4);
    // Пиксельная широта «y=...» (например 120) физически невозможна в файле
    expect(gpx).not.toMatch(/lat="1[0-9][0-9]/);
  });

  it("KML: coordinates = lon,lat[,alt] в валидных диапазонах", () => {
    const kml = serializeKml(makeState());
    const tuples = [...kml.matchAll(/(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/g)];
    expect(tuples.length).toBeGreaterThan(0);
    for (const [, lonS, latS] of tuples) {
      expect(isValidGeo(Number(latS), Number(lonS))).toBe(true);
    }
  });

  it("JSON: waypoints содержат geo lat/lon и AGL из профиля высот", () => {
    const json = JSON.parse(serializeJson(makeState()));
    const wps = json.routes[0].waypoints;
    expect(wps).toHaveLength(12); // полная трасса, без среза
    expect(wps[0].lat).toBeCloseTo(55.7558, 4);
    expect(wps[0].altitudeAGL).toBe(120);
    expect(wps[wps.length - 1].altitudeAGL).toBe(90);
    for (const w of wps) expect(isValidGeo(w.lat, w.lon)).toBe(true);
  });

  it("MAVLink: ВСЕ путевые точки всех маршрутов (ранее — срез 3×6)", () => {
    const out = serializeMavlink(makeState());
    expect(out).toContain("MAV_CMD_NAV_WAYPOINT 11:");
    expect((out.match(/MAV_CMD_NAV_WAYPOINT/g) ?? []).length).toBe(12);
  });
});

describe("wizardExport — completeness: buildFullExport не обрезает", () => {
  it("CSV содержит все 14 строк данных (1 старт + 1 цель + 12 waypoint)", () => {
    const csv = serializeCsv(makeState());
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(15); // + шапка
    expect(lines.filter((l) => l.startsWith("waypoint,"))).toHaveLength(12);
  });

  it("buildPreview — честный ПРЕФИКС реального файла для каждого формата", () => {
    const s = makeState();
    for (const fmt of ["json", "csv", "gpx", "kml", "mavlink"] as const) {
      const full = buildFullExport(fmt, s);
      const preview = buildPreview(fmt, s, 5);
      expect(full.startsWith(preview)).toBe(true);
      expect(preview.split("\n").length).toBeLessThanOrEqual(5);
    }
  });
});

describe("wizardExport — CSV safety (RFC 4180 + Formula Injection)", () => {
  it("опасное имя '=SUM(A1)' экранируется префиксом ' и кавычками", () => {
    const csv = serializeCsv(makeState());
    // Формат сериализатора utils/csv: опасное значение -> `'"<payload>"`
    expect(csv).toContain(`'"=CMD()"`);
    // значение внутри кавычек с префиксом — Excel не вычислит формулу
    const injRow = csv.split("\n").find((l) => l.startsWith("target,"));
    expect(injRow).toBeDefined();
    expect(injRow).toContain(`'"=CMD()"`);
  });

  it("кавычки в имени удваиваются по RFC 4180", () => {
    const s = makeState({
      startPoints: [gp("s1", 'Точка "особая"', 55.75, 37.6)],
    });
    const csv = serializeCsv(s);
    expect(csv).toContain('"Точка ""особая"""');
  });

  it("escapeXml принимает undefined/null без падения и экранирует разметку", () => {
    expect(escapeXml(undefined)).toBe("");
    expect(escapeXml(null)).toBe("");
    expect(escapeXml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("точки с невалидными координатами (NaN/вне диапазона) в экспорт НЕ попадают", () => {
    const s = makeState({
      startPoints: [
        gp("s1", "Старт 1", 55.7558, 37.6173),
        { id: "bad", name: "битая", lat: NaN, lon: 200, x: 0, y: 0 },
      ],
    });
    const csv = serializeCsv(s);
    expect(csv).not.toContain("битая");
    const gpx = serializeGpx(s);
    expect(gpx).not.toContain("битая");
    expect(gpx).not.toMatch(/lat="NaN"/);
  });
});
