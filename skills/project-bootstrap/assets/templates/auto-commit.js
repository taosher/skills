import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";

const INTERNAL_TITLE = "[auto-commit hook] commit message generator";
const DIFF_BUDGET = 12000;
const PROMPT_TIMEOUT_MS = 120000;

let busy = false;
const internalSessions = new Set();

function log(message) {
  console.error(`[auto-commit] ${message}`);
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
  internalSessions.add(helperId);

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
  if (sessionID && internalSessions.has(sessionID)) {
    internalSessions.delete(sessionID);
    return;
  }
  if (busy) {
    log("skip: previous commit flow still running");
    return;
  }

  busy = true;
  try {
    let sessionDirectory = eventLocationDirectory(event) ?? ctx.location.directory;
    if (sessionID) {
      try {
        const info = await ctx.session.get({ sessionID });
        sessionDirectory = info?.location?.directory ?? sessionDirectory;
      } catch {
        // Fall back to the event/plugin location.
      }
    }

    const inside = (await git(sessionDirectory, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
    if (inside !== "true") {
      log(`skip: ${sessionDirectory} is not inside a git work tree`);
      return;
    }

    const target = (await git(sessionDirectory, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (!target) {
      log(`skip: cannot resolve work tree root for ${sessionDirectory}`);
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
      log(`skip: ${target} belongs to a different repository`);
      return;
    }

    log(`target: ${target}`);
    await git(target, ["add", "-A"]);
    const files = (await git(target, ["diff", "--cached", "--name-only"]))
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length === 0) {
      log("skip: no staged changes");
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
      if (message) log(`message generated: ${message.subject}`);
      else log("prompt returned no usable text, using fallback");
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
    busy = false;
  }
}

export default Plugin.define({
  id: "monavi.auto-commit",
  setup(ctx) {
    log(`hook loaded (directory=${ctx.location.directory})`);
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.idle"],
        signal: controller.signal,
      })) {
        await commitIfNeeded(ctx, event);
      }
    })().catch((error) => {
      if (!controller.signal.aborted) log(`event subscription failed: ${String(error)}`);
    });
    return () => controller.abort();
  },
});
