import { describe, it, expect } from "vitest";
import { projectDisplayName, formatRelativeDate, checkoutLabel } from "../../src/viewer/app/display.ts";

describe("checkoutLabel", () => {
  it("appends the branch for a worktree project", () => {
    expect(checkoutLabel({ name: "cortex", branch: "mesh/composer" })).toBe("cortex @ mesh/composer");
  });
  it("leaves a main checkout bare", () => {
    expect(checkoutLabel({ name: "cortex", branch: null })).toBe("cortex");
  });
});

describe("projectDisplayName", () => {
  it("uses the basename of root_path", () =>
    expect(projectDisplayName({ name: "Users-rka-Development-cortex", root_path: "/Users/rka/Development/cortex" })).toBe("cortex"));
  it("strips a trailing slash", () =>
    expect(projectDisplayName({ name: "x", root_path: "/a/b/" })).toBe("b"));
  it("falls back to the slug when root_path is missing", () =>
    expect(projectDisplayName({ name: "legacy-slug", root_path: null })).toBe("legacy-slug"));
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-07-07T14:34:00").getTime();
  const ago = (ms) => new Date(now - ms).toISOString();
  const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR;

  it("returns empty string for empty input", () => {
    expect(formatRelativeDate("", now)).toBe("");
    expect(formatRelativeDate(null, now)).toBe("");
    expect(formatRelativeDate(undefined, now)).toBe("");
  });
  it("passes an unparseable string through untouched", () =>
    expect(formatRelativeDate("not-a-date", now)).toBe("not-a-date"));
  it("shows 'just now' under a minute", () =>
    expect(formatRelativeDate(ago(5 * SEC), now)).toBe("just now"));
  it("clamps future timestamps to 'just now'", () =>
    expect(formatRelativeDate(new Date(now + 5 * SEC).toISOString(), now)).toBe("just now"));
  it("formats minutes, singular and plural", () => {
    expect(formatRelativeDate(ago(MIN), now)).toBe("1 min ago");
    expect(formatRelativeDate(ago(2 * MIN + 5 * SEC), now)).toBe("2 mins ago");
  });
  it("formats hours, singular and plural", () => {
    expect(formatRelativeDate(ago(HR), now)).toBe("1 hr ago");
    expect(formatRelativeDate(ago(3 * HR), now)).toBe("3 hrs ago");
  });
  it("formats 1 and 2 days relatively", () => {
    expect(formatRelativeDate(ago(DAY + HR), now)).toBe("1 day ago");
    expect(formatRelativeDate(ago(2 * DAY + HR), now)).toBe("2 days ago");
  });
  it("falls back to an absolute clock at 3 days", () =>
    expect(formatRelativeDate("2026-01-21T14:34:00", now)).toBe("January 21, 2026 2:34pm"));
  it("uses 12am/12pm at the clock boundaries", () => {
    expect(formatRelativeDate("2026-01-21T00:05:00", now)).toBe("January 21, 2026 12:05am");
    expect(formatRelativeDate("2026-01-21T12:00:00", now)).toBe("January 21, 2026 12:00pm");
  });
});
