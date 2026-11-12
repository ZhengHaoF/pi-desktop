/**
 * Relay diagnostic log (opt-in, JSONL on disk).
 *
 * The audit log is metadata-only *and* in-memory, so it can never answer
 * "why was my phone rejected 20 seconds ago" after the fact. This log is the
 * opposite trade-off: it is on disk and specific (pairing-gate verdicts,
 * credential/secret verdicts, binding inventory), but it still never records
 * payloads, ciphertext, tokens or secrets — only short SHA-256 digests, so a
 * token can be correlated across `pair.create` → `device.hello` without the
 * plaintext ever landing in a file.
 *
 * Diagnostics must never affect the relay: every write is best-effort and the
 * log disables itself permanently on the first I/O error.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Rotate at 4 MB (keeps one previous file as `<path>.1`). */
const MAX_BYTES = 4 * 1024 * 1024;

export type DiagValue = string | number | boolean | null | undefined | string[] | number[];

export class RelayDiagLog {
  private readonly path?: string;
  private disabled = false;

  constructor(path?: string) {
    this.path = path;
  }

  get enabled(): boolean {
    return Boolean(this.path) && !this.disabled;
  }

  get filePath(): string | undefined {
    return this.path;
  }

  /** Stable 10-hex digest for correlating a token/secret without leaking it. */
  static digest(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
  }

  record(event: string, fields: Record<string, DiagValue> = {}): void {
    const path = this.path;
    if (!path || this.disabled) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.rotateIfNeeded(path);
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
      appendFileSync(path, `${line}\n`, "utf8");
    } catch {
      // Never let diagnostics break the relay.
      this.disabled = true;
    }
  }

  private rotateIfNeeded(path: string): void {
    try {
      if (statSync(path).size < MAX_BYTES) return;
    } catch {
      return; // No file yet.
    }
    try {
      unlinkSync(`${path}.1`);
    } catch {
      // No previous rotation to drop.
    }
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // Rotation is best-effort; keep appending to the current file.
    }
  }
}
