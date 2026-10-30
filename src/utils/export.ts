// Утилиты экспорта/импорта
import type { Marker, Project, Route, Restriction } from "../types";
import { pixelToGeoFromBounds } from "./googleMaps";
import { toCsv, parseCsv, FORMULA_INJECTION_PREFIXES } from "./csv";

/**
 * Получение координат маркера с учётом привязки к Google Maps
 */
function getMarkerGeoCoords(
  marker: Marker,
  project?: Project,
): { lat: number | null; lon: number | null } {
  // Если есть привязка к онлайн-картам, вычисляем координаты автоматически
  if (
    project?.map?.bounds &&
    (project.map.source === "google" ||
      project.map.source === "yandex" ||
      project.map.source === "osm")
  ) {
    const geo = pixelToGeoFromBounds(
      { x: marker.x, y: marker.y },
      project.map.bounds,
      project.map.width,
      project.map.height,
    );
    return { lat: geo.lat, lon: geo.lng };
  }
  // Иначе используем сохранённые координаты
  return { lat: marker.lat, lon: marker.lon };
}

/**
 * Экспорт маркеров в CSV
 * Безопасная сериализация (ФАЗА 2, п.3): все поля проходят через toCsv —
 * кавычование по RFC 4180 и защита от Formula Injection (=, +, -, @, Tab, CR).
 */
export function exportToCSV(markers: Marker[], project?: Project): string {
  const header = ["id", "name", "x", "y", "lat", "lon", "type", "comment"];
  const rows = markers.map((m) => {
    const geo = getMarkerGeoCoords(m, project);
    return [
      m.id,
      m.name,
      m.x,
      m.y,
      geo.lat ?? "",
      geo.lon ?? "",
      m.type,
      m.comment,
    ];
  });
  return toCsv([header, ...rows], { delimiter: ";" });
}

/**
 * Экспорт маркеров в JSON
 */
export function exportToJSON(markers: Marker[]): string {
  return JSON.stringify(markers, null, 2);
}

/**
 * Экспорт маркеров в GeoJSON
 */
export function exportToGeoJSON(markers: Marker[], project?: Project): string {
  const features = markers
    .map((m) => {
      const geo = getMarkerGeoCoords(m, project);
      if (geo.lat === null || geo.lon === null) return null;
      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [geo.lon, geo.lat],
        },
        properties: {
          id: m.id,
          name: m.name,
          type: m.type,
          color: m.color,
          comment: m.comment,
          pixelX: m.x,
          pixelY: m.y,
        },
      };
    })
    .filter((f) => f !== null);

  return JSON.stringify(
    {
      type: "FeatureCollection",
      features,
    },
    null,
    2,
  );
}

/**
 * Экспорт маркеров в GPX
 */
export function exportToGPX(markers: Marker[], project?: Project): string {
  const tacticalNodes = markers
    .map((m) => {
      const geo = getMarkerGeoCoords(m, project);
      if (geo.lat === null || geo.lon === null) return null;
      return `  <wpt lat="${geo.lat}" lon="${geo.lon}">
    <name>${escapeXml(m.name)}</name>
    <desc>${escapeXml(m.comment)}</desc>
    <type>${escapeXml(m.type)}</type>
  </wpt>`;
    })
    .filter((w) => w !== null)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TotalQuadro Coordinate Marker">
${tacticalNodes}
</gpx>`;
}

/**
 * Экспорт маркеров в KML
 */
export function exportToKML(markers: Marker[], project?: Project): string {
  const placemarks = markers
    .map((m) => {
      const geo = getMarkerGeoCoords(m, project);
      if (geo.lat === null || geo.lon === null) return null;
      return `    <Placemark>
      <name>${escapeXml(m.name)}</name>
      <description>${escapeXml(m.comment)}</description>
      <Point>
        <coordinates>${geo.lon},${geo.lat},0</coordinates>
      </Point>
    </Placemark>`;
    })
    .filter((p) => p !== null)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>TotalQuadro Markers</name>
${placemarks}
  </Document>
</kml>`;
}

/**
 * Экспорт всего проекта в JSON
 */
export function exportProject(project: Project): string {
  // Секьюрити: API-ключи не должны покидать устройство вместе с файлом проекта —
  // экспорт передаётся другим людям, а ключ в .tqproj = утечка платного квотного доступа.
  const redacted: Project = {
    ...project,
    // ЭТАП 1.2: поле apiKey полностью удалено из модели — экспорт не содержит
    // секретов ни при каких условиях (раньше писался пустой apiKey-заглушка).
    googleMaps: project.googleMaps
      ? { enabled: project.googleMaps.enabled }
      : project.googleMaps,
    yandexMaps: project.yandexMaps
      ? { enabled: project.yandexMaps.enabled }
      : project.yandexMaps,
  };
  return JSON.stringify(redacted, null, 2);
}

/**
 * Импорт проекта из JSON.
 * Валидация структуры: файл может быть повреждён или содержать объекты
 * без обязательных полей (points, числовые координаты и т.п.), что иначе
 * приводит к крахам в planPathAroundZones / fitViewToData / делению на ноль.
 * Некорректные элементы отбрасываются, недостающие секции дополняются
 * значениями по умолчанию. Возвращает null только если это явно не проект.
 */
export function importProject(json: string): Project | null {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (typeof data.version !== "string" && typeof data.projectName !== "string")
    return null;

  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);

  // Карта: принимаем только с валидными размерами и dataUrl, иначе — null
  let map: Project["map"] = null;
  if (
    data.map &&
    typeof data.map === "object" &&
    typeof data.map.dataUrl === "string" &&
    num(data.map.width, 0) > 0 &&
    num(data.map.height, 0) > 0
  ) {
    map = data.map;
  }

  const markers: Marker[] = arr<any>(data.markers)
    .filter((m) => m && typeof m === "object")
    .map((m, i) => ({
      ...m,
      id: str(m.id, `m-${Date.now()}-${i}`),
      name: str(m.name, `Точка ${i + 1}`),
      x: num(m.x, 0),
      y: num(m.y, 0),
    }));

  const routes: Route[] = arr<any>(data.routes)
    .filter((r) => r && typeof r === "object" && Array.isArray(r.points))
    .map((r, i) => ({
      ...r,
      id: str(r.id, `r-${Date.now()}-${i}`),
      points: r.points.filter(
        (p: any) =>
          p &&
          typeof p === "object" &&
          Number.isFinite(p.lat) &&
          Number.isFinite(p.lng),
      ),
    }))
    .filter((r) => r.points.length >= 2);

  const restrictions: Restriction[] = arr<any>(data.restrictions)
    .filter((z) => z && typeof z === "object" && Array.isArray(z.points))
    .map((z, i) => ({
      ...z,
      id: str(z.id, `z-${Date.now()}-${i}`),
      points: z.points.filter(
        (p: any) =>
          p &&
          typeof p === "object" &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y),
      ),
    }))
    .filter((z) => z.points.length >= 1);

  return {
    version: str(data.version, "1.0"),
    projectName: str(data.projectName, "Импортированный проект"),
    createdAt: str(data.createdAt, new Date().toISOString()),
    updatedAt: str(data.updatedAt, new Date().toISOString()),
    map,
    calibration: {
      enabled: !!(data.calibration && data.calibration.enabled === true),
      points: arr(data.calibration?.points),
    },
    restrictions,
    markers,
    routes,
    importLists:
      data.importLists && typeof data.importLists === "object"
        ? data.importLists
        : undefined,
    layers: arr(data.layers),
    settings: {
      showGrid: !!(data.settings && data.settings.showGrid),
      gridSize: num(data.settings?.gridSize, 100),
      showCoordinates: !!data.settings?.showCoordinates,
      theme: data.settings?.theme === "light" ? "light" : "dark",
      // Стиль подложки из импортируемого проекта; внешние Overpass-слои удалены —
      // нормализуем к схеме, спутник/гибрид сохраняем.
      tileStyle:
        data.settings?.tileStyle === "satellite" ||
        data.settings?.tileStyle === "hybrid"
          ? (data.settings.tileStyle as "satellite" | "hybrid")
          : ("scheme" as const),
      tilesEnabled: data.settings?.tilesEnabled,
    },
    googleMaps: {
      // ЭТАП 1.2: apiKey из файла проекта ИГНОРИРУЕТСЯ (секреты не импортируются).
      enabled: !!(data.googleMaps && data.googleMaps.enabled),
    },
    yandexMaps: {
      enabled: !!(data.yandexMaps && data.yandexMaps.enabled),
    },
    openStreetMap: {
      enabled: !!(data.openStreetMap && data.openStreetMap.enabled),
      // legacy-значения ('osm', 'carto') и новые ('esri', 'esri-sat') — все валидны
      tileServer: ["osm", "opentopomap", "carto", "esri", "esri-sat"].includes(
        data.openStreetMap?.tileServer,
      )
        ? data.openStreetMap.tileServer
        : "osm",
    },
  };
}

/**
 * Импорт маркеров из CSV
 * Парсинг конечным автоматом (src/utils/csv.ts, RFC 4180): поддержка CRLF/LF, BOM,
 * многострочных полей в кавычках и удвоенных кавычек. Обратное снятие префикса
 * Formula Injection (`'=...`) выполняется при разборе текстовых колонок.
 */
export function importFromCSV(csv: string): Partial<Marker>[] {
  const rows = parseCsv(csv, { delimiter: ";" });
  if (rows.length < 2) return [];

  // Число с проверкой: нечисловые значения -> null (ранее parseFloat давал NaN,
  // который молча попадал в данные маркеров).
  const numOrNull = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Снятие защитного префикса formula injection при импорте нашего же экспорта.
  // Формат сериализатора (csv.ts): опасное значение -> `'"<payload>"` (префикс ПЕРЕД кавычками).
  const unescapeCell = (v: string | undefined): string => {
    if (v === undefined) return "";
    if (v.length > 3 && v.startsWith("'\"") && v.endsWith('"')) {
      const inner = v.slice(2, -1).replace(/""/g, '"');
      if (FORMULA_INJECTION_PREFIXES.some((p) => inner.startsWith(p)))
        return inner;
    }
    return v;
  };

  const markers: Partial<Marker>[] = [];
  // Индекс колонок по заголовку (устойчивый импорт: не зависим от порядка/полноты колонок).
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const cName = col("name", "название", "имя");
  const cX = col("x");
  const cY = col("y");
  const cLat = col("lat", "latitude", "широта");
  const cLon = col("lon", "lng", "long", "longitude", "долгота");
  const cType = col("type", "тип");
  const cComment = col("comment", "описание", "комментарий");

  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i];
    if (parts.every((p) => p === "")) continue; // пропуск фантомных пустых строк
    const at = (idx: number): string | undefined =>
      idx >= 0 ? parts[idx] : undefined;
    const x = numOrNull(at(cX));
    const y = numOrNull(at(cY));
    // Строки без валидных координат отбрасываем явно (ранее молча создавался маркер 0,0).
    if (x === null && y === null && at(cLat) === undefined) continue;
    markers.push({
      name: unescapeCell(at(cName)) || `Точка ${i}`,
      x: x ?? 0,
      y: y ?? 0,
      lat: numOrNull(at(cLat)),
      lon: numOrNull(at(cLon)),
      type: unescapeCell(at(cType)) || "default",
      comment: unescapeCell(at(cComment)),
    });
  }
  return markers;
}

/**
 * Импорт маркеров из GeoJSON
 */
export function importFromGeoJSON(json: string): Partial<Marker>[] {
  try {
    const data = JSON.parse(json);
    if (data.type !== "FeatureCollection") return [];

    return data.features
      .filter((f: any) => f.geometry?.type === "Point")
      .map((f: any, i: number) => ({
        name: f.properties?.name || `Точка ${i + 1}`,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        type: f.properties?.type || "default",
        comment: f.properties?.comment || "",
        color: f.properties?.color || "#00ff00",
      }));
  } catch {
    return [];
  }
}

/**
 * Экранирование XML-символов
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Скачивание файла
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
