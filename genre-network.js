// genre-network.js - Force-directed Obsidian-style genre folksonomy network
(function () {
  async function initGenreNetwork() {
    const container = document.getElementById("genre-network-container");
    if (!container) return;

    let data;
    try {
      const res = await fetch("genre_network.json");
      if (!res.ok) throw new Error("Network data response not ok");
      data = await res.json();
    } catch (err) {
      console.warn("Could not load genre_network.json:", err);
      return;
    }

    if (!data || !data.nodes || !data.links) return;

    // Clear any previous render
    container.innerHTML = "";

    function getScreenDimensions() {
      const width = Math.max(300, Math.floor(container.clientWidth || window.innerWidth));
      const height = Math.max(700, Math.min(920, Math.floor(window.innerHeight * 0.9)));
      return { width, height };
    }

    let { width, height } = getScreenDimensions();
    container.style.height = `${height}px`;

    // SVG container with zoom support
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("style", "display: block; cursor: grab; user-select: none;");

    // Root group for zooming & panning
    const gRoot = svg.append("g").attr("class", "network-root");

    // Layer groups: links at bottom, nodes in middle, labels on TOP
    const linkGroup = gRoot.append("g").attr("class", "links");
    const nodeGroup = gRoot.append("g").attr("class", "nodes");
    const labelGroup = gRoot.append("g").attr("class", "labels");

    // Precompute node offsets and copy items
    const nodes = data.nodes.map((d) => {
      const copy = Object.assign({}, d);
      copy.labelOffset = copy.radius + (copy.isMajor ? 14 : copy.radius >= 11 ? 11 : 9);
      return copy;
    });

    const nodeById = new Map();
    nodes.forEach((n) => nodeById.set(n.id, n));

    const links = data.links.map((d) => Object.assign({}, d));

    // Fast lookup for adjacency and connected links
    const neighborMap = new Map();
    const nodeLinkMap = new Map();

    nodes.forEach((n) => {
      neighborMap.set(n.id, new Set([n.id]));
      nodeLinkMap.set(n.id, []);
    });

    links.forEach((l) => {
      const sId = l.source;
      const tId = l.target;
      if (neighborMap.has(sId)) neighborMap.get(sId).add(tId);
      if (neighborMap.has(tId)) neighborMap.get(tId).add(sId);
    });

    // Zoom state
    let currentK = 1;

    // Dynamic label visibility:
    // 1. Zoom out far (k <= 0.5): ALL labels fade away completely
    // 2. Base zoom (k ~ 1.0): Major hubs & mid-tier labels visible
    // 3. Zoom in (k >= 1.15): Medium subgenres reveal
    // 4. Zoom in deeper (k >= 1.45): Smallest subgenres reveal
    function getLabelOpacity(d, k) {
      // Zoom out far enough: every genre name fades away
      if (k <= 0.5) return 0;

      // Tier 1: Major hubs fade in between 0.5 and 0.8, fully visible above 0.8
      if (d.isMajor) {
        return Math.min(1, (k - 0.5) / 0.3);
      }

      // Tier 2: Mid-size subgenres (Alternative Rock, Heavy Metal, etc.)
      if (d.radius >= 11) {
        if (k < 0.85) return 0;
        return Math.min(1, (k - 0.85) / 0.2);
      }

      // Tier 3: Medium subgenres (Shoegaze, Post-Rock, etc.)
      if (d.radius >= 7.5) {
        if (k < 1.15) return 0;
        return Math.min(1, (k - 1.15) / 0.25);
      }

      // Tier 4: Smallest niche subgenres
      if (k < 1.45) return 0;
      return Math.min(1, (k - 1.45) / 0.3);
    }

    // Render links
    const linkElements = linkGroup
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("class", "genre-network-link")
      .attr("stroke", "rgba(255, 255, 255, 0.12)")
      .attr("stroke-width", 1);

    // Populate node-to-link references for fast hover lookup
    linkElements.each(function (l) {
      const sId = l.source.id || l.source;
      const tId = l.target.id || l.target;
      if (nodeLinkMap.has(sId)) nodeLinkMap.get(sId).push(this);
      if (nodeLinkMap.has(tId)) nodeLinkMap.get(tId).push(this);
    });

    // Render nodes
    const nodeElements = nodeGroup
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", (d) => `genre-network-node ${d.isMajor ? "is-major" : "is-minor"}`);

    // Map DOM elements by node ID for instant lookup
    const nodeDomMap = new Map();
    nodeElements.each(function (d) {
      nodeDomMap.set(d.id, this);
    });

    // Draw node circles with Obsidian tone gradients
    nodeElements
      .append("circle")
      .attr("r", (d) => d.radius)
      .attr("class", "node-circle")
      .attr("fill", (d) => {
        if (d.isMajor) return "#f4f4f5";
        if (d.radius >= 11) return "#a1a1aa";
        return "#52525b";
      })
      .attr("stroke", (d) => {
        if (d.isMajor) return "rgba(255, 255, 255, 0.45)";
        if (d.radius >= 11) return "rgba(255, 255, 255, 0.2)";
        return "rgba(255, 255, 255, 0.08)";
      })
      .attr("stroke-width", (d) => (d.isMajor ? 1.5 : 1));

    // Render labels in separate top layer
    const labelElements = labelGroup
      .selectAll("text")
      .data(nodes)
      .enter()
      .append("text")
      .attr("class", (d) => {
        if (d.isMajor) return "genre-network-label label-tier-major";
        if (d.radius >= 11) return "genre-network-label label-tier-mid";
        return "genre-network-label label-tier-small";
      })
      .text((d) => d.name);

    const labelDomMap = new Map();
    labelElements.each(function (d) {
      labelDomMap.set(d.id, this);
    });

    function updateLabels() {
      labelElements.style("opacity", (d) => getLabelOpacity(d, currentK));
    }

    // Initial label visibility
    updateLabels();

    // Hover state management
    let isDragging = false;
    let highlightedElements = [];

    function clearHover() {
      gRoot.classed("has-hover", false);
      for (let i = 0; i < highlightedElements.length; i++) {
        const el = highlightedElements[i];
        el.classList.remove("highlighted");
        if (el.tagName === "text") {
          el.style.opacity = "";
        }
      }
      highlightedElements = [];
      updateLabels();
    }

    // Drag behavior with drag-lock to prevent glitching/flashing on hover
    nodeElements.call(
      d3
        .drag()
        .on("start", function (event, d) {
          isDragging = true;
          clearHover();
          svg.classed("is-dragging", true);
          d3.select(this).classed("is-dragged", true);

          if (!event.active) simulation.alphaTarget(0.15).restart();
          d.fx = d.x;
          d.fy = d.y;
          svg.attr("style", "display: block; cursor: grabbing; user-select: none;");
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", function (event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
          svg.attr("style", "display: block; cursor: grab; user-select: none;");

          svg.classed("is-dragging", false);
          d3.select(this).classed("is-dragged", false);

          // Keep drag flag active for a moment to prevent spurious mouseenter triggers
          setTimeout(() => {
            isDragging = false;
          }, 80);
        })
    );

    // Fast, optimized hover interactions: highlight nodes, links, and reveal text directly
    nodeElements
      .on("mouseenter", function (event, d) {
        if (isDragging) return;

        clearHover();
        gRoot.classed("has-hover", true);

        const neighbors = neighborMap.get(d.id);
        if (neighbors) {
          neighbors.forEach((nId) => {
            const nEl = nodeDomMap.get(nId);
            const lEl = labelDomMap.get(nId);
            if (nEl) {
              nEl.classList.add("highlighted");
              highlightedElements.push(nEl);
            }
            if (lEl) {
              lEl.classList.add("highlighted");
              lEl.style.opacity = "1";
              highlightedElements.push(lEl);
            }
          });
        }

        const connLinks = nodeLinkMap.get(d.id);
        if (connLinks) {
          connLinks.forEach((linkEl) => {
            linkEl.classList.add("highlighted");
            highlightedElements.push(linkEl);
          });
        }
      })
      .on("mouseleave", () => {
        if (isDragging) return;
        clearHover();
      });

    // Throttled zoom updates
    let zoomRaf = null;
    const zoom = d3
      .zoom()
      .scaleExtent([0.35, 4.0])
      .filter((event) => {
        if (event.type === "wheel") return event.ctrlKey || event.metaKey;
        return !event.button;
      })
      .on("zoom", (event) => {
        gRoot.attr("transform", event.transform);
        currentK = event.transform.k;
        if (!zoomRaf) {
          zoomRaf = requestAnimationFrame(() => {
            updateLabels();
            zoomRaf = null;
          });
        }
      });

    svg.call(zoom);

    // Double click to reset view
    svg.on("dblclick.zoom", () => {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    });

    // Highly optimized force simulation
    const simulation = d3
      .forceSimulation(nodes)
      .alphaDecay(0.04) // Settles rapidly to conserve CPU
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance((d) => (d.source.isMajor || d.target.isMajor ? 115 : 68))
          .strength(0.35)
      )
      .force(
        "charge",
        d3
          .forceManyBody()
          .strength((d) => (d.isMajor ? -520 : -95))
          .distanceMax(550)
      )
      .force(
        "collide",
        d3
          .forceCollide()
          .radius((d) => d.radius + 6.5)
          .strength(0.85)
      )
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(0.012))
      .force("y", d3.forceY(height / 2).strength(0.016));

    // Update positions on tick
    simulation.on("tick", () => {
      linkElements
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      nodeElements.attr("transform", (d) => `translate(${d.x},${d.y})`);
      labelElements.attr("transform", (d) => `translate(${d.x},${d.y + d.labelOffset})`);
    });

    // Window resize handler
    window.addEventListener("resize", () => {
      const dims = getScreenDimensions();
      width = dims.width;
      height = dims.height;
      container.style.height = `${height}px`;
      svg.attr("viewBox", `0 0 ${width} ${height}`);
      simulation.force("center", d3.forceCenter(width / 2, height / 2));
      simulation.force("x", d3.forceX(width / 2).strength(0.012));
      simulation.force("y", d3.forceY(height / 2).strength(0.016));
      simulation.alpha(0.15).restart();
    });
  }

  // Auto-mount when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGenreNetwork);
  } else {
    initGenreNetwork();
  }
})();
