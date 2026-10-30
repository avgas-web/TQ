// Регрессионные тесты ФАЗЫ 3.3: граница persist — валидация до попадания в стор.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createValidatedStorage } from "../src/utils/validatedStorage";
import { eventBus } from "../src/utils/eventBus";

const Schema = z.object({
  name: z.string().default("anon"),
  count: z.preprocess(
    (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0),
    z.number(),
  ),
});
type Shape = z.infer<typeof Schema>;

beforeEach(() => {
  localStorage.clear();
});

describe("validatedStorage — целостность на границе Zustand persist", () => {
  it("REGRESSION: битый JSON в хранилище → null (чистый старт) + событие storage:error, НЕ throw", async () => {
    const spy = vi.fn();
    eventBus.on("storage:error", spy);
    localStorage.setItem("tq-test-broken", JSON.stringify({ state: {} }));
    // подменим сырое значение на невалидный JSON напрямую
    Storage.prototype.getItem = () => "{garbage!!";
    const store = createValidatedStorage<Shape>("tq-test-broken", Schema);
    await expect(store.getItem("tq-test-broken")).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    eventBus.off("storage:error", spy);
  });

  it("валидный envelope проходит насквозь без предупреждений", async () => {
    const store = createValidatedStorage<Shape>("tq-test-ok", Schema);
    await store.setItem("tq-test-ok", {
      state: { name: "миссия", count: 3 },
      version: 1,
    });
    const got = await store.getItem("tq-test-ok");
    expect(got).not.toBeNull();
    expect(got!.state).toEqual({ name: "миссия", count: 3 });
    expect(got!.version).toBe(1);
  });

  it("migrate вызывается с (persistedState, version) ДО схемы", async () => {
    const migrate = vi.fn((s: unknown) => ({ ...(s as object), count: 42 }));
    const store = createValidatedStorage<Shape>("tq-test-mig", Schema, {
      migrate,
    });
    await store.setItem("tq-test-mig", { state: { name: "x" }, version: 1 });
    const got = await store.getItem("tq-test-mig");
    expect(migrate).toHaveBeenCalledWith({ name: "x" }, 1);
    expect(got!.state.count).toBe(42);
  });

  it("envelope без поля state → чистый старт + storage:error", async () => {
    localStorage.setItem("tq-test-nostate", JSON.stringify({ nope: 1 }));
    const spy = vi.fn();
    eventBus.on("storage:error", spy);
    const store = createValidatedStorage<Shape>("tq-test-nostate", Schema);
    await expect(store.getItem("tq-test-nostate")).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    eventBus.off("storage:error", spy);
  });

  it("setItem сериализует envelope {state, version} (контракт zustand PersistStorage)", async () => {
    const store = createValidatedStorage<Shape>("tq-test-write", Schema);
    await store.setItem("tq-test-write", {
      state: { name: "n", count: 1 },
      version: 7,
    });
    const raw = localStorage.getItem("tq-test-write");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ version: 7 });
  });
});
