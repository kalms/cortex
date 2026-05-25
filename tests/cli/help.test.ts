import { describe, it, expect } from "vitest";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "../../src/cli/help.js";
import { renderTopic } from "../../src/cli/commands/help.js";

describe("help renderers", () => {
  it("top-level help lists all namespaces", () => {
    const out = renderTopLevelHelp();
    expect(out).toContain("code");
    expect(out).toContain("decision");
    expect(out).toContain("graph");
    expect(out).toContain("index");
    expect(out).toContain("eval");
  });

  it("namespace help lists commands", () => {
    const out = renderNamespaceHelp("code");
    expect(out).toContain("search");
    expect(out).toContain("find");
    expect(out).toContain("show");
  });

  it("command help includes examples", () => {
    const out = renderCommandHelp("code", "search");
    expect(out).toContain("Examples:");
    expect(out).toContain("cortex code search");
  });

  it("renderTopic returns markdown for known topic", () => {
    const out = renderTopic("qualified-names");
    expect(out).toContain("qualified name");
  });

  it("renderTopic on unknown topic throws", () => {
    expect(() => renderTopic("xyzzy")).toThrow();
  });
});
