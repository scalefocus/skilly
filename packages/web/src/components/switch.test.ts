// Unit: the shared Switch control (SKILLY_SPEC.md §30.6) — aria contract, disabled handling, and
// the toggle callback. No DOM: the component is rendered to static markup for the attribute
// checks and invoked as a plain function for the onClick contract. Keyboard (Space/Enter) and the
// label-click path are native <button>/<label> behaviour and are covered by the e2e spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Next compiles ui.tsx with the automatic JSX runtime; the tsx test loader uses the classic one
// (`React.createElement`) and the file never imports React by name — so provide the global the
// classic output expects BEFORE the module is evaluated (hence the dynamic import).
(globalThis as { React?: typeof React }).React = React;
const { Switch } = await import("./ui");

const noop = () => {};

test("renders role=switch with aria-checked mirroring `checked`", () => {
  const on = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: noop, label: "Require review" }));
  const off = renderToStaticMarkup(createElement(Switch, { checked: false, onChange: noop, label: "Require review" }));
  assert.match(on, /<button[^>]*role="switch"[^>]*aria-checked="true"/);
  assert.match(off, /<button[^>]*role="switch"[^>]*aria-checked="false"/);
  // Wrapped in a <label> so the text is the accessible name AND clicking it toggles the button.
  assert.match(on, /^<label class="switch-row"/);
  assert.match(on, /<span class="switch-label">Require review<\/span>/);
  assert.match(on, /type="button"/);
});

test("enabled by default; disabled renders the native attribute AND aria-disabled", () => {
  const enabled = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: noop, label: "x" }));
  assert.doesNotMatch(enabled, /disabled/);
  const disabled = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: noop, label: "x", disabled: true }));
  assert.match(disabled, /<button[^>]*aria-disabled="true"[^>]*disabled=""/);
  // Disabled still reports its state — the locked `global` switch renders ON, not blank.
  assert.match(disabled, /aria-checked="true"/);
});

test("title lands on the wrapping label, so the hint covers text and control alike", () => {
  const html = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: noop, label: "x", title: "global always requires review" }));
  assert.match(html, /<label class="switch-row" title="global always requires review"/);
});

/** Pull the inner <button>'s props out of the element tree the component returns. */
function buttonProps(props: Parameters<typeof Switch>[0]): { onClick: () => void } {
  const el = Switch(props) as ReactElement<{ children: ReactElement[] }>;
  const button = el.props.children[1] as ReactElement<{ onClick: () => void }>;
  return button.props;
}

test("click reports the NEXT state — never flips its own display (server-confirmed only)", () => {
  const seen: boolean[] = [];
  buttonProps({ checked: true, onChange: (n) => seen.push(n), label: "x" }).onClick();
  buttonProps({ checked: false, onChange: (n) => seen.push(n), label: "x" }).onClick();
  assert.deepEqual(seen, [false, true]);
});

test("a disabled switch ignores clicks", () => {
  let calls = 0;
  buttonProps({ checked: true, onChange: () => calls++, label: "x", disabled: true }).onClick();
  assert.equal(calls, 0);
});
