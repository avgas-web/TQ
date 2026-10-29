// ═══════════════════════════════════════════════════════════════
// ApiKeyMaskedInput — защищённый UI-компонент ввода API-ключа (ЭТАП 1.2).
// Требования ТОРа:
//  • masked input (значение не светится в DOM как plain text);
//  • модальное окно-предупреждение о рисках перед сохранением;
//  • ключ хранится ТОЛЬКО в памяти текущей сессии (useApiKeysStore,
//    БЕЗ persist) — компонент никогда не пишет localStorage/IndexedDB.
// Компонент не знает о конкретном провайдере — только провайдер-id + label.
// ═══════════════════════════════════════════════════════════════
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useApiKeysStore, getEffectiveApiKey, maskKeyPreview, type MapsProviderId,
} from '../store/useApiKeysStore';

export interface ApiKeyMaskedInputProps {
  provider: MapsProviderId;
  label: string;
  /** Вызывается после подтверждения и сохранения ключа в сессионный стор */
  onCommit?: (provider: MapsProviderId, key: string) => void | Promise<void>;
  /** Отключает кнопку сохранения (напр. идёт загрузка карты) */
  disabled?: boolean;
}

const RISK_BULLETS = [
  'Ключ виден всем, кто получит доступ к этому устройству или браузеру.',
  'Не используйте ключи с широкими квотами/платежными данными на общих машинах.',
  'Ограничьте ключ в консоли провайдера по HTTP-Referer и IP.',
  'После закрытия вкладки ключ исчезает — он НЕ сохраняется на диск.',
] as const;

const ApiKeyMaskedInput: React.FC<ApiKeyMaskedInputProps> = ({ provider, label, onCommit, disabled }) => {
  const manual = useApiKeysStore((s) => s.manual[provider]);
  const setManualKey = useApiKeysStore((s) => s.setManualKey);
  const clearAllKeys = useApiKeysStore((s) => s.clearAllKeys);

  const [draft, setDraft] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  // При смене провайдера/размонтировании черновик не должен «протекать» в DOM
  useEffect(() => () => { setDraft(''); }, [provider]);

  const effective = getEffectiveApiKey(provider);
  const preview = manual ? maskKeyPreview(manual) : (effective ? `${maskKeyPreview(effective)} (из .env)` : '');

  const handlePasteGuard = useCallback((e: React.ClipboardEvent<HTMLInputElement>): void => {
    // Разрешаем вставку, но режем управляющие символы/пробелы по краям — частый источник «невидимых» ошибок
    const t = e.clipboardData.getData('text').trim();
    if (!t) { e.preventDefault(); return; }
    e.preventDefault();
    setDraft(t.replace(/\s+/g, ''));
  }, []);

  const openConfirm = (): void => {
    const k = draft.trim();
    if (!k) { setNote('Введите API ключ'); return; }
    if (/\s/.test(k)) { setNote('Ключ не должен содержать пробелов'); return; }
    setNote('');
    setConfirmOpen(true);
  };

  const confirmSave = async (): Promise<void> => {
    const k = draft.trim();
    setConfirmOpen(false);
    setBusy(true);
    try {
      setManualKey(provider, k);
      setDraft('');
      await onCommit?.(provider, k);
      setNote('Ключ сохранён только в памяти этой сессии.');
    } finally {
      setBusy(false);
    }
  };

  const forget = (): void => {
    clearAllKeys();
    setDraft('');
    setNote('Ключ удалён из памяти сессии.');
  };

  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-400 block">{label}</label>
      <div className="flex gap-1 items-center">
        <input
          ref={inputRef}
          type="password"
          name={`${provider}-maps-key`}
          autoComplete="new-password"
          spellCheck={false}
          aria-label={`API ключ ${label}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={handlePasteGuard}
          placeholder={manual ? '•••••••••••• (введён)' : 'Введите API ключ'}
          className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500 font-mono tracking-wider"
        />
        <button
          type="button"
          onClick={openConfirm}
          disabled={disabled || busy}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-xs"
        >
          {busy ? '...' : 'Сохранить'}
        </button>
        {(manual || !!preview) && (
          <button
            type="button"
            onClick={forget}
            className="px-2 py-1 bg-gray-600 hover:bg-red-700 text-white rounded text-xs"
            title="Забыть ключ (очистить память сессии)"
          >✕</button>
        )}
      </div>
      {preview && <p className="text-[10px] text-gray-500 font-mono">{preview}</p>}
      {note && <p role="status" className="text-[11px] text-amber-300">{note}</p>}

      {confirmOpen && createPortal(
        <div
          role="dialog" aria-modal="true" aria-labelledby="apikey-risk-title"
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmOpen(false); }}
        >
          <div className="bg-gray-800 border border-amber-500/50 rounded-lg max-w-md w-full p-4 space-y-3 shadow-2xl">
            <h4 id="apikey-risk-title" className="text-sm font-semibold text-amber-400">⚠️ Риск хранения API-ключа</h4>
            <p className="text-xs text-gray-300">
              Вы собираетесь сохранить ключ <b>{label}</b>. Он будет храниться <b>только в оперативной памяти</b> этой
              вкладки (без записи на диск), но пока вкладка открыта — любой скрипт/расширение браузера на этой машине
              потенциально может его прочитать.
            </p>
            <ul className="list-disc pl-5 text-[11px] text-gray-400 space-y-1">
              {RISK_BULLETS.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-3 py-1.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-200"
              >Отмена</button>
              <button
                type="button"
                data-testid="apikey-confirm"
                onClick={() => { void confirmSave(); }}
                className="px-3 py-1.5 rounded text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
              >Осознанно сохраняю в память сессии</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ApiKeyMaskedInput;
