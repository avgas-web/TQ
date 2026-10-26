// MissionWizard — оболочка пошагового мастера: прогресс-бар 9 этапов,
// навигация Назад/Далее с жёсткой блокировкой, горячие клавиши Alt+←/→,
// confirmation при переходе на завершённый этап назад.
import React, { useEffect, useState } from 'react';
import {
  useMissionWizardStore, WIZARD_STEPS, STEP_LABELS_RU, type WizardStep,
} from '../../store/useMissionWizardStore';
import { MapSelectionStep } from './MapSelectionStep';
import { CraftSelectionStep } from './CraftSelectionStep';
import { StartPointsStep } from './StartPointsStep';
import { TargetPointsStep } from './TargetPointsStep';
import { FleetFormationStep } from './FleetFormationStep';
import { NFZAndRoutesStep } from './NFZAndRoutesStep';
import { AltitudeProfilesStep } from './AltitudeProfilesStep';
import { ExportPreparationStep } from './ExportPreparationStep';
import { MissionDeploymentStep } from './MissionDeploymentStep';
import { ConfirmDialog, NextButton, StepIssues } from './shared';
import { ensureDefaultTileMap } from '../../hooks/useAppInitialization';

const STEP_COMPONENTS: Record<WizardStep, React.FC> = {
  'map-selection': MapSelectionStep,
  'craft-selection': CraftSelectionStep,
  'start-points': StartPointsStep,
  'target-points': TargetPointsStep,
  'fleet-formation': FleetFormationStep,
  'nfz-and-routes': NFZAndRoutesStep,
  'altitude-profiles': AltitudeProfilesStep,
  'export-preparation': ExportPreparationStep,
  'mission-deployment': MissionDeploymentStep,
};

export function MissionWizard() {
  const currentStep = useMissionWizardStore((s) => s.currentStep);
  const completedSteps = useMissionWizardStore((s) => s.completedSteps);
  const goToNextStep = useMissionWizardStore((s) => s.goToNextStep);
  const goToPreviousStep = useMissionWizardStore((s) => s.goToPreviousStep);
  const goToStep = useMissionWizardStore((s) => s.goToStep);
  const [pendingJump, setPendingJump] = useState<WizardStep | null>(null);

  // АВТОЗАГРУЗКА КАРТЫ ПРИ ВХОДЕ В МАСТЕР (корневой фикс «точки на пустом
  // поле без карты»): при монтировании мастера гарантируем наличие тайловой
  // подложки — в продакшене это no-op (App/useAppInitialization уже загрузил
  // OSM), а на standalone-экране/в тестах карта создаётся сама. Идемпотентно.
  // Отложенный microtask нужен из-за async-гидрации zustand persist: синхронная
  // загрузка на mount была бы перезаписана гидрацией через тик («карта
  // исчезает»). Если гидрация ещё не завершена — ensureDefaultTileMap сам
  // переносит создание карты в onFinishHydration (см. useAppInitialization).
  useEffect(() => {
    void Promise.resolve().then(() => ensureDefaultTileMap());
  }, []);

  // Горячие клавиши Alt+← / Alt+→
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowRight') goToNextStep();
      if (e.key === 'ArrowLeft') goToPreviousStep();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToNextStep, goToPreviousStep]);

  const idx = WIZARD_STEPS.indexOf(currentStep);
  const StepComp = STEP_COMPONENTS[currentStep];

  const jumpTo = (step: WizardStep) => {
    if (step === currentStep) return;
    if (completedSteps.includes(step)) setPendingJump(step); // назад — с confirmation
    else goToStep(step); // вперёд к доступному — прямая проверка в сторе
  };

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100" data-testid="mission-wizard">
      {/* Прогресс-бар этапов */}
      <nav aria-label="Прогресс мастер-планирования" className="flex items-center gap-1 border-b border-slate-800 bg-slate-950 px-3 py-2">
        {WIZARD_STEPS.map((step, i) => {
          const done = completedSteps.includes(step);
          const active = step === currentStep;
          return (
            <button
              key={step}
              type="button"
              data-testid={`wizard-step-${i + 1}`}
              title={STEP_LABELS_RU[step]}
              onClick={() => jumpTo(step)}
              className={
                'flex items-center gap-1 rounded-full px-2 py-1 text-[11px] transition ' +
                (active ? 'bg-cyan-600 font-bold text-white'
                  : done ? 'bg-green-900/60 text-green-300 hover:bg-green-800'
                    : 'bg-slate-800 text-slate-500')
              }
            >
              <span>{done && !active ? '✓' : i + 1}</span>
              <span className="hidden lg:inline">{STEP_LABELS_RU[step]}</span>
            </button>
          );
        })}
        <span className="ml-auto text-xs text-slate-400">Этап {idx + 1}/{WIZARD_STEPS.length} · Alt+←/→ навигация</span>
      </nav>

      {/* Контент этапа */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <StepComp />
      </main>

      {/* Навигация */}
      <footer className="flex items-center gap-3 border-t border-slate-800 bg-slate-950 px-4 py-2">
        <button type="button" className="btn-secondary" data-testid="back-btn"
          disabled={idx === 0} onClick={goToPreviousStep}
          title={idx === 0 ? 'Первый этап' : 'Вернуться к предыдущему этапу'}>
          ← Назад
        </button>
        <div className="flex-1"><StepIssues /></div>
        {currentStep !== 'mission-deployment' ? (
          <>
            <NextButton />
            <button type="button" className="btn-secondary" data-testid="save-progress"
              title="Автосохранение активно; кнопка — принудительный снимок"
              onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(useMissionWizardStore.getState().startPoints)).catch(() => undefined); }}>
              💾 Сохранить прогресс
            </button>
          </>
        ) : (
          <span className="text-xs text-green-400">Финальный этап</span>
        )}
      </footer>

      {pendingJump && (
        <ConfirmDialog
          title={`Вернуться к завершённому этапу «${STEP_LABELS_RU[pendingJump]}»? Данные последующих этапов сохранятся, но их придётся перепроверить.`}
          onConfirm={() => { goToStep(pendingJump); setPendingJump(null); }}
          onCancel={() => setPendingJump(null)}
        />
      )}
    </div>
  );
}
