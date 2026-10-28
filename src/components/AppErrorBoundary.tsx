// ═══════════════════════════════════════════════════════════════
// AppErrorBoundary — перехват крашей рендера вместо белого экрана.
// Показывает диагностику (сообщение/стек/componentStack) и кнопку сброса:
// очистка персистентных хранилищ + перезагрузка ⇒ выход из «битого снапшота».
// Класс-компонент: getDerivedStateFromError/errorBoundary — единственная
// легитимная ниша классов в современном React (хуков для этого нет).
// ═══════════════════════════════════════════════════════════════
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

/** Ключи всех persist-хранилищ приложения (см. useMapStore/useMissionStore/useFleetStore). */
const STORAGE_KEYS = ['tq-map', 'tq-mission', 'tq-fleet', 'totalquadro-storage'] as const;

export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Единственный канал диагностики упавшего дерева — консоль/будущий APM.
    console.error('[AppErrorBoundary] render crash:', error, info.componentStack);
    this.setState({ info });
  }

  private readonly handleReset = (): void => {
    try {
      for (const key of STORAGE_KEYS) localStorage.removeItem(key);
    } catch {
      /* localStorage может быть заблокирован приватным режимом — идём дальше */
    }
    window.location.reload();
  };

  private readonly handleKeep = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-gray-950 p-4">
        <div
          role="alert"
          className="max-w-lg w-full rounded-xl border border-red-500/60 bg-gray-900 p-5 text-sm text-gray-200 shadow-2xl"
        >
          <h1 className="text-lg font-bold text-red-400 mb-2">⛔ Приложение упало</h1>
          <p className="mb-2 leading-relaxed">
            Произошла непредвиденная ошибка рендера. Можно попробовать продолжить работу
            или выполнить полный сброс сохранённых данных проекта.
          </p>
          <pre className="mb-3 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-xs text-red-300 whitespace-pre-wrap">
            {error.message}
            {info?.componentStack ? `\n\n${info.componentStack.slice(0, 800)}` : ''}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="flex-1 rounded-lg bg-red-700 hover:bg-red-600 px-3 py-2 font-semibold text-white"
              title={`Очистить ${STORAGE_KEYS.length} локальных хранилищ и перезагрузить страницу`}
            >
              🧹 Сбросить данные и перезапустить
            </button>
            <button
              onClick={this.handleKeep}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-2 text-gray-200"
            >
              ↩ Продолжить без сброса
            </button>
          </div>
        </div>
      </div>
    );
  }
}
