type CommandDoc = {
  usage: string;
  description: string;
  examples: string[];
  seeAlso?: string[];
};

const NAMESPACES: Record<string, Record<string, CommandDoc>> = {
  code: {
    search: {
      usage: "cortex code search <pattern>",
      description: "Full-text search across indexed source.",
      examples: [
        "cortex code search ribbon",
        "cortex code search 'useFetch' --kind=function",
      ],
      seeAlso: ["cortex code find", "cortex code show"],
    },
    find: {
      usage: "cortex code find <name>",
      description: "Find a symbol by name (function, module, class).",
      examples: [
        "cortex code find handleRequest",
        "cortex code find 'use%' --kind=function",
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
    list:    { usage: "cortex decision list [--query=...]",   description: "List or search decisions.", examples: ["cortex decision list", "cortex decision list --query='auth'"] },
    show:    { usage: "cortex decision show <id>",            description: "Show a decision by id.", examples: ["cortex decision show abc-123"] },
    why:     { usage: "cortex decision why <input>",          description: "Show decisions governing a file or symbol.", examples: ["cortex decision why src/api.ts"] },
    create:  { usage: "cortex decision create --title=... --description=... --rationale=...", description: "Create a new decision.", examples: ["cortex decision create --title='use Postgres' --description=... --rationale=..."] },
    update:  { usage: "cortex decision update <id> --field=value",  description: "Update fields on an existing decision.", examples: ["cortex decision update abc-123 --rationale='updated'"] },
    delete:  { usage: "cortex decision delete <id>",                description: "Delete a decision.", examples: ["cortex decision delete abc-123"] },
    link:    { usage: "cortex decision link <id> <target> [--relation=GOVERNS]", description: "Link a decision to a file or symbol.", examples: ["cortex decision link abc-123 src/auth.ts"] },
    promote: { usage: "cortex decision promote <id>",               description: "Promote a proposed decision to active.", examples: ["cortex decision promote abc-123"] },
    propose: { usage: "cortex decision propose --title=... --problem=... --resolution=... --rationale=...", description: "Propose a decision (status=proposed).", examples: ["cortex decision propose --title=... ..."] },
    supersede: { usage: "cortex decision supersede <old-id> --title=... --problem=... --resolution=... --rationale=...", description: "Atomically supersede an existing decision.", examples: ["cortex decision supersede abc-123 ..."] },
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
};

export function renderTopLevelHelp(): string {
  const lines = [
    "cortex — knowledge graph for your codebase, on the command line",
    "",
    "Usage:",
    "  cortex <namespace> <command> [args] [--flags]",
    "",
    "Namespaces:",
    "  code        Search, view, and trace code in indexed projects",
    "  decision    Architectural decisions and provenance",
    "  graph       Raw Cypher / SQL queries (advanced)",
    "  index       Manage which projects are indexed",
    "  eval        Run the eval harness",
    "",
    "Common commands:",
    "  cortex code find <name>     find a symbol by name",
    "  cortex code show <input>    show source for a symbol or file",
    "  cortex code where <input>   find what calls a symbol",
    "  cortex decision why <input> show governing decisions",
    "  cortex eval                 run the eval harness",
    "",
    "Meta:",
    "  cortex tour                 60-second guided walkthrough",
    "  cortex help <topic>         concept-level help (qualified-names, projects, …)",
    "  cortex install              add cortex to PATH",
    "",
    "  --version                   print version",
    "  --help                      show help for any command",
  ];
  return lines.join("\n");
}

export function renderNamespaceHelp(namespace: string): string {
  const cmds = NAMESPACES[namespace];
  if (!cmds) return `unknown namespace '${namespace}'`;
  const lines = [`cortex ${namespace} — ${describeNamespace(namespace)}`, "", "Commands:"];
  for (const [name, doc] of Object.entries(cmds)) {
    lines.push(`  ${name.padEnd(12)}${doc.description}`);
  }
  lines.push("", `Run \`cortex ${namespace} <command> --help\` for details on any command.`);
  return lines.join("\n");
}

export function renderCommandHelp(namespace: string, command: string): string {
  const doc = NAMESPACES[namespace]?.[command];
  if (!doc) return `unknown command 'cortex ${namespace} ${command}'`;
  const lines = [
    `cortex ${namespace} ${command} — ${doc.description}`,
    "",
    "Usage:",
    `  ${doc.usage}`,
    "",
    "Examples:",
    ...doc.examples.map((e) => `  ${e}`),
  ];
  if (doc.seeAlso?.length) {
    lines.push("", "See also:");
    for (const ref of doc.seeAlso) lines.push(`  ${ref}`);
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
  })[ns] ?? "";
}
