import { useMemo, useState } from "react";
import type { PymybotRequest, RunResult, Settings } from "../../shared/types";
import { extractImages, failureText, numericSeries, quoteArg } from "../util";
import { Chart } from "./Chart";

export type Exec = (request: PymybotRequest, onStderr?: (chunk: string) => void) => Promise<RunResult>;

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

function Failure({ result }: { result: RunResult }) {
  const text = failureText(result);
  return text ? <div className="err">✗ {text}</div> : null;
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
  result: RunResult | null;
}

export function OutputPanel({ state }: { state: RunState }) {
  const outputs = state.result?.json?.ok ? (state.result.json.outputs as unknown[]) : null;
  const stripped = useMemo(() => (outputs ? (extractImages(outputs).stripped as unknown[]) : null), [outputs]);
  if (!state.running && !state.result) return <div className="muted">选择结构和动作脚本后点击「运行」。默认只允许虚拟总线、串口回环和图片文件。</div>;
  return (
    <div className="frames">
      {state.running && <div className="warn">运行中…（可点「停止」协作式中断）</div>}
      {state.result && <Failure result={state.result} />}
      {state.result?.json?.ok && <div className="ok">✓ 完成，{state.result.durationMs} ms，{outputs?.length ?? 0} 个输出</div>}
      {stripped?.map((frame, i) => (
        <div key={i} className="frame">
          <div className="muted">#{i + 1}</div>
          <Json value={frame} />
          <Images value={outputs![i]} />
        </div>
      ))}
      {state.live && (
        <details open={state.running || (state.result !== null && failureText(state.result) !== null)}>
          <summary className="muted">stderr</summary>
          <pre className="stream">{state.live}</pre>
        </details>
      )}
    </div>
  );
}

export function HardwarePanel({ items, error, onRefresh }: { items: HardwareItem[]; error: string | null; onRefresh(): void }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button onClick={onRefresh}>刷新</button>
        <span className="muted">来自 hardware 命令，不激活驱动。</span>
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

export function QueryPanel({ robot, exec, allowHardware }: { robot: string; exec: Exec; allowHardware: boolean }) {
  const [sql, setSql] = useState("SHOW TABLES;");
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (command: "query" | "apply-sql") => {
    setBusy(true);
    try {
      setResult(await exec(command === "query" ? { command, robot, sql } : { command, robot, sql, allowHardware }));
    } finally {
      setBusy(false);
    }
  };
  const output = result?.json?.ok ? result.json.output : null;
  return (
    <div className="panel-body fill" style={{ padding: 0 }}>
      <textarea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
      <div className="row">
        <button className="primary" disabled={!robot || busy} onClick={() => go("query")}>查询（query）</button>
        <button disabled={!robot || busy} onClick={() => go("apply-sql")} title="激活临时会话并应用 SQL，不改磁盘文件">应用到临时会话（apply-sql）</button>
        <span className="muted">每条语句都必须以 ; 结尾。query 只接受 SHOW TABLES 和 SELECT *。</span>
      </div>
      {result && <Failure result={result} />}
      {typeof output === "string" ? <pre>{output}</pre> : output !== null && output !== undefined && <Json value={output} />}
    </div>
  );
}

export function SamplePanel({ robot, exec, hardware, allowHardware, visible }: {
  robot: string; exec: Exec; hardware: HardwareItem[]; allowHardware: boolean; visible: boolean;
}) {
  const [name, setName] = useState("");
  const [count, setCount] = useState(50);
  const [intervalMs, setIntervalMs] = useState(50);
  const [timeout, setTimeoutSec] = useState(30);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);
  const target = hardware.some((h) => h.name === name) ? name : hardware[0]?.name ?? "";
  const samples = useMemo(() => (result?.json?.ok ? (result.json.samples as unknown[]) : []), [result]);
  const series = useMemo(() => numericSeries(samples), [samples]);
  const labels = useMemo(() => samples.map((_, i) => String(i + 1)), [samples]);
  const go = async () => {
    setBusy(true);
    try {
      setResult(await exec({ command: "sample", robot, name: target, count, intervalMs, timeout, allowHardware }));
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
        <label>次数 <input type="number" min={1} max={1000} value={count} style={{ width: 70 }} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <label>间隔 ms <input type="number" min={0} max={60000} value={intervalMs} style={{ width: 80 }} onChange={(e) => setIntervalMs(Number(e.target.value))} /></label>
        <label>超时 s <input type="number" min={1} max={3600} value={timeout} style={{ width: 70 }} onChange={(e) => setTimeoutSec(Number(e.target.value))} /></label>
        <button className="primary" disabled={!robot || !target || busy} onClick={go}>{busy ? "采样中…" : "采样"}</button>
        <label><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />原始 JSON</label>
        <span className="muted">一次激活、采完后整体返回；激活本身可能写硬件。</span>
      </div>
      {result && <Failure result={result} />}
      {raw ? <Json value={samples} /> : <Chart series={series} xLabels={labels} visible={visible && !raw} />}
    </div>
  );
}

interface ToolEvent {
  name?: string;
  status?: string;
}

export function AgentPanel({ robot, exec, hardware, allowHardware, settings }: {
  robot: string; exec: Exec; hardware: HardwareItem[]; allowHardware: boolean; settings: Settings | null;
}) {
  const [task, setTask] = useState("列出硬件和可用动作脚本");
  const [allowActions, setAllowActions] = useState(false);
  const [readVars, setReadVars] = useState<string[]>([]);
  const [cameraVars, setCameraVars] = useState<string[]>([]);
  const [timeout, setTimeoutSec] = useState(180);
  const [maxRequests, setMaxRequests] = useState(8);
  const [maxToolCalls, setMaxToolCalls] = useState(16);
  const [live, setLive] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const cameras = hardware.filter((h) => h.type === "Camera");
  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const go = async () => {
    setBusy(true);
    setLive("");
    setResult(null);
    try {
      setResult(await exec(
        { command: "agent", robot, task, timeout, allowHardware, allowActions, readVars, cameraVars, maxRequests, maxToolCalls },
        (chunk) => setLive((prev) => (prev + chunk).slice(-200000)),
      ));
    } finally {
      setBusy(false);
    }
  };
  const json = result?.json;
  const events = (json && Array.isArray(json.tool_events) ? json.tool_events : []) as ToolEvent[];
  return (
    <div className="panel-body fill" style={{ padding: 0 }}>
      <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="自然语言任务" />
      <div className="row">
        <button className="primary" disabled={!robot || !task.trim() || busy} onClick={go}>{busy ? "执行中…" : "发送任务"}</button>
        <label title="不勾选时，执行脚本/读取/拍照在无终端环境下都会被拒绝">
          <input type="checkbox" checked={allowActions} onChange={(e) => setAllowActions(e.target.checked)} />预授权动作 --allow-actions
        </label>
        <label>超时 s <input type="number" value={timeout} min={1} max={3600} style={{ width: 70 }} onChange={(e) => setTimeoutSec(Number(e.target.value))} /></label>
        <label>请求上限 <input type="number" value={maxRequests} min={1} max={100} style={{ width: 60 }} onChange={(e) => setMaxRequests(Number(e.target.value))} /></label>
        <label>工具上限 <input type="number" value={maxToolCalls} min={1} max={1000} style={{ width: 60 }} onChange={(e) => setMaxToolCalls(Number(e.target.value))} /></label>
        <span className="muted">模型：{settings?.model || "MYBOT_MODEL 环境变量"}</span>
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
      {live && <pre className="stream">{live}</pre>}
      {result && <Failure result={result} />}
      {json?.ok && typeof json.output === "string" && <div className="agent-answer">{json.output}</div>}
      {!!events.length && <div className="muted">工具调用：{events.map((e) => `${e.name}:${e.status}`).join("  ")}</div>}
    </div>
  );
}

export interface LogEntry {
  at: number;
  request: PymybotRequest;
  result: RunResult;
}

export function LogPanel({ entries, onClear }: { entries: LogEntry[]; onClear(): void }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button onClick={onClear}>清空</button>
        <span className="muted">每次 pymybot 调用的命令行、退出码、stderr 与 JSON。</span>
      </div>
      {[...entries].reverse().map((entry, i) => {
        const failure = failureText(entry.result);
        return (
          <details key={entries.length - i} className="frame" style={{ marginBottom: 4 }}>
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
