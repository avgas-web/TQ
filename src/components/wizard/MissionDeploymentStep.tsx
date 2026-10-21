// ЭТАП 8: развёртывание — генерация файла, скачивание, MAVLink-инструкция,
// лог операций, сохранение миссии, экспорт .tqproj, сброс с confirmation.
import { useState } from 'react';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';
import { buildPreview } from './ExportPreparationStep';
import { ConfirmDialog } from './shared';

export function MissionDeploymentStep() {
  const s = useMissionWizardStore();
  const [confirmReset, setConfirmReset] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const generateAndDownload = async () => {
    setError(null);
    try {
      setProgress(10);
      await s.deployMission();          // валидация + запись в лог
      setProgress(60);
      if (!s.exportFormat) throw new Error('Формат не выбран');
      const content = buildPreview(s.exportFormat, s);
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mission-${Date.now()}.${s.exportFormat === 'mavlink' ? 'bin.txt' : s.exportFormat}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setProgress(100);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      useMissionWizardStore.setState((st) => ({ deploymentLog: [...st.deploymentLog, `✗ ${msg} — попробуйте повторить.`] }));
    }
  };

  const saveProject = () => {
    const data = JSON.stringify({ version: 1, wizard: s }, null, 2);
    localStorage.setItem('tq-mission-saved', data);
    useMissionWizardStore.setState((st) => ({ deploymentLog: [...st.deploymentLog, '✓ Миссия сохранена локально.'] }));
  };

  const exportTqproj = () => {
    const blob = new Blob([JSON.stringify({ version: 1, craftType: s.craftType, startPoints: s.startPoints, targetPoints: s.targetPoints, fleetGroups: s.fleetGroups, noFlyZones: s.noFlyZones, routes: s.calculatedRoutes })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mission.tqproj';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <h2 className="text-lg font-bold text-emerald-300">Этап 8. Передача заданий</h2>

      <button type="button" data-testid="download-file"
        className="btn-primary w-fit px-8 py-4 text-base"
        onClick={() => void generateAndDownload()}>
        ⬇ Скачать файл ({s.exportFormat?.toUpperCase() ?? '—'})
      </button>
      {progress > 0 && progress < 100 && (
        <div role="progressbar" aria-valuenow={progress} className="h-2 w-64 rounded bg-slate-700">
          <div className="h-2 rounded bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && <p role="alert" data-testid="deploy-error" className="text-sm text-red-300">✗ {error} — проверьте данные этапа 7 и повторите.</p>}

      {s.craftType === 'drone' && (
        <details open className="rounded border border-slate-700 bg-slate-800/50 p-3 text-xs" aria-label="Инструкция MAVLink">
          <summary className="cursor-pointer font-bold text-cyan-300">Как передать задание в дрон по MAVLink</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
            <li>Подключите дрон к наземной станции через QGroundControl / Mission Planner (USB или телеметрия 57600 8N1).</li>
            <li>Откройте скачанный файл маршрута в разделе «Полётное задание» (Flight Tasks).</li>
            <li>Проверьте точки на карте, затем «Загрузить» (Upload) → дождитесь подтверждения MAV_ACK.</li>
            <li>Перед пуском убедитесь, что NFZ загружены в геозоны полётного контроллера.</li>
          </ol>
          <button type="button" data-testid="send-to-drone" className="btn-secondary mt-2"
            onClick={() => useMissionWizardStore.setState((st) => ({ deploymentLog: [...st.deploymentLog, 'ℹ Прямая отправка недоступна: используйте инструкцию выше (нет подключённого MAVLink-устройства).'] }))}>
            Отправить в дрон
          </button>
        </details>
      )}

      <h3 className="text-sm font-bold text-slate-300">Лог операций</h3>
      <ul data-testid="deployment-log" aria-label="Лог передачи"
        className="max-h-40 overflow-auto rounded border border-slate-700 bg-black/60 p-2 font-mono text-[11px] text-slate-300">
        {s.deploymentLog.length === 0 && <li className="text-slate-500">пока пусто</li>}
        {s.deploymentLog.map((l, i) => <li key={i}>{l}</li>)}
      </ul>

      <div className="mt-auto flex gap-2">
        <button type="button" data-testid="save-mission" className="btn-secondary" onClick={saveProject}>💾 Сохранить миссию</button>
        <button type="button" data-testid="export-tqproj" className="btn-secondary" onClick={exportTqproj}>📦 Экспортировать проект (.tqproj)</button>
        <button type="button" data-testid="new-mission" className="btn-danger ml-auto" onClick={() => setConfirmReset(true)}>↺ Начать новую миссию</button>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Начать новую миссию? Все данные текущего плана (точки, группы, зоны, маршруты, высоты) будут удалены безвозвратно. Вы уверены?"
          onConfirm={() => { s.resetWizard(); setConfirmReset(false); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
