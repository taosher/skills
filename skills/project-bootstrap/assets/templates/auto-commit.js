import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";

const INTERNAL_TITLE = "[auto-commit hook] commit message generator";
const DIFF_BUDGET = 12000;
const PROMPT_TIMEOUT_MS = 120000;
const IDLE_DEBOUNCE_MS = 1000;
// The server can load the same plugin for multiple locations. Keep locks on
// globalThis so those instances dedupe the same idle event.
const SHARED_STATE = Symbol.for("oc.auto-commit.state");

function shared() {
  let state = globalThis[SHARED_STATE];
  if (!state || typeof state !== "object") {
    state = {};
    globalThis[SHARED_STATE] = state;
  }
  // Hot reload keeps globalThis alive across module versions, so migrate the
  // shape instead of assuming a fresh process.
  if (!(state.busyRepos instanceof Set)) state.busyRepos = new Set();
  if (!(state.internalSessions instanceof Set)) state.internalSessions = new Set();
  if (!(state.lastHandled instanceof Map)) state.lastHandled = new Map();
  return state;
}

function log(message) {
  console.error(`[auto-commit] ${message}`);
}

function debug(message) {
  if (process.env.OC_AUTO_COMMIT_DEBUG === "1") log(message);
}

function sameProject(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(a.canonical && b.canonical && a.canonical === b.canonical);
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null || error === undefined
            ? 0
            : typeof error.code === "number"
              ? error.code
              : 1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function sanitizeSubject(value) {
  return value
    .split("\n")[0]
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .trim()
    .slice(0, 100);
}

function extractMessage(text) {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*"subject"[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.subject === "string" && parsed.subject.trim()) {
        return {
          subject: sanitizeSubject(parsed.subject),
          body: String(parsed.body ?? "").trim(),
        };
      }
    } catch {
      // fall through to prose parsing
    }
  }

  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const subject = sanitizeSubject(
    lines[0].replace(/^\{?"subject"\s*:\s*"?/, "").replace(/"?,?\}?$/, ""),
  );
  if (!subject) return null;
  return {
    subject,
    body: lines
      .slice(1)
      .join("\n")
      .replace(/[{}"]/g, "")
      .trim()
      .slice(0, 2000),
  };
}

function fallbackMessage(fileCount, stat) {
  return {
    subject: "chore: sync working tree changes",
    body: [
      `- ${fileCount} file(s) changed; LLM summary unavailable (generation failed).`,
      `- Stat: ${stat || "n/a"}`,
    ].join("\n"),
  };
}

async function generateCommitMessage(ctx, diff, files, target) {
  const created = await ctx.session.create({
    title: INTERNAL_TITLE,
    location: { directory: target },
  });
  const helperId = created?.id;
  if (!helperId) throw new Error("failed to create helper session");
  shared().internalSessions.add(helperId);

  try {
    const prompt = [
      "You are a commit message generator. Write a commit message for the changes below.",
      "Rules:",
      "- English only.",
      "- Conventional commits: type must be one of feat, fix, docs, refactor, test, chore, perf, ci, build.",
      "- Subject: imperative mood, max 72 characters, no trailing period.",
      "- Body: bullet list of what changed and why, one bullet per area.",
      "- Base the message ONLY on the diff below; do not invent changes.",
      '- Reply with ONLY a JSON object {"subject": "...", "body": "..."}, no prose, no code fences.',
      "",
      "Changed files:",
      ...files.map((file) => `- ${file}`),
      "",
      "Diff (may be truncated):",
      diff,
    ].join("\n");

    const result = await ctx.session.generate({ sessionID: helperId, prompt });
    return extractMessage(result?.text ?? result?.data?.text ?? "");
  } finally {
    try {
      await ctx.session.remove({ sessionID: helperId });
    } catch {
      // Helper session cleanup must not hide the commit result.
    }
  }
}

function eventLocationDirectory(event) {
  return event?.location?.directory ?? event?.properties?.location?.directory ?? null;
}

function absoluteGitPath(base, value) {
  if (!value) return null;
  return isAbsolute(value) ? value : resolvePath(base, value);
}

async function commitIfNeeded(ctx, event) {
  const sessionID = event?.data?.sessionID ?? event?.properties?.sessionID ?? null;
  const state = shared();
  if (sessionID && state.internalSessions.has(sessionID)) return;

  let sessionDirectory = eventLocationDirectory(event) ?? ctx.location.directory;
  let sessionProject = null;
  if (sessionID) {
    try {
      const info = await ctx.session.get({ sessionID });
      sessionDirectory = info?.location?.directory ?? sessionDirectory;
      sessionProject = info?.location?.project ?? null;
    } catch {
      // The session may already be gone; there is nothing to commit.
      return;
    }
  }

  // The event stream is server-wide. Ignore sessions from other projects
  // before touching their working tree.
  if (sessionProject && ctx.location.project && !sameProject(sessionProject, ctx.location.project)) {
    return;
  }

  const now = Date.now();
  if (sessionID) {
    const last = state.lastHandled.get(sessionID) ?? 0;
    if (now - last < IDLE_DEBOUNCE_MS) return;
  }

  let target = null;
  try {
    const inside = (await git(sessionDirectory, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
    if (inside !== "true") {
      debug(`skip: ${sessionDirectory} is not inside a git work tree`);
      return;
    }

    target = (await git(sessionDirectory, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (!target) {
      debug(`skip: cannot resolve work tree root for ${sessionDirectory}`);
      return;
    }

    const targetCommon = absoluteGitPath(
      target,
      (await git(target, ["rev-parse", "--git-common-dir"])).stdout.trim(),
    );
    const baseCommon = absoluteGitPath(
      ctx.location.directory,
      (await git(ctx.location.directory, ["rev-parse", "--git-common-dir"])).stdout.trim(),
    );
    if (targetCommon && baseCommon && targetCommon !== baseCommon) {
      debug(`skip: ${target} belongs to a different repository`);
      return;
    }

    if (state.busyRepos?.has(target)) {
      debug(`skip: ${target} is already being committed`);
      return;
    }
    if (sessionID) state.lastHandled.set(sessionID, now);
    state.busyRepos.add(target);

    debug(`target: ${target}`);
    await git(target, ["add", "-A"]);
    const files = (await git(target, ["diff", "--cached", "--name-only"]))
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length === 0) {
      debug("skip: no staged changes");
      return;
    }

    let diff = (await git(target, ["diff", "--cached"])).stdout.trim();
    if (diff.length > DIFF_BUDGET) diff = `${diff.slice(0, DIFF_BUDGET)}\n... [truncated]`;
    const stat = (await git(target, ["diff", "--cached", "--shortstat"])).stdout.trim();

    let message = null;
    try {
      message = await Promise.race([
        generateCommitMessage(ctx, diff, files, target),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("commit message timeout")), PROMPT_TIMEOUT_MS),
        ),
      ]);
      if (message) debug(`message generated: ${message.subject}`);
      else debug("prompt returned no usable text, using fallback");
    } catch (error) {
      log(`LLM message generation failed, using fallback: ${String(error)}`);
    }

    const finalMessage = message ?? fallbackMessage(files.length, stat);
    const footer = "Generated by opencode auto-commit hook; commit only, no push.";
    const body = finalMessage.body ? `${finalMessage.body}\n\n${footer}` : footer;
    const commit = await git(target, [
      "commit",
      "-m",
      finalMessage.subject,
      "-m",
      body,
    ]);
    if (commit.code !== 0) {
      log(`git commit failed (exit ${commit.code}): ${commit.stderr.trim().slice(0, 500)}`);
    } else {
      log(`committed ${files.length} file(s): ${finalMessage.subject}`);
    }
  } catch (error) {
    log(`flow failed: ${String(error)}`);
  } finally {
    if (target) state.busyRepos?.delete(target);
  }
}

export default Plugin.define({
  id: "oc.auto-commit",
  setup(ctx) {
    debug(`hook loaded (directory=${ctx.location.directory})`);
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.idle"],
        signal: controller.signal,
      })) {
        try {
          await commitIfNeeded(ctx, event);
        } catch (error) {
          // One bad event must not kill the subscription for the process.
          log(`event handling failed: ${String(error)}`);
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) log(`event subscription failed: ${String(error)}`);
    });
    return () => controller.abort();
  },
});
