// home-chart.js - Top 50 albums on Last.fm visualization for the home tab
(function () {
  let simulation = null;
  let nodes = [];
  let cancelled = false;
  let spawnTimer = null;
  let container = null;
  let isInitialized = false;

  const defaultPhysics = { attraction: -15, minDistance: 2, gravity: 0.07 };

  function getPhysics() {
    if (window.__chartPhysics) return window.__chartPhysics;
    try {
      const saved = JSON.parse(localStorage.getItem("chartfm_physics") || "null");
      if (saved) return Object.assign({}, defaultPhysics, saved);
    } catch (e) {}
    return defaultPhysics;
  }

  let currentPhysics = Object.assign({}, getPhysics());
  if (!window.__chartPhysics) {
    window.__chartPhysics = Object.assign({}, currentPhysics);
  }

  const calcRadius = (size, dist) => (size * 0.5) + (dist * 0.5);
  const nodeSize = 64;
  let radius = calcRadius(nodeSize, currentPhysics.minDistance);
  const getNodeGravity = (d) => {
    // Intense gravity scaling: larger albums experience significantly stronger pull
    const scale = d?.size ? Math.pow(d.size / nodeSize, 2.8) : 1;
    return currentPhysics.gravity * scale;
  };

  async function fetchTop50Albums() {
    // 1. Try local top50.json first for instant zero-latency loading
    try {
      const res = await fetch("top50.json");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return data;
        }
      }
    } catch (e) {
      console.warn("Could not load local top50.json, attempting live API fetch...", e);
    }

    // 2. Fallback to live Last.fm API
    try {
      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      const artistUrl = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&api_key=${apiKey}&format=json&limit=55`;
      const artistRes = await fetch(artistUrl);
      const artistData = await artistRes.json();
      const artists = artistData?.artists?.artist || [];

      const albumPromises = artists.map(async (art, idx) => {
        try {
          const aName = encodeURIComponent(art.name);
          const aUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettopalbums&artist=${aName}&api_key=${apiKey}&format=json&limit=1`;
          const aRes = await fetch(aUrl);
          const aData = await aRes.json();
          const alb = aData?.topalbums?.album?.[0];
          if (!alb) return null;

          const images = alb.image || [];
          const imgList = Array.isArray(images) ? images : [images];
          const urls = imgList.map((img) => (img?.["#text"] || "").trim()).filter(Boolean);
          const validUrls = urls.filter((u) => !u.includes("2a96cbd8b46e442fc41c2b86b821562f") && !u.includes("noimage"));
          if (!validUrls.length) return null;

          return {
            rank: idx + 1,
            name: alb.name || "",
            artist: art.name || "",
            playcount: alb.playcount || art.playcount || 0,
            image: validUrls[validUrls.length - 1]
          };
        } catch (err) {
          return null;
        }
      });

      const resolved = await Promise.all(albumPromises);
      return resolved.filter(Boolean).slice(0, 50);
    } catch (err) {
      console.error("Failed to fetch live Last.fm top albums", err);
      return [];
    }
  }

  function preloadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(false);
      const img = new Image();
      let done = false;
      img.onload = () => { if (!done) { done = true; resolve(true); } };
      img.onerror = () => { if (!done) { done = true; resolve(false); } };
      setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3500);
      img.src = url;
    });
  }

  window.initHomeTopAlbums = async function () {
    const homeView = document.getElementById("home-tab-view");
    if (!homeView || isInitialized) return;
    isInitialized = true;

    homeView.innerHTML = `
      <div id="home-chart-container" style="position: relative; width: 100%; height: calc(100vh - 30px); min-height: 500px; margin: 0 auto; user-select: none; overflow: hidden; display: block;">
        <div class="chart-backdrop-overlay" style="position: absolute; inset: 0; background: rgba(0, 0, 0, 0.78); opacity: 0; pointer-events: none; transition: opacity 0.35s ease; z-index: 1000;"></div>
        <div class="chart-loading-indicator" style="position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%); color: #888; font-style: italic; font-size: 0.88rem; letter-spacing: 0.5px; pointer-events: none; user-select: none;">
          loading<span class="loading-dot-1">.</span><span class="loading-dot-2">.</span><span class="loading-dot-3">.</span>
        </div>
      </div>
    `;

    container = document.getElementById("home-chart-container");
    const backdropOverlay = container.querySelector(".chart-backdrop-overlay");
    const loadingIndicator = container.querySelector(".chart-loading-indicator");

    let width = Math.max(300, Math.floor(container.clientWidth || window.innerWidth));
    let height = Math.max(450, Math.floor(window.innerHeight - 30));
    container.style.height = `${height}px`;

    function updateDimensions() {
      if (!container || !container.isConnected) return;
      if (container.offsetWidth === 0 && container.offsetHeight === 0) return;
      width = Math.max(300, Math.floor(container.clientWidth || window.innerWidth));
      height = Math.max(450, Math.floor(window.innerHeight - 30));
      container.style.height = `${height}px`;

      if (simulation) {
        simulation
          .force("center", d3.forceCenter(width / 2, height / 2))
          .force("x", d3.forceX(width / 2).strength(getNodeGravity))
          .force("y", d3.forceY(height / 2).strength(getNodeGravity));
        simulation.alpha(0.2).restart();
      }
    }

    window.refreshHomeChartDimensions = updateDimensions;
    window.addEventListener("resize", updateDimensions);

    // Fetch the top 50 albums
    const albums = await fetchTop50Albums();
    if (!albums || !albums.length) {
      if (loadingIndicator) {
        loadingIndicator.textContent = "unable to load top albums currently.";
      }
      return;
    }

    // Preload album artwork in parallel
    const verifiedAlbums = [];
    await Promise.all(
      albums.map(async (alb) => {
        const ok = await preloadImage(alb.image);
        if (ok) verifiedAlbums.push(alb);
      })
    );

    // Sort by playcount descending (most popular first) and assign rank
    verifiedAlbums.sort((a, b) => (Number(b.playcount) || 0) - (Number(a.playcount) || 0));
    verifiedAlbums.forEach((alb, i) => alb.rank = i + 1);
    const finalAlbums = verifiedAlbums.slice(0, 50);

    const playcounts = finalAlbums.map((a) => Number(a.playcount) || 0);
    const minP = Math.min(...playcounts);
    const maxP = Math.max(...playcounts);
    const minSqrt = Math.sqrt(Math.max(0, minP));
    const maxSqrt = Math.sqrt(Math.max(0, maxP));

    function getAlbumSize(alb) {
      const p = Number(alb.playcount) || 0;
      const sqrtP = Math.sqrt(Math.max(0, p));
      const ratio = (maxSqrt - minSqrt > 0) ? (sqrtP - minSqrt) / (maxSqrt - minSqrt) : 0.5;
      // Intense dynamic sizing between 32px and 118px
      return Math.round(32 + Math.pow(ratio, 1.15) * 86);
    }

    if (loadingIndicator) loadingIndicator.remove();

    // Create D3 Force Simulation
    nodes = [];
    simulation = d3.forceSimulation(nodes)
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(getNodeGravity))
      .force("y", d3.forceY(height / 2).strength(getNodeGravity))
      .force("charge", d3.forceManyBody().strength(currentPhysics.attraction).distanceMax(140))
      .force("collide", d3.forceCollide().radius((d) => d.radius).strength(0.8).iterations(3))
      .on("tick", () => {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            const s = (a.size + b.size) / 2 + currentPhysics.minDistance;
            if (absX < s && absY < s) {
              const ox = s - absX;
              const oy = s - absY;
              const signX = dx >= 0 ? 1 : -1;
              const signY = dy >= 0 ? 1 : -1;
              if (ox < oy) {
                if (a.fx == null && b.fx == null) {
                  a.x -= (ox / 2) * signX;
                  b.x += (ox / 2) * signX;
                } else if (a.fx == null) {
                  a.x -= ox * signX;
                } else if (b.fx == null) {
                  b.x += ox * signX;
                }
              } else {
                if (a.fx == null && b.fx == null) {
                  a.y -= (oy / 2) * signY;
                  b.y += (oy / 2) * signY;
                } else if (a.fx == null) {
                  a.y -= oy * signY;
                } else if (b.fx == null) {
                  b.y += oy * signY;
                }
              }
            }
          }
        }

        const pad = 28;
        for (const d of nodes) {
          const half = d.size / 2;
          d.x = Math.max(half + pad, Math.min(width - half - pad, d.x));
          d.y = Math.max(half + pad, Math.min(height - half - pad, d.y));
          if (d.el) {
            d.el.style.transform = `translate(${d.x - half}px, ${d.y - half}px)`;
          }
        }
      });

    let focusedItem = null;

    if (backdropOverlay) {
      backdropOverlay.addEventListener("click", () => {
        if (focusedItem) {
          deactivateFocus(focusedItem.node, focusedItem.el);
        }
      });
    }

    function activateFocus(node, nodeEl, album) {
      if (focusedItem) deactivateFocus(focusedItem.node, focusedItem.el);
      focusedItem = { node, el: nodeEl, album };
      if (backdropOverlay) {
        backdropOverlay.style.opacity = "1";
        backdropOverlay.style.pointerEvents = "auto";
        backdropOverlay.style.cursor = "pointer";
      }
      nodeEl.classList.add("album-focused");

      const isNearBottom = node.y > height * 0.65;
      const topOrBottom = isNearBottom
        ? `bottom: calc(50% + ${Math.round(node.size * 1.1 + 14)}px);`
        : `top: calc(50% + ${Math.round(node.size * 1.1 + 14)}px);`;

      const playcountStr = Number(album.playcount).toLocaleString();

      const info = document.createElement("div");
      info.className = "album-focus-info";
      info.style.cssText = `position: absolute; ${topOrBottom} left: 50%; transform: translateX(-50%); width: 280px; text-align: center; color: #ffffff; pointer-events: auto; cursor: pointer; z-index: 1003; animation: focusFadeIn 0.25s ease forwards;`;
      info.innerHTML = `
        <div style="font-weight: 700; font-size: 0.95rem; line-height: 1.25; margin-bottom: 2px; color: #ffffff; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.name}</div>
        <div style="font-size: 0.85rem; color: #ffffff; margin-bottom: 2px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.artist}</div>
        <div style="font-size: 0.8rem; color: #ffffff; margin-bottom: 3px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">scrobbled ${playcountStr} times</div>
        <div style="font-size: 0.76rem; color: #adb5bd; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">#${album.rank} on last.fm</div>
        <div class="album-focus-hint">click to view album info &rarr;</div>
      `;
      nodeEl.appendChild(info);
    }

    function deactivateFocus(node, nodeEl) {
      if (focusedItem && focusedItem.el === nodeEl) {
        focusedItem = null;
      }
      if (backdropOverlay) {
        backdropOverlay.style.opacity = "0";
        backdropOverlay.style.pointerEvents = "none";
      }
      nodeEl.classList.remove("album-focused");
      const info = nodeEl.querySelector(".album-focus-info");
      if (info) info.remove();
    }

    const albumDetailCache = new Map();

    async function fetchAlbumInfo(artist, albumName) {
      const key = `${artist.toLowerCase()}|${albumName.toLowerCase()}`;
      if (albumDetailCache.has(key)) return albumDetailCache.get(key);
      try {
        const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
        const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(albumName)}&format=json`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data && data.album) {
            albumDetailCache.set(key, data.album);
            return data.album;
          }
        }
      } catch (err) {
        console.warn("Could not fetch Last.fm album details:", err);
      }
      return null;
    }

    let modalBackdropEl = null;

    function ensureAlbumModal() {
      if (modalBackdropEl) return modalBackdropEl;
      modalBackdropEl = document.createElement("div");
      modalBackdropEl.className = "album-modal-backdrop";
      modalBackdropEl.innerHTML = `
        <div class="album-modal-card">
          <button class="album-modal-close" aria-label="Close modal">&times;</button>
          <div class="album-modal-content"></div>
        </div>
      `;
      modalBackdropEl.querySelector(".album-modal-close").addEventListener("click", closeAlbumModal);
      modalBackdropEl.addEventListener("click", (e) => {
        if (e.target === modalBackdropEl) closeAlbumModal();
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modalBackdropEl.classList.contains("active")) {
          closeAlbumModal();
        }
      });
      document.body.appendChild(modalBackdropEl);
      return modalBackdropEl;
    }

    function closeAlbumModal() {
      if (modalBackdropEl) modalBackdropEl.classList.remove("active");
    }

    function openAlbumModal(album) {
      const modal = ensureAlbumModal();
      const content = modal.querySelector(".album-modal-content");
      const artistName = typeof album.artist === "object" ? (album.artist.name || album.artist["#text"] || "Unknown Artist") : (album.artist || "Unknown Artist");
      const albumName = album.name || "Unknown Album";
      const imgUrl = (typeof album.image === "string" ? album.image : "") || (Array.isArray(album.image) ? (album.image[3]?.["#text"] || album.image[2]?.["#text"] || album.image[0]?.["#text"]) : "") || "";
      const playcountNum = Number(album.playcount) || 0;
      const playcountStr = playcountNum.toLocaleString();
      const rankBadge = album.rank ? `#${album.rank} Worldwide on Last.fm` : "Featured on Last.fm";

      content.innerHTML = `
        <div class="album-modal-header">
          <img class="album-modal-img" src="${imgUrl}" alt="${albumName}" />
          <div class="album-modal-meta">
            <div class="album-modal-rank">${rankBadge}</div>
            <h2 class="album-modal-title">${albumName}</h2>
            <div class="album-modal-artist">${artistName}</div>
            <div class="album-modal-tags" id="modal-tags">
              <span class="album-modal-tag">loading tags...</span>
            </div>
          </div>
        </div>
        <div class="album-modal-stats">
          <div class="album-modal-stat-box">
            <div class="album-modal-stat-label">Total Scrobbles</div>
            <div class="album-modal-stat-value">${playcountStr}</div>
          </div>
          <div class="album-modal-stat-box">
            <div class="album-modal-stat-label">Total Listeners</div>
            <div class="album-modal-stat-value" id="modal-listeners">...</div>
          </div>
          <div class="album-modal-stat-box">
            <div class="album-modal-stat-label">Plays / Listener</div>
            <div class="album-modal-stat-value" id="modal-ratio">...</div>
          </div>
        </div>
        <div class="album-modal-wiki-title">About this album</div>
        <div class="album-modal-wiki" id="modal-wiki">Fetching description from Last.fm...</div>
        <div class="album-modal-footer">
          <a class="album-modal-lastfm-link" id="modal-lastfm-link" href="https://www.last.fm/music/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)}" target="_blank" rel="noopener">
            View on Last.fm &rarr;
          </a>
        </div>
      `;

      modal.classList.add("active");

      fetchAlbumInfo(artistName, albumName).then((info) => {
        if (!modal.classList.contains("active")) return;
        const listenersEl = document.getElementById("modal-listeners");
        const ratioEl = document.getElementById("modal-ratio");
        const tagsEl = document.getElementById("modal-tags");
        const wikiEl = document.getElementById("modal-wiki");
        const linkEl = document.getElementById("modal-lastfm-link");

        if (info) {
          const listenersNum = Number(info.listeners) || 0;
          const globalPlaycount = Number(info.playcount) || playcountNum;
          if (listenersEl) {
            listenersEl.textContent = listenersNum ? listenersNum.toLocaleString() : "N/A";
          }
          if (ratioEl) {
            if (listenersNum > 0 && globalPlaycount > 0) {
              ratioEl.textContent = (globalPlaycount / listenersNum).toFixed(1);
            } else {
              ratioEl.textContent = "N/A";
            }
          }
          if (info.tags?.tag && tagsEl) {
            const tags = Array.isArray(info.tags.tag) ? info.tags.tag : [info.tags.tag];
            tagsEl.innerHTML = tags.slice(0, 5).map((t) => `<span class="album-modal-tag">${t.name}</span>`).join("");
          } else if (tagsEl) {
            tagsEl.innerHTML = `<span class="album-modal-tag">album</span>`;
          }
          if (info.wiki?.summary && wikiEl) {
            const clean = info.wiki.summary.replace(/<a\b[^>]*>(.*?)<\/a>/gi, "").trim();
            wikiEl.textContent = clean;
          } else if (wikiEl) {
            wikiEl.textContent = "No description available on Last.fm for this album.";
          }
          if (info.url && linkEl) {
            linkEl.href = info.url;
          }
        } else {
          if (listenersEl) listenersEl.textContent = "N/A";
          if (ratioEl) ratioEl.textContent = "N/A";
          if (tagsEl) tagsEl.innerHTML = `<span class="album-modal-tag">album</span>`;
          if (wikiEl) wikiEl.textContent = "Unable to load Last.fm description.";
        }
      });
    }

    window.openAlbumModal = openAlbumModal;

    let nextAlbumIndex = 0;

    function addNode(album) {
      const size = getAlbumSize(album);
      const angle = (nodes.length * 0.6) + (Math.random() - 0.5) * 0.4;
      // First albums pop in middle; subsequent albums pop around outer circle
      const dist = nodes.length < 5
        ? (15 + Math.random() * 20)
        : (75 + Math.sqrt(nodes.length) * 26 + Math.random() * 15);

      const node = {
        id: nodes.length,
        size: size,
        radius: (size * 0.5) + (currentPhysics.minDistance * 0.5),
        album: album,
        x: width / 2 + Math.cos(angle) * dist,
        y: height / 2 + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2
      };

      const nodeEl = document.createElement("div");
      nodeEl.className = "album-node";
      nodeEl.style.cssText = `position: absolute; top: 0; left: 0; width: ${size}px; height: ${size}px; cursor: grab; will-change: transform;`;

      const inner = document.createElement("div");
      inner.className = "album-card-inner";

      const img = document.createElement("img");
      img.src = album.image;
      img.alt = album.name;
      img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";
      inner.appendChild(img);
      nodeEl.appendChild(inner);

      let hoverTimeout = null;
      let leaveTimeout = null;
      let isHovering = false;
      let isDragging = false;
      let dragMoved = false;

      nodeEl.__albumData = album;

      nodeEl.addEventListener("mouseenter", () => {
        isHovering = true;
        if (leaveTimeout) {
          clearTimeout(leaveTimeout);
          leaveTimeout = null;
        }
        if (!nodeEl.classList.contains("album-focused") && !isDragging) {
          hoverTimeout = setTimeout(() => {
            if (isHovering && !isDragging) {
              activateFocus(node, nodeEl, album);
            }
          }, 380);
        }
      });

      nodeEl.addEventListener("mouseleave", () => {
        isHovering = false;
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        if (nodeEl.classList.contains("album-focused")) {
          leaveTimeout = setTimeout(() => {
            if (!isHovering && nodeEl.classList.contains("album-focused")) {
              deactivateFocus(node, nodeEl);
            }
          }, 350);
        }
      });

      d3.select(nodeEl).call(
        d3.drag()
          .filter((event) => {
            // When the album is focused with the shadow overlay, do NOT drag!
            // This leaves mousedown and click free for opening album info.
            if (nodeEl.classList.contains("album-focused")) {
              return false;
            }
            return !event.ctrlKey && !event.button;
          })
          .on("start", (event) => {
            isDragging = true;
            dragMoved = false;
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
              hoverTimeout = null;
            }
            if (nodeEl.classList.contains("album-focused")) {
              deactivateFocus(node, nodeEl);
            }
            if (!event.active) simulation.alphaTarget(0.3).restart();
            node.fx = node.x;
            node.fy = node.y;
            nodeEl.style.cursor = "grabbing";
            nodeEl.style.zIndex = "50";
          })
          .on("drag", (event) => {
            if (Math.abs(event.dx) > 1 || Math.abs(event.dy) > 1) {
              dragMoved = true;
            }
            node.fx = event.x;
            node.fy = event.y;
          })
          .on("end", (event) => {
            isDragging = false;
            if (!event.active) simulation.alphaTarget(0);
            node.fx = null;
            node.fy = null;
            nodeEl.style.cursor = "grab";
            nodeEl.style.zIndex = "";
          })
      );

      nodeEl.addEventListener("click", (e) => {
        if (dragMoved) return;
        if (nodeEl.classList.contains("album-focused")) {
          e.stopPropagation();
          openAlbumModal(album);
          deactivateFocus(node, nodeEl);
        }
      });

      node.el = nodeEl;
      nodes.push(node);
      container.appendChild(nodeEl);
      simulation.nodes(nodes);
      simulation.alpha(0.65).restart();
    }

    function addNextNode() {
      if (nextAlbumIndex >= finalAlbums.length) return;
      const alb = finalAlbums[nextAlbumIndex++];
      addNode(alb);
    }

    function spawnStep() {
      if (cancelled || nodes.length >= finalAlbums.length) {
        spawnTimer = null;
        return;
      }
      addNextNode();
      if (nodes.length >= finalAlbums.length) {
        spawnTimer = null;
        return;
      }
      const progress = nodes.length / finalAlbums.length;
      const delay = Math.round(15 + 465 * Math.pow(1 - progress, 2.4));
      spawnTimer = setTimeout(spawnStep, delay);
    }

    spawnStep();

    // Listen to physics adjustments from settings tab
    const onPhysicsChange = (e) => {
      const p = e?.detail || window.__chartPhysics;
      if (!p || !simulation) return;
      currentPhysics = Object.assign({}, p);
      for (const d of nodes) {
        d.radius = (d.size * 0.5) + (currentPhysics.minDistance * 0.5);
      }
      simulation.force("charge", d3.forceManyBody().strength(currentPhysics.attraction).distanceMax(140));
      simulation.force("collide", d3.forceCollide().radius((d) => d.radius).strength(0.8).iterations(3));
      simulation.force("x", d3.forceX(width / 2).strength(getNodeGravity));
      simulation.force("y", d3.forceY(height / 2).strength(getNodeGravity));
      simulation.alpha(0.35).restart();
    };

    window.addEventListener("chartfm-physics-change", onPhysicsChange);
  };
})();
