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
    .linkLabel((e) => e.relation)
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
    .enableNodeDrag(true)
    .onNodeDragEnd((node) => {
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    })
    .onNodeClick((node) => {
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
      Graph.cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z: 0 }, 1000);
      closeDetailPanel();
    });

  // Configure orbit controls: Cmd/Ctrl+drag for pan instead of right-click
  const controls = Graph.controls();
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  container.addEventListener("mousedown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    } else {
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    }
  });

  let selectedNode = null;

  function closeDetailPanel() {
    detailPanel.classList.add("hidden");
    selectedNode = null;
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

    Graph.linkOpacity((link) => {
      const connected =
        (link.source === node || link.source.id === node.id) ||
        (link.target === node || link.target.id === node.id);
      return connected ? 1 : 0.05;
    });

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

  closePanel.addEventListener("click", (e) => {
    e.stopPropagation();
    closeDetailPanel();
  });

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

  // -- Kind filters --
  document.querySelectorAll("#filters input").forEach((cb) => {
    cb.addEventListener("change", applyFilters);
  });

  function applyFilters() {
    const activeKinds = new Set();
    document.querySelectorAll("#filters input:checked").forEach((cb) => {
      activeKinds.add(cb.dataset.kind);
    });

    graphData.nodes.forEach((n) => {
      if (!n.__mesh) return;
      const cb = document.querySelector(
        '#filters input[data-kind="' + n.kind + '"]'
      );
      const visible = !cb || activeKinds.has(n.kind);
      n.__mesh.visible = visible;
      if (n.__sprite) n.__sprite.visible = visible;
    });

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
})();
