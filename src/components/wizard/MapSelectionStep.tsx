// ЭТАП 1 (ТЗ): выбор карт для загрузки.
// Пользователь мультивыбирает подложки из ВСЕХ рабочих вариантов (2ГИС удалён
// полностью — см. utils/openStreetMap.ts) и назначает основную карту.
// Выбор синхронизируется с картографическим стором через useMissionWizardStore
// (toggleMapChoice / setPrimaryMap), поэтому этап реально влияет на загрузку
// тайлов, а не является декорацией.
import React from 'react';
import {
  useMissionWizardStore, MAP_CHOICES,
} from '../../store/useMissionWizardStore';
import { TILE_PROVIDERS } from '../../utils/openStreetMap';
import { StepShell } from './shared';

export function MapSelectionStep() {
  const selectedMaps = useMissionWizardStore((s) => s.selectedMaps);
  const primaryMap = useMissionWizardStore((s) => s.primaryMap);
  const toggleMapChoice = useMissionWizardStore((s) => s.toggleMapChoice);
  const setPrimaryMap = useMissionWizardStore((s) => s.setPrimaryMap);

  return (
    <StepShell
      title="Этап 1. Выбор карт для загрузки"
      hint="Отметьте одну или несколько подложек для загрузки тайлов и выберите основную (активную) карту. Все серверы работают по HTTPS без API-ключей."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {MAP_CHOICES.map((choice) => {
          const isSelected = selectedMaps.includes(choice.id);
          const isPrimary = primaryMap === choice.id;
          const info = TILE_PROVIDERS[choice.id];
          return (
            <div
              key={choice.id}
              data-testid={`map-choice-card-${choice.id}`}
              className={
                'rounded-xl border-2 p-4 transition ' +
                (isPrimary
                  ? 'border-cyan-400 bg-cyan-950/60 shadow-lg shadow-cyan-500/20'
                  : isSelected
                    ? 'border-emerald-500/70 bg-slate-800/80'
                    : 'border-slate-700 bg-slate-800/50 hover:border-slate-500')
              }
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-cyan-500"
                  checked={isSelected}
                  aria-label={`Загружать карту: ${choice.label}`}
                  onChange={() => toggleMapChoice(choice.id)}
                  data-testid={`map-choice-${choice.id}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-slate-100">{choice.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-400">{choice.desc}</span>
                  <span className="mt-1 block text-[10px] text-slate-500">
                    zoom до {info.maxZoom} · {info.attribution.replace(/<[^>]*>/g, '')}
                  </span>
                </span>
              </label>
              <button
                type="button"
                data-testid={`map-primary-${choice.id}`}
                disabled={!isSelected}
                aria-pressed={isPrimary}
                onClick={() => setPrimaryMap(choice.id)}
                className={
                  'mt-3 w-full rounded-lg border px-3 py-1.5 text-xs font-semibold transition ' +
                  (isPrimary
                    ? 'border-cyan-400 bg-cyan-500 text-slate-950'
                    : isSelected
                      ? 'border-slate-600 bg-slate-900 text-slate-200 hover:border-cyan-500 hover:text-cyan-300'
                      : 'cursor-not-allowed border-slate-800 bg-slate-900/50 text-slate-600')
                }
                title={isSelected ? 'Сделать основной активной подложкой' : 'Сначала отметьте карту для загрузки'}
              >
                {isPrimary ? '★ Основная карта' : 'Сделать основной'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300" role="note">
        Выбрано карт: <b data-testid="map-selection-count">{selectedMaps.length}</b>
        {primaryMap && (
          <> · основная: <b data-testid="map-selection-primary">{MAP_CHOICES.find((c) => c.id === primaryMap)?.label ?? primaryMap}</b></>
        )}
        {!isSelectedNothing(selectedMaps) && !primaryMap && (
          <span className="ml-2 text-amber-300">⚠ Назначьте основную карту.</span>
        )}
        {selectedMaps.length === 0 && (
          <span className="ml-2 text-amber-300">⚠ Выберите хотя бы одну карту — без этого дальше идти нельзя.</span>
        )}
      </div>
    </StepShell>
  );
}

function isSelectedNothing(selected: readonly unknown[]) {
  return selected.length === 0;
}

export default MapSelectionStep;
