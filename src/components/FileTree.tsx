import { useMemo, useState } from "react";
import type { FileEntry } from "../../shared/types";
import { basename } from "../util";

interface Props {
  entries: FileEntry[];
  activePath: string | null;
  robot: string;
  script: string;
  onOpen(path: string): void;
}

const DEFAULT_OPEN = new Set(["robots", "scripts"]);

export function FileTree({ entries, activePath, robot, script, onOpen }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(entries.filter((e) => e.kind === "dir" && !DEFAULT_OPEN.has(e.path)).map((e) => e.path)),
  );
  const visible = useMemo(
    () => entries.filter((entry) => {
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) if (collapsed.has(parts.slice(0, i).join("/"))) return false;
      return true;
    }),
    [entries, collapsed],
  );
  const toggle = (path: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  return (
    <div className="tree">
      {visible.map((entry) => {
        const depth = entry.path.split("/").length - 1;
        const isDir = entry.kind === "dir";
        return (
          <div
            key={entry.path}
            className={`tree-row${entry.path === activePath ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={entry.path}
            onClick={() => (isDir ? toggle(entry.path) : onOpen(entry.path))}
          >
            <span className="muted">{isDir ? (collapsed.has(entry.path) ? "▸" : "▾") : " "}</span>
            <span>{basename(entry.path)}</span>
            {entry.path === robot && <span className="tag">结构</span>}
            {entry.path === script && <span className="tag">动作</span>}
          </div>
        );
      })}
    </div>
  );
}
