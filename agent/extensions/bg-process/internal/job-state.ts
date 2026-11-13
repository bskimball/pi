export const STREAM_CAP = 48_000;

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface StreamBuf {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface JobState {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid?: number;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: StreamBuf;
  stderr: StreamBuf;
  killRequested: boolean;
  persistent: boolean;
  runnerPid?: number;
  runnerUnavailable?: boolean;
  /** Persistent runner: how many times output.log was truncated after reaching its cap. */
  outputLogResets?: number;
}

export function emptyStream(): StreamBuf {
  return { text: "", truncated: false, bytes: 0 };
}

export function appendStream(buf: StreamBuf, chunk: Buffer | string): void {
  const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!piece) return;
  buf.bytes += Buffer.byteLength(piece, "utf8");
  const next = buf.text + piece;
  buf.truncated ||= next.length > STREAM_CAP;
  buf.text = next.slice(-STREAM_CAP);
}
