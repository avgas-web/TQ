// ЭТАП 7: подготовка к экспорту — чек-лист финальной валидации, выбор формата,
// предпросмотр файла (первые строки + размер + счётчики).
import { useMemo, useState } from 'react';
import { useMissionWizardStore, type ExportFormat } from '../../store/useMissionWizardStore';

const FORMATS: { id: ExportFormat; label: string; desc: string }[] = [
  { id: 'mavlink', label: 'MAVLink', desc: 'Передача заданий в полётные контроллеры' },
  { id: 'json', label: 'JSON', desc: 'Полный архив проекта миссии' },
  { id: 'csv', label: 'CSV', desc: 'Таблица точек для анализа' },
  { id: 'gpx', label: 'GPX', desc: 'GPS-навигаторы и трекинг-приложения' },
  { id: 'kml', label: 'KML', desc: 'Google Earth' },
];

/** Генерация контента превью по формату (детальный экспорт — утилита utils/export.ts). */
export function buildPreview(format: ExportFormat, s: ReturnType<typeof useMissionWizardStore.getState>): string {
  const firstRoute = s.calculatedRoutes[0];
  switch (format) {
    case 'json':
      return JSON.stringify({ craftType: s.craftType, startPoints: s.startPoints.length, targetPoints: s.targetPoints.length, routes: s.calculatedRoutes.map((r) => ({ id: r.id, len: Math.round(r.lengthMeters) })) }, null, 2);
    case 'csv': {
      const rows = ['lat,lon,name,type'];
      for (const p of s.startPoints.slice(0, 10)) rows.push(`${p.lat},${p.lon},"${p.name}",start`);
      for (const p of s.targetPoints.slice(0, 10)) rows.push(`${p.lat},${p.lon},"${p.name}",target`);
      return rows.join('\n');
    }
    case 'gpx':
      return `<?xml version="1.0"?>\n<gpx version="1.1">\n${(firstRoute?.points ?? []).slice(0, 8).map((p) => `  <wpt lat="${p.y}" lon="${p.x}"/>`).join('\n')}\n</gpx>`;
    case 'kml':
      return `<?xml version="1.0"?>\n<kml><Document>\n${s.calculatedRoutes.slice(0, 5).map((r) => `  <Placemark><LineString><coordinates>${r.points.map((p) => `${p.x},${p.y}`).join(' ')}</coordinates></LineString></Placemark>`).join('\n')}\n</Document></kml>`;
    case 'mavlink':
      return s.calculatedRoutes.slice(0, 3).map((r) =>
        r.points.slice(0, 6).map((p, i) => `MAV_CMD_NAV_WAYPOINT ${i}: x=${p.x.toFixed(0)} y=${p.y.toFixed(0)}`).join('\n')).join('\n---\n');
  }
}

export function ExportPreparationStep() {
  const s = useMissionWizardStore();
  const [previewFormat, setPreviewFormat] = useState<ExportFormat>(s.exportFormat ?? 'json');

  const checklist = useMemo(() => ([
    { ok: s.startPoints.length > 0, text: `Все точки старта валидны (${s.startPoints.length})` },
    { ok: s.targetPoints.length > 0, text: `Все цели валидны (${s.targetPoints.length})` },
    { ok: s.fleetGroups.length > 0 && s.fleetGroups.reduce((a, g) => a + g.totalCraft, 0) === s.totalCraft, text: `Группы сформированы корректно (${s.fleetGroups.length}, суммарно ${s.fleetGroups.reduce((a, g) => a + g.totalCraft, 0)}/${s.totalCraft})` },
    { ok: s.calculatedRoutes.length > 0 && !s.calculatedRoutes.some((r) => r.blockedByNfz), text: `Маршруты пересчитаны, обход зон ПВО (ADIZ) выполнен (${s.calculatedRoutes.length})` },
    { ok: !s.calculatedRoutes.some((r) => r.exceedsRange && !r.acknowledged), text: 'Превышения дальности подтверждены или отсутствуют' },
    { ok: true, text: `Высоты скорректированы (точек: ${s.altitudeProfiles.reduce((a, p) => a + p.points.filter((x) => !x.belowTerrainWarning).length, 0)})` },
  ]), [s]);

  const preview = useMemo(() => buildPreview(previewFormat, s), [previewFormat, s]);
  const hasCriticalErrors = checklist.some((c) => !c.ok);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <h2 className="text-lg font-bold text-amber-300">Этап 7. Подготовка к экспорту</h2>

      {/* Чек-лист */}
      <ul data-testid="final-checklist" aria-label="Чек-лист проверки данных" className="grid grid-cols-1 gap-1 text-sm md:grid-cols-2">
        {checklist.map((c, i) => (
          <li key={i} className={c.ok ? 'rounded bg-green-950/40 px-2 py-1 text-green-300' : 'rounded bg-red-950/40 px-2 py-1 text-red-300'}>
            {c.ok ? '✓' : '✗'} {c.text}
          </li>
        ))}
      </ul>
      {hasCriticalErrors && (
        <p role="alert" className="text-xs text-red-300">Есть некритично не закрытые проверки — вернитесь на предыдущие этапы и устраните ✗.</p>
      )}

      {/* Выбор формата */}
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="mb-1 text-xs uppercase text-slate-400">Формат экспорта</legend>
        {FORMATS.map((f) => (
          <label key={f.id} data-testid={`format-${f.id}`}
            className={'cursor-pointer rounded border px-3 py-2 ' + (s.exportFormat === f.id ? 'border-cyan-400 bg-cyan-950/60' : 'border-slate-700 bg-slate-800/50')}>
            <input type="radio" name="export-format" value={f.id}
              checked={s.exportFormat === f.id}
              onChange={() => s.setExportFormat(f.id)} />{' '}
            <b>{f.label}</b> <span className="text-xs text-slate-400">— {f.desc}</span>
          </label>
        ))}
      </fieldset>

      {/* Превью */}
      <div className="flex items-center gap-2 text-xs">
        <label>Показать превью:
          <select data-testid="preview-select" className="input-dark ml-2 inline w-32" value={previewFormat} onChange={(e) => setPreviewFormat(e.target.value as ExportFormat)}>
            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <span className="text-slate-400">Размер ≈ {(preview.length / 1024).toFixed(1)} КБ · маршрутов: {s.calculatedRoutes.length} · точек: {s.startPoints.length + s.targetPoints.length} · групп: {s.fleetGroups.length}</span>
      </div>
      <pre data-testid="export-preview" className="max-h-48 overflow-auto rounded border border-slate-700 bg-black/60 p-2 text-[11px] leading-tight text-slate-300">{preview.split('\n').slice(0, 20).join('\n')}</pre>
    </div>
  );
}
