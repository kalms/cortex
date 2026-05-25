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
import { renderTopic } from "./commands/help.js";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "./help.js";
import { renderTour } from "./tour.js";
import { runInstall } from "./install.js";

const NAMESPACES = ["code", "decision", "graph", "index", "eval"];
const META_COMMANDS = ["tour", "help", "install"];

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

  // Meta flags
  if (argv.flags.version || argv.flags.v) {
    process.stdout.write(`cortex ${getVersion()}\n`);
    return;
  }

  // Top-level help
  if ((argv.namespace === null || argv.namespace === "help") && (argv.flags.help || argv.flags.h || argv.namespace === null)) {
    process.stdout.write(renderTopLevelHelp() + "\n");
    return;
  }

  // Meta commands
  if (argv.namespace === "tour") {
    const ctx = loadContext(process.cwd());
    process.stdout.write(renderTour(ctx) + "\n");
    return;
  }
  if (argv.namespace === "help") {
    const topic = argv.command;
    if (!topic) {
      process.stdout.write(renderTopLevelHelp() + "\n");
      return;
    }
    process.stdout.write(renderTopic(topic) + "\n");
    return;
  }
  if (argv.namespace === "install") {
    runInstall({ quiet: argv.flags.quiet === true, uninstall: argv.flags.uninstall === true });
    return;
  }

  // Per-namespace --help
  if (argv.namespace && NAMESPACES.includes(argv.namespace)) {
    if (argv.flags.help || argv.flags.h) {
      if (argv.command) {
        process.stdout.write(renderCommandHelp(argv.namespace, argv.command) + "\n");
      } else {
        process.stdout.write(renderNamespaceHelp(argv.namespace) + "\n");
      }
      return;
    }
  }

  if (!argv.namespace) {
    process.stdout.write(renderTopLevelHelp() + "\n");
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
  }
}

tryCommand(main);
