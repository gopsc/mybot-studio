// Paths in requests are workspace-relative POSIX paths; the main process resolves them.
export type PymybotRequest =
  | { command: "check"; robot: string; input?: string }
  | { command: "hardware"; robot: string }
  | { command: "scripts" }
  | { command: "query"; robot: string; sql: string }
  | { command: "run"; robot: string; input: string; timeout: number; allowHardware: boolean; vars: Record<string, string> }
  | { command: "sample"; robot: string; name: string; count: number; intervalMs: number; timeout: number; allowHardware: boolean }
  | { command: "apply-sql"; robot: string; sql: string; allowHardware: boolean }
  | {
      command: "agent";
      robot: string;
      task: string;
      timeout: number;
      allowHardware: boolean;
      allowActions: boolean;
      readVars: string[];
      cameraVars: string[];
      maxRequests: number;
      maxToolCalls: number;
    };

export type PymybotCommand = PymybotRequest["command"];

export type PymybotJson =
  | ({ ok: true; command: string } & Record<string, unknown>)
  | ({ ok: false; error: { type: string; message: string } } & Record<string, unknown>);

export interface RunResult {
  id: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  json: PymybotJson | null;
  stderr: string;
  durationMs: number;
  // Set when nothing was executed or the process output was unusable.
  failure?: "declined" | "busy" | "spawn" | "invalid-request" | "bad-output" | "output-too-large";
  failureMessage?: string;
}

export interface Settings {
  python: string;
  modulePaths: string[];
  cameraSrcDir: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
}

export interface FileEntry {
  path: string;
  kind: "file" | "dir";
}

export interface WorkspaceInfo {
  root: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface StderrEvent {
  id: string;
  chunk: string;
}

export interface StudioApi {
  platform: string;
  openWorkspace(): Promise<WorkspaceInfo | null>;
  currentWorkspace(): Promise<WorkspaceInfo | null>;
  refreshWorkspace(): Promise<WorkspaceInfo | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<Settings>;
  resolvePython(): Promise<string>;
  run(id: string, request: PymybotRequest): Promise<RunResult>;
  cancel(id: string): Promise<void>;
  onStderr(listener: (event: StderrEvent) => void): () => void;
}
