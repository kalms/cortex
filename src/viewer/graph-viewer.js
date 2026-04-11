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
      '<div style="color:#333;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;font-size:13px">' +
      "No nodes in graph.<br>Use create_decision or index_repository to add data.</div>";
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  const svg = d3.select(container).append("svg").attr("width", width).attr("height", height);

  const g = svg.append("g");
  svg.call(
    d3.zoom().scaleExtent([0.05, 10]).on("zoom", (event) => {
      g.attr("transform", event.transform);
    })
  );

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(edges)
        .id((d) => d.id)
        .distance(80)
    )
    .force("charge", d3.forceManyBody().strength(-100))
    .force("center", d3.forceCenter(width / 2, height / 2));

  const linkGroup = g.append("g");
  const link = linkGroup
    .selectAll("line")
    .data(edges)
    .join("line")
    .attr("class", "edge-line");

  link.append("title").text((d) => d.relation);

  const nodeGroup = g.append("g");
  const node = nodeGroup
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node-group")
    .call(
      d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended)
    )
    .on("click", (event, d) => showDetail(d));

  node.each(function (d) {
    const el = d3.select(this);

    if (d.kind === "decision") {
      const s = 8;
      const hex = d3.range(6).map((i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return [s * Math.cos(a), s * Math.sin(a)];
      });
      el.append("polygon")
        .attr("points", hex.map((p) => p.join(",")).join(" "))
        .attr("class", "node-shape kind-decision");
    } else if (d.kind === "reference") {
      el.append("rect")
        .attr("x", -4)
        .attr("y", -4)
        .attr("width", 8)
        .attr("height", 8)
        .attr("class", "node-shape kind-reference");
    } else {
      el.append("circle").attr("r", 4).attr("class", "node-shape");
    }
  });

  node
    .append("text")
    .attr("class", "node-label")
    .attr("dx", 10)
    .attr("dy", 3)
    .text((d) => d.name);

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  let selectedNode = null;

  function showDetail(d) {
    selectedNode = d;

    node.classed("selected", (n) => n === d);
    node.selectAll(".node-shape").classed("selected", (n) => n === d);
    link.classed("highlighted", (e) => e.source === d || e.target === d);

    const data = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
    let html = "<h2>" + escapeHtml(d.name) + "</h2>";
    html += field("Kind", d.kind);
    html += field("Tier", d.tier);

    if (d.kind === "decision") {
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

    if (d.qualified_name) html += field("Qualified Name", d.qualified_name);
    if (d.file_path) html += field("File", d.file_path);

    const connected = edges
      .filter((e) => e.source.id === d.id || e.target.id === d.id)
      .map((e) => {
        const other = e.source.id === d.id ? e.target : e.source;
        const dir = e.source.id === d.id ? "\u2192" : "\u2190";
        return escapeHtml(dir + " " + e.relation + " " + other.name);
      });

    if (connected.length > 0) {
      html += field("Connections", connected.join("<br>"));
    }

    html += field("ID", d.id);
    detailContent.innerHTML = html;
    detailPanel.classList.remove("hidden");
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
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  closePanel.addEventListener("click", () => {
    detailPanel.classList.add("hidden");
    selectedNode = null;
    node.classed("selected", false);
    node.selectAll(".node-shape").classed("selected", false);
    link.classed("highlighted", false);
  });

  searchInput.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    node.style("opacity", (d) => (q === "" || d.name.toLowerCase().includes(q) ? 1 : 0.1));
    link.style("opacity", q === "" ? 1 : 0.05);
  });

  document.querySelectorAll("#filters input").forEach((cb) => {
    cb.addEventListener("change", applyFilters);
  });

  function applyFilters() {
    const activeKinds = new Set();
    document.querySelectorAll("#filters input:checked").forEach((cb) => {
      activeKinds.add(cb.dataset.kind);
    });

    node.style("display", (d) => {
      const has = document.querySelector('#filters input[data-kind="' + d.kind + '"]');
      return !has || activeKinds.has(d.kind) ? null : "none";
    });

    link.style("display", (e) => {
      const sv = isVisible(e.source);
      const tv = isVisible(e.target);
      return sv && tv ? null : "none";
    });
  }

  function isVisible(d) {
    const cb = document.querySelector('#filters input[data-kind="' + d.kind + '"]');
    return !cb || cb.checked;
  }
})();
