import type { RunResult, StudioApi } from "../shared/types";

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export const studio = (): StudioApi => window.studio;

export const newId = () => crypto.randomUUID();

export function extname(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function failureText(result: RunResult): string | null {
  if (result.failure) return result.failureMessage ?? result.failure;
  if (result.json && !result.json.ok) return `${result.json.error.type}: ${result.json.error.message}`;
  return null;
}

export interface CapturedImage {
  src: string;
  label: string;
}

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Pulls base64 camera captures out of driver results so JSON stays readable.
export function extractImages(value: unknown): { stripped: unknown; images: CapturedImage[] } {
  const images: CapturedImage[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    if (typeof node !== "object" || node === null) return node;
    const record = node as Record<string, unknown>;
    const b64 = record.b64 ?? record.base64;
    if (typeof record.mime === "string" && IMAGE_MIME.has(record.mime) && typeof b64 === "string" && BASE64.test(b64)) {
      images.push({ src: `data:${record.mime};base64,${b64}`, label: `${path || "image"} ${record.width ?? "?"}×${record.height ?? "?"}` });
      const { b64: _a, base64: _b, ...rest } = record;
      return { ...rest, b64: `<${record.bytes ?? "?"} bytes>` };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child, path ? `${path}.${key}` : key)]));
  };
  return { stripped: walk(value, ""), images };
}

// One series per numeric leaf (dotted path); missing values stay null so lines break.
export function numericSeries(samples: unknown[]): Map<string, (number | null)[]> {
  const series = new Map<string, (number | null)[]>();
  samples.forEach((sample, index) => {
    const visit = (node: unknown, key: string, depth: number) => {
      if (typeof node === "number" && Number.isFinite(node) && key) {
        if (!series.has(key)) series.set(key, new Array(samples.length).fill(null));
        series.get(key)![index] = node;
      } else if (depth < 4 && typeof node === "object" && node !== null) {
        for (const [child, value] of Object.entries(node)) visit(value, key ? `${key}.${child}` : child, depth + 1);
      }
    };
    visit(sample, "", 0);
  });
  return series;
}

export interface Location {
  target: "robot" | "script";
  line: number;
  column: number;
}

export function locateError(message: string): Location | null {
  const sql = /\(line (\d+), column (\d+)\)/.exec(message);
  if (sql) return { target: "robot", line: Number(sql[1]), column: Number(sql[2]) };
  const mt = /\bline (\d+)/i.exec(message);
  if (mt) return { target: "script", line: Number(mt[1]), column: 1 };
  return null;
}
