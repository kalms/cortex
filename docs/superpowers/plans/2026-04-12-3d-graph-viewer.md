# 3D Graph Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2D D3/SVG graph viewer with a 3D WebGL viewer using 3d-force-graph, with neon color-coded nodes, directional particles, click-to-focus camera, and mobile support.

**Architecture:** Three files are rewritten in-place (`src/viewer/index.html`, `src/viewer/graph-viewer.js`, `src/viewer/style.css`). The viewer loads 3d-force-graph + Three.js from CDN. No build step, no npm deps. The server (`src/mcp-server/api.ts`) and API (`/api/graph`) are unchanged.

**Tech Stack:** 3d-force-graph (1.80.x), Three.js (0.183.x), vanilla JS, CSS

**Spec:** `docs/superpowers/specs/2026-04-12-3d-graph-viewer-design.md`

---

### Task 1: Update HTML — swap D3 for 3d-force-graph

**Files:**
- Modify: `src/viewer/index.html`

- [ ] **Step 1: Replace the D3 script tag with Three.js + 3d-force-graph**

Replace:
```html
<script src="https://d3js.org/d3.v7.min.js"></script>
```

With:
```html
<script src="https://unpkg.com/three@0.183.2/build/three.min.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.80.0/dist/3d-force-graph.min.js"></script>
```

Everything else in `index.html` stays the same — the toolbar, detail panel, filters, and graph-container div are all reused.

- [ ] **Step 2: Commit**

```bash
git add src/viewer/index.html
git commit -m "feat(viewer): swap D3 CDN for Three.js + 3d-force-graph"
```

---

### Task 2: Core 3D graph rendering

**Files:**
- Modify: `src/viewer/graph-viewer.js` (full rewrite)

- [ ] **Step 1: Write the base graph-viewer.js with 3D graph initialization**

Replace the entire contents of `src/viewer/graph-viewer.js` with:

```js
(async function () {
  const container = document.getElementById("graph-container");
  const searchInput = document.getElementById("search");
  const detailPanel = document.getElementById("detail-panel");
  const detailContent = document.getElementById("detail-content");
  const closePanel = document.getElementById("close-panel");

  const response = await fetch("/api/graph");
  const { nodes, edges } = await response.json();

  if (nodes.length === 0) {
    container.innerHTML =
      '<div style="color:#555;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;font-size:13px;font-family:Geist Mono,monospace">' +
      "No nodes in graph.<br>Use create_decision or index_repository to add data.</div>";
    return;
  }

  // -- Color maps --
  const NODE_COLORS = {
    decision: "#ff9f1c",
    function: "#2ec4b6",
    component: "#06d6a0",
    path: "#a0a0a0",
    reference: "#cb5cff",
  };

  const NODE_SIZES = {
    decision: 6,
    function: 4,
    component: 4,
    path: 3,
    reference: 3,
  };

  const EDGE_COLORS = {
    CALLS: "#444444",
    IMPORTS: "#444444",
    GOVERNS: "#ff9f1c",
    SUPERSEDES: "#ef476f",
    REFERENCES: "#cb5cff",
  };

  // -- Prepare link data (3d-force-graph expects "source"/"target" keys) --
  const graphData = {
    nodes: nodes.map((n) => ({ ...n })),
    links: edges.map((e) => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
    })),
  };

  // -- Create graph --
  const Graph = ForceGraph3D()(container)
    .backgroundColor("#000000")
    .graphData(graphData)
    .nodeVal((n) => NODE_SIZES[n.kind] || 4)
    .nodeColor((n) => NODE_COLORS[n.kind] || "#888")
    .nodeOpacity(1)
    .linkColor((e) => EDGE_COLORS[e.relation] || "#444")
    .linkOpacity(0.6)
    .linkWidth(0.3)
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(0.4)
    .linkDirectionalParticleSpeed(0.005)
    .linkDirectionalParticleColor((e) => EDGE_COLORS[e.relation] || "#444")
    .linkLabel((e) => e.relation);
})();
```

- [ ] **Step 2: Start the dev server and verify the graph renders in the browser**

Run: `npm run dev` (if not already running)

Open `http://localhost:3333/viewer` — expect to see colored spheres (all kinds are spheres by default at this point) on a black background with edges and animated particles. The graph should be rotatable with click+drag.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): core 3D graph rendering with color-coded nodes and edges"
```

---

### Task 3: Custom node shapes by kind

**Files:**
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Add nodeThreeObject to render octahedrons for decisions and boxes for references**

Add this right after the `.linkDirectionalParticleColor(...)` line, before the closing `})();`:

```js
    // -- Custom node shapes --
    .nodeThreeObject((node) => {
      const color = NODE_COLORS[node.kind] || "#888";
      const size = NODE_SIZES[node.kind] || 4;
      let geometry;

      if (node.kind === "decision") {
        geometry = new THREE.OctahedronGeometry(size);
      } else if (node.kind === "reference") {
        geometry = new THREE.BoxGeometry(size, size, size);
      } else {
        geometry = new THREE.SphereGeometry(size * 0.6, 16, 12);
      }

      const material = new THREE.MeshLambertMaterial({
        color: color,
        transparent: true,
        opacity: 1,
      });

      return new THREE.Mesh(geometry, material);
    })
    .nodeThreeObjectExtend(false)
```

- [ ] **Step 2: Verify in browser**

Reload `http://localhost:3333/viewer`. Expect:
- Decisions: diamond/octahedron shapes in amber
- Functions: spheres in teal
- Components: spheres in green
- Paths: spheres in grey
- References: cubes in violet

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): custom 3D node shapes — octahedrons for decisions, cubes for references"
```

---

### Task 4: Node labels as text sprites

**Files:**
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Replace nodeThreeObject to include a label sprite grouped with the shape mesh**

Replace the entire `nodeThreeObject` block (from `.nodeThreeObject((node) => {` through `.nodeThreeObjectExtend(false)`) with:

```js
    // -- Custom node shapes with labels --
    .nodeThreeObject((node) => {
      const color = NODE_COLORS[node.kind] || "#888";
      const size = NODE_SIZES[node.kind] || 4;
      const group = new THREE.Group();

      // Shape
      let geometry;
      if (node.kind === "decision") {
        geometry = new THREE.OctahedronGeometry(size);
      } else if (node.kind === "reference") {
        geometry = new THREE.BoxGeometry(size, size, size);
      } else {
        geometry = new THREE.SphereGeometry(size * 0.6, 16, 12);
      }

      const material = new THREE.MeshLambertMaterial({
        color: color,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      group.add(mesh);

      // Label sprite
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const fontSize = 48;
      const text = node.name;
      ctx.font = `${fontSize}px Geist Mono, monospace`;
      const textWidth = ctx.measureText(text).width;
      canvas.width = textWidth + 20;
      canvas.height = fontSize + 20;
      ctx.font = `${fontSize}px Geist Mono, monospace`;
      ctx.fillStyle = "#aaaaaa";
      ctx.fillText(text, 10, fontSize);

      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      const scaleFactor = 0.15;
      sprite.scale.set(
        canvas.width * scaleFactor,
        canvas.height * scaleFactor,
        1
      );
      sprite.position.set(size + 3, 0, 0);
      group.add(sprite);

      // Store references for hover/selection
      node.__mesh = mesh;
      node.__sprite = sprite;
      node.__originalColor = color;

      return group;
    })
    .nodeThreeObjectExtend(false)
```

- [ ] **Step 2: Verify in browser**

Reload the viewer. Each node should have its name as a text label floating to the right of the shape. Labels should be readable from any angle (sprites always face camera).

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): add text sprite labels to 3D nodes"
```

---

### Task 5: Camera controls and click-to-focus

**Files:**
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Configure orbit controls and click-to-focus**

Add these lines after `.nodeThreeObjectExtend(false)`:

```js
    // -- Camera controls --
    .enableNodeDrag(true)
    .onNodeDragEnd((node) => {
      // Pin node on drop
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    })
    .onNodeClick((node) => {
      // Fly camera to clicked node
      const distance = 80;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
      Graph.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        { x: node.x, y: node.y, z: node.z },
        1000
      );
      showDetail(node);
    })
    .onBackgroundClick(() => {
      // Reset camera
      Graph.cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z: 0 }, 1000);
      closeDetailPanel();
    });
```

- [ ] **Step 2: Configure Cmd/Ctrl+drag for pan**

Add this block after the Graph creation, before the closing `})();`:

```js
  // Configure orbit controls: Cmd/Ctrl+drag for pan instead of right-click
  const controls = Graph.controls();
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  // Override: when Cmd/Ctrl is held, left mouse pans
  container.addEventListener("mousedown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    } else {
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    }
  });
```

- [ ] **Step 3: Add the showDetail and closeDetailPanel functions**

Add these functions right after the `container.addEventListener` block:

```js
  let selectedNode = null;

  function closeDetailPanel() {
    detailPanel.classList.add("hidden");
    selectedNode = null;
    // Restore all nodes to full opacity
    graphData.nodes.forEach((n) => {
      if (n.__mesh) {
        n.__mesh.material.opacity = 1;
        n.__mesh.material.color.set(n.__originalColor);
      }
      if (n.__sprite) n.__sprite.material.opacity = 1;
    });
    Graph.linkOpacity(0.6);
  }

  function showDetail(node) {
    selectedNode = node;

    // Dim unrelated nodes
    graphData.nodes.forEach((n) => {
      if (!n.__mesh) return;
      const isConnected =
        n === node ||
        graphData.links.some(
          (l) =>
            ((l.source === node || l.source.id === node.id) &&
             (l.target === n || l.target.id === n.id)) ||
            ((l.target === node || l.target.id === node.id) &&
             (l.source === n || l.source.id === n.id))
        );
      n.__mesh.material.opacity = isConnected ? 1 : 0.15;
      if (n.__sprite) n.__sprite.material.opacity = isConnected ? 1 : 0.15;
    });

    // Brighten connected edges
    Graph.linkOpacity((link) => {
      const connected =
        (link.source === node || link.source.id === node.id) ||
        (link.target === node || link.target.id === node.id);
      return connected ? 1 : 0.05;
    });

    // Build detail HTML
    const data = typeof node.data === "string" ? JSON.parse(node.data) : node.data;
    let html = "<h2>" + escapeHtml(node.name) + "</h2>";
    html += field("Kind", node.kind);
    html += field("Tier", node.tier);

    if (node.kind === "decision") {
      if (data.description) html += field("Description", data.description);
      if (data.rationale) html += field("Rationale", data.rationale);
      if (data.status) html += field("Status", data.status);
      if (data.alternatives && data.alternatives.length > 0) {
        const altText = data.alternatives
          .map((a) => escapeHtml(a.name) + ": " + escapeHtml(a.reason_rejected))
          .join("<br>");
        html += field("Alternatives", altText);
      }
    }

    if (node.qualified_name) html += field("Qualified Name", node.qualified_name);
    if (node.file_path) html += field("File", node.file_path);

    // Build clickable connections
    const connected = graphData.links
      .filter((e) => {
        const src = e.source.id || e.source;
        const tgt = e.target.id || e.target;
        return src === node.id || tgt === node.id;
      })
      .map((e) => {
        const src = e.source.id || e.source;
        const otherId = src === node.id ? (e.target.id || e.target) : src;
        const other = graphData.nodes.find((n) => n.id === otherId);
        const dir = src === node.id ? "\u2192" : "\u2190";
        const name = other ? other.name : otherId;
        return (
          '<a href="#" class="connection-link" data-node-id="' +
          escapeHtml(otherId) +
          '">' +
          escapeHtml(dir + " " + e.relation + " " + name) +
          "</a>"
        );
      });

    if (connected.length > 0) {
      html += field("Connections", connected.join("<br>"));
    }

    html += field("ID", node.id);
    detailContent.innerHTML = html;
    detailPanel.classList.remove("hidden");

    // Wire up clickable connections
    detailContent.querySelectorAll(".connection-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const targetId = link.dataset.nodeId;
        const targetNode = graphData.nodes.find((n) => n.id === targetId);
        if (targetNode) {
          const distance = 80;
          const distRatio =
            1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z);
          Graph.cameraPosition(
            {
              x: targetNode.x * distRatio,
              y: targetNode.y * distRatio,
              z: targetNode.z * distRatio,
            },
            { x: targetNode.x, y: targetNode.y, z: targetNode.z },
            1000
          );
          showDetail(targetNode);
        }
      });
    });
  }

  function field(label, value) {
    return (
      '<div class="field"><div class="field-label">' +
      escapeHtml(label) +
      '</div><div class="field-value">' +
      value +
      "</div></div>"
    );
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
```

- [ ] **Step 4: Add close panel handler**

Add this after the helper functions:

```js
  closePanel.addEventListener("click", (e) => {
    e.stopPropagation();
    closeDetailPanel();
  });
```

- [ ] **Step 5: Verify in browser**

Reload the viewer. Test:
- Click+drag rotates
- Scroll zooms
- Cmd+drag (Mac) pans
- Click node: camera flies to it, detail panel opens, unrelated nodes dim
- Click background: camera resets, panel closes
- Click a connection link in the detail panel: camera flies to that node

- [ ] **Step 6: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): camera controls, click-to-focus, detail panel with clickable connections"
```

---

### Task 6: Hover states

**Files:**
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Add hover handler**

Add this line in the Graph builder chain, right before `.enableNodeDrag(true)`:

```js
    .onNodeHover((node) => {
      container.style.cursor = node ? "pointer" : "default";
      // Reset all nodes to original color if not selected
      graphData.nodes.forEach((n) => {
        if (!n.__mesh || n === selectedNode) return;
        n.__mesh.material.color.set(n.__originalColor);
      });
      // Brighten hovered node to white
      if (node && node.__mesh) {
        node.__mesh.material.color.set("#ffffff");
      }
    })
```

- [ ] **Step 2: Verify in browser**

Hover over nodes — they should turn white. Moving away restores their original color. Cursor changes to pointer on hover.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): hover state — nodes brighten to white on hover"
```

---

### Task 7: Search and kind filters

**Files:**
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Add search input handler**

Add this after the `closePanel.addEventListener` block:

```js
  // -- Search --
  searchInput.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    graphData.nodes.forEach((n) => {
      if (!n.__mesh) return;
      const match = q === "" || n.name.toLowerCase().includes(q);
      n.__mesh.material.opacity = match ? 1 : 0.1;
      if (n.__sprite) n.__sprite.material.opacity = match ? 1 : 0.1;
    });
    Graph.linkOpacity(q === "" ? 0.6 : 0.05);
  });
```

- [ ] **Step 2: Add kind filter handlers**

Add this after the search handler:

```js
  // -- Kind filters --
  document.querySelectorAll("#filters input").forEach((cb) => {
    cb.addEventListener("change", applyFilters);
  });

  function applyFilters() {
    const activeKinds = new Set();
    document.querySelectorAll("#filters input:checked").forEach((cb) => {
      activeKinds.add(cb.dataset.kind);
    });

    // Filter nodes: hide unchecked kinds
    graphData.nodes.forEach((n) => {
      if (!n.__mesh) return;
      const cb = document.querySelector(
        '#filters input[data-kind="' + n.kind + '"]'
      );
      const visible = !cb || activeKinds.has(n.kind);
      n.__mesh.visible = visible;
      if (n.__sprite) n.__sprite.visible = visible;
    });

    // Filter links: hide if either end is hidden
    Graph.linkVisibility((link) => {
      const src = link.source;
      const tgt = link.target;
      const srcCb = document.querySelector(
        '#filters input[data-kind="' + src.kind + '"]'
      );
      const tgtCb = document.querySelector(
        '#filters input[data-kind="' + tgt.kind + '"]'
      );
      const srcVis = !srcCb || activeKinds.has(src.kind);
      const tgtVis = !tgtCb || activeKinds.has(tgt.kind);
      return srcVis && tgtVis;
    });
  }
```

- [ ] **Step 3: Verify in browser**

- Type "auth" in search: only auth-related nodes stay bright, rest dim
- Clear search: all nodes restore
- Uncheck "decisions": decision nodes and their GOVERNS/SUPERSEDES edges disappear
- Re-check: they return

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer.js
git commit -m "feat(viewer): search highlighting and kind filter toggles"
```

---

### Task 8: Update CSS — drop SVG styles, add responsive layout

**Files:**
- Modify: `src/viewer/style.css`

- [ ] **Step 1: Rewrite style.css**

Replace the entire contents of `src/viewer/style.css` with:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #000;
  color: #ccc;
  font-family: "Geist Mono", monospace;
  font-size: 13px;
  overflow: hidden;
}

/* -- Toolbar -- */
#toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.92);
  border-bottom: 1px solid #1a1a1a;
}

#logo {
  color: #555;
  font-size: 12px;
  font-weight: 300;
  letter-spacing: 1px;
  white-space: nowrap;
}

#search {
  background: #0a0a0a;
  border: 1px solid #222;
  color: #ccc;
  font-family: "Geist Mono", monospace;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 3px;
  width: 220px;
}

#search:focus {
  outline: none;
  border-color: #444;
}

#filters {
  display: flex;
  gap: 12px;
}

#filters label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: #555;
  font-size: 11px;
}

#filters input[type="checkbox"] {
  accent-color: #fff;
}

/* -- Mobile toolbar collapse -- */
#search-toggle,
#filter-toggle {
  display: none;
  background: none;
  border: 1px solid #333;
  color: #888;
  font-family: "Geist Mono", monospace;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
}

#search-toggle:hover,
#filter-toggle:hover {
  color: #fff;
  border-color: #555;
}

/* -- Graph container -- */
#graph-container {
  width: 100vw;
  height: 100vh;
}

#graph-container canvas {
  display: block;
}

/* -- Detail panel -- */
#detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 340px;
  height: 100vh;
  background: rgba(8, 8, 8, 0.96);
  border-left: 1px solid #1a1a1a;
  padding: 48px 16px 16px;
  overflow-y: auto;
  z-index: 20;
  transition: transform 0.2s ease;
}

#detail-panel.hidden {
  transform: translateX(100%);
}

#close-panel {
  position: absolute;
  top: 10px;
  right: 12px;
  background: none;
  border: none;
  color: #444;
  font-size: 18px;
  cursor: pointer;
  font-family: "Geist Mono", monospace;
}

#close-panel:hover {
  color: #fff;
}

#detail-content h2 {
  color: #ddd;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 14px;
  word-break: break-word;
}

.field {
  margin-bottom: 12px;
}

.field-label {
  color: #555;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 3px;
}

.field-value {
  color: #999;
  font-size: 12px;
  word-break: break-word;
  line-height: 1.5;
}

/* Clickable connection links */
.connection-link {
  color: #2ec4b6;
  text-decoration: none;
  display: block;
  padding: 2px 0;
}

.connection-link:hover {
  color: #fff;
}

/* -- Mobile layout (< 768px) -- */
@media (max-width: 768px) {
  #toolbar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
  }

  #search {
    display: none;
    width: 100%;
    order: 10;
  }

  #search.show {
    display: block;
  }

  #filters {
    display: none;
    width: 100%;
    flex-wrap: wrap;
    order: 11;
  }

  #filters.show {
    display: flex;
  }

  #search-toggle,
  #filter-toggle {
    display: inline-block;
  }

  /* Detail panel: bottom half-sheet */
  #detail-panel {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    height: 50vh;
    border-left: none;
    border-top: 1px solid #1a1a1a;
    border-radius: 12px 12px 0 0;
    padding: 40px 16px 16px;
  }

  #detail-panel.hidden {
    transform: translateY(100%);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/viewer/style.css
git commit -m "feat(viewer): CSS rewrite — drop SVG styles, add responsive mobile layout"
```

---

### Task 9: Mobile toolbar toggle buttons

**Files:**
- Modify: `src/viewer/index.html`
- Modify: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Add toggle buttons to the toolbar in index.html**

In `src/viewer/index.html`, add the two toggle buttons after the `<span id="logo">` line:

```html
    <button id="search-toggle" aria-label="Toggle search">&#x1F50D;</button>
    <button id="filter-toggle" aria-label="Toggle filters">&#x2699;</button>
```

The full toolbar section becomes:

```html
  <div id="toolbar">
    <span id="logo">cortex</span>
    <button id="search-toggle" aria-label="Toggle search">&#x1F50D;</button>
    <button id="filter-toggle" aria-label="Toggle filters">&#x2699;</button>
    <input type="text" id="search" placeholder="Search nodes...">
    <div id="filters">
      <label><input type="checkbox" data-kind="function" checked> functions</label>
      <label><input type="checkbox" data-kind="component" checked> components</label>
      <label><input type="checkbox" data-kind="decision" checked> decisions</label>
      <label><input type="checkbox" data-kind="path" checked> paths</label>
      <label><input type="checkbox" data-kind="reference" checked> references</label>
    </div>
  </div>
```

- [ ] **Step 2: Add toggle logic in graph-viewer.js**

Add this at the end of graph-viewer.js, before the closing `})();`:

```js
  // -- Mobile toolbar toggles --
  const searchToggle = document.getElementById("search-toggle");
  const filterToggle = document.getElementById("filter-toggle");
  const filtersEl = document.getElementById("filters");

  if (searchToggle) {
    searchToggle.addEventListener("click", () => {
      searchInput.classList.toggle("show");
      if (searchInput.classList.contains("show")) searchInput.focus();
    });
  }

  if (filterToggle) {
    filterToggle.addEventListener("click", () => {
      filtersEl.classList.toggle("show");
    });
  }
```

- [ ] **Step 3: Verify in browser at narrow viewport**

Open the viewer, then resize the browser to < 768px width (or use DevTools responsive mode). Expect:
- Search input and filters hidden by default
- Magnifying glass icon reveals search
- Gear icon reveals filters
- Detail panel slides up from bottom

- [ ] **Step 4: Commit**

```bash
git add src/viewer/index.html src/viewer/graph-viewer.js
git commit -m "feat(viewer): mobile toolbar toggles for search and filters"
```

---

### Task 10: Visual testing with Playwright

**Files:**
- No file changes — this is verification only.

- [ ] **Step 1: Ensure server is running with seeded data**

```bash
# Re-seed if needed
rm -f .cortex/graph.db && npx tsx scripts/seed.ts
# Start server
npm run dev
```

- [ ] **Step 2: Open viewer in Playwright and take screenshot**

Navigate to `http://localhost:3333/viewer` in Playwright. Take a full-page screenshot. Verify:
- Black background
- 14 nodes visible with correct shapes (octahedrons, spheres, cubes)
- Nodes colored by kind (amber, teal, green, grey, violet)
- Edges with directional particles
- Node labels visible

- [ ] **Step 3: Test node click → detail panel**

Click the "Switch to OAuth 2.0 + OIDC" node (via JS evaluate). Verify:
- Camera animates to node
- Detail panel slides in with correct metadata
- Unrelated nodes dimmed
- Connections listed and clickable

- [ ] **Step 4: Test clickable connection**

Click a connection link in the detail panel (e.g., "→ GOVERNS authMiddleware"). Verify:
- Camera flies to the target node
- Detail panel updates to show that node's info

- [ ] **Step 5: Test search**

Type "auth" in search box. Verify matching nodes bright, non-matching dimmed.

- [ ] **Step 6: Test kind filter**

Uncheck "decisions" checkbox. Verify decision nodes and GOVERNS/SUPERSEDES edges disappear.

- [ ] **Step 7: Test mobile layout**

Resize viewport to 375x667. Verify:
- Toggle buttons visible
- Search/filters hidden, revealable via toggles
- Click a node: panel slides up from bottom

- [ ] **Step 8: Test close panel**

Click the × button. Verify panel closes without selecting a node behind it.

- [ ] **Step 9: Final commit**

```bash
git add -A
git commit -m "feat(viewer): 3D graph viewer — complete rewrite with WebGL, neon palette, mobile support"
```
