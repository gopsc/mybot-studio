import { useEffect, useMemo, useRef, useState } from "react";
import type { PymybotRequest, RunResult, ServeEvent, ServeRequest, ServeResult, SessionStatus, Settings } from "../../shared/types";
import {
  CANCELLED, cliOutcome, extractImages, failureText, newId, numericSeries, type Outcome, quoteArg, serveError, serveOutcome, studio,
} from "../util";
import { Chart } from "./Chart";

export type Exec = (request: PymybotRequest, onStderr?: (chunk: string) => void) => Promise<RunResult>;
export type ServeCall = (request: ServeRequest, options?: { id?: string; onEvent?: (event: ServeEvent) => void }) => Promise<ServeResult>;

export interface Problem {
  message: string;
  path: string | null;
  line: number;
  column: number;
}

export interface HardwareItem {
  name: string;
  type: string;
  metadata: Record<string, unknown>;
}

export interface CheckState {
  running: boolean;
  summary: string | null;
  problems: Problem[];
}

function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function Images({ value }: { value: unknown }) {
  const { images } = useMemo(() => extractImages(value), [value]);
  if (!images.length) return null;
  return (
    <div className="images">
      {images.map((image, i) => (
        <figure key={i}>
          <img src={image.src} alt={image.label} />
          <figcaption>{image.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function Failure({ error }: { error: string | null | undefined }) {
  return error ? <div className="err">✗ {error}</div> : null;
}

export function ProblemsPanel({ state, onReveal }: { state: CheckState; onReveal(problem: Problem): void }) {
  if (state.running) return <div className="muted">检查中…</div>;
  return (
    <div>
      {state.summary && <div className={state.problems.length ? "err" : "ok"}>{state.summary}</div>}
      {state.problems.map((problem, i) => (
        <div key={i} className="problem" onClick={() => onReveal(problem)}>
          <span className="err">✗</span>
          <span className="mono">{problem.message}</span>
          {problem.path && <span className="muted">{problem.path}:{problem.line}:{problem.column}</span>}
        </div>
      ))}
      {!state.summary && <div className="muted">保存 .sql / .mt 文件或点击「检查」后在这里显示静态检查结果。</div>}
    </div>
  );
}

export interface RunState {
  running: boolean;
  live: string;
  outcome: Outcome | null;
  session: boolean;
}

export function OutputPanel({ state }: { state: RunState }) {
  const outputs = (state.outcome?.json?.outputs as unknown[] | undefined) ?? null;
  const stripped = useMemo(() => (outputs ? (extractImages(outputs).stripped as unknown[]) : null), [outputs]);
  if (!state.running && !state.outcome) return <div className="muted">选择结构和动作脚本后点击「运行」。默认只允许虚拟总线、串口回环和图片文件。</div>;
  return (
    <div className="frames">
      {state.running && <div className="warn">运行中…（可点「停止」协作式中断）</div>}
      <Failure error={state.outcome?.error} />
      {state.outcome?.json && (
        <div className="ok">✓ 完成{state.session ? "（会话）" : ""}，{state.outcome.durationMs} ms，{outputs?.length ?? 0} 个输出</div>
      )}
      {stripped?.map((frame, i) => (
        <div key={i} className="frame">
          <div className="muted">#{i + 1}</div>
          <Json value={frame} />
          <Images value={outputs![i]} />
        </div>
      ))}
      {state.live && (
        <details open={state.running || !!state.outcome?.error}>
          <summary className="muted">stderr</summary>
          <pre className="stream">{state.live}</pre>
        </details>
      )}
    </div>
  );
}

export function HardwarePanel({ items, error, session, onRefresh }: {
  items: HardwareItem[]; error: string | null; session: boolean; onRefresh(): void;
}) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button onClick={onRefresh} disabled={session}>刷新</button>
        <span className="muted">{session ? "当前会话中的硬件（含热更新 SQL 的改动）。" : "来自 hardware 命令，不激活驱动。"}</span>
      </div>
      {error && <div className="err">✗ {error}</div>}
      {!!items.length && (
        <table className="grid">
          <thead><tr><th>变量</th><th>表（驱动）</th><th>元数据</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.name}>
                <td className="mono">{item.name}</td>
                <td>{item.type}</td>
                <td className="mono">{Object.entries(item.metadata).map(([k, v]) => `${k}=${String(v)}`).join("  ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function QueryPanel({ robot, exec, serveCall, session, allowHardware, onHardware }: {
  robot: string; exec: Exec; serveCall: ServeCall; session: boolean; allowHardware: boolean;
  onHardware(items: { name: string; type: string }[]): void;
}) {
  const [sql, setSql] = useState("SHOW TABLES;");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (command: "query" | "apply-sql") => {
    setBusy(true);
    try {
      if (command === "apply-sql" && session) {
        const started = Date.now();
        const result = await serveCall({ method: "apply-sql", sql });
        if (result.ok) onHardware(result.result.hardware);
        setOutcome(serveOutcome(result, started));
      } else {
        setOutcome(cliOutcome(await exec(command === "query" ? { command, robot, sql } : { command, robot, sql, allowHardware })));
      }
    } finally {
      setBusy(false);
    }
  };
  const output = outcome?.json?.output;
  return (
    <div className="panel-body fill" style={{ padding: 0 }}>
      <textarea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
      <div className="row">
        <button className="primary" disabled={!robot || busy} onClick={() => go("query")} title="静态读取磁盘上的结构文件">查询（query）</button>
        {session ? (
          <button disabled={busy} onClick={() => go("apply-sql")} title="热更新当前会话，改动保留到会话结束，不改磁盘文件">应用到当前会话</button>
        ) : (
          <button disabled={!robot || busy} onClick={() => go("apply-sql")} title="激活临时会话并应用 SQL，不改磁盘文件">应用到临时会话（apply-sql）</button>
        )}
        <span className="muted">每条语句都必须以 ; 结尾。query 只接受 SHOW TABLES 和 SELECT *。</span>
      </div>
      <Failure error={outcome?.error} />
      {outcome?.json && session && !outcome.error && output === "" && <div className="ok">✓ 已应用到会话</div>}
      {typeof output === "string" ? output && <pre>{output}</pre> : output != null && <Json value={output} />}
    </div>
  );
}

interface Point {
  label: string;
  value: unknown;
}

export function SamplePanel({ robot, exec, serveCall, session, hardware, allowHardware, visible }: {
  robot: string; exec: Exec; serveCall: ServeCall; session: boolean; hardware: HardwareItem[]; allowHardware: boolean; visible: boolean;
}) {
  const [name, setName] = useState("");
  const [count, setCount] = useState(50);
  const [continuous, setContinuous] = useState(true);
  const [windowSize, setWindowSize] = useState(300);
  const [intervalMs, setIntervalMs] = useState(50);
  const [timeout, setTimeoutSec] = useState(30);
  const [points, setPoints] = useState<Point[]>([]);
  const [received, setReceived] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);
  const current = useRef<string | null>(null);
  const target = hardware.some((h) => h.name === name) ? name : hardware[0]?.name ?? "";
  const samples = useMemo(() => points.map((p) => p.value), [points]);
  const series = useMemo(() => numericSeries(samples), [samples]);
  const labels = useMemo(() => points.map((p) => p.label), [points]);

  const goCli = async () => {
    const result = await exec({ command: "sample", robot, name: target, count: Math.min(count, 1000), intervalMs, timeout, allowHardware });
    const done = cliOutcome(result);
    const values = (done.json?.samples as unknown[] | undefined) ?? [];
    setPoints(values.map((value, i) => ({ label: String(i + 1), value })));
    setReceived(values.length);
    setOutcome(done);
  };

  const goLive = async () => {
    const id = newId();
    const limit = windowSize;
    const buffer: Point[] = [];
    let total = 0;
    current.current = id;
    setPoints([]);
    setReceived(0);
    const flush = () => {
      setPoints(buffer.slice());
      setReceived(total);
    };
    const timer = setInterval(flush, 100);
    const started = Date.now();
    try {
      const result = await serveCall({ method: "sample", name: target, count: continuous ? 1_000_000 : count, intervalMs }, {
        id,
        onEvent: (event) => {
          if (event.type !== "sample") return;
          total += 1;
          buffer.push({ label: String(event.index + 1), value: event.value });
          if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
        },
      });
      const stopped = !result.ok && result.error.code === CANCELLED;
      setOutcome(stopped ? { error: null, json: { stopped: true }, durationMs: Date.now() - started } : serveOutcome(result, started));
    } finally {
      clearInterval(timer);
      flush();
      current.current = null;
    }
  };

  const go = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await (session ? goLive() : goCli());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body fill" style={{ padding: 0, height: "100%" }}>
      <div className="row">
        <label>变量
          <select value={target} onChange={(e) => setName(e.target.value)}>
            {hardware.map((h) => <option key={h.name} value={h.name}>{h.name}（{h.type}）</option>)}
          </select>
        </label>
        {session && <label title="直到点击停止"><input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} />连续</label>}
        {!(session && continuous) && (
          <label>次数 <input type="number" min={1} max={session ? 1_000_000 : 1000} value={count} style={{ width: 80 }} onChange={(e) => setCount(Number(e.target.value))} /></label>
        )}
        <label>间隔 ms <input type="number" min={0} max={60000} value={intervalMs} style={{ width: 80 }} onChange={(e) => setIntervalMs(Number(e.target.value))} /></label>
        {session ? (
          <label title="图表只保留最近的样本">窗口 <input type="number" min={10} max={100000} value={windowSize} style={{ width: 80 }} onChange={(e) => setWindowSize(Number(e.target.value))} /></label>
        ) : (
          <label>超时 s <input type="number" min={1} max={3600} value={timeout} style={{ width: 70 }} onChange={(e) => setTimeoutSec(Number(e.target.value))} /></label>
        )}
        {busy && session ? (
          <button className="danger" onClick={() => current.current && void studio().serveCancel(current.current)}>停止采样</button>
        ) : (
          <button className="primary" disabled={!robot || !target || busy} onClick={go}>{busy ? "采样中…" : "采样"}</button>
        )}
        <label><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />原始 JSON</label>
        <span className="muted">
          {session ? `实时流（会话）${received ? `：已收 ${received} 个样本` : ""}` : "一次激活、采完后整体返回；激活本身可能写硬件。"}
        </span>
      </div>
      <Failure error={outcome?.error} />
      {raw ? <Json value={samples} /> : <Chart series={series} xLabels={labels} visible={visible && !raw} />}
    </div>
  );
}

interface Turn {
  id: string;
  task: string;
  items: { kind: "text" | "tool" | "result" | "confirm"; text: string; ok?: boolean }[];
  running: boolean;
  error?: string;
  output?: string;
  usage?: Record<string, number>;
}

function brief(value: unknown, max = 160): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AgentPanel({ robot, serveCall, session, hardware, allowHardware, settings }: {
  robot: string; serveCall: ServeCall; session: SessionStatus; hardware: HardwareItem[]; allowHardware: boolean; settings: Settings | null;
}) {
  const [task, setTask] = useState("列出硬件和可用动作脚本");
  const [allowActions, setAllowActions] = useState(false);
  const [readVars, setReadVars] = useState<string[]>([]);
  const [cameraVars, setCameraVars] = useState<string[]>([]);
  const [timeout, setTimeoutSec] = useState(180);
  const [maxRequests, setMaxRequests] = useState(8);
  const [maxToolCalls, setMaxToolCalls] = useState(16);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [resetting, setResetting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastConfig = useRef<string | null>(null);
  const cameras = hardware.filter((h) => h.type === "Camera");
  const running = turns.some((t) => t.running);
  const blocked = session.state === "Active";
  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const update = (id: string, change: (turn: Turn) => Turn) => setTurns((list) => list.map((t) => (t.id === id ? change(t) : t)));
  const add = (id: string, item: Turn["items"][number]) => update(id, (turn) => {
    const last = turn.items[turn.items.length - 1];
    if (item.kind === "text" && last?.kind === "text") {
      return { ...turn, items: [...turn.items.slice(0, -1), { ...last, text: last.text + item.text }] };
    }
    return { ...turn, items: [...turn.items, item] };
  });

  const send = async () => {
    const text = task.trim();
    if (!text || running || blocked) return;
    const options = { robot, timeout, allowHardware, allowActions, readVars, cameraVars, maxRequests, maxToolCalls };
    const config = JSON.stringify({ ...options, settings });
    const id = newId();
    const fresh = lastConfig.current !== null && lastConfig.current !== config && turns.length > 0;
    lastConfig.current = config;
    setTurns((list) => [...(fresh ? [] : list), { id, task: text, items: [], running: true }]);
    setTask("");
    const result = await serveCall({ method: "agent.ask", task: text, ...options }, {
      id,
      onEvent: (event) => {
        if (event.type === "agent") {
          const e = event.event;
          if (e.type === "text_delta") add(id, { kind: "text", text: String(e.text ?? "") });
          else if (e.type === "tool_call") add(id, { kind: "tool", text: `→ ${e.tool} ${brief(e.arguments)}` });
          else if (e.type === "tool_result") {
            add(id, { kind: "result", ok: e.ok !== false, text: `← ${e.tool} ${e.ok === false ? "失败" : "完成"}${e.executed ? "（已执行）" : ""}` });
          }
        } else if (event.type === "confirm") {
          add(id, { kind: "confirm", ok: event.approved, text: `${event.approved ? "✓ 已批准" : "✗ 已拒绝"} ${event.tool} ${brief(event.arguments)}` });
        }
      },
    });
    update(id, (turn) => ({
      ...turn,
      running: false,
      error: result.ok ? undefined : result.error.code === CANCELLED ? "已停止；对话已关闭" : `${serveError(result)}（对话已关闭）`,
      output: result.ok ? String(result.result.output ?? "") : undefined,
      usage: result.ok ? result.result.usage : undefined,
    }));
    if (!result.ok) lastConfig.current = null;
  };

  const reset = async () => {
    setResetting(true);
    try {
      await serveCall({ method: "agent.reset" });
      setTurns([]);
      lastConfig.current = null;
    } finally {
      setResetting(false);
    }
  };

  const stop = () => turns.filter((t) => t.running).forEach((t) => void studio().serveCancel(t.id));

  return (
    <div className="panel-body fill agent" style={{ padding: 0 }}>
      <div className="row">
        <label title="不勾选时，执行脚本/读取/拍照前会弹窗确认">
          <input type="checkbox" checked={allowActions} onChange={(e) => setAllowActions(e.target.checked)} />预授权动作 --allow-actions
        </label>
        <label>超时 s <input type="number" value={timeout} min={1} max={3600} style={{ width: 70 }} onChange={(e) => setTimeoutSec(Number(e.target.value))} /></label>
        <label>请求上限 <input type="number" value={maxRequests} min={1} max={100} style={{ width: 60 }} onChange={(e) => setMaxRequests(Number(e.target.value))} /></label>
        <label>工具上限 <input type="number" value={maxToolCalls} min={1} max={1000} style={{ width: 60 }} onChange={(e) => setMaxToolCalls(Number(e.target.value))} /></label>
        <button onClick={reset} disabled={running || resetting}>新对话</button>
        <span className="muted">模型：{settings?.model || "MYBOT_MODEL 环境变量"}{session.agent ? " · 对话进行中" : ""}</span>
      </div>
      {!!hardware.length && (
        <div className="row">
          <span className="muted">可读变量 --read-var：</span>
          {hardware.map((h) => (
            <label key={h.name}><input type="checkbox" checked={readVars.includes(h.name)} onChange={() => toggle(readVars, setReadVars, h.name)} />{h.name}</label>
          ))}
          {!!cameras.length && <span className="muted">摄像头 --camera-var：</span>}
          {cameras.map((h) => (
            <label key={h.name}><input type="checkbox" checked={cameraVars.includes(h.name)} onChange={() => toggle(cameraVars, setCameraVars, h.name)} />{h.name}</label>
          ))}
        </div>
      )}
      <div className="transcript">
        {!turns.length && <div className="muted">多轮对话：选项不变时智能体保留上下文和已激活的硬件；修改选项、出错或点「新对话」会重新开始。</div>}
        {turns.map((turn) => (
          <div key={turn.id} className="turn">
            <div className="user-msg">{turn.task}</div>
            {turn.items.map((item, i) => (
              item.kind === "text"
                ? <div key={i} className="agent-answer">{item.text}</div>
                : <div key={i} className={`mono ${item.ok === false ? "err" : "muted"}`}>{item.text}</div>
            ))}
            {!turn.running && turn.output && !turn.items.some((i) => i.kind === "text") && <div className="agent-answer">{turn.output}</div>}
            {turn.running && <div className="warn">思考中…</div>}
            <Failure error={turn.error} />
            {turn.usage && <div className="muted">请求 {turn.usage.requests ?? "?"} 次 · 工具 {turn.usage.tool_calls ?? "?"} 次</div>}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="row composer">
        <textarea rows={2} value={task} onChange={(e) => setTask(e.target.value)} placeholder={blocked ? "结束机器人会话后才能使用智能体" : "自然语言任务（Ctrl+Enter 发送）"}
          disabled={blocked} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
        {running
          ? <button className="danger" onClick={stop}>停止</button>
          : <button className="primary" disabled={!robot || !task.trim() || blocked} onClick={() => void send()}>发送</button>}
      </div>
    </div>
  );
}

export type LogEntry =
  | { at: number; kind: "cli"; request: PymybotRequest; result: RunResult }
  | { at: number; kind: "serve"; request: ServeRequest; result: ServeResult; durationMs: number };

export function LogPanel({ entries, serveLog, onClear }: { entries: LogEntry[]; serveLog: string; onClear(): void }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button onClick={onClear}>清空</button>
        <span className="muted">每次 pymybot 调用的命令行或 serve 请求、退出码、stderr 与 JSON。</span>
      </div>
      {serveLog && (
        <details className="frame" style={{ marginBottom: 4 }}>
          <summary className="muted">pymybot serve 进程 stderr</summary>
          <pre className="stream">{serveLog}</pre>
        </details>
      )}
      {[...entries].reverse().map((entry, i) => {
        const key = entries.length - i;
        if (entry.kind === "serve") {
          const failure = serveError(entry.result);
          return (
            <details key={key} className="frame" style={{ marginBottom: 4 }}>
              <summary>
                <span className={failure ? "err" : "ok"}>{failure ? "✗" : "✓"}</span>{" "}
                {new Date(entry.at).toLocaleTimeString()} <b>serve {entry.request.method}</b>{" "}
                <span className="muted">{entry.durationMs} ms</span>{" "}
                {failure && <span className="err">{failure.slice(0, 160)}</span>}
              </summary>
              <Json value={entry.request} />
              <Json value={extractImages(entry.result.ok ? entry.result.result : entry.result.error).stripped} />
            </details>
          );
        }
        const failure = failureText(entry.result);
        return (
          <details key={key} className="frame" style={{ marginBottom: 4 }}>
            <summary>
              <span className={failure ? "err" : "ok"}>{failure ? "✗" : "✓"}</span>{" "}
              {new Date(entry.at).toLocaleTimeString()} <b>{entry.request.command}</b>{" "}
              <span className="muted">exit={String(entry.result.exitCode)} {entry.result.durationMs} ms</span>{" "}
              {failure && <span className="err">{failure.slice(0, 160)}</span>}
            </summary>
            <pre className="muted">$ {entry.result.argv.map(quoteArg).join(" ")}</pre>
            {entry.result.stderr && <pre className="stream">{entry.result.stderr}</pre>}
            {entry.result.json && <Json value={extractImages(entry.result.json).stripped} />}
          </details>
        );
      })}
    </div>
  );
}
