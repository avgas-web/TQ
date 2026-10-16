// ─── AltitudeProfile: маленькое окно профиля высоты по всему маршруту ─────────
// SVG-кривая: серый заполненный профиль рельефа (Open-Elevation, с
// интерполяцией между узлами) + цветная кривая требуемой ABS-высоты полёта
// (terrain + запас / ручные AGL этапов / полом-потолок зон). Наведение на
// кривую показывает дистанцию, рельеф и высоту полёта в точке.
import React, { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { interpolateProfile, fetchElevations } from '../utils/elevation';
import { haversineDistanceM } from '../utils/actionMode';

interface Props {
  routeId?: string | null;
  onClose: () => void;
}

interface NodeInfo { distM: number; abs: number | null; agl: number | null }
interface ProfileData {
  nodes: NodeInfo[];
  terrain: (number | null)[];   // рельеф по сэмплам профиля
  dists: number[];              // дистанция каждого сэмпла, м
  totalM: number;
  maxAbs: number;
  minAbs: number;
  maxTerrain: number | null;
}

const W = 300;
const H = 110;
const PAD_T = 8, PAD_B = 14, PAD_X = 6;

const AltitudeProfile: React.FC<Props> = ({ routeId, onClose }) => {
  const project = useStore((s) => s.project);
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const routes = useMemo(
    () => (project.routes || []).filter((r) => r.visible !== false && r.points.length >= 2),
    [project.routes],
  );
  const route = useMemo(() => {
    if (routeId) return routes.find((r) => r.id === routeId) || routes[0] || null;
    return routes[0] || null;
  }, [routes, routeId]);

  // Ключ данных маршрута — при изменении точек/высот перезапрашиваем профиль
  const dataKey = useMemo(() => {
    if (!route) return '';
    return `${route.id}|${route.points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.altitudeAGL ?? ''},${p.altitudeAbs ?? ''}`).join(';')}`;
  }, [route]);

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!route) { setProfile(null); return; }
    const run = async () => {
      setLoading(true);
      try {
        const geo = route.points.map((p) => ({ lat: p.lat, lng: p.lng }));
        // узлы маршрута: накопленная дистанция + требуемая ABS
        const nodes: NodeInfo[] = [];
        let acc = 0;
        for (let i = 0; i < geo.length; i++) {
          if (i > 0) acc += haversineDistanceM(geo[i - 1], geo[i]);
          const pt = route.points[i];
          const abs = typeof pt.altitudeAbs === 'number' ? pt.altitudeAbs : null;
          const terr = typeof pt.terrainM === 'number' ? pt.terrainM : null;
          const agl = abs !== null && terr !== null ? abs - terr : (typeof pt.altitudeAGL === 'number' ? pt.altitudeAGL : null);
          nodes.push({ distM: acc, abs, agl });
        }
        // плотный профиль рельефа вдоль ломаной (кэш elevation.ts делает дёшево)
        const samples = interpolateProfile(geo, 500, 160);
        const elev = await fetchElevations(samples);
        if (cancelled) return;
        const segLens: number[] = [];
        for (let i = 0; i < samples.length - 1; i++) segLens.push(haversineDistanceM(samples[i], samples[i + 1]));
        const dists: number[] = [0];
        for (let i = 0; i < segLens.length; i++) dists.push(dists[i] + segLens[i]);
        const totalM = dists[dists.length - 1] || acc || 1;
        const absVals = nodes.filter((n) => n.abs !== null).map((n) => n.abs as number);
        const terrVals = elev.filter((v): v is number => typeof v === 'number');
        setProfile({
          nodes,
          terrain: elev,
          dists,
          totalM,
          maxAbs: absVals.length ? Math.max(...absVals) : 0,
          minAbs: absVals.length ? Math.min(...absVals) : 0,
          maxTerrain: terrVals.length ? Math.max(...terrVals) : null,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  if (!route) {
    return (
      <div className="absolute z-50 w-[320px] rounded-lg border border-gray-600 bg-gray-900/95 shadow-xl text-xs text-gray-300 p-2">
        <div className="flex items-center justify-between mb-1">
          <span className="font-bold text-cyan-300">Профиль высот</span>
          <button className="text-gray-400 hover:text-white px-1" onClick={onClose} aria-label="Закрыть окно профиля">✕</button>
        </div>
        Маршрутов пока нет — добавьте маршрут в режиме «Редактирование маршрута».
      </div>
    );
  }

  const hasAbs = profile ? profile.nodes.some((n) => n.abs !== null) : false;
  const yMax = Math.max(profile?.maxAbs ?? 0, profile?.maxTerrain ?? 0, 10);
  const yMin = Math.min(0, profile?.minAbs ?? 0, ...(profile ? profile.terrain.filter((v): v is number => typeof v === 'number') : []));
  const span = Math.max(10, yMax - yMin);

  const X = (d: number) => PAD_X + (W - 2 * PAD_X) * Math.min(1, Math.max(0, d / (profile?.totalM || 1)));
  const Y = (v: number) => H - PAD_B - ((H - PAD_T - PAD_B) * (v - yMin)) / span;

  // путь кривой ABS по узлам (пропускаем null-узлы)
  const flightPath = useMemo(() => {
    if (!profile || !hasAbs) return '';
    const pts = profile.nodes.filter((n) => n.abs !== null);
    if (pts.length < 2) return '';
    return pts.map((n, i) => `${i === 0 ? 'M' : 'L'}${X(n.distM).toFixed(1)},${Y(n.abs as number).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, hasAbs]);

  // область рельефа (серая подложка)
  const terrainArea = useMemo(() => {
    if (!profile) return '';
    const withElev = profile.dists
      .map((d, i) => ({ d, e: profile.terrain[i] }))
      .filter((o): o is { d: number; e: number } => typeof o.e === 'number');
    if (withElev.length < 2) return '';
    const base = Y(yMin).toFixed(1);
    return `M${X(withElev[0].d).toFixed(1)},${base} ` +
      withElev.map((o) => `L${X(o.d).toFixed(1)},${Y(o.e).toFixed(1)}`).join(' ') +
      ` L${X(withElev[withElev.length - 1].d).toFixed(1)},${base} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, yMin]);

  const fmtM = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} км` : `${Math.round(v)} м`);

  const onMoveSvg = (e: React.MouseEvent) => {
    if (!profile || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / Math.max(1, r.width)) * W;
    // ближайший узел маршрута по экранной X
    let bi = -1, bd = Infinity;
    profile.nodes.forEach((n, i) => {
      const d = Math.abs(X(n.distM) - sx);
      if (d < bd) { bd = d; bi = i; }
    });
    if (bi >= 0) setHover({ x: X(profile.nodes[bi].distM), y: 0, i: bi });
  };

  const hv = hover && profile ? profile.nodes[hover.i] : null;

  return (
    <div className="absolute z-50 w-[320px] rounded-lg border border-cyan-700/70 bg-gray-900/95 shadow-xl text-xs select-none">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700">
        <span className="font-bold text-cyan-300 truncate" title={route.name}>📈 {route.name}</span>
        <select
          className="ml-auto max-w-[110px] px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-gray-200"
          value={route.id}
          onChange={(e) => {
            const st = useStore.getState();
            st.setActiveRoute(e.target.value);
            setHover(null);
          }}
          title="Выбрать маршрут для профиля"
        >
          {routes.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
        </select>
        <button className="text-gray-400 hover:text-white px-1" onClick={onClose} aria-label="Закрыть окно профиля">✕</button>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          onMouseMove={onMoveSvg}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label="Профиль высоты по маршруту"
        >
          {/* сетка */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={PAD_X} x2={W - PAD_X} y1={PAD_T + (H - PAD_T - PAD_B) * f} y2={PAD_T + (H - PAD_T - PAD_B) * f} stroke="#334155" strokeWidth={0.5} />
          ))}
          {terrainArea && <path d={terrainArea} fill="#64748b55" stroke="#94a3b8" strokeWidth={0.8} />}
          {flightPath && (
            <path d={flightPath} fill="none" stroke={route.color || '#22d3ee'} strokeWidth={1.8} strokeLinejoin="round" />
          )}
          {/* узлы маршрута */}
          {profile?.nodes.map((n, i) => (
            n.abs !== null ? <circle key={i} cx={X(n.distM)} cy={Y(n.abs)} r={hover?.i === i ? 3.2 : 2} fill={route.color || '#22d3ee'} /> : null
          ))}
          {hover && <line x1={hover.x} x2={hover.x} y1={PAD_T} y2={H - PAD_B} stroke="#e2e8f0" strokeWidth={0.6} strokeDasharray="3 2" />}
          {/* подписи оси */}
          <text x={PAD_X} y={H - 4} fontSize={7} fill="#94a3b8">0</text>
          <text x={W - PAD_X} y={H - 4} fontSize={7} fill="#94a3b8" textAnchor="end">{profile ? fmtM(profile.totalM) : ''}</text>
          <text x={W - PAD_X} y={PAD_T + 6} fontSize={7} fill="#94a3b8" textAnchor="end">{`${Math.round(yMax)} м`}</text>
        </svg>
        {loading && !profile && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/60 text-gray-300">⏳ запрос рельефа…</div>
        )}
        {!loading && !hasAbs && profile && (
          <div className="absolute inset-x-0 bottom-4 text-center text-[10px] text-amber-300/90">
            высоты не определены — нажмите «🛰 Пересчитать высоты»
          </div>
        )}
      </div>
      <div className="px-2 pb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-gray-400">
        <span><span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#64748b' }} /> рельеф{profile?.maxTerrain != null ? ` (пик ${Math.round(profile.maxTerrain)} м)` : ''}</span>
        <span><span className="inline-block w-3 h-0.5" style={{ background: route.color || '#22d3ee' }} /> высота полёта ABS</span>
        {hv && (
          <span className="text-gray-200">
            {fmtM(hv.distM)} · {hv.abs !== null ? `${Math.round(hv.abs)} м ABS` : '—'}{hv.agl !== null ? ` (${Math.round(hv.agl)} м AGL)` : ''}
          </span>
        )}
      </div>
    </div>
  );
};

export default AltitudeProfile;
