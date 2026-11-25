// The steer/follow-up notify-and-reject behaviour lives in
// use-agent-session-turn.test.mjs. What remains here is the composer-side rule
// set (image queues, awaited handlers) and has no behaviour test of its own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const submissionSource = readFileSync(new URL("./useComposerSubmission.ts", import.meta.url), "utf8");

test("composer submission blocks unrecoverable image queues, awaits text handlers, and restores rejected snapshots", () => {
  assert.match(submissionSource, /onSteer\?:[\s\S]*?Promise<void> \| void/);
  assert.match(submissionSource, /onFollowUp\?:[\s\S]*?Promise<void> \| void/);
  assert.match(submissionSource, /if \(attachedImages\.length > 0\)[\s\S]*?queuedImagesUnsupported[\s\S]*?return;/);
  assert.match(submissionSource, /await Promise\.resolve\(onSteer\(msg\)\)/);
  assert.match(submissionSource, /await Promise\.resolve\(onFollowUp\(msg\)\)/);
  assert.match(submissionSource, /catch \{\s*restoreFailedSubmission\(snapshot, clearedAtRevision, "queue"\)/);
});
