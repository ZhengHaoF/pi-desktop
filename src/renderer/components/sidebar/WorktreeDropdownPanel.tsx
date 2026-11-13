import { useState, useCallback, useRef } from "react";
import { Input } from "@/components/ui/Input";
import { useI18n } from "@/i18n";
import { Check, Plus, Trash2 } from "lucide-react";
import { abbreviateHomePath } from "@/lib/display-path";
import type { WorktreeEntry } from "@/hooks/useSidebarWorkspace";
import { PathLabel, useDeferredFocus } from "./WorkspaceDropdown";
import { Button } from "@/components/ui/Button";

export interface WorktreeDropdownPanelProps {
  worktrees: WorktreeEntry[];
  selectedCwd: string | null;
  homeDir: string;
  projectRoot: string;
  /** Switch the effective cwd. The host decides whether the dropdown closes. */
  onSelectWorktree: (path: string) => void;
  onWorktreeCreated: (path: string, branch: string) => void;
  onWorktreeRemoved: () => void;
}

/**
 * Worktree list plus the create/remove flows, shared by the sidebar's top-level
 * worktree switcher and the per-project branch menu in aggregated mode. Owns
 * its own transient UI state so both hosts stay thin.
 */
export function WorktreeDropdownPanel({
  worktrees,
  selectedCwd,
  homeDir,
  projectRoot,
  onSelectWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
}: WorktreeDropdownPanelProps) {
  const { t } = useI18n();
  const deferFocus = useDeferredFocus();
  const newInputRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const handleCreateWorktree = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { call } = await import("@/lib/api-client");
      const { worktree } = await call("worktrees.create", {
        projectRoot,
        cwd: projectRoot,
        branch,
      });
      setNewOpen(false);
      setNewBranch("");
      onWorktreeCreated(worktree.path, branch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newBranch, busy, projectRoot, onWorktreeCreated]);

  const handleRemoveWorktree = useCallback(
    async (path: string, force: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const { call } = await import("@/lib/api-client");
        await call("worktrees.remove", {
          cwd: projectRoot,
          path,
          force,
        });
        setConfirmRemove(null);
        if (selectedCwd === path) onSelectWorktree(projectRoot);
        onWorktreeRemoved();
      } catch (e) {
        if (!force && (e as { detail?: { dirty?: boolean } }).detail?.dirty) {
          setConfirmRemove(path);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, projectRoot, selectedCwd, onSelectWorktree, onWorktreeRemoved],
  );

  return (
    <>
      <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
        {worktrees.map((wt) => {
          const isCurrent = wt.path === selectedCwd || (wt.isMain && !worktrees.some((w) => w.path === selectedCwd));
          if (confirmRemove === wt.path) {
            return (
              <div
                key={wt.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 10px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--danger-soft)",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontSize: 11,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("worktreeForceRemoveConfirm", "Uncommitted changes. Force remove checkout?")}
                </span>
                <Button
                  onClick={() => void handleRemoveWorktree(wt.path, true)}
                  disabled={busy}
                  variant="danger"
                  style={{
                    padding: "3px 9px",
                    borderRadius: 5,
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                    // Solid destructive confirm keeps its filled danger palette.
                    background: "var(--danger)",
                    borderColor: "var(--danger)",
                    color: "#fff",
                  }}
                >
                  {t("force", "Force")}
                </Button>
                <Button
                  onClick={() => setConfirmRemove(null)}
                  style={{
                    padding: "3px 9px",
                    borderRadius: 5,
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  {t("cancel", "Cancel")}
                </Button>
              </div>
            );
          }
          return (
            <div
              key={wt.path}
              className="wt-row"
              style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
            >
              <Button
                onClick={() => {
                  onSelectWorktree(wt.path);
                }}
                title={wt.path}
                pressed={isCurrent}
                variant="ghost"
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "8px 10px",
                  border: "none",
                  background: isCurrent ? "var(--bg-selected)" : undefined,
                  textAlign: "left",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {isCurrent ? (
                  <Check size={10} strokeWidth={2} color="var(--accent)" style={{ flexShrink: 0 }} />
                ) : (
                  <span style={{ width: 10, flexShrink: 0 }} />
                )}
                <PathLabel text={wt.branch ?? abbreviateHomePath(wt.path, homeDir)} style={{ flex: 1 }} />
                {wt.isMain && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {t("mainBranch", "main")}
                  </span>
                )}
              </Button>
              {!wt.isMain && (
                <Button
                  onClick={() => void handleRemoveWorktree(wt.path, false)}
                  disabled={busy}
                  title={t("removeWorktreeHint", "Remove worktree checkout {path}; the branch is kept").replace(
                    "{path}",
                    wt.path,
                  )}
                  variant="danger"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 34,
                    height: 28,
                    padding: 0,
                    marginRight: 4,
                    border: "none",
                    borderRadius: 5,
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {!newOpen ? (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            setNewOpen(true);
            setError(null);
            deferFocus(() => newInputRef.current?.focus());
          }}
          title={t("createWorktreeHint", "Create a worktree checkout for a branch")}
          variant="ghost"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "8px 10px",
            border: "none",
            textAlign: "left",
            fontSize: 11,
          }}
        >
          <Plus size={10} strokeWidth={1.1} style={{ flexShrink: 0 }} />
          <span>{t("newWorktree", "New worktree…")}</span>
        </Button>
      ) : (
        <div style={{ padding: "6px 8px" }}>
          <Input
            ref={newInputRef}
            value={newBranch}
            onChange={(e) => {
              setNewBranch(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreateWorktree();
              }
              if (e.key === "Escape") {
                setNewOpen(false);
                setNewBranch("");
                setError(null);
              }
            }}
            placeholder={t("branchName", "branch name")}
            style={{
              width: "100%",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "5px 8px",
              border: "1px solid var(--accent)",
              borderRadius: 5,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
            <Button
              onClick={() => void handleCreateWorktree()}
              disabled={busy || !newBranch.trim()}
              variant="primary"
              style={{
                flex: 1,
                padding: "4px 0",
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {busy ? t("creating", "Creating…") : t("create", "Create")}
            </Button>
            <Button
              onClick={() => {
                setNewOpen(false);
                setNewBranch("");
                setError(null);
              }}
              style={{
                flex: 1,
                padding: "4px 0",
                borderRadius: 5,
                fontSize: 11,
              }}
            >
              {t("cancel", "Cancel")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "5px 10px 8px",
            color: "var(--danger)",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
