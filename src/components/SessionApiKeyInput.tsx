// ═══════════════════════════════════════════════════════════════
// SessionApiKeyInput — защищённый ввод API-ключа провайдера (ЭТАП 1.2).
//   • masked input (type=password + autoComplete=new-password) — ключ
//     не отображается на экране и не сохраняется браузерами;
//   • модальное окно-предупреждение о рисках клиентских ключей перед
//     применением (требование ТЗ);
//   • значение передаётся родителю только через onChange → в sessionSecrets
//     (память текущей сессии); компонент НИКОГДА не пишет ключ сам;
//   • после применения поле очищается — полное значение не остаётся в DOM;
//     в UI показывается только маска (ab••••yz) и источник (session|env|none).
// Строгая типизация: никаких any.
// ═══════════════════════════════════════════════════════════════
import React, { useState } from 'react';
import {
  PROVIDER_KEY_META,
  getApiKeySource,
  maskApiKey,
  type MapProviderKeyKind,
} from '../utils/sessionSecrets';

interface SessionApiKeyInputProps {
  kind: MapProviderKeyKind;
  /** Вызывается с trimmed-значением ('' = очистка). Родитель кладёт его в sessionSecrets. */
  onApply: (key: string) => void | Promise<void>;
  disabled?: boolean;
}

const SOURCE_LABEL: Record<'session' | 'env' | 'none', { text: string; cls: string }> = {
  session: { text: 'Ключ активен (память сессии)', cls: 'text-green-400' },
  env: { text: 'Dev-ключ из .env (только для разработки!)', cls: 'text-yellow-400' },
  none: { text: 'Ключ не задан', cls: 'text-gray-500' },
};

const SessionApiKeyInput: React.FC<SessionApiKeyInputProps> = ({ kind, onApply, disabled }) => {
  const meta = PROVIDER_KEY_META[kind];
  const [draft, setDraft] = useState('');
  const [showWarning, setShowWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // маска применённого ключа — реактивна от store-флага родителя? Нет: держим
  // локальную копию только маски (полное значение нигде не храним).
  const [appliedMask, setAppliedMask] = useState('');
  const source = getApiKeySource(kind);

  const confirmApply = async () => {
    setShowWarning(false);
    setBusy(true);
    setError('');
    try {
      await onApply(draft.trim());
      setAppliedMask(maskApiKey(draft));
      setDraft(''); // полное значение уходит из DOM-поля сразу после применения
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось применить ключ');
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setError('');
    try {
      await onApply('');
      setAppliedMask('');
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-400 block">
        API ключ {meta.label} <span className="text-gray-600">(только память сессии)</span>
      </label>
      <div className="flex gap-1">
        <input
          type="password"
          name={`${kind}-maps-session-key`}
          autoComplete="new-password"
          spellCheck={false}
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setError('')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (draft.trim()) setShowWarning(true);
            }
          }}
          placeholder={appliedMask ? `Активен: ${appliedMask}` : 'Введите API ключ'}
          className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
        />
        <button
          type="button"
          disabled={disabled || busy || !draft.trim()}
          onClick={() => setShowWarning(true)}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-xs"
        >
          {busy ? '...' : 'Применить'}
        </button>
        {(appliedMask || source !== 'none') && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={handleClear}
            title="Забыть ключ текущей сессии"
            className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-gray-200 rounded text-xs"
          >
            ✕
          </button>
        )}
      </div>
      <p className={`text-[10px] ${SOURCE_LABEL[source].cls}`}>
        {source === 'session' && appliedMask
          ? `${SOURCE_LABEL.session.text}: ${appliedMask}`
          : SOURCE_LABEL[source].text}
      </p>
      {error && (
        <div className="p-2 bg-red-900/30 border border-red-500 rounded text-xs text-red-300">
          ❌ {error}
        </div>
      )}

      {/* Модальное окно-предупреждение о рисках (требование ЭТАП 1.2) */}
      {showWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Предупреждение о рисках использования API-ключа"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowWarning(false)}
        >
          <div
            className="max-w-md w-full bg-gray-800 border border-yellow-600 rounded-lg p-4 space-y-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold text-yellow-400">
              ⚠️ Риски использования API-ключа в браузере
            </h4>
            <ul className="text-xs text-gray-300 space-y-1.5 list-disc pl-4">
              <li>Любой ключ в клиентском коде может быть извлечён посетителями страницы или расширениями браузера.</li>
              <li>Злоумышленник сможет расходовать ваш квотный/платный лимит провайдера карт.</li>
              <li>В этом приложении ключ НЕ сохраняется в localStorage/IndexedDB и НЕ попадает в экспорт проекта — он живёт только в памяти текущей вкладки и стирается при закрытии.</li>
              <li>Рекомендуется: отдельный ключ с HTTP-Referer ограничениями и минимальными правами; для продакшена — проксирование запросов через свой сервер.</li>
            </ul>
            <p className="text-xs text-gray-400">
              Ключ: <span className="font-mono">{maskApiKey(draft)}</span> ({meta.label})
            </p>
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowWarning(false)}
                className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={confirmApply}
                className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded text-xs font-medium"
              >
                Понимаю риск, применить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionApiKeyInput;
