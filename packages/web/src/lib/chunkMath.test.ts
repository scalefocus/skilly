// Chunked-upload part arithmetic (§6): the browser slicer and the server's exact-size
// enforcement share these functions, so their edge cases are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partCount, partSize, partRange } from "./chunkMath";

const MB = 1024 * 1024;

test("partCount: exact multiples, remainders, single-part, and validation", () => {
  assert.equal(partCount(10 * MB, 5 * MB), 2, "even split");
  assert.equal(partCount(10 * MB + 1, 5 * MB), 3, "one byte over adds a part");
  assert.equal(partCount(1, 5 * MB), 1, "tiny file is one part");
  assert.equal(partCount(5 * MB, 5 * MB), 1, "exactly one chunk is one part");
  assert.throws(() => partCount(0, 5 * MB), /positive integer/);
  assert.throws(() => partCount(-1, 5 * MB), /positive integer/);
  assert.throws(() => partCount(1.5, 5 * MB), /positive integer/);
  assert.throws(() => partCount(10, 0), /positive integer/);
});

test("partSize: full-size non-final parts, remainder final part, full final part on even split", () => {
  // 12,298,506 bytes at 5 MB — the real-world case that motivated chunking.
  const total = 12_298_506;
  const chunk = 5 * MB;
  assert.equal(partCount(total, chunk), 3);
  assert.equal(partSize(total, chunk, 0), chunk);
  assert.equal(partSize(total, chunk, 1), chunk);
  assert.equal(partSize(total, chunk, 2), total - 2 * chunk, "final part is the remainder");
  // Even split: the final part is a FULL chunk, never zero.
  assert.equal(partSize(10 * MB, 5 * MB, 1), 5 * MB);
  assert.throws(() => partSize(total, chunk, 3), /part index/);
  assert.throws(() => partSize(total, chunk, -1), /part index/);
  assert.throws(() => partSize(total, chunk, 1.5), /part index/);
});

test("partRange: contiguous, gapless, and sums to the total", () => {
  const total = 12_298_506;
  const chunk = 5 * MB;
  let expectStart = 0;
  let sum = 0;
  for (let i = 0; i < partCount(total, chunk); i++) {
    const { start, end } = partRange(total, chunk, i);
    assert.equal(start, expectStart, `part ${i} starts where the previous ended`);
    assert.equal(end - start, partSize(total, chunk, i), `part ${i} range matches its size`);
    expectStart = end;
    sum += end - start;
  }
  assert.equal(sum, total, "ranges cover the whole bundle exactly");
});
