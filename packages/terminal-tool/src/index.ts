import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";

export interface TerminalRunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  workspaceRoot: string;
  blockedPatterns?: RegExp[];
}

export interface TerminalRunResult {
  command: string;
  cwd: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  blocked_reason?: string;
}

const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|\/)/,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/,
  /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/,
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|disk)/,
  /\bmkfs\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  /\bshutdown\b/,
  /\breboot\b/,
];

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export class TerminalToolError extends Error {
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = "TerminalToolError";
    this.blocked = blocked;
  }
}

function assertWithinRoot(workspaceRoot: string, cwd: string) {
  const absRoot = resolve(workspaceRoot);
  const absCwd = resolve(cwd);
  if (absCwd !== absRoot) {
    const rel = relative(absRoot, absCwd);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new TerminalToolError(`cwd escapes workspace root: ${absCwd}`, true);
    }
  }
}

function findBlockedPattern(command: string, patterns: RegExp[]) {
  for (const pattern of patterns) if (pattern.test(command)) return pattern;
  return null;
}

export async function runTerminal(options: TerminalRunOptions): Promise<TerminalRunResult> {
  const command = options.command.trim();
  if (!command) {
    throw new TerminalToolError("empty command", true);
  }
  assertWithinRoot(options.workspaceRoot, options.cwd);
  const blocked = findBlockedPattern(command, options.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS);
  if (blocked) {
    return {
      command,
      cwd: options.cwd,
      exit_code: -1,
      duration_ms: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      blocked_reason: `command matched blocked pattern: ${blocked.source}`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise<TerminalRunResult>((resolvePromise) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const appendStdout = (chunk: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
      }
    };
    const appendStderr = (chunk: Buffer) => {
      if (stderr.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
      }
    };

    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", appendStderr);

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolvePromise({
        command,
        cwd: options.cwd,
        exit_code: 124,
        duration_ms: Date.now() - started,
        stdout,
        stderr: stderr + `\n[terminal-tool] command exceeded timeout of ${timeoutMs}ms`,
        truncated,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        command,
        cwd: options.cwd,
        exit_code: -1,
        duration_ms: Date.now() - started,
        stdout,
        stderr: stderr + `\n[terminal-tool] spawn error: ${err.message}`,
        truncated,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        command,
        cwd: options.cwd,
        exit_code: typeof code === "number" ? code : -1,
        duration_ms: Date.now() - started,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

export const terminalToolSchema = {
  name: "bash",
  description: "Execute a shell command scoped to the active worktree. cwd must be within workspace_root.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command to execute" },
      cwd: { type: "string", description: "absolute path (must be within workspace_root)" },
      timeout_ms: { type: "number", description: "optional timeout in milliseconds (default 30000)" },
    },
    required: ["command", "cwd"],
  },
} as const;
