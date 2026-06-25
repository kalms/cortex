import { describe, it, expect } from "vitest";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "../../src/cli/help.js";
import { renderTopic } from "../../src/cli/commands/help.js";
import { makeStyler } from "../../src/cli/style.js";

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

describe("help styling", () => {
  const styler = makeStyler({ isTTY: true }, {}, "always");

  it("no styler → no ANSI (unchanged output)", () => {
    expect(renderTopLevelHelp()).not.toContain("\x1b");
    expect(renderNamespaceHelp("code")).not.toContain("\x1b");
    expect(renderCommandHelp("code", "search")).not.toContain("\x1b");
  });

  it("enabled styler colors headings/names/examples but keeps the words", () => {
    const out = renderCommandHelp("code", "search", styler);
    expect(out).toContain("\x1b[");
    expect(out).toContain("Examples:");
    expect(out).toContain("cortex code search");
  });
});
