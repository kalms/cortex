import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EVAL_CLI = resolve(process.cwd(), "evals/src/cli.ts");

export type EvalCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runEvalCommand(cmd: EvalCommand, _ctx: ProjectContext): Promise<void> {
  const subcommand = cmd.command;
  if (subcommand === null || subcommand === "run") {
    const args: string[] = [];
    if (cmd.positionals[0]) args.push(`--target=${cmd.positionals[0]}`);
    if (typeof cmd.flags.path === "string") args.push(`--path=${cmd.flags.path}`);
    execFileSync("npx", ["tsx", EVAL_CLI, ...args], { stdio: "inherit" });
    return;
  }
  if (subcommand === "baseline") {
    const target = cmd.positionals[0];
    if (!target) throw new UsageError("missing <target>", "Usage: cortex eval baseline <target> [--path=...]");
    const args = [`--capture-baseline=${target}`];
    if (typeof cmd.flags.path === "string") args.push(`--path=${cmd.flags.path}`);
    execFileSync("npx", ["tsx", EVAL_CLI, ...args], { stdio: "inherit" });
    return;
  }
  if (subcommand === "report") {
    const reportsDir = resolve(process.cwd(), "evals/reports");
    if (!existsSync(reportsDir)) throw new UsageError("no reports yet", "Run: cortex eval [target]");
    let chosen: string | undefined;
    if (cmd.flags.at && typeof cmd.flags.at === "string") chosen = join(reportsDir, cmd.flags.at);
    else {
      const dirs = readdirSync(reportsDir).filter((d) => statSync(join(reportsDir, d)).isDirectory()).sort();
      chosen = dirs.length > 0 ? join(reportsDir, dirs[dirs.length - 1]) : undefined;
    }
    if (!chosen || !existsSync(join(chosen, "summary.md"))) throw new UsageError("no matching report", "Run: cortex eval [target]");
    process.stdout.write(readFileSync(join(chosen, "summary.md"), "utf-8"));
    return;
  }
  throw new UsageError(`unknown command 'cortex eval ${subcommand}'`, "Run: cortex eval --help");
}
