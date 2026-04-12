import { GraphStore } from "../src/graph/store.js";
import { DecisionService } from "../src/decisions/service.js";
import { DecisionPromotion } from "../src/decisions/promotion.js";

const store = new GraphStore(".cortex/graph.db");
const service = new DecisionService(store);
const promotion = new DecisionPromotion(store);

// Code entities
const authMiddleware = store.createNode({ kind: "function", name: "authMiddleware", qualified_name: "src/auth/middleware.ts::authMiddleware", file_path: "src/auth/middleware.ts" });
const validateToken = store.createNode({ kind: "function", name: "validateToken", qualified_name: "src/auth/validate.ts::validateToken", file_path: "src/auth/validate.ts" });
const handleRequest = store.createNode({ kind: "function", name: "handleRequest", qualified_name: "src/api/handler.ts::handleRequest", file_path: "src/api/handler.ts" });
const dbConnect = store.createNode({ kind: "function", name: "dbConnect", qualified_name: "src/db/connect.ts::dbConnect", file_path: "src/db/connect.ts" });
const cacheLayer = store.createNode({ kind: "component", name: "CacheLayer", qualified_name: "src/cache/CacheLayer.vue", file_path: "src/cache/CacheLayer.vue" });
const userStore = store.createNode({ kind: "component", name: "UserStore", qualified_name: "src/stores/user.ts::UserStore", file_path: "src/stores/user.ts" });

// Edges between code entities
store.createEdge({ source_id: handleRequest.id, target_id: authMiddleware.id, relation: "CALLS" });
store.createEdge({ source_id: authMiddleware.id, target_id: validateToken.id, relation: "CALLS" });
store.createEdge({ source_id: handleRequest.id, target_id: dbConnect.id, relation: "CALLS" });
store.createEdge({ source_id: cacheLayer.id, target_id: userStore.id, relation: "IMPORTS" });

// Decisions
const d1 = service.create({
  title: "Use JWT for authentication",
  description: "All API endpoints require JWT bearer tokens for authentication",
  rationale: "Stateless auth scales horizontally. JWTs contain claims so we avoid session storage. Industry standard for API auth.",
  alternatives: [
    { name: "Session cookies", reason_rejected: "Requires sticky sessions or shared session store" },
    { name: "API keys", reason_rejected: "No user identity, harder to revoke per-session" },
  ],
  governs: [authMiddleware.id, validateToken.id],
});

const d2 = service.create({
  title: "PostgreSQL as primary database",
  description: "Use PostgreSQL for all persistent application data",
  rationale: "JSONB support, strong ecosystem, proven at scale. Supports both relational and document patterns.",
  alternatives: [
    { name: "MySQL", reason_rejected: "Weaker JSON support, less advanced indexing" },
    { name: "MongoDB", reason_rejected: "Need relational queries for reporting" },
  ],
  governs: [dbConnect.id],
});

const d3 = service.create({
  title: "Redis for caching layer",
  description: "Use Redis as the application cache with TTL-based invalidation",
  rationale: "Sub-millisecond reads, built-in TTL, pub/sub for cache invalidation across instances.",
  governs: [cacheLayer.id],
});

const d4 = service.create({
  title: "Vue 3 Composition API for frontend",
  description: "All new components use Vue 3 Composition API with script setup",
  rationale: "Better TypeScript integration, more explicit reactivity, easier to test and compose.",
  alternatives: [
    { name: "Options API", reason_rejected: "Harder to share logic between components" },
    { name: "React", reason_rejected: "Team expertise is in Vue" },
  ],
  governs: ["src/components/", "src/stores/"],
});

// Promote some to team tier
promotion.promote(d1.id, "team");
promotion.promote(d2.id, "team");

// Supersede an old decision
const d5 = service.create({
  title: "Switch to OAuth 2.0 + OIDC",
  description: "Replace custom JWT auth with OAuth 2.0 / OpenID Connect via Auth0",
  rationale: "Centralizes identity management, supports MFA, SSO, and social login out of the box.",
  governs: [authMiddleware.id, validateToken.id],
});
service.update(d1.id, { status: "superseded", superseded_by: d5.id });
promotion.promote(d5.id, "team");

// Reference node
const jiraRef = store.createNode({ kind: "reference", name: "AUTH-1234", data: { url: "https://jira.example.com/AUTH-1234" } });
service.linkReference(d5.id, jiraRef.id);

store.close();
console.error("Seeded database with 6 code entities, 5 decisions, and 1 reference.");
