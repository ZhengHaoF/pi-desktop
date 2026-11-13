import { useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import type { GitStatusResult } from "@shared/api-types";

/** Git facts for the chat-area branch indicator, keyed to one cwd. */
export interface GitBranchStatus {
  /** The cwd this data was fetched for — guards against stale responses. */
  forCwd: string;
  isGit: boolean;
  branch: string | null;
  clean: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

/**
 * Poll `git.status` for the session cwd so the chat top bar can show which
 * branch (and worktree) the agent works in. Refresh happens when the cwd
 * changes and whenever callers bump `refreshKey` (agent turn end, window
 * focus), mirroring how the explorer refreshes its git status.
 */
export function useGitBranchStatus(cwd: string | null, refreshKey: number): GitBranchStatus | null {
  const [status, setStatus] = useState<GitBranchStatus | null>(null);

  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void call("git.status", { path: cwd })
      .then((d: GitStatusResult) => {
        if (cancelled) return;
        setStatus({
          forCwd: cwd,
          isGit: d.isGit,
          branch: d.branch ?? null,
          clean: d.clean,
          staged: d.staged,
          modified: d.modified,
          untracked: d.untracked,
          conflicted: d.conflicted,
        });
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);

  // A result for a previous cwd is stale the moment the cwd changes; hide the
  // indicator until the fresh response lands.
  return status && status.forCwd === cwd ? status : null;
}
