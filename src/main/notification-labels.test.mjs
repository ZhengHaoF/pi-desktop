import assert from "node:assert/strict";
import test from "node:test";
import { notificationLabels } from "./notification-labels.ts";

const languages = ["en-US", "zh-CN", "zh-TW"];
const expectedKeys = ["agentFinishedBody", "agentFinishedTitle", "updateAvailableBody", "updateAvailableTitle"];

test("system notifications expose the same label set in all three app languages", () => {
  const byLanguage = Object.fromEntries(languages.map((language) => [language, notificationLabels(language)]));
  for (const language of languages) {
    const labels = byLanguage[language];
    assert.deepEqual([...Object.keys(labels).sort()], expectedKeys, `${language} label keys drifted`);
    for (const key of expectedKeys.filter((name) => name !== "updateAvailableBody")) {
      assert.ok(labels[key].trim().length > 0, `${language}.${key} is empty`);
    }
    assert.ok(labels.updateAvailableBody("9.9.9").includes("9.9.9"), `${language} drops the version`);
    assert.notEqual(labels.updateAvailableBody(null), labels.updateAvailableBody("9.9.9"));
  }
  assert.equal(byLanguage["en-US"].agentFinishedTitle, "Agent finished");
  assert.notEqual(byLanguage["zh-CN"].agentFinishedTitle, byLanguage["en-US"].agentFinishedTitle);
  assert.notEqual(byLanguage["zh-TW"].agentFinishedBody, byLanguage["zh-CN"].agentFinishedBody);
});
