// Утилиты экспорта/импорта
import type { Marker, Project } from '../types';
import { pixelToGeoFromBounds } from './googleMaps';

/**
 * Получение координат маркера с учётом привязки к Google Maps
 */
function getMarkerGeoCoords(marker: Marker, project?: Project): { lat: number | null; lon: number | null } {
  // Если есть привязка к онлайн-картам, вычисляем координаты автоматически
  if (project?.map?.bounds && (project.map.source === 'google' || project.map.source === 'yandex' || project.map.source === 'osm')) {
    const geo = pixelToGeoFromBounds(
      { x: marker.x, y: marker.y },
      project.map.bounds,
      project.map.width,
      project.map.height
    );
    return { lat: geo.lat, lon: geo.lng };
  }
  // Иначе используем сохранённые координаты
  return { lat: marker.lat, lon: marker.lon };
}

/**
 * Экспорт маркеров в CSV
 */
export function exportToCSV(markers: Marker[], project?: Project): string {
  const header = 'id;name;x;y;lat;lon;type;comment';
  const rows = markers.map(m => {
    const geo = getMarkerGeoCoords(m, project);
    return `${m.id};${m.name};${m.x};${m.y};${geo.lat ?? ''};${geo.lon ?? ''};${m.type};${m.comment}`;
  });
  return [header, ...rows].join('\n');
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
    .map(m => {
      const geo = getMarkerGeoCoords(m, project);
      if (geo.lat === null || geo.lon === null) return null;
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
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
    .filter(f => f !== null);

  return JSON.stringify({
    type: 'FeatureCollection',
    features,
  }, null, 2);
}

/**
 * Экспорт маркеров в GPX
 */
export function exportToGPX(markers: Marker[], project?: Project): string {
  const waypoints = markers
    .map(m => {
      const geo = getMarkerGeoCoords(m, project);
      if (geo.lat === null || geo.lon === null) return null;
      return `  <wpt lat="${geo.lat}" lon="${geo.lon}">
    <name>${escapeXml(m.name)}</name>
    <desc>${escapeXml(m.comment)}</desc>
    <type>${escapeXml(m.type)}</type>
  </wpt>`;
    })
    .filter(w => w !== null)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TotalQuadro Coordinate Marker">
${waypoints}
</gpx>`;
}

/**
 * Экспорт маркеров в KML
 */
export function exportToKML(markers: Marker[], project?: Project): string {
  const placemarks = markers
    .map(m => {
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
    .filter(p => p !== null)
    .join('\n');

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
  return JSON.stringify(project, null, 2);
}

/**
 * Импорт проекта из JSON
 */
export function importProject(json: string): Project | null {
  try {
    const data = JSON.parse(json);
    if (data.version && data.projectName) {
      return data as Project;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Импорт маркеров из CSV
 */
export function importFromCSV(csv: string): Partial<Marker>[] {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const markers: Partial<Marker>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (parts.length >= 4) {
      markers.push({
        name: parts[1] || `Точка ${i}`,
        x: parseFloat(parts[2]) || 0,
        y: parseFloat(parts[3]) || 0,
        lat: parts[4] ? parseFloat(parts[4]) : null,
        lon: parts[5] ? parseFloat(parts[5]) : null,
        type: parts[6] || 'default',
        comment: parts[7] || '',
      });
    }
  }
  return markers;
}

/**
 * Импорт маркеров из GeoJSON
 */
export function importFromGeoJSON(json: string): Partial<Marker>[] {
  try {
    const data = JSON.parse(json);
    if (data.type !== 'FeatureCollection') return [];

    return data.features
      .filter((f: any) => f.geometry?.type === 'Point')
      .map((f: any, i: number) => ({
        name: f.properties?.name || `Точка ${i + 1}`,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        type: f.properties?.type || 'default',
        comment: f.properties?.comment || '',
        color: f.properties?.color || '#00ff00',
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Скачивание файла
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
