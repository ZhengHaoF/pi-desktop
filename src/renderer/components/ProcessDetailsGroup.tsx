import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { ChevronRight } from "lucide-react";
import type { ThinkingExpansionStore } from "@/lib/thinking-expansion-store";
import { scaledChatFont } from "@/lib/chat-appearance";
import { Button } from "@/components/ui/Button";

interface Props {
  messageCount: number;
  toolCallCount: number;
  children: ReactNode;
  stateKey: string;
  expansionStore: ThinkingExpansionStore;
}

export function ProcessDetailsGroup({ messageCount, toolCallCount, children, stateKey, expansionStore }: Props) {
  const getSnapshot = useMemo(() => () => expansionStore.getSnapshot(stateKey), [expansionStore, stateKey]);
  const expanded = useSyncExternalStore(expansionStore.subscribe, getSnapshot, getSnapshot);
  const { language, t } = useI18n();
  const parts = [
    t("processDetails", "Process details"),
    language !== "en-US"
      ? `${messageCount} ${t("messagesCount", "messages")}`
      : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
  ];
  if (toolCallCount > 0) {
    parts.push(
      language !== "en-US"
        ? `${toolCallCount} ${t("toolCallsCount", "tool calls")}`
        : `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`,
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => expansionStore.toggle(stateKey)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          fontSize: scaledChatFont(12),
          textAlign: "left",
        }}
        title={
          expanded
            ? t("collapseProcessDetails", "Collapse process details")
            : t("expandProcessDetails", "Expand process details")
        }
      >
        <ChevronRight
          size={12}
          strokeWidth={1.6}
          style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </Button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
