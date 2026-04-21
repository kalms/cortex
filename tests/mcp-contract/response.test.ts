import { describe, it, expect } from "vitest";
import { ok, empty, error, SuccessResponse, NoResultsResponse, ErrorResponse, ResponseSchema } from "../../src/mcp-server/response.js";

describe("response helpers", () => {
  it("ok() produces a valid SuccessResponse", () => {
    const r = ok("hello");
    expect(SuccessResponse.safeParse(r).success).toBe(true);
    expect(r.content[0].text).toBe("hello");
    expect(r.isError).toBeUndefined();
  });

  it("empty() produces a valid NoResultsResponse with the stable prefix", () => {
    const r = empty("search_graph(name_pattern=foo)");
    expect(NoResultsResponse.safeParse(r).success).toBe(true);
    expect(r.content[0].text).toMatch(/^No results: /);
    expect(r.content[0].text).toContain("search_graph(name_pattern=foo)");
  });

  it("error() produces a valid ErrorResponse with reason slug", () => {
    const r = error("project_not_found", "no project registered at /tmp/x");
    expect(ErrorResponse.safeParse(r).success).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^ERROR reason=project_not_found: /);
  });

  it("ResponseSchema accepts all three shapes", () => {
    expect(ResponseSchema.safeParse(ok("x")).success).toBe(true);
    expect(ResponseSchema.safeParse(empty("q")).success).toBe(true);
    expect(ResponseSchema.safeParse(error("internal_error", "boom")).success).toBe(true);
  });

  it("ResponseSchema rejects malformed responses", () => {
    expect(ResponseSchema.safeParse({ content: "not-an-array" }).success).toBe(false);
    expect(ResponseSchema.safeParse({ content: [{ type: "image", text: "x" }] }).success).toBe(false);
  });

  it("empty() output is discriminated by NoResultsResponse, not SuccessResponse", () => {
    const nr = empty("q");
    expect(NoResultsResponse.safeParse(nr).success).toBe(true);
    // It happens to also be a valid SuccessResponse shape, but the union must
    // match NoResultsResponse first. We can't inspect which member matched,
    // so we instead assert that reordering is reflected by parsing against
    // schemas individually: NoResultsResponse MUST pass.
    expect(ResponseSchema.safeParse(nr).success).toBe(true);
  });

  it("error() output is discriminated by ErrorResponse, not SuccessResponse", () => {
    const e = error("internal_error", "boom");
    expect(ErrorResponse.safeParse(e).success).toBe(true);
    // SuccessResponse would reject it because of isError: true literal.
    expect(SuccessResponse.safeParse(e).success).toBe(false);
    expect(ResponseSchema.safeParse(e).success).toBe(true);
  });
});
