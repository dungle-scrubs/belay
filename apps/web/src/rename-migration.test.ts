import { beforeEach, describe, expect, it } from "vitest";
import { migrateRenamedStorage } from "./rename-migration";

function makeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));

  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as unknown as Storage;
}

describe("rename storage migration", () => {
  let local: Storage;
  let session: Storage;

  beforeEach(() => {
    local = makeStorage({
      "trevor.sidebar.width": "320",
      "trevor.modelPreferences.global": '{"m":"x"}',
      unrelated: "keep me",
    });
    // Drafts and prompt history are tab-scoped in sessionStorage, not localStorage - app.tsx passes
    // window.sessionStorage to useDraftPersistence/usePromptHistory.
    session = makeStorage({
      "trevor-web-identity": '{"id":"w1"}',
      "trevor.draft.tab1.sess-abc": "half-typed prompt",
      "trevor.history.tab1.sess-abc": '["one","two"]',
    });
  });

  it("moves prefixed keys from BOTH stores plus the identity key", () => {
    expect(migrateRenamedStorage(local, session)).toBe(5);

    expect(local.getItem("belay.sidebar.width")).toBe("320");
    expect(local.getItem("belay.modelPreferences.global")).toBe('{"m":"x"}');
    expect(session.getItem("belay-web-identity")).toBe('{"id":"w1"}');
  });

  it("preserves the sessionStorage draft and prompt history the rename would otherwise drop", () => {
    migrateRenamedStorage(local, session);

    expect(session.getItem("belay.draft.tab1.sess-abc")).toBe("half-typed prompt");
    expect(session.getItem("belay.history.tab1.sess-abc")).toBe('["one","two"]');
    expect(session.getItem("trevor.draft.tab1.sess-abc")).toBeNull();
  });

  it("survives a store that throws, rather than breaking app boot", () => {
    const hostile = {
      get length() {
        throw new Error("storage disabled");
      },
      getItem: () => {
        throw new Error("storage disabled");
      },
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage;

    expect(() => migrateRenamedStorage(hostile, hostile)).not.toThrow();
    expect(migrateRenamedStorage(hostile, hostile)).toBe(0);
  });

  it("drops the old keys and leaves unrelated keys alone", () => {
    migrateRenamedStorage(local, session);

    expect(local.getItem("trevor.sidebar.width")).toBeNull();
    expect(session.getItem("trevor-web-identity")).toBeNull();
    expect(local.getItem("unrelated")).toBe("keep me");
  });

  it("is idempotent and never clobbers newer state", () => {
    local.setItem("belay.sidebar.width", "480");

    migrateRenamedStorage(local, session);
    expect(local.getItem("belay.sidebar.width")).toBe("480");

    expect(migrateRenamedStorage(local, session)).toBe(0);
    expect(local.getItem("belay.sidebar.width")).toBe("480");
  });
});
