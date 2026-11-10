import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const workflowPath = path.join(root, ".github", "workflows", "build-desktop.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource);
const deepTestsWorkflow = YAML.parse(
  fs.readFileSync(path.join(root, ".github", "workflows", "deep-tests.yml"), "utf8"),
);

function stepByName(jobName, stepName, source = workflow) {
  const step = source.jobs[jobName].steps.find((candidate) => candidate.name === stepName);
  assert.ok(step, `${jobName} is missing step: ${stepName}`);
  return step;
}

test("main pushes package Windows and Android; pull requests test only", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.equal(workflow.jobs["windows-package"].if, "github.event_name != 'pull_request'");
  assert.equal(workflow.jobs["android-package"].if, "github.event_name != 'pull_request'");
  assert.equal(workflow.jobs.test.if, undefined);

  const windowsTools = stepByName("windows-package", "Prepare verified bundled search tools");
  assert.match(windowsTools.run, /ci-downloads\.mjs tools win32-x64/);
  const packaging = stepByName("windows-package", "Package Windows installer").run;
  assert.ok(packaging.includes("ci-downloads.mjs builder"), "builder");
  assert.ok(packaging.includes("--win nsis --x64"), "nsis x64 target");
  assert.ok(packaging.includes("--publish never"), "publish never");

  const androidTest = stepByName("android-package", "Run mobile tests");
  assert.equal(androidTest["working-directory"], "mobile");
  assert.equal(androidTest.run, "flutter test");
  const androidBuild = stepByName("android-package", "Build release APK");
  assert.equal(androidBuild["working-directory"], "mobile");
  assert.equal(androidBuild.run, "flutter build apk --release");
  const relay = stepByName("android-package", "Build relay bundle").run;
  assert.equal(relay, "node scripts/build-relay.mjs");
});

test("pull requests run the unit gate but never packaging", () => {
  // The test job must be unconditional so PRs still exercise typecheck and
  // unit tests; the packaging jobs assert the inverse condition above.
  assert.ok(!workflow.jobs.test.steps.some((step) => step.uses?.startsWith("actions/upload-artifact")));
});

test("tag releases validate the contract and publish a draft with exact assets", () => {
  assert.equal(workflow.jobs["release-contract"].if, "github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
  assert.equal(workflow.jobs.release.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(workflow.jobs.release.needs, ["release-contract", "windows-package", "android-package"]);

  const release = stepByName("release", "Create or update draft release").run;
  assert.match(release, /-name '\*\.exe'/);
  assert.match(release, /-name '\*\.apk'/);
  assert.match(release, /-name '\*\.blockmap'/);
  assert.match(release, /-name '\*\.yml'/);
  assert.match(release, /-name '\*\.mjs'/);
  assert.match(release, /-name '\*\.md'/);
  assert.match(release, /Duplicate release asset names/);
  assert.match(release, /--draft --generate-notes --verify-tag/);
  assert.match(release, /already public; published assets are immutable/);
});

test("Android release signing falls back to debug keys without keystore secrets", () => {
  const keystore = stepByName("android-package", "Restore upload keystore");
  assert.equal(keystore.if, "env.ANDROID_KEYSTORE_SET == 'true'");
  assert.match(keystore.env.ANDROID_KEYSTORE_BASE64, /secrets\.ANDROID_KEYSTORE_BASE64/);
  const signature = stepByName("android-package", "Verify APK signature");
  assert.equal(signature.if, "env.ANDROID_KEYSTORE_SET == 'true'");

  const gradle = fs.readFileSync(path.join(root, "mobile", "android", "app", "build.gradle.kts"), "utf8");
  assert.match(gradle, /releaseSigningActive = !System\.getenv\("ANDROID_KEYSTORE_PATH"\)\.isNullOrBlank\(\)/);
  assert.match(gradle, /signingConfigs\.getByName\("debug"\)/);
});

test("heavy regression suites remain available as a manual workflow", () => {
  // An empty `workflow_dispatch:` parses as null in YAML.
  assert.deepEqual(deepTestsWorkflow.on, { workflow_dispatch: null });

  const helper = stepByName("windows-deep", "Validate Windows managed process helper", deepTestsWorkflow).run;
  assert.match(helper, /PI_WINDOWS_HELPER_HANDLE_LOOPS = "100"/);
  assert.match(helper, /PSNativeCommandUseErrorActionPreference = \$true/);
  assert.match(helper, /check:windows-helper-reproducibility/);
  assert.match(helper, /PI_MANAGED_FLOOD_DURATION_MS = "60000"/);
  assert.match(helper, /PI_MANAGED_FLOOD_PROCESSES = "8"/);
  assert.match(helper, /PI_MANAGED_FLOOD_STREAMS = "both"/);
  assert.match(helper, /npm run test:managed-process-flood/);
  assert.equal(stepByName("windows-deep", "Electron smoke", deepTestsWorkflow).run, "npm run smoke");
  assert.equal(
    stepByName("windows-deep", "Native Windows Herdr integration", deepTestsWorkflow).run,
    "npm run test:herdr-windows-e2e",
  );

  const verify = stepByName("linux-quality", "Run full verification", deepTestsWorkflow).run;
  assert.match(verify, /xvfb-run --auto-servernum npm run verify/);

  for (const [jobName, source] of [
    ["windows-deep", deepTestsWorkflow],
    ["linux-quality", deepTestsWorkflow],
    ["test", workflow],
    ["windows-package", workflow],
    ["android-package", workflow],
  ]) {
    for (const step of source.jobs[jobName].steps) {
      if (step.run?.includes("ci-downloads.mjs")) assert.equal(step.env?.GH_TOKEN, "${{ github.token }}");
    }
  }
});
