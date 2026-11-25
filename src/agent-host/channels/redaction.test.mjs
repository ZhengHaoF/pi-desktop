import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintSecret, redactChannelText, redactChannelValue, safeChannelError } from "./redaction.ts";

test("structured channel redaction recursively removes every sensitive key", () => {
  assert.deepEqual(
    redactChannelValue({
      token: "top-secret",
      nested: [{ app_secret: "also-secret", safe: "visible" }],
      authorization: { value: "Bearer secret" },
    }),
    {
      token: "[REDACTED]",
      nested: [{ app_secret: "[REDACTED]", safe: "visible" }],
      authorization: "[REDACTED]",
    },
  );
});

test("text and error redaction covers headers, query parameters, Telegram bot URLs, and JSON", () => {
  const secret = "abcd1234-super-secret";
  const raw = `Bearer ${secret} https://api.telegram.org/bot${secret}/getMe?token=${secret} {"app_secret":"${secret}"}`;
  const redacted = redactChannelText(raw);
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /bot\[REDACTED\]/);
  assert.equal(safeChannelError(new Error(raw)).includes(secret), false);
  assert.equal(safeChannelError(new Error("x".repeat(700))).length, 500);
});

test("secret fingerprints reveal only the final four trimmed characters", () => {
  assert.equal(fingerprintSecret("  secret-value  "), "••••alue");
  assert.equal(fingerprintSecret("   "), undefined);
});

test("invalid model configuration gives channels a corrective message without internal details", () => {
  const message = safeChannelError(
    Object.assign(new Error("MODEL_CONFIG_INVALID: /private/fixture/models.json SECRET_VALUE"), {
      code: "MODEL_CONFIG_INVALID",
    }),
  );
  assert.match(message, /修复 models.json.*重新加载会话/);
  assert.doesNotMatch(message, /MODEL_CONFIG_INVALID|private|SECRET_VALUE/);
  assert.equal(
    safeChannelError(Object.assign(new Error("MODEL_CONFIG_INVALID: remote error"), { code: -32000 })),
    "MODEL_CONFIG_INVALID: remote error",
  );
});

test("Feishu device-code pairing secrets are redacted in structured and inline shapes", () => {
  assert.deepEqual(
    redactChannelValue({
      device_code: "device-secret",
      verificationUri: "https://accounts.feishu.cn/private",
      qrContent: "https://accounts.feishu.cn/qr-private",
    }),
    { device_code: "[REDACTED]", verificationUri: "[REDACTED]", qrContent: "[REDACTED]" },
  );
  assert.equal(
    safeChannelError(
      new Error(
        'request?device_code=device-secret&user_code=user-secret body={"verification_uri":"https://accounts.feishu.cn/private"}',
      ),
    ),
    'request?device_code=[REDACTED]&user_code=[REDACTED] body={"verification_uri":"[REDACTED]"}',
  );
  assert.equal(
    safeChannelError(new Error('{"qrContent":"https://accounts.feishu.cn/private"}')),
    '{"qrContent":"[REDACTED]"}',
  );
});
