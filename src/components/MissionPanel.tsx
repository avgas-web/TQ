// Панель миссий: планирование (оптимизация порядка точек, «змейка» сканирования),
// параметры путевых точек (задержка/угол камеры/скорость/радиус принятия),
// метаданные миссии и назначения Боевым Аппаратам (старт/цель/маршрут).
// Работает поверх существующего zustand-стора; модуль Боевого Моделирования — CombatAssetSim.

import React, { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import type { OptimizeAlgorithm } from '../utils/mission';
import { DEFAULT_WAYPOINT_PARAMS } from '../utils/mission';
import { CombatAssetSim, type Telemetry } from '../utils/combatAssetSim';
import { DRONE_PROFILES, type DroneMode, type DroneClass } from '../utils/droneProfiles';

const MODE_OPTIONS: Array<{ id: DroneMode; label: string }> = [
  { id: 'short_range', label: DRONE_PROFILES.short_range.label },
  { id: 'long_range', label: DRONE_PROFILES.long_range.label },
];

const ALGORITHMS: Array<{ id: OptimizeAlgorithm; label: string }> = [
  { id: 'nearest_neighbor', label: 'Ближайший сосед' },
  { id: 'genetic', label: 'Генетический' },
  {id: 'simulated_annealing', label: 'Отжиг' },
];

const MissionPanel: React.FC = () => {
  const project = useStore((s) => s.project);
  // Флаг тяжёлой операции (пересчёт высот / загрузка миссии) — блокирует mutate-кнопки
  const isProcessing = useStore((s) => s.isProcessing);
  const activeRouteId = useStore((s) => s.activeRouteId);
  const setActiveRoute = useStore((s) => s.setActiveRoute);
  const optimizeRouteOrder = useStore((s) => s.optimizeRouteOrder);
  const generateScanRoute = useStore((s) => s.generateScanRoute);
  const setWaypointParams = useStore((s) => s.setWaypointParams);
  const setMissionMeta = useStore((s) => s.setMissionMeta);
  const setMissionMode = useStore((s) => s.setMissionMode);
  const droneAssignments = useStore((s) => s.droneAssignments);
  const setDroneAssignment = useStore((s) => s.setDroneAssignment);
  // Парк дронов: режимы (short/long range), агрокласс, видеоканал — из домен-стора
  const fleetDrones = useStore((s) => s.drones);
  const registerDrone = useStore((s) => s.registerDrone);
  const setDroneMode = useStore((s) => s.setDroneMode);
  const setDroneClass = useStore((s) => s.setDroneClass);
  const requestVideo = useStore((s) => s.requestVideo);
  const videoStatusFor = useStore((s) => s.videoStatusFor);

  const routes = useMemo(() => project.routes || [], [project.routes]);
  const route = routes.find((r) => r.id === activeRouteId) ?? routes[0] ?? null;

  const [algorithm, setAlgorithm] = useState<OptimizeAlgorithm>('nearest_neighbor');
  const [optMsg, setOptMsg] = useState('');
  const [scanSpacingPx, setScanSpacingPx] = useState('60');
  const [wpIndex, setWpIndex] = useState(0);
  const [author, setAuthor] = useState('');
  const [droneCount, setDroneCount] = useState(Math.max(1, droneAssignments.length));
  const [simLog, setSimLog] = useState<string[]>([]);
  const [modeMsg, setModeMsg] = useState('');

  /** Смена режима работы миссии (короткие/дальнобойные) + валидация профиля. */
  const applyMissionMode = (mode: DroneMode): void => {
    if (!route) return;
    const cls: DroneClass | undefined = route.missionMeta?.droneClass;
    const warns = setMissionMode(route.id, mode, cls);
    if (warns === null) {
      setModeMsg('⛔ Режим не применён — маршрут не соответствует профилю (см. предупреждения маршрута)');
    } else if (warns.length > 0) {
      setModeMsg(`⚠ Режим применён с предупреждениями: ${warns.join('; ')}`);
    } else {
      setModeMsg('✓ Режим применён: маршрут в пределах профиля');
    }
  };

  const wp = route?.waypointParams?.[Math.min(wpIndex, (route?.points.length ?? 1) - 1)] ?? DEFAULT_WAYPOINT_PARAMS;

  const runOptimize = (): void => {
    if (!route) return;
    const pct = optimizeRouteOrder(route.id, algorithm);
    setOptMsg(pct === null ? 'Нужно ≥3 точек' : `Путь сокращён на ${pct}%`);
  };

  /** «Змейка» по последнему нарисованному полигону зон или по охвату маршрута. */
  const runScan = (): void => {
    const poly = project.restrictions.find((r) => r.type === 'polygon')?.points;
    if (!poly || poly.length < 3) {
      setOptMsg('Нарисуйте полигон зоны — по нему строится змейка сканирования');
      return;
    }
    const spacing = Number(scanSpacingPx);
    const id = generateScanRoute(poly, Number.isFinite(spacing) && spacing > 0 ? spacing : 60);
    if (id) {
      setActiveRoute(id);
      setOptMsg('Маршрут-змейка создан');
    } else {
      setOptMsg('Не удалось построить змейку (см. предупреждения)');
    }
  };

  /** Демонстрация Цикла Боевого Моделирования из Блоков 2/6 в модуле Боевого Моделирования на CombatAssetSim. */
  const runSimCycle = async (): Promise<void> => {
    const sim = new CombatAssetSim('demo-uav', { lat: 59.93, lon: 30.33, batteryPct: 90 });
    const logs: string[] = [];
    try {
      const pf = await sim.preflightCheck();
      logs.push(`preflight: ${pf.ok ? 'OK' : JSON.stringify(pf.checks)}`);
      await sim.arm();
      await sim.takeoff(100);
      await sim.setFlightMode('Auto');
      sim.loadMission(route?.id ?? 'adhoc');
      const t: Telemetry = { ...sim.telemetry(), timestamp: new Date().toISOString() };
      sim.logFlightData([t], 1);
      await sim.returnToHome({ lat: 59.93, lon: 30.33 }, 500);
      logs.push(`RTL ok, батарея ${sim.telemetry().batteryPct}%`);
    } catch (e) {
      logs.push(`ОШИБКА: ${(e as Error).name}: ${(e as Error).message}`);
    }
    setSimLog(logs);
  };

  const num = (v: string): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

  return (
    <div className="p-3 space-y-4 text-sm">
      {/* Выбор маршрута */}
      <div>
        <label className="text-xs text-gray-400">Маршрут миссии</label>
        <select
          value={route?.id ?? ''}
          onChange={(e) => setActiveRoute(e.target.value || null)}
          className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
        >
          <option value="">— не выбран —</option>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        {route?.missionMeta && (
          <div className="text-[11px] text-gray-400 mt-1">
            Автор: {route.missionMeta.author} · создана {new Date(route.missionMeta.createdAt).toLocaleString()}
            {route.missionMeta.mode && (
              <> · режим: {DRONE_PROFILES[route.missionMeta.mode].label}{route.missionMeta.droneClass === 'agri' ? ' · агродрон' : ''}</>
            )}
          </div>
        )}
      </div>

      {/* Режим работы миссии: короткие дистанции / дальнобойные */}
      {route && (
        <div className="border-t border-gray-700 pt-2">
          <div className="text-xs text-gray-400 mb-1">Режим работы (профиль парка)</div>
          <div className="flex gap-2">
            {MODE_OPTIONS.map((m) => {
              const active = (route.missionMeta?.mode ?? 'short_range') === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => applyMissionMode(m.id)}
                  disabled={isProcessing}
                  title={`${DRONE_PROFILES[m.id].maxMissionRangeM >= 1e6
                    ? `до ${Math.round(DRONE_PROFILES[m.id].maxMissionRangeM / 1000)} км`
                    : `до ${Math.round(DRONE_PROFILES[m.id].maxMissionRangeM / 1000)} км`} · высота ${DRONE_PROFILES[m.id].altitudeBandM[0]}–${DRONE_PROFILES[m.id].altitudeBandM[1]} м · видео ${DRONE_PROFILES[m.id].video.resolution}`}
                  className={`flex-1 px-2 py-1 rounded text-white text-[11px] leading-tight ${
                    active ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {m.id === 'short_range' ? '🚜 Короткие / агро' : '🛰 Дальнобойные ≤50 000 км'}
                </button>
              );
            })}
          </div>
          {modeMsg && <div className="text-[11px] text-yellow-300 mt-1">{modeMsg}</div>}
        </div>
      )}

      {/* Оптимизация порядка точек */}
      <div className="border-t border-gray-700 pt-2">
        <div className="text-xs text-gray-400 mb-1">Оптимизация порядка точек (optimize_route)</div>
        <div className="flex gap-2">
          <select
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value as OptimizeAlgorithm)}
            className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          >
            {ALGORITHMS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <button
            onClick={runOptimize}
            disabled={isProcessing}
            title={isProcessing ? 'Блокировано: идёт тяжёлая операция' : undefined}
            className="px-3 py-1 bg-cyan-600 hover:bg-cyan-700 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isProcessing ? '⏳ Занято…' : 'Оптимизировать'}
          </button>
        </div>
        {optMsg && <div className="text-[11px] text-emerald-300 mt-1">{optMsg}</div>}
      </div>

      {/* Змейка сканирования */}
      <div className="border-t border-gray-700 pt-2">
        <div className="text-xs text-gray-400 mb-1">Сканирование полигона «змейкой» (scan_area)</div>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            min={5}
            value={scanSpacingPx}
            onChange={(e) => setScanSpacingPx(e.target.value)}
            className="w-24 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            title="Шаг линий сканирования, пикселей карты"
          />
          <span className="text-[11px] text-gray-500">шаг, px</span>
          <button
            onClick={runScan}
            disabled={isProcessing}
            title={isProcessing ? 'Блокировано: идёт тяжёлая операция' : undefined}
            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isProcessing ? '⏳ Занято…' : 'Построить'}
          </button>
        </div>
      </div>

      {/* Параметры путевой точки */}
      {route && route.points.length > 0 && (
        <div className="border-t border-gray-700 pt-2">
          <div className="text-xs text-gray-400 mb-1">Параметры точки (add_waypoint params)</div>
          <input
            type="range"
            min={0}
            max={route.points.length - 1}
            value={wpIndex}
            onChange={(e) => setWpIndex(Number(e.target.value))}
            className="w-full"
          />
          <div className="text-[11px] text-gray-500 mb-1">точка №{wpIndex + 1} из {route.points.length}</div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['holdSec', 'Задержка, с'],
              ['cameraAngleDeg', 'Камера, °'],
              ['speedMs', 'Скорость, м/с'],
              ['acceptanceRadiusM', 'Радиус прин., м'],
            ] as const).map(([key, label]) => (
              <label key={key} className="text-[11px] text-gray-400">
                {label}
                <input
                  type="number"
                  value={wp[key]}
                  onChange={(e) => setWaypointParams(route.id, wpIndex, { ...wp, [key]: num(e.target.value) })}
                  className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Метаданные миссии */}
      {route && (
        <div className="border-t border-gray-700 pt-2">
          <div className="text-xs text-gray-400 mb-1">Метаданные (create_mission)</div>
          <div className="flex gap-2">
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Автор"
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            />
            <button onClick={() => setMissionMeta(route.id, author)} className="px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded text-white">
              Сохранить
            </button>
          </div>
        </div>
      )}

      {/* Назначения Боевым Аппаратам */}
      <div className="border-t border-gray-700 pt-2">
        <div className="text-xs text-gray-400 mb-1">Боевые Аппараты: старт / цель / узлы боевого курса</div>
        <div className="flex items-center gap-2 mb-2">
          <label className="text-[11px] text-gray-500">кол-во</label>
          <input
            type="number"
            min={1}
            max={8}
            value={droneCount}
            onChange={(e) => setDroneCount(Math.min(8, Math.max(1, num(e.target.value))))}
            className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          />
        </div>
        {Array.from({ length: droneCount }, (_, i) => `uav-${i + 1}`).map((droneId) => {
          const a = droneAssignments.find((d) => d.droneId === droneId);
          // Авто-регистрация дрона в парке при первом появлении в панели
          if (!fleetDrones.some((d) => d.droneId === droneId)) {
            registerDrone(droneId, 'udp://127.0.0.1:14550', ['video']);
          }
          const rec = fleetDrones.find((d) => d.droneId === droneId);
          const video = videoStatusFor(droneId, 0);
          return (
            <div key={droneId} className="mb-1 p-2 bg-gray-800 rounded">
              <div className="text-[11px] text-gray-400 mb-1 flex items-center justify-between">
                <span>🛩 {droneId}</span>
                <button
                  onClick={() => requestVideo(droneId, !rec?.videoRequested)}
                  className={`px-2 py-0.5 rounded text-[10px] text-white ${video.streaming ? 'bg-red-600 animate-pulse' : 'bg-gray-600 hover:bg-gray-500'}`}
                  title={video.note}
                >
                  {video.streaming ? '● REC LIVE' : '▶ Видео'}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1 mb-1">
                <select
                  value={rec?.mode ?? 'short_range'}
                  onChange={(e) => setDroneMode(droneId, e.target.value as DroneMode)}
                  className="px-1 py-1 bg-gray-700 border border-gray-600 rounded text-white text-[11px]"
                  title="Режим работы дрона"
                >
                  <option value="short_range">Короткий / агро</option>
                  <option value="long_range">Дальнобойный ≤50 000 км</option>
                </select>
                <select
                  value={rec?.droneClass ?? 'standard'}
                  onChange={(e) => setDroneClass(droneId, e.target.value as DroneClass)}
                  className="px-1 py-1 bg-gray-700 border border-gray-600 rounded text-white text-[11px]"
                  title="Класс применения"
                >
                  <option value="standard">Обычный</option>
                  <option value="agri">Агродрон</option>
                </select>
                <div className="px-1 py-1 text-[10px] text-gray-400 truncate" title={video.note}>
                  {video.ok ? `📹 ${DRONE_PROFILES[rec?.mode ?? 'short_range'].video.resolution}` : '📹 —'}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1">
                <select
                  value={a?.startId ?? ''}
                  onChange={(e) => setDroneAssignment(droneId, { startId: e.target.value || null })}
                  className="px-1 py-1 bg-gray-700 border border-gray-600 rounded text-white text-[11px]"
                >
                  <option value="">старт…</option>
                  {(project.importLists?.starts ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
                <select
                  value={a?.goalId ?? ''}
                  onChange={(e) => setDroneAssignment(droneId, { goalId: e.target.value || null })}
                  className="px-1 py-1 bg-gray-700 border border-gray-600 rounded text-white text-[11px]"
                >
                  <option value="">цель…</option>
                  {(project.importLists?.goals ?? []).map((g) => (
                    <option key={g.id} value={g.id}>{g.label}</option>
                  ))}
                </select>
                <select
                  value={a?.routeId ?? ''}
                  onChange={(e) => setDroneAssignment(droneId, { routeId: e.target.value || null })}
                  className="px-1 py-1 bg-gray-700 border border-gray-600 rounded text-white text-[11px]"
                >
                  <option value="">маршрут…</option>
                  {routes.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {/* Симуляция цикла управления */}
      <div className="border-t border-gray-700 pt-2">
        <button onClick={() => void runSimCycle()} className="w-full px-3 py-1 bg-amber-600 hover:bg-amber-700 rounded text-white">
          ▶ Прогнать цикл в модуле Боевого Моделирования на (preflight → arm → takeoff → RTL)
        </button>
        {simLog.length > 0 && (
          <pre className="mt-2 p-2 bg-gray-900 rounded text-[11px] text-gray-300 whitespace-pre-wrap">{simLog.join('\n')}</pre>
        )}
      </div>
    </div>
  );
};

export default MissionPanel;
