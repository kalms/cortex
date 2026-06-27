import { NO_STYLE, type Styler } from "./style.js";

type CommandDoc = {
  usage: string;
  description: string;
  examples: string[];
  seeAlso?: string[];
};

const NAMESPACES: Record<string, Record<string, CommandDoc>> = {
  code: {
    search: {
      usage: "cortex code search <pattern> [--limit=N] [--offset=N]",
      description:
        "Full-text search across ALL indexed files (including docs/Markdown), " +
        "each hit annotated with its enclosing symbol and ranked code-first. " +
        "For symbols by name — and for --kind filtering — use 'cortex code find'.",
      examples: [
        "cortex code search ribbon",
        "cortex code search 'parseBody'",
      ],
      seeAlso: ["cortex code find", "cortex code show"],
    },
    find: {
      usage: "cortex code find <name> [--kind=a,b | --kinds=a,b] [--limit=N] [--offset=N]",
      description:
        "Find a symbol by name, ranked by relevance (kind priority × name match). " +
        "Doc/plan sections are excluded by default (a stderr note reports how many " +
        "and how to opt in); --kind/--kinds narrows to an explicit kind list.",
      examples: [
        "cortex code find handleRequest",
        "cortex code find 'use%' --kind=function",
        "cortex code find serve --kind=function,route --limit=10",
        "cortex code find lifecycle --kind=section",
      ],
      seeAlso: ["cortex code show", "cortex code search"],
    },
    show: {
      usage: "cortex code show <input>",
      description: "Show source for a symbol. <input> can be a file path, a qualified name, or a bare name.",
      examples: [
        "cortex code show apps/components/Card.vue",
        "cortex code show 'src/api.ts::handleRequest'",
      ],
      seeAlso: ["cortex code where", "cortex code calls"],
    },
    where: {
      usage: "cortex code where <input>",
      description: "Find what calls a symbol.",
      examples: ["cortex code where handleRequest"],
      seeAlso: ["cortex code calls"],
    },
    calls: {
      usage: "cortex code calls <input>",
      description: "Find what a symbol calls.",
      examples: ["cortex code calls handleRequest"],
      seeAlso: ["cortex code where"],
    },
    arch: {
      usage: "cortex code arch [--aspects=structure,dependencies,routes,all]",
      description: "Get architectural overview.",
      examples: ["cortex code arch", "cortex code arch --aspects=routes"],
    },
    schema: {
      usage: "cortex code schema",
      description: "List node labels and edge types with counts.",
      examples: ["cortex code schema"],
    },
  },
  decision: {
    candidates: { usage: "cortex decision candidates [--max=N]",        description: "Frame decision candidates from git history + docs (machine manifest; no writes). Optional --max=N to cap.", examples: ["cortex decision candidates", "cortex decision candidates --max=20"] },
    count:      { usage: "cortex decision count",                        description: "Print the number of decisions in this repo (cold-start probe used by hooks).", examples: ["cortex decision count"] },
    create:  { usage: "cortex decision create --title=... --description=... --rationale=...", description: "Create a new decision.", examples: ["cortex decision create --title='use Postgres' --description=... --rationale=..."] },
    delete:  { usage: "cortex decision delete <id>",                description: "Delete a decision.", examples: ["cortex decision delete abc-123"] },
    link:    { usage: "cortex decision link <id> <target> [--relation=GOVERNS]", description: "Link a decision to a file or symbol.", examples: ["cortex decision link abc-123 src/auth.ts"] },
    list:    { usage: "cortex decision list [--query=...]",   description: "List or search decisions.", examples: ["cortex decision list", "cortex decision list --query='auth'"] },
    propose: { usage: "cortex decision propose --title=... --problem=... --resolution=... --rationale=...", description: "Propose a decision (status=proposed).", examples: ["cortex decision propose --title=... ..."] },
    rehome:  { usage: "cortex decision rehome <id> --to=<repo_path> [--dry-run]", description: "Move a decision (row + links) to another repo's .cortex/decisions.db.", examples: ["cortex decision rehome abc-123 --to=/Users/rka/Development/anthill-cloud-sales"] },
    show:    { usage: "cortex decision show <id>",            description: "Show a decision by id.", examples: ["cortex decision show abc-123"] },
    supersede: { usage: "cortex decision supersede <old-id> --title=... --problem=... --resolution=... --rationale=...", description: "Atomically supersede an existing decision.", examples: ["cortex decision supersede abc-123 ..."] },
    update:  { usage: "cortex decision update <id> --field=value",  description: "Update fields on an existing decision.", examples: ["cortex decision update abc-123 --rationale='updated'"] },
    why:     { usage: "cortex decision why <input>",          description: "Show decisions governing a file or symbol.", examples: ["cortex decision why src/api.ts"] },
  },
  graph: {
    query: { usage: "cortex graph query '<cypher>'", description: "Run a Cypher query against the graph.", examples: ["cortex graph query 'MATCH (f:function) RETURN count(f)'"] },
    sql:   { usage: "cortex graph sql '<sql>'",       description: "Run raw SQL against the graph.db (escape hatch when Cypher misbehaves).", examples: ["cortex graph sql 'SELECT kind, COUNT(*) FROM nodes GROUP BY kind'"] },
  },
  index: {
    status:  { usage: "cortex index status",                 description: "Show index state for the current project.", examples: ["cortex index status"] },
    changes: { usage: "cortex index changes",                description: "List files changed since last index.", examples: ["cortex index changes"] },
    list:    { usage: "cortex index list",                   description: "List all indexed projects.", examples: ["cortex index list"] },
    delete:  { usage: "cortex index delete <project>",       description: "Delete an indexed project.", examples: ["cortex index delete some-project"] },
  },
  eval: {
    run:      { usage: "cortex eval [<target>] [--path=...]",       description: "Run the eval harness against all targets, or one.", examples: ["cortex eval", "cortex eval anthill-cloud --path=/Users/rka/Development/anthill-cloud"] },
    baseline: { usage: "cortex eval baseline <target> [--path=...]", description: "Capture the baseline for a target.", examples: ["cortex eval baseline anthill-cloud --path=..."] },
    report:   { usage: "cortex eval report [--latest|--at=<timestamp>]", description: "Print the latest (or specified) eval summary.", examples: ["cortex eval report"] },
  },
  todo: {
    list:       { usage: "cortex todo list [--query=…]",                              description: "List or search todos.", examples: ["cortex todo list", "cortex todo list --query='viewer'"] },
    show:       { usage: "cortex todo show <id>",                                     description: "Show a todo (with links) by id.", examples: ["cortex todo show T-12"] },
    search:     { usage: "cortex todo search <query>",                                description: "Full-text search todos.", examples: ["cortex todo search drawer"] },
    propose:    { usage: "cortex todo propose [<summary>] [--description=…] [--governs=a,b] [--spawns-from=…] [--blocked-by=a,b]", description: "Create a todo. With no summary, opens $EDITOR for summary + description.", examples: ["cortex todo propose", "cortex todo propose 'Fix drawer' --governs=src/x.ts"] },
    update:     { usage: "cortex todo update <id> [--summary=…] [--description=…] [--assignee=…] [--governs=a,b]", description: "Update a todo. With no field flags, opens $EDITOR pre-filled.", examples: ["cortex todo update T-12 --assignee=rka"] },
    transition: { usage: "cortex todo transition <id> <state> [--reason=…] [--resolved-by=a,b] [--blocked-by=a,b]", description: "Move a todo between states (open|in_progress|blocked|done|cancelled).", examples: ["cortex todo transition T-12 in_progress", "cortex todo transition T-12 done --resolved-by=#42"] },
    link:       { usage: "cortex todo link <id> <target> [--relation=GOVERNS]",       description: "Link a todo to a file, symbol, decision, PR, or another todo.", examples: ["cortex todo link T-12 src/x.ts", "cortex todo link T-12 D-0j21 --relation=SPAWNS_FROM"] },
  },
};

export function renderTopLevelHelp(styler: Styler = NO_STYLE): string {
  const h = (s: string) => styler.bold(s);
  const name = (s: string) => styler.cyan(s);
  const ex = (s: string) => styler.green(s);
  const lines = [
    "cortex — knowledge graph for your codebase, on the command line",
    "",
    h("Usage:"),
    "  cortex <namespace> <command> [args] [--flags]",
    "",
    h("Namespaces:"),
    `  ${name("code".padEnd(10))}  Search, view, and trace code in indexed projects`,
    `  ${name("decision".padEnd(10))}  Architectural decisions and provenance`,
    `  ${name("graph".padEnd(10))}  Raw Cypher / SQL queries (advanced)`,
    `  ${name("index".padEnd(10))}  Manage which projects are indexed`,
    `  ${name("eval".padEnd(10))}  Run the eval harness`,
    `  ${name("todo".padEnd(10))}  Planned work — tasks and their lifecycle`,
    "",
    h("Common commands:"),
    `  ${ex("cortex code find <name>")}     find a symbol by name`,
    `  ${ex("cortex code show <input>")}    show source for a symbol or file`,
    `  ${ex("cortex code where <input>")}   find what calls a symbol`,
    `  ${ex("cortex decision why <input>")} show governing decisions`,
    `  ${ex("cortex eval")}                 run the eval harness`,
    "",
    h("Meta:"),
    `  ${ex("cortex tour")}                 60-second guided walkthrough`,
    `  ${ex("cortex help <topic>")}         concept-level help (qualified-names, projects, …)`,
    `  ${ex("cortex install")}              add cortex to PATH`,
    "",
    "  --version                   print version",
    "  --help                      show help for any command",
  ];
  return lines.join("\n");
}

export function renderNamespaceHelp(namespace: string, styler: Styler = NO_STYLE): string {
  const cmds = NAMESPACES[namespace];
  if (!cmds) return `unknown namespace '${namespace}'`;
  const lines = [`cortex ${namespace} — ${describeNamespace(namespace)}`, "", styler.bold("Commands:")];
  for (const [cmdName, doc] of Object.entries(cmds)) {
    lines.push(`  ${styler.cyan(cmdName.padEnd(12))}${doc.description}`);
  }
  lines.push("", `Run \`cortex ${namespace} <command> --help\` for details on any command.`);
  return lines.join("\n");
}

export function renderCommandHelp(namespace: string, command: string, styler: Styler = NO_STYLE): string {
  const doc = NAMESPACES[namespace]?.[command];
  if (!doc) return `unknown command 'cortex ${namespace} ${command}'`;
  const lines = [
    `cortex ${namespace} ${command} — ${doc.description}`,
    "",
    styler.bold("Usage:"),
    `  ${doc.usage}`,
    "",
    styler.bold("Examples:"),
    ...doc.examples.map((e) => `  ${styler.green(e)}`),
  ];
  if (doc.seeAlso?.length) {
    lines.push("", styler.bold("See also:"));
    for (const ref of doc.seeAlso) lines.push(`  ${styler.cyan(ref)}`);
  }
  return lines.join("\n");
}

function describeNamespace(ns: string): string {
  return ({
    code: "Search, view, and trace code in indexed projects",
    decision: "Architectural decisions and provenance",
    graph: "Raw Cypher / SQL queries (advanced)",
    index: "Manage which projects are indexed",
    eval: "Run the eval harness",
    todo: "Planned work — tasks and their lifecycle",
  })[ns] ?? "";
}
