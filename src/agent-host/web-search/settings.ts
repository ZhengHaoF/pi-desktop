import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeWebSearchSettings, WEB_SEARCH_DEFAULTS, type WebSearchSettings } from "../../shared/web-search.ts";
import { desktopDataRoot } from "../desktop-data-root.ts";

export { WEB_SEARCH_DEFAULTS };

/**
 * Global web search preferences. They live in the desktop data root, not in
 * ~/.pi, because the Pi CLI shares that directory and has no search feature.
 */
export class WebSearchSettingsStore {
  readonly filename: string;
  private tail: Promise<unknown> = Promise.resolve();
  private cache: WebSearchSettings | undefined;
  private loadFailed = false;

  constructor(filename: string) {
    this.filename = filename;
  }

  /** Synchronous read for tool execution and availability probes; a broken file degrades to defaults. */
  get(): WebSearchSettings {
    if (this.cache) return this.cache;
    try {
      const raw = readFileSync(this.filename, "utf8");
      this.cache = normalizeWebSearchSettings(JSON.parse(raw) as unknown);
      this.loadFailed = false;
    } catch {
      this.cache = { ...WEB_SEARCH_DEFAULTS };
      this.loadFailed = true;
    }
    return this.cache;
  }

  hasLoadFailed(): boolean {
    this.get();
    return this.loadFailed;
  }

  /** Serialized read-modify-write; the returned settings are re-read from disk after the write. */
  patch(next: Partial<WebSearchSettings>): Promise<WebSearchSettings> {
    const operation = this.tail.then(async () => {
      const merged = normalizeWebSearchSettings({ ...this.get(), ...next });
      this.write(merged);
      this.cache = merged;
      this.loadFailed = false;
      return merged;
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private write(settings: WebSearchSettings): void {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      renameSync(temporaryPath, this.filename);
      try {
        chmodSync(this.filename, 0o600);
      } catch {
        /* best effort on platforms without POSIX modes */
      }
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        /* ignore cleanup failure */
      }
      throw error;
    }
  }
}

export const webSearchSettings = new WebSearchSettingsStore(path.join(desktopDataRoot(), "web-search.json"));
