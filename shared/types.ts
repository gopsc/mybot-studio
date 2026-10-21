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

export interface AgentOptions {
  robot: string;
  timeout: number;
  allowHardware: boolean;
  allowActions: boolean;
  readVars: string[];
  cameraVars: string[];
  maxRequests: number;
  maxToolCalls: number;
}

// Requests to the long-lived `pymybot serve` process; paths are workspace-relative.
export type ServeRequest =
  | { method: "session.status" }
  | { method: "session.activate"; robot: string; allowHardware: boolean }
  | { method: "session.deactivate" }
  | { method: "run"; input: string; timeout: number; vars: Record<string, string> }
  | { method: "apply-sql"; sql: string }
  | { method: "sample"; name: string; count: number; intervalMs: number }
  | ({ method: "agent.ask"; task: string } & AgentOptions)
  | { method: "agent.reset" };

export interface ServeError {
  code: number;
  message: string;
  data?: { type?: string; tool_events?: unknown[] } & Record<string, unknown>;
}

export type ServeResult =
  | { ok: true; result: any }
  | { ok: false; error: ServeError; failure?: "declined" | "invalid-request" | "spawn" | "exited" };

export interface SessionStatus {
  state: "Active" | "Inactive";
  robot?: string;
  allowHardware?: boolean;
  since?: number;
  busy: string | null;
  agent: boolean;
}

export type ServeEvent =
  | { type: "session"; status: SessionStatus }
  | { type: "sample"; id: string; index: number; value: unknown; t: number }
  | { type: "agent"; id: string; event: Record<string, unknown> }
  | { type: "confirm"; tool: string; arguments: unknown; approved: boolean }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; code: number | null; signal: string | null };

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
  serve(id: string, request: ServeRequest): Promise<ServeResult>;
  serveCancel(id: string): Promise<void>;
  onServe(listener: (event: ServeEvent) => void): () => void;
}
