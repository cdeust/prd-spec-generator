#!/usr/bin/env node
/**
 * judge.mjs — host-side executor for cross-vendor (non-Anthropic) judge
 * slots in the self-check jury's model-diversity panel.
 *
 * The pipeline is host-driven: when a spawn_subagents invocation names a
 * `model` that is not an Anthropic model, the host cannot dispatch it via
 * the Agent tool — it must call an external OpenAI-compatible API directly.
 * This script is that executor, invoked as a subprocess by the host.
 *
 * Usage:
 *   node judge.mjs --provider gemini --prompt-file /tmp/prompt.txt
 *   node judge.mjs --provider mistral --model mistral-small-latest < prompt.txt
 *   node judge.mjs --base-url https://... --model my-model --api-key sk-... --prompt-file p.txt
 *
 * Env (used when the matching flag is absent):
 *   EXTERNAL_JUDGE_BASE_URL, EXTERNAL_JUDGE_MODEL, EXTERNAL_JUDGE_API_KEY,
 *   EXTERNAL_JUDGE_TIMEOUT_MS, GEMINI_API_KEY, MISTRAL_API_KEY.
 *
 * Precondition: prompt text is either the file named by --prompt-file, or
 * stdin if --prompt-file is omitted. Prompt text is opaque to this script —
 * it is not validated as a "judge prompt" beyond being non-empty.
 * Postcondition: prints exactly one JSON object to stdout, one of:
 *   {status:"ok", verdict:{...}, model, provider, latency_ms}
 *   {status:"skipped", reason}
 *   {status:"error", reason}
 * and exits 0 in all three cases — "skipped"/"error" are expected, callable
 * outcomes, not process failures (a missing API key is not a bug). The one
 * exception is a CLI usage error (bad flags, unreadable prompt file), which
 * exits 2 and prints to stderr, never stdout.
 *
 * Invariant: the API key is never printed, in --debug output or otherwise
 * (see lib/redact.mjs — every debug object routes through it).
 */

import { readFileSync } from "node:fs";
import { resolveConfig } from "./lib/config.mjs";
import { runJudge } from "./lib/judge-core.mjs";
import { redact } from "./lib/redact.mjs";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  let promptText;
  if (flags.promptFile) {
    try {
      promptText = readFileSync(flags.promptFile, "utf8");
    } catch (err) {
      process.stderr.write(
        `judge.mjs: cannot read --prompt-file ${flags.promptFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  } else {
    promptText = await readStdin();
  }

  if (!promptText || !promptText.trim()) {
    process.stderr.write("judge.mjs: empty prompt (no --prompt-file content and empty stdin)\n");
    process.exit(2);
  }

  const config = resolveConfig(flags, process.env);

  if (flags.debug === "true") {
    process.stderr.write(`judge.mjs debug config: ${JSON.stringify(redact({ ...config, apiKey: config.apiKey ? "set" : "" }))}\n`);
  }

  const result = await runJudge(config, promptText);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((err) => {
  process.stderr.write(`judge.mjs: unexpected failure: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
