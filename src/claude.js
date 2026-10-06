import { spawn } from "node:child_process";
import { log } from "./log.js";

function summarizeInput(input = {}) {
  const s = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? "";
  return String(s).replace(/\n/g, " ").slice(0, 110);
}

/**
 * Run `claude -p` headless and return its final result text.
 * The prompt is passed as an argv element (no shell), so message content needs no escaping.
 * With `label` set, streams live progress (tool calls + narration) to the console log;
 * without it (e.g. the classifier) the run is silent.
 */
export class CancelledError extends Error {
  constructor() {
    super("cancelled by user");
    this.name = "CancelledError";
  }
}

/**
 * System-prompt line that moves a worker into its worktree. Workers START in one shared
 * directory (config.workerSessionsDir) rather than in their worktree: the Claude desktop app
 * files an imported session under the folder it started in, so a per-worktree start gave every
 * review its own `auto-<repo>-<ts>` sidebar group. The worktree is reached through --add-dir
 * instead, and this line makes the shell go there before anything else runs.
 */
export const workdirInstruction = (workdir) =>
  `Your task's working directory is ${workdir} (an isolated git worktree of the repository). ` +
  `Your FIRST tool call must be the Bash command: cd ${workdir} — every file path, search, git, gh and test command ` +
  `for this task runs there, never in the directory this session started in.`;

export function runClaude({ bin, prompt, cwd, timeoutMs, model, extraArgs = [], label, signal, sessionId, resumeSessionId, name, workdir }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...extraArgs];
  if (model) args.push("--model", model);
  let env = process.env;
  if (workdir) {
    // --add-dir is variadic: it must be followed by another flag, never by a positional value.
    args.push("--add-dir", workdir, "--append-system-prompt", workdirInstruction(workdir));
    // The repo's CLAUDE.md lives in the worktree, which is now an added dir, not the cwd.
    env = { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
  }
  // resumeSessionId continues an EARLIER worker session (must run from that session's cwd) —
  // used by review follow-ups so the worker keeps the context of its own prior review.
  // Otherwise a caller-chosen session id makes the headless run resumable afterwards:
  // `claude --resume <sessionId>` (from the same cwd) reopens it interactively.
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else if (sessionId) {
    args.push("--session-id", sessionId);
    // `--name` is the session's display title: the CLI records it in the transcript and the
    // Claude desktop app shows it when the session is imported (showInDesktopApp). Without it
    // an imported worker session is a blank row that only its worktree folder name identifies.
    // New sessions only — a resumed session keeps the title it already has.
    if (name) args.push("--name", name);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let result = null;
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (signal) {
      const onAbort = () => {
        cancelled = true;
        child.kill("SIGKILL");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleEvent = (event) => {
      if (event.type === "result") {
        // The result event is final — settle NOW instead of waiting for process
        // close, which can lag minutes if the worker left children holding the pipe.
        clearTimeout(timer);
        child.kill();
        if (event.is_error || event.subtype !== "success") {
          // e.g. inaccessible model, auth failure — surface as a real error, not a parseable result.
          const reason = event.subtype && event.subtype !== "success" ? event.subtype : "error";
          return reject(new Error(`claude failed (${reason}): ${(event.result ?? "").slice(0, 300)}`));
        }
        result = event.result ?? "";
        resolve(result);
        return;
      }
      if (!label || event.type !== "assistant") return;
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          log(`[${label}] ⏺ ${block.name}: ${summarizeInput(block.input)}`);
        } else if (block.type === "text" && block.text?.trim()) {
          log(`[${label}] 💬 ${block.text.trim().replace(/\n/g, " ").slice(0, 150)}`);
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // non-JSON noise on stdout — ignore
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${bin}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) {
        return reject(new CancelledError());
      }
      if (timedOut) {
        return reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60000)} min`));
      }
      if (code !== 0 && result === null) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(result ?? "");
    });
  });
}

/** Extract the first JSON object from model output that may contain surrounding prose/fences. */
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}
