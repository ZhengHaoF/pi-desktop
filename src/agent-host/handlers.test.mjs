import { importTestBundle } from "#test-bundle";
import { extractInterfaceProperties } from "../../scripts/check-contract-coverage.mjs";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { MessageChannel } from "node:worker_threads";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { TEXT_PREVIEW_MAX_BYTES } from "../shared/file-types.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const isolatedAgentDirectory = mkdtempSync(path.join(tmpdir(), "pi-handler-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolatedAgentDirectory, "sessions");
process.env.PI_OFFLINE = "1";
test.after(() => rmSync(isolatedAgentDirectory, { recursive: true, force: true }));
let modulePromise;

async function loadHandlersModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/agent-host/handlers", {
      packages: "external",
      absWorkingDir: root,
      stdin: {
        contents:
          'export * from "./handlers.ts"; export { setDesktopSessionToolNames } from "./session-tool-store.ts"; export {createRpcServer, createRpcClient} from "../contract/rpc.ts"; export {ExecutionLogStore} from "./execution-log-store.ts";',
        resolveDir: import.meta.dirname,
        loader: "ts",
      },
    });
  })();
  return modulePromise;
}

async function captureHandlers() {
  const { registerHandlers } = await loadHandlersModule();
  const handlers = {};
  const events = [];
  registerHandlers({
    handle(next) {
      Object.assign(handlers, next);
    },
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  });
  return { handlers, events };
}

test("agent command envelope validation runs before session lookup without closing the open command domain", async () => {
  const { handlers } = await captureHandlers();
  for (const command of [null, [], {}, { type: false }, { type: " " }]) {
    await assert.rejects(
      handlers["agent.command"]({ sessionId: "missing-fixture", command }),
      (error) => error.code === "BAD_REQUEST",
    );
  }
  await assert.rejects(
    handlers["agent.command"]({
      sessionId: "missing-fixture",
      command: { type: "future_sdk_command", opaque: { retained: true } },
    }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("model connection tests use isolated configuration and preserve success and provider errors", async (t) => {
  const { handlers } = await captureHandlers();
  const calls = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({
      url: request.url,
      model: body.model,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      fixtureAuth: request.headers.authorization === "Bearer nonsecret-local-fixture",
    });
    if (fail) {
      response
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "PLAN22_MODEL_TEST_FAILURE", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finishReason] of [
      [{ role: "assistant", content: "OK" }, null],
      [{}, "stop"],
    ]) {
      response.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          "\n\n",
      );
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const modelFile = path.join(isolatedAgentDirectory, "models.json");
  const before = await handlers["modelsConfig.get"]();
  const options = {
    providerName: "plan22-handler-test",
    provider: {
      baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
      api: "openai-completions",
      apiKey: "nonsecret-local-fixture",
    },
    model: {
      id: "fixture",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  const result = await handlers["modelsConfig.test"](options);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.responseText, "OK");
  assert.equal(result.status, 200);
  fail = true;
  const failure = await handlers["modelsConfig.test"](options);
  assert.equal(failure.ok, false);
  // TestResult permits a missing status; the provider error must still be preserved.
  if (failure.status !== undefined) assert.equal(failure.status, 400);
  assert.match(failure.error, /PLAN22_MODEL_TEST_FAILURE/);
  assert.equal(calls.length, 2, "test requests must not retry provider failures");
  assert.ok(
    calls.every(
      (call) =>
        call.url === "/v1/chat/completions" && call.model === "fixture" && call.maxTokens === 16 && call.fixtureAuth,
    ),
  );
  assert.deepEqual(await handlers["modelsConfig.get"](), before);
  if (before.version === "missing") assert.throws(() => readFileSync(modelFile), { code: "ENOENT" });
});

test("web search settings persist, gate availability, and test the effective key with one real call", async (t) => {
  const { handlers } = await captureHandlers();
  const { Response } = globalThis;
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ results: [{ title: "DeepSeek 首页", url: "https://www.deepseek.com" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  // Defaults keep the feature off with no resolvable credential.
  const initial = await handlers["settings.getWebSearch"]();
  assert.equal(initial.settings.enabled, false);
  assert.equal(initial.credential.source, "none");
  assert.equal(initial.credential.providerId, "deepseek");

  // Saving a dedicated key makes it the reported credential source.
  const saved = await handlers["settings.setWebSearch"]({ enabled: true, apiKeyOverride: "sk-web-search-fixture" });
  assert.equal(saved.settings.enabled, true);
  assert.equal(saved.credential.source, "override");

  // The test runs exactly one real search with the saved key.
  const passed = await handlers["settings.testWebSearch"]();
  assert.equal(passed.ok, true, passed.error);
  assert.equal(passed.responseText, "DeepSeek 首页");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].auth, "Bearer sk-web-search-fixture");
  assert.equal(calls[0].body.count, 1);

  // A draft key is validated without being persisted.
  const draft = await handlers["settings.testWebSearch"]({ apiKeyOverride: "sk-draft" });
  assert.equal(draft.ok, true, draft.error);
  assert.equal(calls[1].auth, "Bearer sk-draft");
  assert.equal((await handlers["settings.getWebSearch"]()).settings.apiKeyOverride, "sk-web-search-fixture");

  // Non-retryable provider failures map to readable errors.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "insufficient balance" } }), { status: 402 });
  const failed = await handlers["settings.testWebSearch"]({ apiKeyOverride: "sk-draft" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /balance/);
});

test("model discovery uses isolated configuration and parses provider catalogs", async (t) => {
  const { handlers } = await captureHandlers();
  const calls = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    calls.push({
      url: request.url,
      auth: request.headers.authorization,
      version: request.headers["anthropic-version"],
    });
    if (request.url === "/models") {
      // No version segment: exercises the /v1 fallback candidate.
      response.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    if (fail) {
      response
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "PLAN22_MODEL_LIST_FAILURE", type: "invalid_api_key" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "fixture-alpha", object: "model", created: 1, owned_by: "fixture" },
          { id: "fixture-beta", display_name: "Fixture Beta" },
          { id: "   " },
          { object: "model" },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const before = await handlers["modelsConfig.get"]();
  const modelFile = path.join(isolatedAgentDirectory, "models.json");
  const provider = {
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    api: "openai-completions",
    apiKey: "nonsecret-local-fixture",
    // Half-edited model rows must not block the provider composition used for listing.
    models: [{ id: "" }],
  };

  const result = await handlers["modelsConfig.discover"]({ providerName: "plan22-list-test", provider });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.models, [{ id: "fixture-alpha" }, { id: "fixture-beta", name: "Fixture Beta" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/models");
  assert.equal(calls[0].auth, "Bearer nonsecret-local-fixture");

  fail = true;
  const failure = await handlers["modelsConfig.discover"]({ providerName: "plan22-list-test", provider });
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 401);
  assert.match(failure.error, /authentication failed/);
  assert.equal(calls.length, 2, "provider failures must not retry other endpoint candidates");

  // A base URL without the version segment falls back to /v1/models, and
  // Anthropic-style catalogs authenticate with x-api-key instead of Bearer.
  fail = false;
  const anthropic = await handlers["modelsConfig.discover"]({
    providerName: "plan22-list-test",
    provider: {
      baseUrl: "http://127.0.0.1:" + server.address().port,
      api: "anthropic-messages",
      apiKey: "nonsecret-local-fixture",
    },
  });
  assert.equal(anthropic.ok, true, anthropic.error);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].url, "/models");
  assert.equal(calls[3].url, "/v1/models");
  assert.equal(calls[3].auth, undefined);
  assert.equal(calls[3].version, "2023-06-01");

  const unsupported = await handlers["modelsConfig.discover"]({
    providerName: "plan22-list-test",
    provider: { baseUrl: "https://example.invalid", api: "google-generative-ai", apiKey: "nonsecret-local-fixture" },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.unsupported, true);

  assert.deepEqual(await handlers["modelsConfig.get"](), before);
  if (before.version === "missing") assert.throws(() => readFileSync(modelFile), { code: "ENOENT" });
});

const modelsDevFixture = {
  "stepfun-step-plan": {
    id: "stepfun-step-plan",
    name: "StepFun Step Plan (China)",
    api: "https://api.stepfun.com/step_plan/v1",
    models: {
      "step-5-preview": {
        id: "step-5-preview",
        name: "Step 5 Preview",
        reasoning: true,
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        limit: { context: 1_000_000, output: 65_536 },
        canonical_model_id: "stepfun/step-5-preview",
      },
    },
  },
  stepfun: {
    id: "stepfun",
    name: "StepFun (China)",
    api: "https://api.stepfun.com/v1",
    models: {
      "step-5-preview": {
        id: "step-5-preview",
        name: "Step 5 Preview",
        limit: { context: 1_000_000, output: 65_536 },
        cost: { input: 0.959, output: 2.741, cache_read: 0.048 },
      },
    },
  },
};

test("model info fills match by base URL, cache the catalog, and never upload provider data", async (t) => {
  const { handlers } = await captureHandlers();
  const requests = [];
  const nativeFetch = globalThis.fetch;
  const cacheFile = path.join(isolatedAgentDirectory, "models-dev-catalog.json");
  rmSync(cacheFile, { force: true });
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => modelsDevFixture };
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    rmSync(cacheFile, { force: true });
  });

  const before = await handlers["modelsConfig.get"]();
  const modelFile = path.join(isolatedAgentDirectory, "models.json");
  const result = await handlers["modelsConfig.fillModelInfo"]({
    modelId: "step-5-preview",
    providerName: "stepfun-provider",
    provider: { baseUrl: "https://api.stepfun.com/step_plan/v1", apiKey: "nonsecret-local-fixture" },
    model: { id: "step-5-preview" },
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.fields, {
    name: "Step 5 Preview",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    // The filled cost is always complete: models.json requires all four keys.
    cost: { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 },
  });
  assert.deepEqual(result.source, {
    kind: "models-dev",
    providerName: "StepFun Step Plan (China)",
    matchedBy: "baseUrl",
    priceProviderName: "StepFun (China)",
  });
  assert.equal(result.stale, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "https://models.dev/api.json", "the catalog URL is fixed");
  assert.ok(existsSync(cacheFile), "the catalog is cached on disk");

  // The second call is served from the cache, and nothing is written to models.json.
  const cached = await handlers["modelsConfig.fillModelInfo"]({
    modelId: "step-5-preview",
    providerName: "stepfun-provider",
    provider: { baseUrl: "https://api.stepfun.com/step_plan/v1" },
    model: {
      id: "step-5-preview",
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 },
      name: "Step 5 Preview",
    },
  });
  assert.equal(cached.ok, true, cached.error);
  assert.equal(requests.length, 1);
  assert.deepEqual(cached.filled, [], "an entry that already matches reports nothing to fill");
  assert.deepEqual(await handlers["modelsConfig.get"](), before);
  if (before.version === "missing") assert.throws(() => readFileSync(modelFile), { code: "ENOENT" });

  const missing = await handlers["modelsConfig.fillModelInfo"]({
    modelId: "no-such-model",
    model: { id: "no-such-model" },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no-such-model/);
  const invalid = await handlers["modelsConfig.fillModelInfo"]({ model: {} });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /modelId is required/);
});

test("model info fills fall back to the built-in catalogs when the network is unavailable", async (t) => {
  const { handlers } = await captureHandlers();
  const nativeFetch = globalThis.fetch;
  const cacheFile = path.join(isolatedAgentDirectory, "models-dev-catalog.json");
  rmSync(cacheFile, { force: true });
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    rmSync(cacheFile, { force: true });
  });

  const builtin = await handlers["modelsConfig.fillModelInfo"]({
    modelId: "deepseek-flash",
    providerName: "my-provider",
    provider: { baseUrl: "https://example.invalid/v1" },
    model: { id: "deepseek-flash" },
  });
  assert.equal(builtin.ok, true, builtin.error);
  assert.equal(builtin.source.kind, "builtin");
  assert.match(builtin.source.providerName, /deepseek/i);
  assert.ok(builtin.filled.length > 0);
  assert.equal(existsSync(cacheFile), false, "a failed download must not create a cache file");
});

test("model config saves reject payloads the runtime would drop and keep the previous file", async (t) => {
  const { handlers } = await captureHandlers();
  const modelFile = path.join(isolatedAgentDirectory, "models.json");
  const before = await handlers["modelsConfig.get"]();
  t.after(async () => {
    const current = await handlers["modelsConfig.get"]();
    if (before.version === "missing") {
      rmSync(modelFile, { force: true });
      return;
    }
    if (current.version !== before.version) {
      await handlers["modelsConfig.set"]({ config: before.config, expectedVersion: current.version });
    }
  });

  // A partial cost object is refused before it reaches the disk: the schema gate
  // names the missing property, and the runtime round-trip backs it up for
  // payloads the schema alone would accept.
  await assert.rejects(
    () =>
      handlers["modelsConfig.set"]({
        expectedVersion: before.version,
        config: {
          providers: {
            "plan22-validate": {
              api: "openai-completions",
              baseUrl: "https://example.invalid/v1",
              apiKey: "nonsecret-local-fixture",
              models: [{ id: "fixture", cost: { input: 1, output: 2, cacheRead: 0 } }],
            },
          },
        },
      }),
    (error) =>
      error.code === "BAD_REQUEST" &&
      /cacheWrite/.test(error.message) &&
      (/no changes were saved/.test(error.message) || /rejected by the model runtime/.test(error.message)),
  );
  assert.deepEqual(await handlers["modelsConfig.get"](), before, "a rejected save must not touch models.json");

  // The same config with a complete cost saves.
  const saved = await handlers["modelsConfig.set"]({
    expectedVersion: before.version,
    config: {
      providers: {
        "plan22-validate": {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          apiKey: "nonsecret-local-fixture",
          models: [{ id: "fixture", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    },
  });
  assert.equal(saved.ok, true);
  const reloaded = await handlers["modelsConfig.get"]();
  assert.equal(reloaded.config.providers["plan22-validate"].models[0].cost.cacheWrite, 0);

  // Removing every provider stays legitimate.
  const cleared = await handlers["modelsConfig.set"]({ expectedVersion: reloaded.version, config: { providers: {} } });
  assert.equal(cleared.ok, true);
});

test("registerHandlers exposes every contract method exactly once", async () => {
  const { handlers } = await captureHandlers();
  const expected = extractInterfaceProperties(
    "api.ts",
    readFileSync(path.join(root, "src/contract/api.ts"), "utf8"),
    "Api",
  );
  assert.deepEqual(Object.keys(handlers).sort(), expected.sort());
  for (const method of [
    "host.ping",
    "host.runtimeProbe",
    "host.toolchain",
    "sessions.list",
    "sessions.contextPage",
    "sessions.entryContent",
    "worktrees.list",
    "git.status",
    "agent.state",
    "channels.list",
    "channels.accountConnect",
    "files.list",
    "files.download",
    "models.list",
    "models.refresh",
    "models.refreshCancel",
    "models.preferences.get",
    "models.preferences.set",
    "models.default.set",
    "models.thinkingLevel.set",
    "auth.providers",
    "skills.list",
    "plugins.list",
    "processes.list",
    "processes.read",
    "processes.wait",
    "processes.stop",
    "processes.restart",
    "processes.export",
    "herdr.runtime.get",
    "herdr.runtime.configure",
    "herdr.runtime.probe",
    "herdr.runtime.restart",
    "herdr.runtime.connect",
    "herdr.runtime.disconnect",
    "herdr.snapshot",
    "herdr.workspace.create",
    "herdr.pane.split",
    "herdr.pane.read",
    "herdr.agent.start",
    "herdr.agent.prompt",
    "herdr.agent.sendKeys",
    "herdr.agent.wait",
    "herdr.agent.waitCancel",
    "herdr.terminal.open",
    "herdr.terminal.input",
    "herdr.terminal.resize",
    "herdr.terminal.ack",
    "herdr.terminal.close",
    "system.allowRoot",
  ]) {
    assert.equal(typeof handlers[method], "function", `${method} must be registered`);
  }
});

test("both text endpoints preserve UTF-8 boundaries and byte budgets while Host ping remains available", async (t) => {
  const project = mkdtempSync(path.join(tmpdir(), "pi-preview-handlers-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const file = path.join(project, "large.txt");
  writeFileSync(file, "中🙂".repeat(TEXT_PREVIEW_MAX_BYTES));
  const { handlers } = await captureHandlers();
  const { createRpcClient, createRpcServer } = await loadHandlersModule();
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer(),
    client = createRpcClient(port1);
  server.handle(handlers);
  server.attachPort(port2);
  t.after(() => {
    client.close();
    server.detachPort(port2);
    port2.close();
  });
  await client.call("system.allowRoot", { path: project });
  await client.call("files.meta", { path: file }); // warm authorization before checking IO fairness
  let finished = 0;
  const previews = ["files.read", "files.preview", "files.read", "files.preview"].map((method) =>
    client.call(method, { path: file }).then((result) => {
      finished++;
      return result;
    }),
  );
  const ping = await client.call("host.ping");
  assert.equal(ping.ok, true);
  assert.ok(finished < previews.length, "a queued ping must not wait for all file reads to finish");
  for (const result of await Promise.all(previews)) {
    assert.ok(Buffer.byteLength(result.content, "utf8") <= TEXT_PREVIEW_MAX_BYTES);
    assert.equal(result.truncated, true);
    assert.ok(!result.content.includes("\ufffd"), "a truncated code point must not become a replacement character");
  }
  for (const method of ["files.read", "files.preview"]) {
    await assert.rejects(client.call(method, { path: project }), (error) => error.code === "BAD_REQUEST");
    await assert.rejects(handlers[method]({ path: path.join(project, "deleted.txt") }), { code: "ENOENT" });
  }
});

test("Herdr RPC parameter objects reject unknown keys at the Host boundary", async () => {
  const { assertHerdrParamKeys } = await loadHandlersModule();
  assert.deepEqual(assertHerdrParamKeys(undefined, []), {});
  assert.deepEqual(assertHerdrParamKeys({ paneId: "pane-a", mode: "observe" }, ["paneId", "mode"]), {
    paneId: "pane-a",
    mode: "observe",
  });
  assert.throws(
    () => assertHerdrParamKeys({ paneId: "pane-a", rawMethod: "shell.exec" }, ["paneId"]),
    (error) => error.code === "HERDR_INVALID_REQUEST" && /unsupported parameter/.test(error.message),
  );
});

test("Herdr Host validates path parameter types before filesystem policy checks", async () => {
  const { handlers } = await captureHandlers();
  await assert.rejects(
    handlers["herdr.workspace.create"]({ cwd: 42 }),
    (error) => error.code === "HERDR_INVALID_REQUEST" && error.message === "Workspace parameters are invalid.",
  );
  await assert.rejects(
    handlers["herdr.workspace.create"]({ cwd: "/tmp/project", name: { label: "unsafe" } }),
    (error) => error.code === "HERDR_INVALID_REQUEST" && error.message === "Workspace parameters are invalid.",
  );
  await assert.rejects(
    handlers["herdr.pane.split"]({ paneId: "pane-a", direction: "horizontal", cwd: { path: "/tmp" } }),
    (error) => error.code === "HERDR_INVALID_REQUEST" && error.message === "Pane split parameters are invalid.",
  );
});

test("agent.new uses a unique temporary lock key for every request", async () => {
  const { createAgentNewLockKey } = await loadHandlersModule();
  const keys = Array.from({ length: 1_000 }, () => createAgentNewLockKey());

  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => /^__new__[0-9a-f-]{36}$/.test(key)));
});

test("auto-title keeps the local fallback when service creation fails", async () => {
  const { generateSessionTitleWithFallback } = await loadHandlersModule();
  const title = await generateSessionTitleWithFallback(async () => {
    throw new Error("project resources unavailable");
  }, "  Fix\n the login page  ");

  assert.equal(title, "Fix the login page");
});

test("conditional auto-title writes never replace a manual session name", async (t) => {
  const fixtureDirectory = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "auto-title-fixture");
  mkdirSync(fixtureDirectory, { recursive: true });
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

  const createFixture = (sessionId) => {
    const sessionPath = path.join(fixtureDirectory, `2026-08-16T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-16T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf8",
    );
    return sessionPath;
  };

  const guardedSessionId = "auto-title-guarded";
  const guardedPath = createFixture(guardedSessionId);
  const concurrentSessionId = "auto-title-concurrent";
  const concurrentPath = createFixture(concurrentSessionId);
  const { handlers } = await captureHandlers();
  const { applySessionNameIfEmpty } = await loadHandlersModule();

  // Populate the session id → path cache used by the handlers.
  await handlers["sessions.list"]();

  assert.equal(await applySessionNameIfEmpty(guardedSessionId, "Automatic title"), true);
  await handlers["sessions.rename"]({ id: guardedSessionId, name: "Manual title" });
  assert.equal(await applySessionNameIfEmpty(guardedSessionId, "Late automatic title"), false);
  assert.equal(SessionManager.open(guardedPath).getSessionName(), "Manual title");

  await Promise.all([
    applySessionNameIfEmpty(concurrentSessionId, "Automatic title"),
    handlers["sessions.rename"]({ id: concurrentSessionId, name: "Concurrent manual title" }),
  ]);
  assert.equal(SessionManager.open(concurrentPath).getSessionName(), "Concurrent manual title");
});

test("channel initialization failure is reported without an unhandled rejection", async () => {
  const { initializeChannels } = await loadHandlersModule();
  const reports = [];
  initializeChannels(
    {
      async initialize() {
        throw new Error("media init failed?token=sensitive-token");
      },
    },
    (message) => reports.push(message),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports, ["media init failed?token=[REDACTED]"]);
});

test("credential mutation failures distinguish committed state from an unverified mutation", async () => {
  const { credentialMutationFailure } = await loadHandlersModule();
  const synchronizationError = new CredentialSynchronizationError("test-provider", "setRuntimeApiKey", undefined, {
    cause: new Error("secret upstream detail"),
  });

  const committed = await credentialMutationFailure(
    {
      async listCredentials() {
        return [{ providerId: "test-provider", type: "api_key" }];
      },
      async refresh() {
        throw new Error("secret retry detail");
      },
    },
    "test-provider",
    { present: true, type: "api_key" },
    synchronizationError,
  );
  assert.deepEqual(committed, {
    ok: true,
    synchronized: false,
    warning: {
      code: "MODEL_SYNC_FAILED",
      message: "Credentials were updated, but the local model state could not be refreshed. Retry model refresh.",
    },
  });
  assert.doesNotMatch(JSON.stringify(committed), /secret/);

  await assert.rejects(
    credentialMutationFailure(
      {
        async listCredentials() {
          return [];
        },
        async refresh() {
          throw new Error("must not refresh");
        },
      },
      "test-provider",
      { present: true, type: "api_key" },
      synchronizationError,
    ),
    (error) => error?.code === "INTERNAL" && !String(error?.message).includes("secret"),
  );
});

test("model list projection isolates provider availability failures and keeps the last known state", async () => {
  const { projectModelsList } = await loadHandlersModule();
  const goodModel = { id: "fresh", name: "Fresh model", provider: "good", reasoning: false };
  const cachedModel = { id: "cached", name: "Cached model", provider: "broken", reasoning: false };
  const result = await projectModelsList(
    {
      getProviders() {
        return [{ id: "good" }, { id: "broken" }];
      },
      getAvailableSnapshot() {
        return [cachedModel];
      },
      async getAvailable(providerId) {
        if (providerId === "good") return [goodModel];
        throw new Error("secret provider failure detail");
      },
    },
    {
      getEnabledModels() {
        return undefined;
      },
      getDefaultProvider() {
        return undefined;
      },
      getDefaultModel() {
        return undefined;
      },
    },
    { source: "network", refreshed: true, aborted: false, warnings: [] },
  );

  assert.deepEqual(result.models.map((model) => `${model.provider}/${model.id}`).sort(), [
    "broken/cached",
    "good/fresh",
  ]);
  assert.deepEqual(result.catalog.warnings, [
    {
      provider: "broken",
      code: "PROVIDER_AVAILABILITY_FAILED",
      message: "Unable to check broken model availability; the last known state remains available.",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret provider failure detail/);
});

test("model preferences project the persisted default and keep it enabled", async () => {
  const { projectModelPreferences, includeDefaultModelInEnabled } = await loadHandlersModule();
  const available = [
    { id: "alpha", name: "Alpha", provider: "fixture" },
    { id: "beta", name: "Beta", provider: "fixture" },
  ];
  const settings = {
    getDefaultProvider() {
      return "fixture";
    },
    getDefaultModel() {
      return "beta";
    },
    getDefaultThinkingLevel() {
      return "high";
    },
    getAllModelThinkingLevels() {
      return { "fixture/alpha": "low" };
    },
  };

  const unfiltered = projectModelPreferences(available, undefined, settings);
  assert.deepEqual(unfiltered.enabledModels, null);
  assert.deepEqual(unfiltered.defaultModel, { provider: "fixture", modelId: "beta" });
  assert.equal(unfiltered.defaultThinkingLevel, "high");
  assert.deepEqual(unfiltered.modelThinkingLevels, { "fixture/alpha": "low" });

  // The desktop picker lists every available model, so a default is projected
  // whether or not enabledModels scopes it (Pi's own picker still honors that list).
  const scoped = projectModelPreferences(available, ["fixture/alpha"], settings);
  assert.deepEqual(scoped.enabledModels, ["fixture/alpha"]);
  assert.deepEqual(scoped.defaultModel, { provider: "fixture", modelId: "beta" });

  // Persisting a default adds it back to enabledModels, matching Pi's own behavior.
  assert.deepEqual(includeDefaultModelInEnabled(["fixture/alpha"], "fixture", "beta"), [
    "fixture/alpha",
    "fixture/beta",
  ]);
  assert.deepEqual(includeDefaultModelInEnabled(["fixture/beta"], "fixture", "beta"), ["fixture/beta"]);
  // A thinking-level suffix still refers to the same model.
  assert.deepEqual(includeDefaultModelInEnabled(["fixture/beta:high"], "fixture", "beta"), ["fixture/beta:high"]);
  assert.equal(includeDefaultModelInEnabled(undefined, "fixture", "beta"), undefined);
  assert.deepEqual(includeDefaultModelInEnabled([], "fixture", "beta"), []);
});

test("default thinking levels persist per model and globally in Pi settings", async (t) => {
  const { handlers } = await captureHandlers();
  const base = mkdtempSync(path.join(tmpdir(), "pi-thinking-level-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  mkdirSync(project, { recursive: true });

  await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" });
  const preferences = await handlers["models.preferences.get"]({ cwd: project });
  assert.equal(preferences.defaultThinkingLevel, null);
  assert.deepEqual(preferences.modelThinkingLevels, {});
  const model = preferences.models.find((entry) => entry.provider === "openai");
  assert.ok(model, "setting an OpenAI credential should expose OpenAI models");
  const reference = `${model.provider}/${model.id}`;

  const perModel = await handlers["models.thinkingLevel.set"]({
    cwd: project,
    provider: model.provider,
    modelId: model.id,
    level: "high",
  });
  assert.equal(perModel.modelThinkingLevels[reference], "high");
  assert.equal(perModel.defaultThinkingLevel, null);
  const reloadedPerModel = await handlers["models.preferences.get"]({ cwd: project });
  assert.equal(reloadedPerModel.modelThinkingLevels[reference], "high");

  const clearedModel = await handlers["models.thinkingLevel.set"]({
    cwd: project,
    provider: model.provider,
    modelId: model.id,
    level: null,
  });
  assert.deepEqual(clearedModel.modelThinkingLevels, {});

  const global = await handlers["models.thinkingLevel.set"]({ cwd: project, level: "low" });
  assert.equal(global.defaultThinkingLevel, "low");
  const globalCleared = await handlers["models.thinkingLevel.set"]({ cwd: project, level: null });
  assert.equal(globalCleared.defaultThinkingLevel, null);
  const reloadedGlobal = await handlers["models.preferences.get"]({ cwd: project });
  assert.equal(reloadedGlobal.defaultThinkingLevel, null);

  await assert.rejects(
    handlers["models.thinkingLevel.set"]({ cwd: project, level: "extreme" }),
    (error) => error.code === "BAD_REQUEST",
  );
  await assert.rejects(
    handlers["models.thinkingLevel.set"]({ cwd: project, provider: "openai", level: "high" }),
    (error) => error.code === "BAD_REQUEST",
  );
  await assert.rejects(
    handlers["models.thinkingLevel.set"]({ cwd: project, provider: "openai", modelId: "missing", level: "high" }),
    (error) => error.code === "BAD_REQUEST",
  );

  await handlers["auth.deleteApiKey"]({ provider: "openai" });
});

test("model projection retains an unavailable default reference instead of authorizing a replacement implicitly", async () => {
  const { projectModelsList } = await loadHandlersModule();
  const model = { id: "other", name: "Other", provider: "other", reasoning: false };
  const result = await projectModelsList(
    { getProviders: () => [{ id: "other" }], getAvailableSnapshot: () => [model], getAvailable: async () => [model] },
    {
      getEnabledModels: () => undefined,
      getDefaultProvider: () => "azure-openai-responses",
      getDefaultModel: () => "legacy",
    },
    { source: "cache", refreshed: false, aborted: false, warnings: [] },
  );
  assert.deepEqual(result.defaultModel, { provider: "azure-openai-responses", modelId: "legacy" });
  assert.deepEqual(
    result.models.map((model) => model.provider),
    ["other"],
  );
});

test("automatic titles stay local when the selected provider/model cannot be resolved", async () => {
  const { generateSessionTitleWithFallback } = await loadHandlersModule();
  let requests = 0,
    fallthrough = 0;
  const title = await generateSessionTitleWithFallback(
    async () => ({
      modelRuntime: {
        getModel: () => undefined,
        getAvailableSnapshot() {
          fallthrough++;
          return [{ provider: "other", id: "other" }];
        },
        hasConfiguredAuth: () => true,
        completeSimple: async () => {
          requests++;
          return { content: [{ type: "text", text: "OTHER_PROVIDER_TITLE" }] };
        },
      },
      settingsManager: { getDefaultProvider: () => "azure-openai-responses", getDefaultModel: () => "legacy" },
    }),
    "Keep this message local",
    "azure-openai-responses",
    "legacy",
  );
  assert.equal(requests, 0);
  assert.equal(fallthrough, 0);
  assert.notEqual(title, "OTHER_PROVIDER_TITLE");
});

test("file, git, worktree, skill, plugin, and system handlers return contract-shaped results", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-handler-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  mkdirSync(path.join(project, "nested"), { recursive: true });
  const textFile = path.join(project, "hello.txt");
  writeFileSync(textFile, "hello handler tests\n");
  const outsideFile = path.join(base, "outside.txt");
  writeFileSync(outsideFile, "must not become an allowed root\n");

  const { handlers } = await captureHandlers();
  assert.deepEqual(await handlers["system.allowRoot"]({ path: project }), { ok: true });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: project }), { ok: true, path: project });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: outsideFile }), {
    ok: false,
    error: "Not a directory",
  });
  await assert.rejects(
    handlers["system.allowRoot"]({ path: outsideFile }),
    (error) => error.code === "BAD_REQUEST" && /Not a directory/.test(error.message),
  );
  await assert.rejects(
    handlers["system.allowRoot"]({ path: path.join(base, "missing") }),
    (error) => error.code === "BAD_REQUEST" && /Directory does not exist/.test(error.message),
  );

  const listed = await handlers["files.list"]({ path: project });
  assert.equal(
    listed.entries.some((entry) => entry.name === "hello.txt" && entry.type === "file"),
    true,
  );

  const read = await handlers["files.read"]({ path: textFile });
  assert.equal(read.encoding, "utf8");
  assert.equal(read.content, "hello handler tests\n");

  const downloaded = await handlers["files.download"]({ path: textFile });
  assert.equal(Buffer.from(downloaded.base64, "base64").toString("utf8"), "hello handler tests\n");
  assert.equal(downloaded.size, Buffer.byteLength("hello handler tests\n"));

  const oversizedFile = path.join(project, "oversized.bin");
  writeFileSync(oversizedFile, "");
  truncateSync(oversizedFile, 50 * 1024 * 1024 + 1);
  await assert.rejects(
    handlers["files.download"]({ path: oversizedFile }),
    (error) =>
      error.code === "RESULT_TOO_LARGE" &&
      error.detail?.size === 50 * 1024 * 1024 + 1 &&
      error.detail?.maxBytes === 50 * 1024 * 1024,
  );

  const meta = await handlers["files.meta"]({ path: textFile });
  assert.equal(meta.language, "text");
  assert.equal(meta.mime, "text/plain");

  const preview = await handlers["files.preview"]({ path: textFile });
  assert.equal(preview.kind, "text");
  assert.equal(preview.content, "hello handler tests\n");

  const index = await handlers["files.index"]({ root: project, query: "hello" });
  assert.equal(Array.isArray(index.files), true);
  assert.equal(index.files.includes("hello.txt"), true);
  await assert.rejects(
    handlers["files.index"]({ root: project, query: "../outside" }),
    (error) => error.code === "BAD_REQUEST" && /Parent traversal/.test(error.message),
  );

  let deepDirectory = project;
  for (let depth = 0; depth < 9; depth += 1) {
    deepDirectory = path.join(deepDirectory, `depth-${depth}`);
    mkdirSync(deepDirectory);
  }
  writeFileSync(path.join(deepDirectory, "beyond-depth.txt"), "too deep", "utf8");
  const directIndex = await handlers["files.index"]({ root: project });
  assert.equal(
    directIndex.matches.some(
      (entry) =>
        entry.path === "depth-0/depth-1/depth-2/depth-3/depth-4/depth-5/depth-6/depth-7/depth-8/beyond-depth.txt",
    ),
    false,
  );
  assert.equal(
    directIndex.matches.some((entry) => entry.path === "depth-0" && entry.isDir),
    true,
  );
  assert.equal(directIndex.truncated, false);

  const git = await handlers["git.status"]({ path: project });
  assert.equal(git.isGit, false);

  const worktrees = await handlers["worktrees.list"]({ projectRoot: project });
  assert.equal(Array.isArray(worktrees.worktrees), true);
  assert.equal(worktrees.projectRoot, project);

  const agentState = await handlers["agent.state"]({ sessionId: "missing-session" });
  assert.deepEqual(agentState, { running: false });

  const skills = await handlers["skills.list"]({ cwd: project });
  assert.equal(Array.isArray(skills.skills), true);

  const plugins = await handlers["plugins.list"]({ cwd: project });
  assert.equal(typeof plugins, "object");

  const running = await handlers["system.runningCount"]();
  assert.equal(running.count, running.sessionIds.length);

  await handlers["files.watchStart"]({ path: project });
  assert.deepEqual(await handlers["files.watchStop"]({ path: project }), { ok: true });
});

test("file routes retain canonical and exact-session-reference authorization after extraction", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-file-authority-"));
  let removeSession = async () => {};
  t.after(async () => {
    try {
      await removeSession();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const project = path.join(base, "project"),
    outside = path.join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  const file = path.join(outside, "referenced.txt");
  writeFileSync(file, "reference-only fixture");
  const escape = path.join(project, "escape");
  symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  const { handlers } = await captureHandlers();
  await handlers["system.allowRoot"]({ path: project });
  for (const method of ["files.read", "files.preview", "files.meta", "files.download", "files.watchStart"]) {
    await assert.rejects(handlers[method]({ path: file }), (error) => error.code === "FORBIDDEN", method);
    await assert.rejects(
      handlers[method]({ path: path.join(escape, "referenced.txt") }),
      (error) => error.code === "FORBIDDEN",
      method,
    );
  }
  for (const [method, params] of [
    ["files.list", { path: outside }],
    ["files.index", { root: outside }],
    ["git.status", { path: outside }],
    ["worktrees.list", { projectRoot: outside }],
    ["worktrees.create", { projectRoot: outside, branch: "fixture" }],
    ["worktrees.remove", { path: outside }],
  ])
    await assert.rejects(handlers[method](params), (error) => error.code === "FORBIDDEN", method);

  const session = SessionManager.create(project, process.env.PI_CODING_AGENT_SESSION_DIR);
  session.appendMessage({ role: "user", content: "[" + file + "]", timestamp: Date.now() });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Referenced fixture" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const sourceSessionId = session.getSessionId();
  removeSession = () => handlers["sessions.delete"]({ id: sourceSessionId });
  assert.equal((await handlers["files.read"]({ path: file, sourceSessionId })).content, "reference-only fixture");
  assert.equal((await handlers["files.preview"]({ path: file, sourceSessionId })).content, "reference-only fixture");
  assert.equal(
    (await handlers["files.meta"]({ path: file, sourceSessionId })).size,
    Buffer.byteLength("reference-only fixture"),
  );
  assert.equal(
    Buffer.from((await handlers["files.download"]({ path: file, sourceSessionId })).base64, "base64").toString(),
    "reference-only fixture",
  );
  await handlers["files.watchStart"]({ path: file, sourceSessionId });
  await handlers["files.watchStop"]({ path: file });
  await assert.rejects(
    handlers["files.read"]({ path: file, sourceSessionId: "not-a-session" }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    handlers["files.list"]({ path: outside, sourceSessionId }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("execution RPC validates budgets, exports original history and removes owned content with the session", async () => {
  const { handlers } = await captureHandlers();
  const { ExecutionLogStore } = await loadHandlersModule();
  for (const query of [{ limit: NaN }, { limit: 201 }, { maxContentBytes: -1 }, { includeContent: "yes" }])
    await assert.rejects(
      handlers["sessions.executions"]({ id: "missing", ...query }),
      (error) => error.code === "BAD_REQUEST",
    );
  const manager = SessionManager.create(isolatedAgentDirectory, process.env.PI_CODING_AGENT_SESSION_DIR);
  manager.appendMessage({ role: "user", content: "Original history fixture", timestamp: Date.now() });
  const id = manager.getSessionId(),
    store = new ExecutionLogStore(id);
  const result = await store.payload({ text: "RPC_ORIGINAL_" + "x".repeat(64 * 1024) });
  await store.append({
    executionId: "rpc-fixture",
    runId: "run",
    toolCallId: "call",
    rootToolCallId: "call",
    anchorEntryId: manager.getLeafId(),
    source: "local",
    toolName: "fixture",
    status: "succeeded",
    requestedAt: 1,
    result,
  });
  const page = await handlers["sessions.executions"]({ id, includeContent: true });
  assert.match(page.records[0].result.value.text, /^RPC_ORIGINAL_/);
  const content = await handlers["sessions.executionContent"]({ id, hash: result.ref.hash });
  assert.equal(content.value.text, page.records[0].result.value.text);
  await assert.rejects(
    handlers["sessions.executionContent"]({ id, hash: result.ref.hash, maxBytes: NaN }),
    (error) => error.code === "BAD_REQUEST",
  );
  const bundle = JSON.parse((await handlers["sessions.export"]({ id, format: "bundle" })).content);
  assert.match(bundle.sessionJsonl, /Original history fixture/);
  assert.equal(bundle.executionHistory.content[result.ref.hash].text, content.value.text);
  await handlers["sessions.delete"]({ id });
  assert.equal(existsSync(manager.getSessionFile()), false);
  assert.deepEqual((await store.readLatest()).records, []);
  await assert.rejects(store.readContent(result.ref.hash, 131072), /ENOENT/);
});

test("session, model configuration, and auth handlers isolate state and preserve error codes", async () => {
  const { handlers } = await captureHandlers();

  const sessions = await handlers["sessions.list"]();
  assert.deepEqual(sessions.sessions, []);
  assert.deepEqual(sessions.runningSessionIds, []);

  await assert.rejects(handlers["sessions.get"]({ id: "missing" }), (error) => error.code === "NOT_FOUND");
  await assert.rejects(handlers["agent.command"]({ sessionId: "missing", command: { type: "abort" } }), (error) =>
    ["NOT_FOUND", "BAD_REQUEST"].includes(error.code),
  );

  const initialModels = await handlers["modelsConfig.get"]();
  assert.deepEqual(initialModels.config, { providers: {} });
  assert.equal(initialModels.version, "missing");
  await assert.rejects(handlers["modelsConfig.set"]({}), (error) => error.code === "BAD_REQUEST");
  await assert.rejects(
    handlers["modelsConfig.set"]({ config: { providers: {} } }),
    (error) => error.code === "BAD_REQUEST",
  );
  const firstSave = await handlers["modelsConfig.set"]({
    config: { providers: {} },
    expectedVersion: initialModels.version,
  });
  assert.equal(firstSave.ok, true);
  assert.match(firstSave.version, /^sha256:/);

  const v087Config = {
    providers: {
      custom: {
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        headers: { Authorization: "Bearer test", "X-Remove-Me": null },
        models: [
          {
            id: "model-one",
            inputLimits: { maxRequestBytes: 4_000_000, images: { maxPerMessage: 4, maxPerRequest: 8 } },
            promptCache: { short: 300, long: 3600 },
            samplingParams: { temperature: 0.2, thinking_token_budget: 1024 },
            compat: { supportsStrictMode: false, supportsMidConvoSystemMessages: true },
            futureField: { preserved: true },
          },
        ],
      },
    },
    modelOverrides: {
      "openai/gpt-6-sol": { inputLimits: { maxRequestBytes: 2_000_000 }, promptCache: { long: 3600 } },
    },
    futureTopLevel: "preserved",
  };
  const editorOne = await handlers["modelsConfig.get"]();
  const editorTwo = await handlers["modelsConfig.get"]();
  await assert.rejects(
    handlers["modelsConfig.set"]({ config: v087Config, expectedVersion: editorOne.version }),
    (error) => error.code === "BAD_REQUEST" && error.detail.issues.some((issue) => issue.path.endsWith("/X-Remove-Me")),
  );
  assert.deepEqual(
    await handlers["modelsConfig.get"](),
    editorOne,
    "invalid legacy null headers must not overwrite configuration",
  );
  delete v087Config.providers.custom.headers["X-Remove-Me"];
  const winningSave = await handlers["modelsConfig.set"]({
    config: {
      ...v087Config,
      providers: {
        ...v087Config.providers,
        custom: {
          ...v087Config.providers.custom,
          headers: { ...v087Config.providers.custom.headers, "X-Remove-Me": undefined },
        },
      },
    },
    expectedVersion: editorOne.version,
  });
  assert.equal(winningSave.ok, true);
  assert.notEqual(winningSave.version, editorOne.version);
  await assert.rejects(
    handlers["modelsConfig.set"]({
      config: { providers: { stale: { api: "openai-completions", baseUrl: "https://example.invalid/v1" } } },
      expectedVersion: editorTwo.version,
    }),
    (error) =>
      error.code === "CONFLICT" &&
      error.detail.expectedVersion === editorTwo.version &&
      error.detail.currentVersion === winningSave.version,
  );
  const winningSnapshot = await handlers["modelsConfig.get"]();
  assert.deepEqual(winningSnapshot.config, v087Config);
  assert.equal(winningSnapshot.version, winningSave.version);

  const models = await handlers["models.list"]({ cwd: root });
  assert.equal(models.catalog.source, "offline");
  const refreshedModels = await handlers["models.refresh"]({ cwd: root, requestId: "offline-test" });
  assert.equal(refreshedModels.catalog.source, "offline");
  assert.deepEqual(await handlers["models.refreshCancel"]({ requestId: "offline-test" }), {
    ok: true,
    cancelled: false,
  });

  const invalidModelTest = await handlers["modelsConfig.test"]({});
  assert.deepEqual(invalidModelTest, { ok: false, error: "providerName is required" });

  const oauthProviders = await handlers["auth.providers"]();
  assert.equal(Array.isArray(oauthProviders.providers), true);
  const allProviders = await handlers["auth.allProviders"]();
  assert.equal(Array.isArray(allProviders.providers), true);

  assert.deepEqual(await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" }), {
    ok: true,
    synchronized: true,
  });
  const preferences = await handlers["models.preferences.get"]({ cwd: root });
  assert.equal(Array.isArray(preferences.models), true);
  assert.equal(preferences.enabledModels, null);
  await assert.rejects(
    handlers["models.preferences.set"]({ cwd: root, enabledModels: [] }),
    (error) => error.code === "BAD_REQUEST",
  );
  const selectedModel = preferences.models.find((model) => model.provider === "openai");
  assert.ok(selectedModel, "setting an OpenAI credential should expose OpenAI models");
  const selectedReference = `${selectedModel.provider}/${selectedModel.id}`;
  const updatedPreferences = await handlers["models.preferences.set"]({
    cwd: root,
    enabledModels: [`${selectedReference}:high`, selectedReference],
  });
  assert.deepEqual(updatedPreferences.enabledModels, [selectedReference]);
  const listedModels = await handlers["models.list"]({ cwd: root });
  // The desktop picker ignores enabledModels: every available model is listed,
  // including the scoped one and everything outside that scope.
  assert.ok(
    listedModels.models.some((model) => `${model.provider}/${model.id}` === selectedReference),
    "the scoped model is still listed",
  );
  assert.ok(listedModels.models.length > 1, "models outside enabledModels are listed too");
  const resetPreferences = await handlers["models.preferences.set"]({ cwd: root, enabledModels: null });
  assert.equal(resetPreferences.enabledModels, null);
  await assert.rejects(
    handlers["auth.setApiKey"]({ provider: "amazon-bedrock", key: "not-a-bearer-token" }),
    (error) => error.code === "BAD_REQUEST" && /interactive, multi-field/.test(error.message),
  );
  assert.deepEqual(await handlers["auth.deleteApiKey"]({ provider: "openai" }), {
    ok: true,
    synchronized: true,
  });
  assert.deepEqual(await handlers["auth.logout"]({ provider: "openai" }), { ok: true, synchronized: true });
  assert.deepEqual(await handlers["auth.loginCancel"]({ provider: "handler-test" }), { ok: true });
  await assert.rejects(
    handlers["auth.loginSubmit"]({ provider: "one", token: "two-token", code: "code" }),
    (error) => error.code === "NOT_FOUND",
  );

  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  writeFileSync(modelsPath, "{broken json", "utf8");
  await assert.rejects(handlers["modelsConfig.get"](), (error) => error.code === "PARSE_ERROR");
  assert.equal(readFileSync(modelsPath, "utf8"), "{broken json");
});

test("sessions.get returns the contract shape without rescanning known session paths", async (t) => {
  const sessionDirectory = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "contract-fixture");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionId = "contract-session";
  const sessionPath = path.join(sessionDirectory, `2026-08-06T00-00-00-000Z_${sessionId}.jsonl`);
  const entries = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-06T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "user-one",
      parentId: null,
      timestamp: "2026-08-06T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1_786_060_801_000 },
    },
    {
      type: "message",
      id: "assistant-one",
      parentId: "user-one",
      timestamp: "2026-08-06T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_802_000,
      },
    },
    {
      type: "message",
      id: "user-two",
      parentId: "assistant-one",
      timestamp: "2026-08-06T00:00:03.000Z",
      message: { role: "user", content: "second", timestamp: 1_786_060_803_000 },
    },
    {
      type: "message",
      id: "assistant-two",
      parentId: "user-two",
      timestamp: "2026-08-06T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_804_000,
      },
    },
  ];
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const { handlers } = await captureHandlers();
  const listed = await handlers["sessions.list"]();
  assert.equal(
    listed.sessions.some((session) => session.id === sessionId),
    true,
  );
  const filtered = await handlers["sessions.list"]({ cwd: path.join(root, ".") });
  assert.equal(
    filtered.sessions.some((session) => session.id === sessionId),
    true,
  );
  const excluded = await handlers["sessions.list"]({ cwd: isolatedAgentDirectory });
  assert.equal(
    excluded.sessions.some((session) => session.id === sessionId),
    false,
  );
  await assert.rejects(handlers["sessions.list"]({ cwd: "relative/project" }), (error) => error.code === "BAD_REQUEST");

  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => {
    throw new Error("global scan must not run");
  };
  t.after(() => {
    SessionManager.listAll = originalListAll;
  });

  const detail = await handlers["sessions.get"]({ id: sessionId });
  assert.deepEqual(Object.keys(detail).sort(), ["context", "filePath", "info", "leafId", "sessionId", "stats", "tree"]);
  assert.equal(detail.sessionId, sessionId);
  assert.equal(detail.filePath, sessionPath);
  assert.equal(detail.info.id, sessionId);
  assert.equal(detail.info.messageCount, 4);
  assert.equal(detail.info.firstMessage, "hello");
  assert.equal(detail.stats.totalMessages, 4);
  assert.equal(detail.stats.cost, 0);
  assert.deepEqual(detail.context.entryIds, ["user-one", "assistant-one", "user-two", "assistant-two"]);
  assert.equal(detail.context.messages.length, 4);
  const { setDesktopSessionToolNames } = await loadHandlersModule();
  setDesktopSessionToolNames(sessionId, []);
  const restoredSelection = await handlers["sessions.get"]({ id: sessionId, includeState: true });
  assert.deepEqual(restoredSelection.toolNames, []);
  assert.equal(restoredSelection.agentState.running, false);

  const paged = await handlers["sessions.get"]({ id: sessionId, historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 } });
  assert.deepEqual(paged.context.entryIds, ["user-two", "assistant-two"]);
  assert.equal(paged.context.truncatedBefore, true);
  const older = await handlers["sessions.contextPage"]({ id: sessionId, cursor: paged.context.previousCursor });
  assert.deepEqual(older.context.entryIds, ["user-one", "assistant-one"]);
  const cursorPayload = JSON.parse(Buffer.from(paged.context.previousCursor, "base64url").toString("utf8"));
  const staleCursor = Buffer.from(
    JSON.stringify({ ...cursorPayload, historyRevision: "stale-revision" }),
    "utf8",
  ).toString("base64url");
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: staleCursor }),
    (error) => error.code === "STALE_CURSOR",
  );
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: "invalid" }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.deepEqual(await handlers["sessions.entryContent"]({ id: sessionId, entryId: "assistant-two" }), {
    content: { type: "text", text: "second answer" },
    deferredContent: {
      entryId: "assistant-two",
      blockIndex: 0,
      originalBytes: Buffer.byteLength(JSON.stringify({ type: "text", text: "second answer" }), "utf8"),
      contentType: "text",
    },
  });
  await assert.rejects(
    handlers["sessions.entryContent"]({ id: sessionId, entryId: "another-session-entry", blockIndex: 0 }),
    (error) => error.code === "NOT_FOUND",
  );
});
