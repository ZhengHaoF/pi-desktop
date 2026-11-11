import assert from "node:assert/strict";
import test from "node:test";
import { WebSearchError } from "../client.ts";
import { tencentWsaProvider } from "./tencent-wsa.ts";

const ctx = { apiKey: "sk-wsa-test", timeoutMs: 5_000 };
const { Response } = globalThis;

/** Wraps each Pages entry as a JSON string the way the SearchPro API returns them. */
function envelope(pages) {
  return { Response: { Pages: pages.map((page) => JSON.stringify(page)), Query: "q", RequestId: "r" } };
}

const samplePage = {
  title: "三星堆名字的由来",
  url: "https://news.example.com/sanxingdui",
  passage: "三星堆遗址位于四川省广汉市……",
  date: "2024-09-03 12:59:00",
  site: "腾讯网",
  score: 0.8887853,
  favicon: "http://img.example.com/a.png",
};

function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test("search posts Query plus Cnt and maps Pages entries into normalized results", async () => {
  const calls = [];
  const restore = withFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(envelope([samplePage, { url: "https://example.com/second", passage: "p" }])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const items = await tencentWsaProvider.search({ query: "  三星堆的由来  ", count: 5 }, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.wsa.cloud.tencent.com/SearchPro");
    assert.equal(calls[0].headers.Authorization, "Bearer sk-wsa-test");
    assert.equal(calls[0].body.Query, "三星堆的由来");
    // count 5 rounds up to the smallest legal Cnt (10); results trim back to the requested count.
    assert.equal(calls[0].body.Cnt, 10);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      title: "三星堆名字的由来",
      url: "https://news.example.com/sanxingdui",
      snippet: "三星堆遗址位于四川省广汉市……",
      summary: "三星堆遗址位于四川省广汉市……",
      siteName: "腾讯网",
      date: "2024-09-03 12:59:00",
      score: 0.8887853,
      authority: undefined,
    });
    assert.equal(items[1].title, "https://example.com/second");
  } finally {
    restore();
  }
});

test("counts on the ladder pass through and entries beyond the count are dropped", async () => {
  let body;
  const restore = withFetch(async (url, init) => {
    body = JSON.parse(init.body);
    const pages = Array.from({ length: 12 }, (_, index) => ({ url: `https://example.com/${index}`, passage: "p" }));
    return new Response(JSON.stringify(envelope(pages)), { status: 200 });
  });
  try {
    const items = await tencentWsaProvider.search({ query: "q", count: 10 }, ctx);
    assert.equal(body.Cnt, 10);
    assert.equal(items.length, 10);
    assert.equal(items[9].url, "https://example.com/9");
  } finally {
    restore();
  }
});

test("business errors inside HTTP 200 map onto stable error codes", async () => {
  const cases = [
    { code: "UnauthorizedOperation", expected: "UNAUTHORIZED" },
    { code: "RequestLimitExceeded", expected: "RATE_LIMITED" },
    { code: "ResourceNotFound", expected: "PAYMENT_REQUIRED" },
    { code: "ResourceUnavailable", expected: "PAYMENT_REQUIRED" },
    { code: "InvalidParameter", expected: "BAD_REQUEST" },
    { code: "InternalError", expected: "UPSTREAM" },
  ];
  for (const { code, expected } of cases) {
    const restore = withFetch(
      async () => new Response(JSON.stringify({ Response: { Error: { Code: code, Message: "m" } } }), { status: 200 }),
    );
    try {
      await assert.rejects(
        () => tencentWsaProvider.search({ query: "q", count: 5 }, ctx),
        (error) => {
          assert.ok(error instanceof WebSearchError);
          assert.equal(error.code, expected);
          return true;
        },
      );
    } finally {
      restore();
    }
  }
});

test("malformed envelopes and unreadable entries are skipped instead of throwing", async () => {
  const restore = withFetch(
    async () =>
      new Response(
        JSON.stringify({
          Response: {
            Pages: ["not json at all", JSON.stringify({ passage: "no url" }), JSON.stringify(samplePage)],
          },
        }),
        { status: 200 },
      ),
  );
  try {
    const items = await tencentWsaProvider.search({ query: "q", count: 5 }, ctx);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, samplePage.url);
  } finally {
    restore();
  }
});

test("an empty query and a missing Pages array fail fast without a billable round-trip", async () => {
  let calls = 0;
  const restore = withFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ Response: {} }), { status: 200 });
  });
  try {
    await assert.rejects(
      () => tencentWsaProvider.search({ query: "   ", count: 5 }, ctx),
      (error) => error.code === "BAD_REQUEST",
    );
    const items = await tencentWsaProvider.search({ query: "q", count: 5 }, ctx);
    assert.equal(calls, 1);
    assert.deepEqual(items, []);
  } finally {
    restore();
  }
});

test("the provider declares itself search-only", () => {
  assert.equal(tencentWsaProvider.id, "tencent-wsa");
  assert.equal(tencentWsaProvider.supportsFetch, false);
  assert.equal(tencentWsaProvider.fetch, undefined);
});
