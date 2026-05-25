import { UsageError } from "../errors.js";

const TOPICS: Record<string, string> = {
  "qualified-names": `qualified names — what they look like and why they matter

Cortex stores every code symbol under a canonical qualified name (qn). It
looks like this:

    Users-rka-Development-anthill-cloud.apps.activator.app.components.ADesignSystemCard

Format: <slash-replaced absolute path>.<dotted path to symbol>

The CLI auto-resolves common input shapes:

  • file paths             apps/foo.vue                  → looked up by file_path
  • canonical qns          Users-...-foo.bar             → direct match
  • dotted suffixes        components.foo                → matches by suffix
  • bare names             handleRequest                 → searched as a name

If multiple match, you'll see a numbered list. Pick one and re-run with
the full qn.
`,
  projects: `projects — how cortex names and finds them

Project name is derived from the git root's absolute path with slashes
replaced by hyphens. For example:

    /Users/rka/Development/anthill-cloud
    → Users-rka-Development-anthill-cloud

The CLI picks the project automatically from the cwd. To override:

    cortex code find foo --project=some-other-project

Listing what's indexed:

    cortex index list
`,
  indexing: `indexing — what gets indexed and where it lives

Cortex's native indexer extracts nodes (functions, modules, files,
decisions, …) and edges (CALLS, IMPORTS, GOVERNS, …) from your repo.

To index the current repo:

    cortex index .

To check status:

    cortex index status

The graph.db lives at one of two paths (in order of preference):

  • <repo>/.cortex/graph.db                       (MCP server convention)
  • ~/.cache/cortex-indexer/<project-name>.db    (standalone indexer cache)
`,
  decisions: `decisions — what they are and how to capture them

A decision is a tracked architectural choice with rationale, alternatives,
and links to the code it governs. Create one when you make a choice that's
not obvious from the code itself.

Three states:

  • create:   directly create an active decision
  • propose:  create a 'proposed' decision (e.g. tied to a PR)
  • supersede: replace an existing decision with a new one (transactional)

Link to code:

    cortex decision link <id> src/auth.ts --relation=GOVERNS
    cortex decision link <id> docs/spec.md --relation=REFERENCES

See: cortex decision --help
`,
  eval: `eval — what the harness measures

The eval harness runs a fixed battery of assertions against an indexed
target (a Nuxt repo, anthill-cloud, etc.) and reports surprises — places
where the outcome differs from the baseline expectation.

To run:

    cortex eval                     # all targets in evals/targets.json
    cortex eval anthill-cloud       # one target
    cortex eval baseline <target>   # capture a new baseline

Read the latest summary:

    cortex eval report

See: docs/architecture/eval-harness.md
`,
};

export function renderTopic(topic: string): string {
  const text = TOPICS[topic];
  if (!text) {
    throw new UsageError(
      `unknown topic '${topic}'`,
      `Try: ${Object.keys(TOPICS).map((t) => `cortex help ${t}`).join(", ")}`,
    );
  }
  return text;
}
