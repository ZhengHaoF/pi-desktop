import assert from "node:assert/strict";
import test from "node:test";
import { readCompactionEstimate, withCompactionEstimate } from "./session-context-usage.ts";

const unknown = { percent: null, tokens: null, contextWindow: 200_000 };

test("the compaction projection is read from a command reply or an event payload", () => {
  assert.equal(readCompactionEstimate({ tokensBefore: 590_000, estimatedTokensAfter: 50_000 }), 50_000);
  assert.equal(readCompactionEstimate({ tokensBefore: 590_000 }), null);
  assert.equal(readCompactionEstimate(undefined), null);
  assert.equal(readCompactionEstimate("compacted"), null);
});

test("an unknown post-compaction reading adopts the compaction projection", () => {
  assert.deepEqual(withCompactionEstimate(unknown, 50_000), {
    percent: 25,
    tokens: 50_000,
    contextWindow: 200_000,
  });
});

test("a measured reading always wins over the estimate", () => {
  const measured = { percent: 61.5, tokens: 123_000, contextWindow: 200_000 };
  assert.equal(withCompactionEstimate(measured, 50_000), measured);
  const halfKnown = { percent: null, tokens: 123_000, contextWindow: 200_000 };
  assert.equal(withCompactionEstimate(halfKnown, 50_000), halfKnown);
});

test("missing usage, missing estimate and missing context window pass through", () => {
  assert.equal(withCompactionEstimate(null, 50_000), null);
  assert.equal(withCompactionEstimate(undefined, 50_000), null);
  assert.equal(withCompactionEstimate(unknown, null), unknown);
  assert.equal(withCompactionEstimate(unknown, 0), unknown);
  const windowless = { percent: null, tokens: null, contextWindow: 0 };
  assert.equal(withCompactionEstimate(windowless, 50_000), windowless);
});
