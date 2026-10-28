// ЭТАП 6: профили высот — точки изменения высоты на маршруте, запрос рельефа
// (Open-Elevation через src/utils/elevation с graceful fallback), график профиля,
// warning при высоте < рельеф+50м, автокоррекция. Этап опционален.
import { useEffect, useState } from 'react';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';
import { fetchElevations } from '../../utils/elevation';

export function AltitudeProfilesStep() {
  const s = useMissionWizardStore();
  const [routeId, setRouteId] = useState(s.calculatedRoutes[0]?.id ?? '');
  const [ratioPct, setRatioPct] = useState(50);
  const [alt, setAlt] = useState(120);
  const [climb, setClimb] = useState<number | ''>('');
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [terrainM, setTerrainM] = useState<number | null>(null);
  const [apiUnavailable, setApiUnavailable] = useState(false);

  const route = s.calculatedRoutes.find((r) => r.id === routeId);
  const profile = s.altitudeProfiles.find((p) => p.routeId === routeId);

  // запрос рельефа для выбранной позиции (fallback: terrainM=null, предупреждение)
  useEffect(() => {
    if (!route || route.points.length < 2) return;
    let cancelled = false;
    const t = ratioPct / 100;
    // интерполяция позиции на полилинии → псевдо-геокоординаты (для демо берём средние lat/lon endpoints)
    setTerrainLoading(true);
    const sp = s.startPoints.find((p) => p.id === route.startPointId);
    const tp = s.targetPoints.find((p) => p.id === route.targetPointId);
    if (!sp || !tp) { setTerrainLoading(false); return; }
    const lat = sp.lat + (tp.lat - sp.lat) * t;
    const lon = sp.lon + (tp.lon - sp.lon) * t;
    // Собственный AbortController: при смене позиции/маршрута или размонтировании
    // устаревший запрос отменяется и не может перезаписать terrainM (race guard).
    const ac = new AbortController();
    void fetchElevations([{ lat, lng: lon }], ac.signal)
      .then((res) => {
        if (cancelled || ac.signal.aborted) return;
        const e = res[0];
        if (e === null || e === undefined) { setTerrainM(null); setApiUnavailable(true); }
        else { setTerrainM(e); setApiUnavailable(false); }
      })
      .catch(() => { if (!cancelled) { setTerrainM(null); setApiUnavailable(true); } })
      .finally(() => { if (!cancelled && !ac.signal.aborted) setTerrainLoading(false); });
    return () => { cancelled = true; ac.abort(); };
  }, [routeId, ratioPct, route, s.startPoints, s.targetPoints]);

  const maxAlt = Math.max(200, ...(profile?.points.map((p) => p.altitudeAgl) ?? []), alt);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <h2 className="text-lg font-bold text-green-300">Этап 6. Участки изменения высоты</h2>
      <p className="text-xs text-slate-400">
        Этот этап опционален — можно продолжить без точек изменения высоты. Safety margin над рельефом: 50 м.
      </p>
      {apiUnavailable && (
        <div role="alert" data-testid="elevation-api-warning" className="rounded bg-yellow-900/50 p-2 text-xs text-yellow-200">
          ⚠ Open-Elevation API недоступен — профиль строится без учёта рельефа, можно продолжить.
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded border border-slate-700 bg-slate-800/50 p-3 text-xs">
        <label>Маршрут
          <select data-testid="alt-route" className="input-dark block" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
            {s.calculatedRoutes.length === 0 && <option value="">нет маршрутов</option>}
            {s.calculatedRoutes.map((r, i) => <option key={r.id} value={r.id}>Маршрут {i + 1}</option>)}
          </select>
        </label>
        <label>Позиция, %
          <input type="number" min={0} max={100} data-testid="alt-ratio" className="input-dark block w-20"
            value={ratioPct} onChange={(e) => setRatioPct(Number(e.target.value))} />
        </label>
        <label>Высота AGL, м
          <input type="number" min={1} data-testid="alt-value" className="input-dark block w-24"
            value={alt} onChange={(e) => setAlt(Number(e.target.value))} />
        </label>
        <label>Взятие, м/с
          <input type="number" min={0.5} step={0.5} data-testid="alt-climb" className="input-dark block w-20"
            value={climb} onChange={(e) => setClimb(e.target.value === '' ? '' : Number(e.target.value))} />
        </label>
        <span data-testid="terrain-readout" className="text-slate-300">
          {terrainLoading ? '⟳ рельеф…' : terrainM !== null ? `Рельеф: ${terrainM.toFixed(0)} м` : 'Рельеф: нет данных'}
        </span>
        <button type="button" data-testid="add-alt-point" className="btn-primary" disabled={!route}
          onClick={() => s.addAltitudePoint({
            routeId, positionRatio: ratioPct / 100, altitudeAgl: alt,
            climbRate: climb === '' ? undefined : climb, terrainM,
          })}>+ Точка высоты</button>
        <button type="button" data-testid="auto-adjust" className="btn-secondary"
          onClick={() => s.autoAdjustAltitudes()}>Автокорректировать по рельефу</button>
      </div>

      {/* График профиля высоты */}
      <svg viewBox="0 0 600 180" data-testid="altitude-chart" className="w-full rounded border border-slate-700 bg-slate-950"
        onClick={(e) => {
          const rect = (e.target as SVGElement).closest('svg')?.getBoundingClientRect();
          if (!rect || !route) return;
          const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
          setRatioPct(Math.max(0, Math.min(100, pct)));
        }}>
        <line x1={0} y1={170} x2={600} y2={170} stroke="#334155" />
        {terrainM !== null && (
          <line x1={0} y1={170 - (terrainM / maxAlt) * 160} x2={600} y2={170 - (terrainM / maxAlt) * 160}
            stroke="#84cc16" strokeDasharray="4 4" />
        )}
        {(profile?.points ?? []).map((p) => {
          const x = p.positionRatio * 600;
          const y = 170 - (p.altitudeAgl / maxAlt) * 160;
          return (
            <g key={p.id}>
              <circle cx={x} cy={y} r={6} fill={p.belowTerrainWarning ? '#ef4444' : '#34d399'}>
                <title>{`${(p.positionRatio * 100).toFixed(0)}% · ${p.altitudeAgl} м${p.belowTerrainWarning ? ' · СЛИШКОМ НИЗКО' : ''}`}</title>
              </circle>
              <text x={x} y={y - 10} fontSize={10} fill="#cbd5e1" textAnchor="middle">{p.altitudeAgl}м</text>
            </g>
          );
        })}
      </svg>

      {/* Таблица точек */}
      <table className="w-full text-left text-xs" aria-label="Точки изменения высоты">
        <thead><tr className="text-slate-400"><th>% маршрута</th><th>Высота AGL</th><th>Рельеф</th><th>Статус</th><th></th></tr></thead>
        <tbody>
          {(profile?.points ?? []).map((p) => (
            <tr key={p.id} className="border-t border-slate-800">
              <td>{(p.positionRatio * 100).toFixed(0)}%</td>
              <td>{p.altitudeAgl} м</td>
              <td>{p.terrainM === null ? '—' : `${p.terrainM.toFixed(0)} м`}</td>
              <td className={p.belowTerrainWarning ? 'text-red-400' : 'text-green-400'}>
                {p.belowTerrainWarning ? '✗ ниже рельефа+50м' : '✓'}
              </td>
              <td><button type="button" aria-label="Удалить точку высоты" className="text-red-400"
                onClick={() => s.removeAltitudePoint(p.routeId, p.id)}>✛</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
