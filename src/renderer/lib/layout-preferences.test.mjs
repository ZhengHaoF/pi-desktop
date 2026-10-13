import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_MIN_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  clampSidebarWidth,
  getKeyboardAdjustedRightPanelWidth,
  getRightPanelWidthBounds,
  getSidebarWidthBounds,
  loadRightPanelPreferredWidth,
  loadSidebarPreferredWidth,
  saveRightPanelPreferredWidth,
  saveSidebarPreferredWidth,
  shouldCollapseSidebarForRightPanel,
} from "./layout-preferences.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

test("loads a valid preferred width and falls back for missing or invalid values", () => {
  assert.equal(loadRightPanelPreferredWidth(createStorage()), RIGHT_PANEL_DEFAULT_WIDTH);
  assert.equal(loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "517" })), 517);
  assert.equal(
    loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "279" })),
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
  assert.equal(
    loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "not-a-number" })),
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
});

test("saves a rounded usable preference without throwing on storage failures", () => {
  const storage = createStorage();
  saveRightPanelPreferredWidth(storage, 412.6);
  assert.equal(storage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY), "413");

  saveRightPanelPreferredWidth(storage, 200);
  assert.equal(storage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY), String(RIGHT_PANEL_MIN_WIDTH));

  assert.doesNotThrow(() =>
    saveRightPanelPreferredWidth(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("blocked");
        },
      },
      400,
    ),
  );
});

test("caps the panel at 40vw while preserving the chat column", () => {
  const wide = getRightPanelWidthBounds(1514, true);
  assert.equal(wide.maxWidth, Math.floor(1514 * 0.4));
  assert.ok(1514 - 280 - wide.maxWidth >= CHAT_MIN_WIDTH);

  const constrained = getRightPanelWidthBounds(1000, true);
  assert.deepEqual(constrained, { minWidth: 280, maxWidth: 300 });
  assert.equal(clampRightPanelWidth(800, 1000, true), 300);
  assert.equal(clampRightPanelWidth(100, 1000, true), 280);
});

test("allows the panel to become narrower only when the viewport cannot fit all minimums", () => {
  assert.deepEqual(getRightPanelWidthBounds(900, true), { minWidth: 200, maxWidth: 200 });
  assert.equal(clampRightPanelWidth(360, 900, true), 200);
  assert.equal(shouldCollapseSidebarForRightPanel(979), true);
  assert.equal(shouldCollapseSidebarForRightPanel(980), false);
});

test("allows terminal workbench layouts to opt into a wider panel without changing the default", () => {
  assert.equal(getRightPanelWidthBounds(1514, false, 0.55).maxWidth, Math.floor(1514 * 0.55));
  assert.equal(getRightPanelWidthBounds(1514, false, 0.72).maxWidth, Math.floor(1514 * 0.72));
  assert.equal(clampRightPanelWidth(2_000, 1514, false, 0.72), Math.floor(1514 * 0.72));
  assert.equal(getRightPanelWidthBounds(1514, false).maxWidth, Math.floor(1514 * 0.4));
});

test("keyboard resizing follows the separator direction and respects bounds", () => {
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowLeft", 1514, true), 376);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowRight", 1514, true), 344);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowLeft", 1514, true, true), 408);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "Home", 1514, true), 280);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "End", 1514, true), Math.floor(1514 * 0.4));
});

test("sidebar width preference loads the stored value and the default otherwise", () => {
  assert.equal(loadSidebarPreferredWidth(createStorage()), SIDEBAR_WIDTH);
  assert.equal(loadSidebarPreferredWidth(createStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "331" })), 331);
  assert.equal(
    loadSidebarPreferredWidth(createStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: String(SIDEBAR_MIN_WIDTH - 1) })),
    SIDEBAR_WIDTH,
  );
  assert.equal(
    loadSidebarPreferredWidth(createStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "not-a-number" })),
    SIDEBAR_WIDTH,
  );
});

test("saves a clamped rounded sidebar preference without throwing on storage failures", () => {
  const storage = createStorage();
  saveSidebarPreferredWidth(storage, 312.6);
  assert.equal(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), "313");

  saveSidebarPreferredWidth(storage, 100);
  assert.equal(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), String(SIDEBAR_MIN_WIDTH));

  saveSidebarPreferredWidth(storage, 5_000);
  assert.equal(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), String(SIDEBAR_MAX_WIDTH));

  assert.doesNotThrow(() =>
    saveSidebarPreferredWidth(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("blocked");
        },
      },
      400,
    ),
  );
});

test("sidebar bounds cap at half the viewport so the conversation column stays usable", () => {
  assert.deepEqual(getSidebarWidthBounds(1514), { minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH });
  assert.deepEqual(getSidebarWidthBounds(700), { minWidth: SIDEBAR_MIN_WIDTH, maxWidth: 350 });
  assert.deepEqual(getSidebarWidthBounds(0), { minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH });

  assert.equal(clampSidebarWidth(1_000, 1514), SIDEBAR_MAX_WIDTH);
  assert.equal(clampSidebarWidth(100, 1514), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(311.6, 1514), 312);
  assert.equal(clampSidebarWidth(400, 700), 350);
  assert.equal(clampSidebarWidth(Number.NaN, 1514), SIDEBAR_WIDTH);
});
