import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards against a regression of the fix for: the viewer's Google Fonts
// stylesheet was loaded as a render-blocking <link rel="stylesheet">, so
// first paint hung for tens of seconds whenever fonts.googleapis.com was
// unreachable (broken DNS/network). The viewer must never render-block on
// an external host — see docs/architecture (fonts load async, print-media
// swap trick, noscript fallback).
const indexHtmlPath = join(__dirname, "../../src/viewer/index.html");

describe("viewer index.html: non-blocking Google Fonts load", () => {
  const html = readFileSync(indexHtmlPath, "utf8");

  it("does not render-block on the fonts.googleapis.com stylesheet", () => {
    // Only the <head>-level link needs to be non-blocking; the <noscript>
    // fallback is intentionally exempt (it only loads when JS is off).
    const [headHtml] = html.split(/<noscript>/);
    const blockingLinkPattern =
      /<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]*rel="stylesheet"[^>]*>/g;
    const blockingMatches = headHtml.match(blockingLinkPattern) ?? [];
    // At least one such (now-async) stylesheet link must be present.
    expect(blockingMatches.length).toBeGreaterThan(0);
    for (const tag of blockingMatches) {
      expect(tag).toMatch(/media="print"/);
      expect(tag).toMatch(/onload="this\.media='all'"/);
    }
  });

  it("provides a <noscript> fallback that still loads the stylesheet", () => {
    const noscriptMatch = html.match(/<noscript>[\s\S]*?<\/noscript>/);
    expect(noscriptMatch).not.toBeNull();
    expect(noscriptMatch![0]).toMatch(
      /<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]+rel="stylesheet"/,
    );
  });

  it("keeps the preconnect hints for fonts.googleapis.com and fonts.gstatic.com", () => {
    expect(html).toMatch(
      /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/,
    );
    expect(html).toMatch(
      /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/,
    );
  });
});
