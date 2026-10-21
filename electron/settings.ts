import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../shared/types.js";

export const DEFAULT_SETTINGS: Settings = {
  python: "",
  modulePaths: [],
  cameraSrcDir: "",
  model: "",
  baseUrl: "",
  apiKeyEnv: "",
};

interface Stored {
  settings: Settings;
  lastWorkspace: string | null;
}

const str = (value: unknown, max = 4096) => (typeof value === "string" && value.length <= max && !value.includes("\0") ? value : "");

export function sanitizeSettings(value: unknown): Settings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const modulePaths = Array.isArray(input.modulePaths) ? input.modulePaths.map((item) => str(item)).filter(Boolean).slice(0, 32) : [];
  return {
    python: str(input.python),
    modulePaths,
    cameraSrcDir: str(input.cameraSrcDir),
    model: str(input.model, 256),
    baseUrl: str(input.baseUrl, 2048),
    apiKeyEnv: /^[A-Za-z_][A-Za-z0-9_]*$/.test(str(input.apiKeyEnv, 128)) ? str(input.apiKeyEnv, 128) : "",
  };
}

export class SettingsStore {
  private data: Stored;

  constructor(private file: string) {
    let raw: Partial<Stored> = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // First launch or unreadable file: start from defaults.
    }
    this.data = {
      settings: sanitizeSettings(raw.settings),
      lastWorkspace: typeof raw.lastWorkspace === "string" ? raw.lastWorkspace : null,
    };
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get lastWorkspace(): string | null {
    return this.data.lastWorkspace;
  }

  update(patch: Partial<Stored>): void {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}
