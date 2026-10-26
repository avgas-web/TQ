// ЭТАП 2: выбор типа аппарата (drone / uav) с confirmation-диалогом.
import { useState } from 'react';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';
import { CRAFT_OPTIONS, type CraftOptionPublic } from './craftOptions';
import { ConfirmDialog, StepShell } from './shared';

export function CraftSelectionStep() {
  const craftType = useMissionWizardStore((s) => s.craftType);
  const setCraftType = useMissionWizardStore((s) => s.setCraftType);
  const resetCraftChoice = useMissionWizardStore((s) => s.resetCraftChoice);
  const [pending, setPending] = useState<CraftOptionPublic | null>(null);
  // тип, на который пользователь хочет сменить зафиксированный (для changeWarn-диалога)
  const [pendingChange, setPendingChange] = useState<CraftOptionPublic | null>(null);
  const [changeWarn, setChangeWarn] = useState(false);

  const pick = (opt: CraftOptionPublic) => {
    // клик по уже выбранной карточке — no-op: не создаём ложного диалога
    if (craftType === opt.type) return;
    if (craftType && craftType !== opt.type) {
      // тип уже зафиксирован — изменение сбрасывает все последующие данные
      setPendingChange(opt);
      setChangeWarn(true);
      return;
    }
    setPending(opt);
  };

  return (
    <StepShell
      title="Этап 2. Выбор типа аппарата"
      hint="Дрон — электрический мультикоптер (до 100 км). БПЛА — самолётного типа (межконтинентальные дальности)."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {CRAFT_OPTIONS.map((opt) => (
          <button
            key={opt.type}
            type="button"
            data-testid={`craft-card-${opt.type}`}
            aria-pressed={craftType === opt.type}
            onClick={() => pick(opt)}
            className={
              'rounded-xl border-2 p-6 text-left transition hover:scale-[1.02] ' +
              (craftType === opt.type
                ? 'border-cyan-400 bg-cyan-950/60 shadow-lg shadow-cyan-500/20'
                : 'border-slate-700 bg-slate-800/60 hover:border-cyan-600')
            }
          >
            <div className="text-4xl">{opt.icon}</div>
            <h3 className="mt-2 text-xl font-bold">{opt.name}</h3>
            <p className="text-sm text-slate-300">{opt.description}</p>
            <p className="mt-2 text-sm font-semibold text-cyan-300">
              Максимальная дальность: {opt.maxRange.toLocaleString('ru-RU')} км
            </p>
            {opt.batteryInfo && <p className="mt-1 text-xs text-slate-400">🔋 {opt.batteryInfo}</p>}
            {opt.engineInfo && <p className="mt-1 text-xs text-slate-400">⛽ {opt.engineInfo}</p>}
            {craftType === opt.type && <p className="mt-2 text-xs font-bold text-green-400">✓ Выбрано</p>}
          </button>
        ))}
      </div>

      {craftType && (
        <p className="mt-2 text-xs text-yellow-300" role="note">
          Тип аппарата зафиксирован ({craftType === 'drone' ? 'дрон' : 'БПЛА'}). Изменение будет доступно только через подтверждённый сброс всех данных.
        </p>
      )}

      {pending && (
        <ConfirmDialog
          title={`Вы выбрали ${pending.name}. Изменить выбор можно будет только со сбросом всех последующих данных. Продолжить?`}
          onConfirm={() => { setCraftType(pending.type); setPending(null); }}
          onCancel={() => setPending(null)}
        />
      )}
      {changeWarn && (
        <ConfirmDialog
          title="Изменение типа аппарата сбросит все последующие данные (точки, группы, маршруты, высоты). Вы уверены?"
          onConfirm={() => {
            // сбрасываем данные И сразу фиксируем новый тип — иначе после
            // полного reset компонент вернулся бы в режим «первого выбора»
            resetCraftChoice(pendingChange?.type);
            setChangeWarn(false);
            setPendingChange(null);
          }}
          onCancel={() => { setChangeWarn(false); setPendingChange(null); }}
        />
      )}
    </StepShell>
  );
}
