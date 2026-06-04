// tests/frame-extraction/path-tokenize.test.ts
import { describe, it, expect } from "vitest";
import { tokenizePath } from "../../src/frame-extraction/path-tokenize.js";

describe("tokenizePath — universal/frontend/backend segments are stripped", () => {
  it("strips src + app + components", () => {
    const { path_tokens } = tokenizePath("src/app/components/billing/invoice.ts");
    expect(path_tokens).toEqual(["billing", "invoice"]);
  });

  it("strips multiple consecutive convention segments", () => {
    const { path_tokens } = tokenizePath("src/lib/services/auth/middleware/token.ts");
    expect(path_tokens).toEqual(["auth", "token"]);
  });

  it("does NOT strip non-convention segments", () => {
    const { path_tokens } = tokenizePath("packages/core/billing/invoice.ts");
    expect(path_tokens).toEqual(["packages", "core", "billing", "invoice"]);
  });

  it("retains case but lowercases for consistency", () => {
    const { path_tokens } = tokenizePath("src/app/Billing/InvoiceList.tsx");
    expect(path_tokens).toEqual(["billing", "invoice", "list"]);
  });
});

describe("tokenizePath — role suffixes", () => {
  it("strips role suffix when the prefix is NOT a convention token (default)", () => {
    // `auth.service.ts` → suffix `.service` stripped because `auth` is a
    // perfectly fine domain word; the role tag is noise here.
    const { symbol_tokens } = tokenizePath("src/auth/auth.service.ts");
    expect(symbol_tokens).toEqual(["auth"]);
  });

  it("preserves role suffix when the prefix IS itself a convention/strip token", () => {
    // `service.service.ts` is pathological but reveals the intent: if the
    // prefix would be stripped, the suffix is the only thing carrying signal.
    const { symbol_tokens } = tokenizePath("packages/foo/service.service.ts", {
      service_suffix_aware: true,
    });
    // After stripping the prefix-as-convention, only `service` would remain
    // before suffix stripping. Suffix-aware mode keeps it as `service`.
    expect(symbol_tokens).toEqual(["service"]);
  });

  it("strips .test and .spec uniformly", () => {
    expect(tokenizePath("src/billing/invoice.test.ts").symbol_tokens).toEqual(["invoice"]);
    expect(tokenizePath("src/billing/invoice.spec.ts").symbol_tokens).toEqual(["invoice"]);
  });

  it("handles paths with no extension", () => {
    const { symbol_tokens } = tokenizePath("Makefile");
    expect(symbol_tokens).toEqual(["makefile"]);
  });
});

describe("tokenizePath — camel/snake/kebab splitting", () => {
  it("splits camelCase into separate symbol tokens", () => {
    expect(tokenizePath("src/InvoiceList.tsx").symbol_tokens).toEqual(["invoice", "list"]);
  });

  it("splits snake_case", () => {
    expect(tokenizePath("src/auth/refresh_token.py").symbol_tokens).toEqual(["refresh", "token"]);
  });

  it("splits kebab-case and strips a leading use prefix", () => {
    expect(tokenizePath("src/use-billing-state.ts").symbol_tokens).toEqual(["billing", "state"]);
  });

  it("splits consecutive-uppercase runs (acronyms)", () => {
    // Regression: a regex that only handles lower→upper boundaries would
    // leave URLParser as one token and only partially split XMLHttpRequest.
    // Both should fully split.
    expect(tokenizePath("src/URLParser.ts").symbol_tokens).toEqual(["url", "parser"]);
    expect(tokenizePath("src/XMLHttpRequest.ts").symbol_tokens).toEqual(["xml", "http", "request"]);
  });

  it("deduplicates within each token list (preserves first occurrence order)", () => {
    const { path_tokens } = tokenizePath("billing/billing/invoice.ts");
    expect(path_tokens).toEqual(["billing", "invoice"]);
  });
});

describe("tokenizePath — convention-aware (Phase 1)", () => {
  it("drops bracketed dynamic route segments from path tokens", () => {
    const { path_tokens } = tokenizePath("apps/x/pages/[orgId]/colors.vue");
    expect(path_tokens).not.toContain("orgid");
    expect(path_tokens).toEqual(["apps", "x", "colors"]);
  });

  it("drops Next.js parenthesised route groups", () => {
    const { path_tokens } = tokenizePath("app/(marketing)/about/page.tsx");
    expect(path_tokens).not.toContain("marketing");
    expect(path_tokens).toContain("about");
  });

  it("strips a leading use prefix from composable/store filenames", () => {
    const { symbol_tokens } = tokenizePath("composables/useFoundationStore.ts");
    expect(symbol_tokens).toEqual(["foundation", "store"]);
  });

  it("does NOT strip use when it is a substring (user, useful)", () => {
    expect(tokenizePath("models/user.ts").symbol_tokens).toEqual(["user"]);
    expect(tokenizePath("lib/useful.ts").symbol_tokens).toEqual(["useful"]);
  });

  it("keeps a lone use when it is the only token", () => {
    expect(tokenizePath("lib/use.ts").symbol_tokens).toEqual(["use"]);
  });

  it("drops trailing route-method suffixes (Nuxt server/api)", () => {
    const { symbol_tokens } = tokenizePath("server/api/users.get.ts");
    expect(symbol_tokens).toEqual(["users"]);
  });

  it("contributes nothing for a fully-dynamic filename", () => {
    const t = tokenizePath("pages/users/[id].vue");
    expect(t.symbol_tokens).toEqual([]);
    expect(t.path_tokens).toEqual(["users"]);
  });

  it("does not mangle dotted bracket segments like [...slug]", () => {
    const t = tokenizePath("pages/[...slug].vue");
    expect(t.symbol_tokens).toEqual([]);
    expect(t.path_tokens).toEqual([]);
  });
});
