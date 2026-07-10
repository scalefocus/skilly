import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./metrics.js";

test("counter increments and renders Prometheus exposition", () => {
  const r = new Registry();
  const c = r.counter("skilly_test_total", "a test counter");
  c.inc();
  c.add(2);
  const out = r.render();
  assert.match(out, /# TYPE skilly_test_total counter/);
  assert.match(out, /skilly_test_total 3/);
});

test("labels produce separate series, escaped correctly", () => {
  const r = new Registry();
  const c = r.counter("skilly_actions_total", "labelled");
  c.inc({ action: "accept" });
  c.inc({ action: "accept" });
  c.inc({ action: "reject" });
  const out = r.render();
  assert.match(out, /skilly_actions_total\{action="accept"\} 2/);
  assert.match(out, /skilly_actions_total\{action="reject"\} 1/);
});

test("gauge sets an absolute value; empty metric renders 0", () => {
  const r = new Registry();
  r.gauge("skilly_leader", "leader flag").set(1);
  r.counter("skilly_empty_total", "never touched");
  const out = r.render();
  assert.match(out, /skilly_leader 1/);
  assert.match(out, /skilly_empty_total 0/);
});
