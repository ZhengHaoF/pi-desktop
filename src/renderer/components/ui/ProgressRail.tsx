/**
 * Vertical progress rail shared by the plan and goal cards: a node glyph per
 * item, connected by a continuous line whose segment style tracks the item
 * status (completed segments solid, in-progress accent, pending hairline).
 *
 * The rail renders one node per row and stretches the connector between rows
 * with `flex: 1`, so it aligns with text rows of any height when placed in
 * the same flex row as the content list.
 */
import type { CSSProperties } from "react";

export type RailItemStatus = "completed" | "in_progress" | "pending";

export interface ProgressRailProps {
  items: readonly { status: RailItemStatus }[];
  /** Node size in px; the connecting line runs between adjacent nodes. */
  nodeSize?: number;
}

const NODE = 13;

/** Connector between two adjacent nodes, styled by the upper item's status. */
function segmentStyle(status: RailItemStatus): CSSProperties {
  if (status === "completed") return { background: "var(--text-dim)" };
  if (status === "in_progress") return { background: "var(--accent)" };
  // Pending: a hairline in the panel's own border colour reads as "future".
  return { background: "var(--border)" };
}

function nodeStyle(status: RailItemStatus, nodeSize: number): CSSProperties {
  const base: CSSProperties = {
    width: nodeSize,
    height: nodeSize,
    borderRadius: "50%",
    boxSizing: "border-box",
    flexShrink: 0,
  };
  if (status === "completed")
    return {
      ...base,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--text-dim)",
      color: "var(--bg-panel)",
      fontSize: nodeSize * 0.7,
      lineHeight: 1,
    };
  const line = status === "in_progress" ? 3 : 2;
  return { ...base, border: `${line}px solid ${status === "in_progress" ? "var(--accent)" : "var(--border)"}` };
}

export function ProgressRail({ items, nodeSize = NODE }: ProgressRailProps) {
  if (items.length === 0) return null;
  const line = Math.max(1, Math.round(nodeSize / 6));
  return (
    <div
      aria-hidden="true"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", width: nodeSize, flexShrink: 0 }}
    >
      {items.map((item, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            flex: index < items.length - 1 ? "1 1 0" : "0 0 auto",
          }}
        >
          {index > 0 ? (
            <div style={{ width: line, height: 5, flexShrink: 0, ...segmentStyle(items[index - 1].status) }} />
          ) : null}
          <span
            className={item.status === "in_progress" ? "rail-node-active" : undefined}
            style={nodeStyle(item.status, nodeSize)}
          >
            {item.status === "completed" ? "✓" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
