// ═══════════════════════════════════════════════════════════════
// wizardExport — полноценные сериализаторы экспорта мастера миссий (ФАЗА 3.1)
//
// Дефекты аудита, закрытые здесь:
//  • buildPreview писал ПИКСЕЛЬНЫЕ координаты мини-карты в атрибуты lat/lon
//    GPX/KML (`lat="${p.y}" lon="${p.x}"`) — навигатор получал «широту 120» и
//    маршрут был непригоден для полёта;
//  • экспорт скачивал тот же обрезанный preview (первые 8/5/6/3 точек) —
//    пользователь получал НЕПОЛНЫЙ файл вместо полной миссии;
//  • CSV собирался ручным `${p.name}` в кавычках — без двойных кавычек по
//    RFC 4180 и без защиты от Formula Injection (=, +, -, @);
//  • не было валидации диапазонов координат — NaN/вырожденные значения
//    молча попадали в файл.
//
// Контракт: `buildFullExport` — единственный источник контента файла;
// `buildPreview` — его ПРЕФИКС (первые N строк), поэтому превью в UI всегда
// показывает реальный формат файла, а не отдельную имитацию.
// ═══════════════════════════════════════════════════════════════
import {
  pxToLon,
  pyToLat,
  type ExportFormat,
} from "../store/useMissionWizardStore";
import type { MissionWizardState } from "../store/useMissionWizardStore";
import { toCsv } from "./csv";

/** Данные мастера (только поля экспорта — функции стора в сериализацию не входят). */
export type WizardExportData = Pick<
  MissionWizardState,
  | "craftType"
  | "startPoints"
  | "targetPoints"
  | "fleetGroups"
  | "calculatedRoutes"
  | "altitudeProfiles"
>;

const CREATOR = "TotalQuadro Mission Wizard";

/** Валидность гео-координаты (WGS-84): finite + диапазон. Точка вне диапазона
 *  в экспорт НЕ попадает — вместо пиксельной заглушки она отбрасывается. */
export function isValidGeo(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** XML-экранирование: принимает unknown (поля внешних данных могут быть undefined). */
export function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Гео-координаты точки маршрута через проекцию мини-карты мастера (equirectangular). */
function routePointGeo(p: { x: number; y: number }): {
  lat: number;
  lon: number;
} {
  return { lat: pyToLat(p.y), lon: pxToLon(p.x) };
}

/** Высота AGL на позиции маршрута: ближайшее по positionRatio изменение высоты. */
function altitudeAt(
  s: WizardExportData,
  routeId: string,
  ratio: number,
): number | null {
  const profile = s.altitudeProfiles.find((pr) => pr.routeId === routeId);
  if (!profile || profile.points.length === 0) return null;
  let best = profile.points[0];
  for (const p of profile.points) {
    if (
      Math.abs(p.positionRatio - ratio) < Math.abs(best.positionRatio - ratio)
    )
      best = p;
  }
  return best.altitudeAgl;
}

function craftLabel(s: WizardExportData): string {
  return s.craftType === "uav"
    ? "UAV"
    : s.craftType === "drone"
      ? "Drone"
      : "Unknown";
}

// ─── Полноценные сериализаторы (без лимитов) ────────────────────

/** JSON: полный архив миссии (все точки, группы, маршруты, профили высот). */
export function serializeJson(s: WizardExportData): string {
  return JSON.stringify(
    {
      format: "totalquadro-mission",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      craftType: s.craftType,
      startPoints: s.startPoints.map(({ id, name, comment, lat, lon }) => ({
        id,
        name,
        comment,
        lat,
        lon,
      })),
      targetPoints: s.targetPoints.map(({ id, name, comment, lat, lon }) => ({
        id,
        name,
        comment,
        lat,
        lon,
      })),
      fleetGroups: s.fleetGroups,
      routes: s.calculatedRoutes.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        startPointId: r.startPointId,
        targetPointId: r.targetPointId,
        lengthMeters: Math.round(r.lengthMeters * 100) / 100,
        blockedByNfz: r.blockedByNfz,
        exceedsRange: r.exceedsRange,
        acknowledged: r.acknowledged,
        waypoints: r.points.map((p, i) => {
          const geo = routePointGeo(p);
          const alt = altitudeAt(
            s,
            r.id,
            r.points.length > 1 ? i / (r.points.length - 1) : 0,
          );
          return { index: i, lat: geo.lat, lon: geo.lon, altitudeAGL: alt };
        }),
      })),
      altitudeProfiles: s.altitudeProfiles,
    },
    null,
    2,
  );
}

/** CSV: таблица всех точек старта/цели и путевых точек маршрутов (гео-координаты).
 *  Сериализация — через utils/csv (RFC 4180 + защита от Formula Injection). */
export function serializeCsv(s: WizardExportData): string {
  const rows: (string | number | null | undefined)[][] = [
    ["kind", "id", "name", "lat", "lon", "altitudeAGL", "routeId", "index"],
  ];
  for (const p of s.startPoints) {
    if (isValidGeo(p.lat, p.lon))
      rows.push(["start", p.id, p.name, p.lat, p.lon, null, null, null]);
  }
  for (const p of s.targetPoints) {
    if (isValidGeo(p.lat, p.lon))
      rows.push(["target", p.id, p.name, p.lat, p.lon, null, null, null]);
  }
  for (const r of s.calculatedRoutes) {
    r.points.forEach((pt, i) => {
      const geo = routePointGeo(pt);
      if (!isValidGeo(geo.lat, geo.lon)) return;
      rows.push([
        "waypoint",
        r.id,
        `Route ${r.id} WP${i}`,
        geo.lat,
        geo.lon,
        altitudeAt(
          s,
          r.id,
          r.points.length > 1 ? i / (r.points.length - 1) : 0,
        ),
        r.id,
        i,
      ]);
    });
  }
  return toCsv(rows, { delimiter: "," });
}

/** GPX 1.1: wpt — старты/цели, trk — все маршруты целиком (реальные lat/lon, ele = AGL). */
export function serializeGpx(s: WizardExportData): string {
  const wpts: string[] = [];
  for (const p of [...s.startPoints, ...s.targetPoints]) {
    if (!isValidGeo(p.lat, p.lon)) continue;
    wpts.push(
      `  <wpt lat="${p.lat}" lon="${p.lon}">\n    <name>${escapeXml(p.name)}</name>\n  </wpt>`,
    );
  }
  const trks = s.calculatedRoutes.map((r) => {
    const segPts = r.points.map((pt, i) => {
      const geo = routePointGeo(pt);
      const alt = altitudeAt(
        s,
        r.id,
        r.points.length > 1 ? i / (r.points.length - 1) : 0,
      );
      const ele = alt !== null ? `<ele>${alt}</ele>` : "";
      return `      <trkpt lat="${geo.lat}" lon="${geo.lon}">${ele ? `\n${ele}` : ""}\n        <name>WP${i}</name>\n      </trkpt>`;
    });
    return `  <trk>\n    <name>${escapeXml(`Route ${r.id}`)}</name>\n    <desc>${escapeXml(`craft=${s.craftType ?? "unknown"} start=${r.startPointId} target=${r.targetPointId}`)}</desc>\n    <trkseg>\n${segPts.join("\n")}\n    </trkseg>\n  </trk>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(CREATOR)}">`,
    ...wpts,
    ...trks,
    "</gpx>",
  ].join("\n");
}

/** KML 2.2: Placemark-точки + LineString-маршруты (lon,lat,alt — по стандарту KML). */
export function serializeKml(s: WizardExportData): string {
  const places: string[] = [];
  for (const p of [...s.startPoints, ...s.targetPoints]) {
    if (!isValidGeo(p.lat, p.lon)) continue;
    places.push(
      `    <Placemark>\n      <name>${escapeXml(p.name)}</name>\n      <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>\n    </Placemark>`,
    );
  }
  for (const r of s.calculatedRoutes) {
    const coords = r.points
      .map((pt, i) => {
        const geo = routePointGeo(pt);
        const alt = altitudeAt(
          s,
          r.id,
          r.points.length > 1 ? i / (r.points.length - 1) : 0,
        );
        return `${geo.lon},${geo.lat},${alt ?? 0}`;
      })
      .join(" ");
    places.push(
      `    <Placemark>\n      <name>${escapeXml(`Route ${r.id}`)}</name>\n      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>\n    </Placemark>`,
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>${escapeXml(`${CREATOR} mission`)}</name>`,
    ...places,
    "  </Document>",
    "</kml>",
  ].join("\n");
}

/** MAVLink-текстовый листинг: ВСЕ маршруты и ВСЕ путевые точки (ранее — срез 3×6). */
export function serializeMavlink(s: WizardExportData): string {
  const blocks = s.calculatedRoutes.map((r) => {
    const lines = r.points.map((pt, i) => {
      const geo = routePointGeo(pt);
      const alt =
        altitudeAt(
          s,
          r.id,
          r.points.length > 1 ? i / (r.points.length - 1) : 0,
        ) ?? 0;
      return `MAV_CMD_NAV_WAYPOINT ${i}: lat=${geo.lat.toFixed(6)} lon=${geo.lon.toFixed(6)} alt=${alt.toFixed(1)}`;
    });
    return [
      `--- Route ${r.id} (${craftLabel(s)}, ${Math.round(r.lengthMeters)} m) ---`,
      ...lines,
    ].join("\n");
  });
  return blocks.join("\n");
}

/** Полный контент экспортного файла выбранного формата (без лимитов строк). */
export function buildFullExport(
  format: ExportFormat,
  s: WizardExportData,
): string {
  switch (format) {
    case "json":
      return serializeJson(s);
    case "csv":
      return serializeCsv(s);
    case "gpx":
      return serializeGpx(s);
    case "kml":
      return serializeKml(s);
    case "mavlink":
      return serializeMavlink(s);
  }
}

/** Превью для Этапа 7 = префикс реального файла (первые maxLines строк).
 *  Раньше это была отдельная «имитация» с пиксельными координатами. */
export function buildPreview(
  format: ExportFormat,
  s: WizardExportData,
  maxLines = 20,
): string {
  return buildFullExport(format, s).split("\n").slice(0, maxLines).join("\n");
}
