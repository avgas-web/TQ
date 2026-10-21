// ЭТАП 4: формирование групп флота. Режимы: авто / вручную, таблица целей,
// валидация суммы аппаратов, визуализация цветных линий старт→цель.
import { useState } from 'react';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';

const GROUP_COLORS = ['#00d0ff', '#ff9500', '#a78bfa', '#34d399', '#f472b6', '#facc15'];

export function FleetFormationStep() {
  const s = useMissionWizardStore();
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [draftTarget, setDraftTarget] = useState('');
  const [draftCount, setDraftCount] = useState(1);
  const [draftStart, setDraftStart] = useState('');

  const totalInGroups = s.fleetGroups.reduce((a, g) => a + g.totalCraft, 0);
  const diff = s.totalCraft - totalInGroups;

  return (
    <div className="flex h-full gap-3 overflow-hidden p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
        <h2 className="text-lg font-bold text-violet-300">Этап 4. Группировка флота</h2>
        <p className="text-xs text-slate-400">
          Распределите аппараты по целям. «Далее» станет активна, когда каждая цель получит хотя бы один аппарат и сумма совпадёт с общим количеством.
        </p>

        {/* Toggle режима */}
        <div role="group" aria-label="Режим формирования" className="flex gap-1">
          <button type="button" data-testid="mode-auto"
            className={'btn-sm ' + (mode === 'auto' ? 'btn-primary' : 'btn-secondary')}
            onClick={() => setMode('auto')}>Автоматически</button>
          <button type="button" data-testid="mode-manual"
            className={'btn-sm ' + (mode === 'manual' ? 'btn-primary' : 'btn-secondary')}
            onClick={() => setMode('manual')}>Вручную</button>
        </div>

        <label className="flex items-center gap-2 text-sm">
          Всего аппаратов:
          <input
            type="number" min={1} data-testid="total-craft"
            className="input-dark w-24"
            value={s.totalCraft || ''}
            onChange={(e) => s.setTotalCraft(Number(e.target.value))}
          />
        </label>

        {mode === 'auto' && (
          <button type="button" className="btn-primary w-fit" data-testid="autofill-btn"
            onClick={() => s.autoFormGroups()}>
            Сформировать группы автоматически
          </button>
        )}

        {mode === 'manual' && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-slate-700 bg-slate-800/50 p-2">
            <label className="text-xs">Цель
              <select data-testid="group-target" className="input-dark block" value={draftTarget} onChange={(e) => setDraftTarget(e.target.value)}>
                <option value="">— выбрать —</option>
                {s.targetPoints.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="text-xs">Старт
              <select data-testid="group-start" className="input-dark block" value={draftStart} onChange={(e) => setDraftStart(e.target.value)}>
                <option value="">— выбрать —</option>
                {s.startPoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="text-xs">Кол-во
              <input type="number" min={1} data-testid="group-count" className="input-dark block w-20"
                value={draftCount} onChange={(e) => setDraftCount(Number(e.target.value))} />
            </label>
            <button type="button" data-testid="add-group" className="btn-primary"
              onClick={() => {
                if (!draftTarget || !draftStart) return;
                s.createFleetGroup({
                  targetPointId: draftTarget, totalCraft: draftCount,
                  assignments: [{ startPointId: draftStart, craftCount: draftCount }],
                });
              }}>+ Группа</button>
          </div>
        )}

        {/* Таблица групп */}
        <table className="w-full text-left text-xs" aria-label="Группы флота">
          <thead><tr className="text-slate-400">
            <th>#</th><th>Цель</th><th>Старты</th><th>Аппараты</th><th></th>
          </tr></thead>
          <tbody>
            {s.fleetGroups.map((g, i) => {
              const t = s.targetPoints.find((x) => x.id === g.targetPointId);
              return (
                <tr key={g.id} className="border-t border-slate-800">
                  <td><span style={{ color: GROUP_COLORS[i % GROUP_COLORS.length] }}>■</span> {i + 1}</td>
                  <td>{t?.name ?? '—'}</td>
                  <td>{g.assignments.map((a) => `${s.startPoints.find((p) => p.id === a.startPointId)?.name ?? '?'}×${a.craftCount}`).join(', ')}</td>
                  <td>{g.totalCraft}</td>
                  <td><button type="button" aria-label={`Удалить группу ${i + 1}`} className="text-red-400" onClick={() => s.removeFleetGroup(g.id)}>✛</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p data-testid="craft-sum-indicator"
          className={'text-sm font-semibold ' + (diff === 0 && s.totalCraft > 0 ? 'text-green-400' : 'text-yellow-300')}>
          В группах: {totalInGroups} из {s.totalCraft}{diff !== 0 ? ` · расхождение ${diff > 0 ? '+' : ''}${diff}` : ''}
        </p>
      </div>

      {/* Визуализация: цветные линии старт→цель */}
      <aside className="w-80 shrink-0 border-l border-slate-800 p-2" aria-label="Визуализация групп">
        <svg viewBox="0 0 640 480" className="w-full rounded border border-slate-700 bg-slate-950">
          {s.fleetGroups.map((g, i) => {
            const t = s.targetPoints.find((x) => x.id === g.targetPointId);
            if (!t) return null;
            return g.assignments.map((a) => {
              const sp = s.startPoints.find((p) => p.id === a.startPointId);
              if (!sp) return null;
              return <line key={g.id + a.startPointId} x1={sp.x} y1={sp.y} x2={t.x} y2={t.y}
                stroke={GROUP_COLORS[i % GROUP_COLORS.length]} strokeWidth={2} opacity={0.8} />;
            });
          })}
          {s.startPoints.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={5} fill="#00d0ff" />)}
          {s.targetPoints.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={5} fill="#f472b6" />)}
        </svg>
      </aside>
    </div>
  );
}
