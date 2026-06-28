#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgv, findSuggestion } from "./router.js";
import { loadContext } from "./context.js";
import { tryCommand, UsageError } from "./errors.js";
import { runCodeCommand } from "./commands/code.js";
import { runDecisionCommand } from "./commands/decision.js";
import { runGraphCommand } from "./commands/graph.js";
import { runIndexCommand } from "./commands/index.js";
import { runEvalCommand } from "./commands/eval.js";
import { runTodoCommand } from "./commands/todo.js";
import { renderTopic } from "./commands/help.js";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "./help.js";
import { renderTour } from "./tour.js";
import { runInstall } from "./install.js";
import { configureColor, makeStyler, type ColorPref } from "./style.js";
import { setupVenv } from "../frame-extraction/venv.js";
import { runFreshnessCommand } from "./commands/freshness.js";
import { runReconcileCommand } from "./commands/reconcile.js";
import { runBriefCommand } from "./commands/brief.js";

const NAMESPACES = ["code", "decision", "graph", "index", "eval", "todo"];
const META_COMMANDS = ["tour", "help", "install", "setup", "freshness", "reconcile", "brief"];

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(1)); // strip node arg too; arg 0 is the tsx/script

  const colorPref: ColorPref =
    argv.flags["no-color"] === true ? "never"
    : argv.flags.color === "always" ? "always"
    : argv.flags.color === "never" ? "never"
    : "auto";
  configureColor(colorPref);
  const out = makeStyler(process.stdout);

  // Meta flags
  if (argv.flags.version || argv.flags.v) {
    process.stdout.write(`cortex ${getVersion()}\n`);
    return;
  }

  // Top-level help
  if ((argv.namespace === null || argv.namespace === "help") && (argv.flags.help || argv.flags.h || argv.namespace === null)) {
    process.stdout.write(renderTopLevelHelp(out) + "\n");
    return;
  }

  // Meta commands
  if (argv.namespace === "tour") {
    const ctx = loadContext(process.cwd());
    process.stdout.write(renderTour(ctx) + "\n");
    return;
  }
  if (argv.namespace === "freshness") {
    const ctx = loadContext(process.cwd());
    runFreshnessCommand(ctx);
    return;
  }
  if (argv.namespace === "reconcile") {
    runReconcileCommand(argv.command);
    return;
  }
  if (argv.namespace === "brief") {
    const ctx = loadContext(process.cwd());
    runBriefCommand(ctx, argv.command ?? argv.positionals[0] ?? null, argv.flags);
    return;
  }
  if (argv.namespace === "help") {
    const topic = argv.command;
    if (!topic) {
      process.stdout.write(renderTopLevelHelp(out) + "\n");
      return;
    }
    process.stdout.write(renderTopic(topic) + "\n");
    return;
  }
  if (argv.namespace === "install") {
    runInstall({ quiet: argv.flags.quiet === true, uninstall: argv.flags.uninstall === true });
    return;
  }
  if (argv.namespace === "setup") {
    if (argv.command !== "frames") {
      throw new UsageError(
        `unknown setup target '${argv.command ?? ""}'`,
        "Run: cortex setup frames",
      );
    }
    const venv = setupVenv({ quiet: argv.flags.quiet === true });
    process.stdout.write(
      venv.status === "ok" ? "frame extraction ready.\n"
      : venv.status === "python_missing" ? "python3 not found — install it first.\n"
      : `setup failed: ${venv.reason}\n`,
    );
    return;
  }

  // Per-namespace --help
  if (argv.namespace && NAMESPACES.includes(argv.namespace)) {
    if (argv.flags.help || argv.flags.h) {
      if (argv.command) {
        process.stdout.write(renderCommandHelp(argv.namespace, argv.command, out) + "\n");
      } else {
        process.stdout.write(renderNamespaceHelp(argv.namespace, out) + "\n");
      }
      return;
    }
  }

  if (!argv.namespace) {
    process.stdout.write(renderTopLevelHelp(out) + "\n");
    return;
  }
  if (!NAMESPACES.includes(argv.namespace)) {
    const suggestion = findSuggestion(argv.namespace, [...NAMESPACES, ...META_COMMANDS]);
    throw new UsageError(
      `unknown namespace '${argv.namespace}'`,
      suggestion ? `Did you mean: cortex ${suggestion}?` : "Run: cortex --help",
    );
  }

  const ctx = loadContext(process.cwd());

  switch (argv.namespace) {
    case "code":
      return runCodeCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "decision":
      return runDecisionCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "graph":
      return runGraphCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "index":
      return runIndexCommand({ command: argv.command, positionals: argv.positionals, flags: argv.flags }, ctx);
    case "eval":
      return runEvalCommand({ command: argv.command, positionals: argv.positionals, flags: argv.flags }, ctx);
    case "todo":
      return runTodoCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
  }
}

tryCommand(main);
