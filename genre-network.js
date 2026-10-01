// genre-network.js - Force-directed Obsidian-style genre folksonomy network
(function () {
  const genreRankMap = new Map();
  const searchGenrePool = [];
  const randomGenrePool = [];

  function formatMetricNumber(num) {
    if (!num || isNaN(num)) return "0";
    if (num >= 1000000) {
      const val = (num / 1000000).toFixed(1);
      return val.endsWith(".0") ? `${Math.round(num / 1000000)}M` : `${val}M`;
    }
    if (num >= 1000) {
      const val = (num / 1000).toFixed(1);
      return val.endsWith(".0") ? `${Math.round(num / 1000)}K` : `${val}K`;
    }
    return String(num);
  }

  const albumPlaycountCache = new Map();
  async function getAlbumPlaycount(artist, album) {
    const key = `${(artist || "").toLowerCase()}|${(album || "").toLowerCase()}`;
    if (albumPlaycountCache.has(key)) return albumPlaycountCache.get(key);
    try {
      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&api_key=${apiKey}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const pc = Number(data?.album?.playcount) || 0;
        albumPlaycountCache.set(key, pc);
        return pc;
      }
    } catch {
      // fallback
    }
    return 0;
  }

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

    // Pre-calculate popularity ranking across the network
    const sortedNodes = [...data.nodes].sort((a, b) => (b.taggings || b.reach || 0) - (a.taggings || a.reach || 0));
    sortedNodes.forEach((node, index) => {
      genreRankMap.set(node.id.toLowerCase(), index + 1);
      genreRankMap.set(node.name.toLowerCase(), index + 1);
      const name = node.name || node.id;
      const lower = name.toLowerCase();
      const norm = lower.replace(/[^a-z0-9]/g, "");
      if (!searchGenrePool.some((g) => g.norm === norm)) {
        searchGenrePool.push({
          name: name,
          count: Number(node.taggings || node.reach) || 0,
          norm: norm
        });
      }
    });

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
    const defaultK = 0.8;
    let currentK = defaultK;
    let hasUserZoomed = false;

    function getInitialTransform(w, h) {
      return d3.zoomIdentity
        .translate(w / 2, h / 2)
        .scale(defaultK)
        .translate(-w / 2, -h / 2);
    }

    // Dynamic label visibility:
    // 1. Zoom out far (k <= 0.4): ALL labels fade away completely
    // 2. Base zoom (k ~ 0.8): Major hubs & mid-tier labels visible
    // 3. Zoom in (k >= 1.0): Medium subgenres reveal
    // 4. Zoom in deeper (k >= 1.3): Smallest subgenres reveal
    function getLabelOpacity(d, k) {
      // Zoom out far enough: every genre name fades away
      if (k <= 0.4) return 0;

      // Tier 1: Major hubs fade in between 0.4 and 0.65, fully visible above 0.65
      if (d.isMajor) {
        return Math.min(1, (k - 0.4) / 0.25);
      }

      // Tier 2: Mid-size subgenres (Alternative Rock, Heavy Metal, etc.)
      if (d.radius >= 11) {
        if (k < 0.65) return 0;
        return Math.min(1, (k - 0.65) / 0.25);
      }

      // Tier 3: Medium subgenres (Shoegaze, Post-Rock, etc.)
      if (d.radius >= 7.5) {
        if (k < 1.0) return 0;
        return Math.min(1, (k - 1.0) / 0.25);
      }

      // Tier 4: Smallest niche subgenres
      if (k < 1.3) return 0;
      return Math.min(1, (k - 1.3) / 0.3);
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

    // Draw node hitarea and circles with Obsidian tone gradients
    nodeElements
      .append("circle")
      .attr("r", (d) => Math.max(d.radius, 14))
      .attr("fill", "transparent")
      .attr("class", "node-hitarea");

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
    let dragMoved = false;
    nodeElements.call(
      d3
        .drag()
        .on("start", function (event, d) {
          dragMoved = false;
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
          if (Math.abs(event.dx) > 1 || Math.abs(event.dy) > 1) {
            dragMoved = true;
          }
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

    function activateHover(d) {
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
    }

    // Fast, optimized hover & click interactions on nodes
    nodeElements
      .on("mouseenter", function (event, d) {
        if (isDragging) return;
        activateHover(d);
      })
      .on("mouseleave", () => {
        if (isDragging) return;
        clearHover();
      })
      .on("click", function (event, d) {
        if (dragMoved) return;
        event.stopPropagation();
        selectGenreDetail(d);
      });

    // Label interactions: hoverable and clickable
    labelElements
      .style("cursor", "pointer")
      .style("pointer-events", "auto")
      .on("mouseenter", function (event, d) {
        if (isDragging) return;
        activateHover(d);
      })
      .on("mouseleave", () => {
        if (isDragging) return;
        clearHover();
      })
      .on("click", function (event, d) {
        event.stopPropagation();
        selectGenreDetail(d);
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
        if (event.sourceEvent) {
          hasUserZoomed = true;
        }
        if (!zoomRaf) {
          zoomRaf = requestAnimationFrame(() => {
            updateLabels();
            zoomRaf = null;
          });
        }
      });

    svg.call(zoom);
    svg.call(zoom.transform, getInitialTransform(width, height));

    // Double click to reset view
    svg.on("dblclick.zoom", () => {
      hasUserZoomed = false;
      svg.transition().duration(500).call(zoom.transform, getInitialTransform(width, height));
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
      if (!hasUserZoomed) {
        svg.call(zoom.transform, getInitialTransform(width, height));
      }
      simulation.force("center", d3.forceCenter(width / 2, height / 2));
      simulation.force("x", d3.forceX(width / 2).strength(0.012));
      simulation.force("y", d3.forceY(height / 2).strength(0.016));
      simulation.alpha(0.15).restart();
    });
  }

  let currentGenreSim = null;
  let genreDetailFetchId = 0;

  async function selectGenreDetail(genreNode) {
    if (!genreNode) return;
    if (typeof genreNode === "string") {
      genreNode = { id: genreNode, name: genreNode };
    }
    const section = document.getElementById("genre-detail-section");
    const titleEl = document.getElementById("genre-detail-title");
    const metaEl = document.getElementById("genre-detail-meta");
    const descEl = document.getElementById("genre-detail-description");
    const linkEl = document.getElementById("genre-detail-lastfm-link");
    const simTitleEl = document.getElementById("genre-sim-title");
    const simSubtitleEl = document.getElementById("genre-sim-subtitle");
    const simMount = document.getElementById("genre-detail-sim-container");

    if (!section || !titleEl || !simMount) return;

    const genreName = genreNode.name || genreNode.id;
    const genreTag = (genreNode.id || genreNode.name || "").toLowerCase();
    const rank = genreRankMap.get(genreTag) || genreRankMap.get((genreNode.name || "").toLowerCase()) || null;
    const rankBadgeEl = document.getElementById("genre-detail-tag-badge");

    // Make section visible
    section.style.display = "block";
    titleEl.textContent = genreName;
    if (rankBadgeEl) {
      rankBadgeEl.textContent = rank ? `#${rank} most popular genre` : "genre overview";
    }
    if (simTitleEl) simTitleEl.textContent = genreName;
    if (simSubtitleEl) simSubtitleEl.textContent = "fetching top albums from Last.fm...";
    if (metaEl) metaEl.innerHTML = `<span style="color: #71717a;">loading statistics...</span>`;
    if (descEl) descEl.innerHTML = `<p style="color: #71717a; font-style: italic;">fetching genre overview from Last.fm...</p>`;
    if (linkEl) {
      linkEl.href = `https://www.last.fm/tag/${encodeURIComponent(genreTag)}`;
      linkEl.textContent = `View "${genreName}" on Last.fm \u2192`;
    }

    if (currentGenreSim) {
      currentGenreSim.destroy();
      currentGenreSim = null;
    }
    simMount.innerHTML = `
      <div style="position: relative; width: 100%; height: 100%; min-height: 480px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
        <div class="chart-loading-indicator" style="color: #a1a1aa; font-style: italic; font-size: 0.9rem; letter-spacing: 0.5px; pointer-events: none; user-select: none;">
          loading ${genreName}'s top albums<span class="loading-dot-1">.</span><span class="loading-dot-2">.</span><span class="loading-dot-3">.</span>
        </div>
        <div id="genre-covers-progress" style="font-size: 0.8rem; color: #71717a; font-variant-numeric: tabular-nums;">
          0 / 25
        </div>
      </div>
    `;

    // Smoothly scroll down to genre detail section
    section.scrollIntoView({ behavior: "smooth", block: "start" });

    const thisFetchId = ++genreDetailFetchId;
    const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";

    const [infoRes, albumsRes] = await Promise.all([
      fetch(`https://ws.audioscrobbler.com/2.0/?method=tag.getinfo&tag=${encodeURIComponent(genreTag)}&api_key=${apiKey}&format=json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`https://ws.audioscrobbler.com/2.0/?method=tag.gettopalbums&tag=${encodeURIComponent(genreTag)}&api_key=${apiKey}&format=json&limit=40`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    ]);

    if (thisFetchId !== genreDetailFetchId) return;

    // Render metadata & wiki
    const reach = Number(infoRes?.tag?.reach || genreNode.reach || 0);

    function updateMeta(scrobblesNum) {
      if (!metaEl) return;
      const parts = [];
      if (reach) parts.push(`<span><strong>${formatMetricNumber(reach)}</strong> listeners</span>`);
      if (typeof scrobblesNum === "number" && scrobblesNum > 0) {
        parts.push(`<span><strong>${formatMetricNumber(scrobblesNum)}</strong> scrobbles</span>`);
      } else if (scrobblesNum === null) {
        parts.push(`<span style="color: #71717a;">calculating scrobbles...</span>`);
      }
      metaEl.innerHTML = parts.join(`<span style="opacity: 0.35;">&bull;</span>`);
    }

    updateMeta(null);

    let wikiText = infoRes?.tag?.wiki?.content || infoRes?.tag?.wiki?.summary || "";
    wikiText = wikiText.replace(/<a\b[^>]*>(.*?)<\/a>\.?/gi, "").trim();
    wikiText = wikiText.replace(/User-contributed text is available under the Creative Commons.*/gi, "").trim();
    wikiText = wikiText.replace(/\s*\.\s*$/g, ".").replace(/\.{2,}$/g, ".").trim();
    wikiText = wikiText.replace(/\s+\./g, ".");

    if (descEl) {
      const paragraphs = wikiText
        ? wikiText.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && p !== ".")
        : [];
      if (paragraphs.length > 0) {
        descEl.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join("");
      } else {
        descEl.innerHTML = `<p style="color: #a1a1aa; font-style: italic;">There is no description available for this genre on Last.FM.</p>`;
      }
    }

    // Process top albums
    const rawAlbums = albumsRes?.albums?.album || [];
    const albumList = Array.isArray(rawAlbums) ? rawAlbums : (rawAlbums ? [rawAlbums] : []);
    const validAlbums = [];

    for (const item of albumList) {
      if (!item) continue;
      const images = item.image || [];
      const imgList = Array.isArray(images) ? images : [images];
      const urls = imgList.map((img) => (img?.["#text"] || "").trim()).filter(Boolean);
      const validUrls = urls.filter((u) => !u.includes("2a96cbd8b46e442fc41c2b86b821562f") && !u.includes("noimage"));
      if (!validUrls.length) continue;

      const artistName = typeof item.artist === "object" ? item.artist?.name : (item.artist || "Unknown Artist");
      validAlbums.push({
        rank: validAlbums.length + 1,
        name: item.name || "Unknown Album",
        artist: artistName,
        genre: genreName,
        image: validUrls[validUrls.length - 1],
        url: item.url || "",
        playcount: Number(item.playcount) || 0
      });

      if (validAlbums.length >= 40) break;
    }

    // Fetch individual album playcounts in parallel to calculate total scrobbles across top albums
    Promise.all(
      validAlbums.slice(0, 25).map(async (alb) => {
        const pc = await getAlbumPlaycount(alb.artist, alb.name);
        alb.playcount = pc;
        return pc;
      })
    ).then((counts) => {
      if (thisFetchId !== genreDetailFetchId) return;
      const sum = counts.reduce((acc, c) => acc + c, 0);
      updateMeta(sum);
    });

    const targetCount = Math.min(25, validAlbums.length);
    const progressEl = simMount.querySelector("#genre-covers-progress");

    let verifiedAlbums = validAlbums;
    if (typeof window.preloadAlbumCovers === "function" && validAlbums.length > 0) {
      verifiedAlbums = await window.preloadAlbumCovers(validAlbums, targetCount, (loaded, target) => {
        if (progressEl) progressEl.textContent = `${loaded} / ${target}`;
      });
    }

    if (thisFetchId !== genreDetailFetchId) return;

    simMount.innerHTML = "";
    if (verifiedAlbums.length > 0 && typeof window.createMiniGenreSimulation === "function") {
      currentGenreSim = window.createMiniGenreSimulation({
        mountElement: simMount,
        albums: verifiedAlbums,
        genreName: genreName
      });
    } else {
      simMount.innerHTML = `
        <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #a1a1aa; font-size: 0.9rem;">
          No album covers available for this tag.
        </div>
      `;
    }
  }

  function clearGenreDetail() {
    genreDetailFetchId++;
    if (currentGenreSim) {
      currentGenreSim.destroy();
      currentGenreSim = null;
    }
    const section = document.getElementById("genre-detail-section");
    if (section) {
      section.style.display = "none";
    }
  }

  window.selectGenreDetail = selectGenreDetail;
  window.clearGenreDetail = clearGenreDetail;

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function findBestMatch(query) {
    const raw = (query || "").trim();
    if (!raw) return null;
    const qLower = raw.toLowerCase();
    const qNorm = qLower.replace(/[^a-z0-9]/g, "");
    if (!qNorm) return null;

    // 1. Exact normalized matches (e.g. "trip hop" vs "trip-hop" vs "triphop")
    const exactNorm = searchGenrePool.filter((g) => g.norm === qNorm);
    if (exactNorm.length > 0) {
      exactNorm.sort((a, b) => b.count - a.count);
      return exactNorm[0].name;
    }

    // 2. Prefix matches (starts with), sorted by popularity
    const prefixMatches = searchGenrePool.filter((g) => g.norm.startsWith(qNorm));
    if (prefixMatches.length > 0) {
      prefixMatches.sort((a, b) => b.count - a.count);
      return prefixMatches[0].name;
    }

    // 3. Substring matches, sorted by popularity
    const subMatches = searchGenrePool.filter((g) => g.norm.includes(qNorm));
    if (subMatches.length > 0) {
      subMatches.sort((a, b) => b.count - a.count);
      return subMatches[0].name;
    }

    return null;
  }

  async function loadGlobalGenres() {
    try {
      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      const res = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=tag.gettoptags&api_key=${apiKey}&format=json&num_res=1000`
      );
      if (!res.ok) return;
      const data = await res.json();
      const tags = data?.toptags?.tag || [];

      const ignoreWords = new Set([
        "seen live", "favorites", "favourites", "loved", "all", "awesome", "fip", "sexy",
        "female vocalists", "male vocalists", "female vocalist", "male vocalist", "check out",
        "my music", "albums i own", "owned", "tracks i love", "songs i love", "spotify",
        "heard on pandora", "under 2000 listeners", "beautiful", "love", "sad", "party",
        "good", "great", "cool", "epic", "favorite", "favourite", "favorite songs",
        "favorites tracks", "favourite tracks", "favorite albums", "favourite albums",
        "masterpiece", "relaxing", "sleep", "study", "workout", "driving", "summer", "chillout"
      ]);
      const noiseRegex = /^(seen live|albums i own|songs i|tracks i|under \d+|heard on|\d{4}s?$)/i;

      tags.forEach((t, idx) => {
        const name = (t.name || "").trim();
        const lower = name.toLowerCase();
        if (!genreRankMap.has(lower)) {
          genreRankMap.set(lower, idx + 1);
        }
        if (
          name.length >= 2 &&
          !ignoreWords.has(lower) &&
          !noiseRegex.test(lower) &&
          !lower.includes("loved")
        ) {
          randomGenrePool.push(name);
          const norm = lower.replace(/[^a-z0-9]/g, "");
          const count = Number(t.count) || 0;
          const existing = searchGenrePool.find((g) => g.norm === norm);
          if (!existing) {
            searchGenrePool.push({ name, count, norm });
          } else if (count > existing.count) {
            existing.name = name;
            existing.count = count;
          }
        }
      });
    } catch (err) {
      console.warn("Could not load global tags pool:", err);
    }
  }

  function handleRandomGenre() {
    let pool = randomGenrePool;
    if (!pool || pool.length === 0) {
      const networkNodes = Array.from(genreRankMap.keys());
      if (networkNodes.length > 0) {
        pool = networkNodes;
      }
    }
    if (!pool || pool.length === 0) return;

    const randomIndex = Math.floor(Math.random() * pool.length);
    const chosenName = pool[randomIndex];
    selectGenreDetail({ name: chosenName, id: chosenName });
  }

  function setupRandomGenreBtn() {
    const randomBtn = document.getElementById("random-genre-btn");
    if (randomBtn && !randomBtn.dataset.bound) {
      randomBtn.dataset.bound = "true";
      randomBtn.addEventListener("click", handleRandomGenre);
    }
  }

  function setupGenreSearch() {
    const input = document.getElementById("genre-search-input");
    const ghost = document.getElementById("genre-search-ghost");
    if (!input || input.dataset.bound) return;
    input.dataset.bound = "true";

    let currentMatch = null;

    function updateAutofill() {
      const val = input.value;
      if (!val || !val.trim()) {
        currentMatch = null;
        if (ghost) ghost.innerHTML = "";
        return;
      }

      currentMatch = findBestMatch(val);

      if (currentMatch) {
        // Apple style inline completion:
        // When the match starts with the typed text (case-insensitive)
        if (currentMatch.toLowerCase().startsWith(val.toLowerCase())) {
          const matchSuffix = currentMatch.slice(val.length);
          if (ghost) {
            ghost.innerHTML = `<span style="visibility: hidden;">${escapeHtml(val)}</span><span>${escapeHtml(matchSuffix)}</span>`;
          }
        } else {
          if (ghost) ghost.innerHTML = "";
        }
      } else {
        if (ghost) ghost.innerHTML = "";
      }
    }

    function triggerSearch(genreName) {
      const target = (genreName || currentMatch || input.value || "").trim();
      if (!target) return;
      selectGenreDetail({ name: target, id: target });
      input.blur();
      if (ghost) ghost.innerHTML = "";
    }

    input.addEventListener("input", updateAutofill);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        if (currentMatch && currentMatch.toLowerCase() !== input.value.toLowerCase()) {
          e.preventDefault();
          input.value = currentMatch;
          updateAutofill();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const trimmed = input.value.trim();
        if (!trimmed) {
          clearGenreDetail();
          input.blur();
          if (ghost) ghost.innerHTML = "";
          return;
        }
        const target = currentMatch || trimmed;
        if (target) {
          input.value = target;
          triggerSearch(target);
        }
      }
    });
  }

  // Auto-mount when DOM is ready
  function initAll() {
    initGenreNetwork();
    setupRandomGenreBtn();
    setupGenreSearch();
    loadGlobalGenres();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
