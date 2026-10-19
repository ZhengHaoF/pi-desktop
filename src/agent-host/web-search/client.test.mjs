import assert from "node:assert/strict";
import test from "node:test";
import { mapUpstreamStatus, postToolJson, WebSearchError } from "./client.ts";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function errorResponse(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ctx = { apiKey: "sk-test", timeoutMs: 5_000 };
const { Response, AbortController } = globalThis;

test("a successful request posts bearer JSON and parses the payload", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ results: [{ title: "t", url: "https://e.com" }] });
  };
  try {
    const data = await postToolJson("https://api.deepseek.com/v1/tools/search", { query: "q" }, ctx);
    assert.equal(data.results.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = original;
  }
});

test("the error matrix maps every documented status to a stable code", () => {
  assert.equal(mapUpstreamStatus(400, "bad").code, "BAD_REQUEST");
  assert.equal(mapUpstreamStatus(401, undefined).code, "UNAUTHORIZED");
  assert.equal(mapUpstreamStatus(402, undefined).code, "PAYMENT_REQUIRED");
  assert.equal(mapUpstreamStatus(403, undefined).code, "FORBIDDEN");
  assert.equal(mapUpstreamStatus(404, undefined).code, "NOT_FOUND");
  assert.equal(mapUpstreamStatus(429, undefined).code, "RATE_LIMITED");
  assert.equal(mapUpstreamStatus(500, undefined).code, "UPSTREAM");
  assert.equal(mapUpstreamStatus(504, undefined).code, "UPSTREAM");
  assert.match(mapUpstreamStatus(402, undefined).message, /balance/i);
  assert.match(mapUpstreamStatus(429, undefined).message, /rate limited/i);
});

test("4xx failures other than 408/429 are not retried", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return errorResponse(402, "insufficient balance");
  };
  try {
    await assert.rejects(
      () => postToolJson("https://api.deepseek.com/v1/tools/search", {}, ctx),
      (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, "PAYMENT_REQUIRED");
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("429 retries and honors the Retry-After hint before succeeding", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return attempts === 1 ? errorResponse(429, "slow down", { "retry-after": "0.05" }) : jsonResponse({ results: [] });
  };
  try {
    const data = await postToolJson("https://api.deepseek.com/v1/tools/search", {}, ctx);
    assert.deepEqual(data.results, []);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("repeated 429 exhausts the attempt budget and surfaces the rate limit", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return errorResponse(429, "slow down", { "retry-after": "0.01" });
  };
  try {
    await assert.rejects(
      () => postToolJson("https://api.deepseek.com/v1/tools/search", {}, ctx),
      (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, "RATE_LIMITED");
        return true;
      },
    );
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("a network failure is retried and an aborted caller signal stops immediately", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("connect ECONNREFUSED");
  };
  try {
    await assert.rejects(
      () => postToolJson("https://api.deepseek.com/v1/tools/search", {}, ctx),
      (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, "NETWORK");
        return true;
      },
    );
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = original;
  }

  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => jsonResponse({ results: [] });
  try {
    await assert.rejects(
      () => postToolJson("https://api.deepseek.com/v1/tools/search", {}, { ...ctx, signal: controller.signal }),
      (error) => error instanceof WebSearchError && error.code === "ABORTED",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("an oversized response is rejected instead of buffered into context", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ content: "x".repeat(1024) });
  try {
    await assert.rejects(
      () => postToolJson("https://api.deepseek.com/v1/tools/fetch", {}, { ...ctx, maxBytes: 64 }),
      (error) => error instanceof WebSearchError && error.code === "TOO_LARGE",
    );
  } finally {
    globalThis.fetch = original;
  }
});
