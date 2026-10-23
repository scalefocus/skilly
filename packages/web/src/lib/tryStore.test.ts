// Unit tests for the Try panel's tab storage (SKILLY_SPEC.md §61.3): keys carry user, skill and
// version; only a finished transcript round-trips (alternating, user first, ending with a reply);
// sign-out clears every Try key and nothing else; blocked storage never throws.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearTryConversations, loadTryConversation, saveTryConversation, tryStoreKey } from "./tryStore";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const g = globalThis as unknown as { sessionStorage: unknown };

beforeEach(() => {
  g.sessionStorage = new MemoryStorage();
});

const convo = [
  { role: "user" as const, content: "hi" },
  { role: "assistant" as const, content: "hello" },
];

test("tryStoreKey: user, skill and resolved version all distinguish a conversation", () => {
  const k = tryStoreKey("u1", "global", "pdf-tools", "1.2.0");
  assert.equal(k, "skilly.try.u1:global/pdf-tools@1.2.0");
  assert.notEqual(k, tryStoreKey("u2", "global", "pdf-tools", "1.2.0"));
  assert.notEqual(k, tryStoreKey("u1", "global", "pdf-tools", "1.3.0"));
});

test("save → load round-trips a finished transcript; an empty save removes the key", () => {
  const k = tryStoreKey("u1", "global", "pdf-tools", "1.2.0");
  saveTryConversation(k, convo);
  assert.deepEqual(loadTryConversation(k), convo);
  saveTryConversation(k, []);
  assert.equal((g.sessionStorage as MemoryStorage).getItem(k), null);
  assert.deepEqual(loadTryConversation(k), []);
});

test("load ignores anything that isn't a finished, alternating transcript", () => {
  const s = g.sessionStorage as MemoryStorage;
  const k = "skilly.try.x";
  for (const bad of ["not json", "{}", JSON.stringify([{ role: "user", content: "q" }]), JSON.stringify([{ role: "assistant", content: "a" }, { role: "user", content: "q" }]), JSON.stringify([{ role: "user", content: 1 }, { role: "assistant", content: "a" }])]) {
    s.setItem(k, bad);
    assert.deepEqual(loadTryConversation(k), [], bad);
  }
});

test("clearTryConversations drops every Try key and leaves other keys alone", () => {
  const s = g.sessionStorage as MemoryStorage;
  saveTryConversation(tryStoreKey("u1", "a", "b", "1.0.0"), convo);
  saveTryConversation(tryStoreKey("u2", "c", "d", "2.0.0"), convo);
  s.setItem("skilly.badgeToasted", "x");
  clearTryConversations();
  assert.equal(s.length, 1);
  assert.equal(s.getItem("skilly.badgeToasted"), "x");
});

test("blocked storage never throws", () => {
  g.sessionStorage = {
    get length(): number {
      throw new Error("blocked");
    },
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadTryConversation("k"), []);
  assert.doesNotThrow(() => saveTryConversation("k", convo));
  assert.doesNotThrow(() => clearTryConversations());
});
