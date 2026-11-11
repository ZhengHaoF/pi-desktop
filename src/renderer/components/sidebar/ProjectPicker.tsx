import { useState, useRef, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/Input";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type { SessionInfo } from "@/lib/types";
import { getRecentProjects } from "@/hooks/useSidebarWorkspace";
import { abbreviateHomePath } from "@/lib/display-path";
import { PathLabel, AnimatedDropdown, useDeferredFocus } from "./WorkspaceDropdown";
import { Button } from "@/components/ui/Button";

interface Props {
  selectedCwd: string | null;
  selectedProject: string | null;
  homeDir: string;
  allSessions: SessionInfo[];
  restoringInitialSession: boolean;
  setSelectedCwd: (cwd: string | null) => void;
  /** Aggregated mode: render a compact "Open project…" trigger instead of the
   *  selected-path display, because the project groups already show the path.
   *  The dropdown then also drops the project list — switching between known
   *  projects happens through the groups — and keeps only the actions that
   *  open a project with no sessions yet. */
  compact?: boolean;
}

export function ProjectPicker({
  selectedCwd,
  selectedProject,
  homeDir,
  allSessions,
  restoringInitialSession,
  setSelectedCwd,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const deferFocus = useDeferredFocus();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const result = await call("system.validateCwd", { path: path });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, setSelectedCwd, t]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const data = await call("system.defaultCwd");
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [setSelectedCwd]);

  /** Desktop-native directory picker (design §6.1). Falls back to path input. */
  const handlePickDirectory = useCallback(async () => {
    try {
      const dir = await window.piBridge?.selectDirectory?.();
      if (!dir) return;
      const result = await call("system.validateCwd", { path: dir });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? dir);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setCustomPathError(null);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [setSelectedCwd, t]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const recentProjects = getRecentProjects(allSessions);
  // Aggregated mode (compact) already lists every project as a group in the
  // sidebar, so the dropdown only offers the actions that open a project with
  // no sessions yet; the project list would just duplicate the groups.
  const showProjectList = !compact;
  const showProjectFilter = showProjectList && recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {compact ? (
        <Button
          onClick={() => setDropdownOpen((v) => !v)}
          title={t("openProjectEllipsis", "Open project…")}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 10px",
            borderRadius: 7,
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
          </svg>
          {t("openProjectEllipsis", "Open project…")}
        </Button>
      ) : (
        <Button
          onClick={() => setDropdownOpen((v) => !v)}
          title={selectedProject ?? selectedCwd ?? ""}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            padding: "6px 10px",
            borderRadius: 7,
            fontSize: 12,
            textAlign: "left",
            // Without a project the trigger invites picking one.
            ...(!selectedCwd
              ? { background: "var(--accent-soft)", border: "1px solid var(--accent-soft-border)" }
              : {}),
          }}
        >
          {selectedCwd ? (
            <PathLabel
              text={abbreviateHomePath(selectedProject ?? selectedCwd, homeDir)}
              style={{
                flex: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text)",
              }}
            />
          ) : (
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              {restoringInitialSession ? "" : t("selectProjectEllipsis", "Select project…")}
            </span>
          )}
        </Button>
      )}

      <AnimatedDropdown
        open={dropdownOpen}
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          right: 0,
          zIndex: 100,
          borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
          overflow: "hidden",
        }}
      >
        {showProjectFilter && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <Input
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setProjectFilter("");
                  setDropdownOpen(false);
                }
              }}
              placeholder={t("filterProjects", "Filter projects…")}
              autoFocus
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                borderRadius: 5,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
        {showProjectList && (
          <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
            {visibleProjects.map((project) => (
              <Button
                key={project}
                onClick={() => {
                  setSelectedCwd(project);
                  setProjectFilter("");
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
                  setDropdownOpen(false);
                }}
                pressed={project === selectedProject}
                variant="ghost"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: project === selectedProject ? "var(--bg-selected)" : undefined,
                  textAlign: "left",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={project}
              >
                {project === selectedProject && (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <polyline points="1.5 5 4 7.5 8.5 2.5" />
                  </svg>
                )}
                {project !== selectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
                <PathLabel text={abbreviateHomePath(project, homeDir)} style={{ flex: 1 }} />
              </Button>
            ))}
            {visibleProjects.length === 0 && projectFilter.trim() && (
              <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
                {t("noMatchingProjects", "No matching projects")}
              </div>
            )}
          </div>
        )}

        {/* Default cwd shortcut */}
        {!customPathOpen && (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              void handleDefaultCwd();
            }}
            variant="ghost"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              border: "none",
              borderTop: showProjectList && visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span>{t("useDefaultDirectory", "Use default directory")}</span>
          </Button>
        )}

        {/* Native directory picker (desktop) */}
        {!customPathOpen && typeof window !== "undefined" && !!window.piBridge && (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              void handlePickDirectory();
            }}
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
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span>{t("browseFolder", "Browse folder…")}</span>
          </Button>
        )}

        {/* Custom path entry */}
        {!customPathOpen ? (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              setCustomPathOpen(true);
              setCustomPathError(null);
              deferFocus(() => customPathInputRef.current?.focus());
            }}
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
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              style={{ flexShrink: 0 }}
            >
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
            <span>{t("customPath", "Custom path…")}</span>
          </Button>
        ) : (
          <div
            style={{
              padding: "6px 8px",
              borderTop: showProjectList && visibleProjects.length > 0 ? "none" : undefined,
            }}
          >
            <Input
              ref={customPathInputRef}
              value={customPathValue}
              onChange={(e) => {
                setCustomPathValue(e.target.value);
                setCustomPathError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitCustomPath();
                }
                if (e.key === "Escape") {
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
                }
              }}
              placeholder="/path/to/project"
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
            {customPathError && (
              <div
                style={{
                  marginTop: 5,
                  color: "var(--danger)",
                  fontSize: 11,
                  lineHeight: 1.35,
                  overflowWrap: "anywhere",
                }}
              >
                {customPathError}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
              <Button
                onClick={() => void commitCustomPath()}
                disabled={customPathValidating || !customPathValue.trim()}
                variant="primary"
                style={{
                  flex: 1,
                  padding: "4px 0",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {customPathValidating ? t("checking", "Checking…") : t("open", "Open")}
              </Button>
              <Button
                onClick={() => {
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
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
      </AnimatedDropdown>
    </div>
  );
}
