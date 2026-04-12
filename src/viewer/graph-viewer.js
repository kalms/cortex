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
    .nodeThreeObjectExtend(false);
})();
