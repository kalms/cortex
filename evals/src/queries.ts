// Killer queries — fixed list, run on every target. SQL is concrete here;
// the spec's Cypher is illustrative. Each entry has a Cypher comment so the
// SQL can be cross-checked against the spec.

export type KillerQuery = {
  name: string;
  cypher: string;     // illustrative — what this would look like in Cypher
  sql: string;        // actual query the harness runs
};

export const KILLER_QUERIES: KillerQuery[] = [
  {
    name: "functions_high_degree",
    cypher: "MATCH (f:function) WHERE f.degree > 5 RETURN f.name, f.degree LIMIT 20",
    // degree = count of incoming + outgoing edges for the node
    sql: `
      SELECT n.name, n.file_path,
             (SELECT COUNT(*) FROM edges WHERE source_id = n.id OR target_id = n.id) AS degree
      FROM nodes n
      WHERE n.kind = 'function'
        AND (SELECT COUNT(*) FROM edges WHERE source_id = n.id OR target_id = n.id) > 5
      LIMIT 20
    `,
  },
  {
    name: "http_calls_with_api_path",
    cypher: "MATCH ()-[r:HTTP_CALLS]->(rt:Route) WHERE rt.name STARTS WITH '/api' RETURN rt.name, count(r) LIMIT 20",
    sql: `
      SELECT rt.name AS route_name, COUNT(*) AS call_count
      FROM edges e
      JOIN nodes rt ON rt.id = e.target_id
      WHERE e.relation = 'HTTP_CALLS'
        AND rt.kind = 'Route'
        AND rt.name LIKE '/api%'
      GROUP BY rt.name
      LIMIT 20
    `,
  },
  {
    name: "route_nodes_named",
    cypher: "MATCH (r:Route) RETURN r.name LIMIT 40",
    sql: "SELECT name FROM nodes WHERE kind = 'Route' LIMIT 40",
  },
  {
    name: "composables_called",
    cypher: "MATCH (f:function)-[c:CALLS]->(g:function) WHERE g.name STARTS WITH 'use' RETURN g.name, count(c) ORDER BY count(c) DESC LIMIT 20",
    sql: `
      SELECT g.name AS composable, COUNT(*) AS in_degree
      FROM edges e
      JOIN nodes g ON g.id = e.target_id
      WHERE e.relation = 'CALLS'
        AND g.kind = 'function'
        AND g.name LIKE 'use%'
      GROUP BY g.name
      ORDER BY in_degree DESC
      LIMIT 20
    `,
  },
  {
    name: "vue_function_count",
    cypher: "MATCH (f:function) WHERE f.file_path ENDS WITH '.vue' RETURN count(f)",
    sql: `
      SELECT name, file_path
      FROM nodes
      WHERE kind = 'function' AND file_path LIKE '%.vue'
    `,
  },
  {
    name: "nitro_handlers",
    cypher: "MATCH (f:function) WHERE f.file_path =~ '.*server/api/.*\\\\.ts' RETURN f.qualified_name LIMIT 20",
    sql: `
      SELECT qualified_name, file_path
      FROM nodes
      WHERE kind = 'function' AND file_path LIKE '%server/api/%' AND file_path LIKE '%.ts'
      LIMIT 20
    `,
  },
  {
    name: "decisions_present",
    cypher: "MATCH (d:Decision) RETURN count(d)",
    sql: "SELECT id, name FROM nodes WHERE kind = 'Decision'",
  },
];
