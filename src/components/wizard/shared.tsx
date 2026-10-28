// Общие UI-примитивы мастера: inline-валидация, модалки, баннеры ошибок.
import { useEffect, useState, type ReactNode } from 'react';
import { useMissionWizardStore } from '../../store/useMissionWizardStore';

export function StepIssues() {
  const issues = useMissionWizardStore((s) => s.issues);
  if (issues.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="mt-3 flex flex-col gap-1">
      {issues.map((i, idx) => (
        <div
          key={idx}
          className={
            'rounded px-2 py-1 text-sm ' +
            (i.level === 'error' ? 'bg-red-900/60 text-red-200' : 'bg-yellow-900/50 text-yellow-200')
          }
        >
          {i.level === 'error' ? '✗ ' : '⚠ '}
          {i.message}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog({
  title, onConfirm, onCancel,
}: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="max-w-md rounded-lg border border-cyan-700 bg-slate-900 p-4">
        <p className="mb-4 text-sm">{title}</p>
        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={onConfirm}>Продолжить</button>
          <button type="button" className="btn-secondary flex-1" onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

/** Кнопка «Далее» с блокировкой по критериям завершения текущего этапа. */
export function NextButton() {
  const goToNextStep = useMissionWizardStore((s) => s.goToNextStep);
  // точечные подписки + чистая validateCurrentStep (не вызывает set) — без каскада рендеров
  const enabled = useMissionWizardStore((s) => s.canProceedToNextStep());
  return (
    <button
      type="button"
      className="btn-primary min-w-[140px]"
      disabled={!enabled}
      title={enabled ? 'Перейти к следующему этапу' : 'Завершите текущий этап — есть незакрытые ошибки'}
      onClick={() => { if (enabled) goToNextStep(); }}
    >
      Далее →
    </button>
  );
}

export function StepShell({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex h-full flex-col gap-2 overflow-auto p-4">
      <h2 className="text-lg font-bold text-cyan-300">{title}</h2>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
      {children}
      <StepIssues />
    </section>
  );
}
