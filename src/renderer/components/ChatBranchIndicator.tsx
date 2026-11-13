import { useI18n } from "@/i18n";
import { abbreviateHomePath } from "@/lib/display-path";
import { GitBranch } from "lucide-react";
import type { GitBranchStatus } from "@/hooks/useGitBranchStatus";

interface Props {
  /** Git status of the session cwd, or null while loading / not a session. */
  status: GitBranchStatus | null;
  /** The session cwd the status belongs to (path shown in the worktree tooltip). */
  cwd: string | null;
  /** Worktree branch recorded on the session, when the cwd is a linked worktree. */
  worktreeBranch?: string;
  homeDir: string;
}

const GitBranchGlyph = <GitBranch size={11} aria-hidden="true" style={{ flexShrink: 0 }} />;

/**
 * Persistent chat-area indicator answering "which branch / worktree is the
 * agent working in". Shows the session cwd's branch; when the cwd is a linked
 * worktree it adds a worktree badge and a tooltip with the checkout path.
 * Hidden entirely when there is no session or the cwd is not a git repo.
 */
export function ChatBranchIndicator({ status, cwd, worktreeBranch, homeDir }: Props) {
  const { t } = useI18n();
  // Only claim worktree identity when git agrees the cwd belongs to that
  // branch — a stale session label must not survive a cwd switch.
  const isWorktree = Boolean(worktreeBranch && status?.branch && worktreeBranch === status.branch);
  if (!status || !cwd || !status.isGit) return null;
  const tooltip = isWorktree
    ? t("worktreePath", "Worktree: {path}").replace("{path}", abbreviateHomePath(cwd, homeDir))
    : cwd;
  const dirtyCount = status.staged + status.modified + status.untracked + status.conflicted;
  return (
    <div
      title={tooltip}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        maxWidth: 200,
        padding: "2px 8px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-hover)",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--text-muted)",
      }}
    >
      {GitBranchGlyph}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: isWorktree ? "var(--accent)" : "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {status.branch ?? t("detachedHead", "detached")}
      </span>
      {isWorktree && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 9,
            fontWeight: 600,
            padding: "0 4px",
            borderRadius: 4,
            background: "var(--accent-chip-bg)",
            color: "var(--accent-chip-fg)",
          }}
        >
          {t("worktreeBadge", "worktree")}
        </span>
      )}
      {!status.clean && dirtyCount > 0 && (
        <span
          aria-label={t("gitDirtyAria", "{count} uncommitted changes").replace("{count}", String(dirtyCount))}
          title={t("gitDirtyAria", "{count} uncommitted changes").replace("{count}", String(dirtyCount))}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            flexShrink: 0,
            background: status.conflicted > 0 ? "var(--danger)" : "var(--warning)",
          }}
        />
      )}
    </div>
  );
}
