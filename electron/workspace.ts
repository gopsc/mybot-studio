import fs from "node:fs";
import path from "node:path";
import type { FileEntry, WorkspaceInfo } from "../shared/types.js";

export const MAX_TEXT = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", "dist", "build", "release"]);
const LISTED = new Set([".sql", ".mt", ".lua", ".md"]);
export const EDITABLE = new Set([".sql", ".mt", ".lua", ".md"]);

export class WorkspaceError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Rejects absolute paths, traversal and symlink escapes; `target` need not exist yet.
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) throw new WorkspaceError("Invalid path");
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.includes("\\")) {
    throw new WorkspaceError(`Path must be workspace-relative: ${rel}`);
  }
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, ...rel.split("/"));
  if (!isInside(realRoot, target)) throw new WorkspaceError(`Path escapes the workspace: ${rel}`);
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!isInside(realRoot, fs.realpathSync(existing))) throw new WorkspaceError(`Path escapes the workspace: ${rel}`);
  return target;
}

export function listWorkspace(root: string): WorkspaceInfo {
  const realRoot = fs.realpathSync(root);
  const entries: FileEntry[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (item.isSymbolicLink()) continue;
      const full = path.join(dir, item.name);
      const rel = path.relative(realRoot, full).split(path.sep).join("/");
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || item.name.endsWith(".egg-info")) continue;
        const before = entries.length;
        entries.push({ path: rel, kind: "dir" });
        walk(full, depth + 1);
        if (entries.length === before + 1) entries.pop();
      } else if (item.isFile() && LISTED.has(path.extname(item.name))) {
        entries.push({ path: rel, kind: "file" });
      }
    }
  };
  walk(realRoot, 0);
  return { root: realRoot, entries, truncated };
}

function regularFile(target: string): fs.Stats {
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) throw new WorkspaceError("Not a regular file");
  return stat;
}

export function readText(root: string, rel: string): string {
  const target = resolveInside(root, rel);
  if (regularFile(target).size > MAX_TEXT) throw new WorkspaceError("File exceeds 8 MiB");
  return fs.readFileSync(target, "utf8");
}

function checkWritable(rel: string, content: string) {
  if (!EDITABLE.has(path.extname(rel))) throw new WorkspaceError(`Only ${[...EDITABLE].join(" ")} files can be written`);
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEXT) throw new WorkspaceError("Content exceeds 8 MiB");
}

export function writeText(root: string, rel: string, content: string): void {
  checkWritable(rel, content);
  const target = resolveInside(root, rel);
  regularFile(target);
  fs.writeFileSync(target, content, "utf8");
}

export function createText(root: string, rel: string, content: string): void {
  checkWritable(rel, content);
  const target = resolveInside(root, rel);
  if (!fs.statSync(path.dirname(target), { throwIfNoEntry: false })?.isDirectory()) {
    throw new WorkspaceError("Parent directory does not exist");
  }
  fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}
