// 2.1/2.5: Zustand v5 persist + makeGuarded/isProcessing race guard.
import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => { localStorage.clear(); });

describe('useStoreShim (persist-safe getState)', () => {
  it('не крашится при вызове getState до завершения гидрации', async () => {
    const { getAppStateSafe } = await import('../src/store/useStore');
    // Стор с zustand persist: getState валиден и до onFinishHydration — shim
    // обязан вернуть состояние (или null), но НИКОГДА не бросить.
    const s = getAppStateSafe();
    expect(s === null || typeof s.project === 'object').toBe(true);
  });

  it('makeStoreShim возвращает null вместо исключения при битом api', async () => {
    const { makeStoreShim } = await import('../src/hooks/useStoreShim');
    const broken = {
      getState() { throw new Error('corrupted hydration payload'); },
    };
    const get = makeStoreShim(broken);
    expect(get()).toBeNull();
  });
});

describe('isProcessing mutation lock (makeGuarded)', () => {
  it('пока isProcessing=trueguarded-мутатор не вызывает мутацию', async () => {
    const { useStore } = await import('../src/store/useStore');
    let calls = 0;
    const guarded = useStore.getState().makeGuarded((x: number) => { calls += x; return calls; });
    useStore.setState({ isProcessing: true });
    expect(guarded(5)).toBeUndefined();
    expect(calls).toBe(0);
    useStore.setState({ isProcessing: false });
    expect(guarded(5)).toBe(5);
    expect(calls).toBe(5);
  });

  it('setProcessing нормализует не-boolean в false', async () => {
    const { useStore } = await import('../src/store/useStore');
    useStore.getState().setProcessing('yes' as unknown as boolean);
    expect(useStore.getState().isProcessing).toBe(false);
    useStore.getState().setProcessing(true);
    expect(useStore.getState().isProcessing).toBe(true);
    useStore.getState().setProcessing(false);
  });
});
