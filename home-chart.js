// home-chart.js - Physics simulation for Last.fm most scrobbled albums (global & user)
(function () {
  const defaultPhysics = { attraction: -15, minDistance: 2, gravity: 0.07, sizeScale: 1.0, gravityDynamics: 1.0 };

  function getScrobblesPhysics() {
    if (window.__scrobblesPhysics) return window.__scrobblesPhysics;
    try {
      const saved = JSON.parse(localStorage.getItem("chartfm_scrobbles_physics") || "null");
      if (saved) return Object.assign({}, defaultPhysics, saved);
    } catch (e) {}
    return defaultPhysics;
  }

  function preloadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(false);
      const img = new Image();
      let done = false;
      img.onload = () => { if (!done) { done = true; resolve(true); } };
      img.onerror = () => { if (!done) { done = true; resolve(false); } };
      setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3500);
      img.referrerPolicy = "no-referrer";
      img.src = url;
      if (img.complete && img.naturalWidth > 0) {
        done = true;
        resolve(true);
      }
    });
  }

  function isGifImage(url) {
    if (!url || typeof url !== "string") return false;
    const clean = url.split("?")[0].split("#")[0].toLowerCase().trim();
    return clean.endsWith(".gif") || clean.includes(".gif");
  }

  // Look up a still replacement image (iTunes -> Last.fm search -> original fallback)
  async function resolveStillAlbumImage(artist, albumName, fallbackUrl) {
    const cleanArtist = (typeof artist === "object" ? (artist?.name || artist?.["#text"] || "") : (artist || "")).trim();
    const cleanAlbum = (albumName || "").trim();
    if (!cleanAlbum) return fallbackUrl;

    // 1. Try iTunes album search (free, open CORS, high-res still covers)
    try {
      const query = encodeURIComponent(`${cleanArtist} ${cleanAlbum}`);
      const res = await fetch(`https://itunes.apple.com/search?term=${query}&entity=album&limit=3`);
      if (res.ok) {
        const data = await res.json();
        const results = data?.results || [];
        for (const item of results) {
          const art = item?.artworkUrl100;
          if (art && !isGifImage(art)) {
            return art.replace("100x100bb.jpg", "600x600bb.jpg");
          }
        }
      }
    } catch (e) {}

    // 2. Try iTunes general search (singles, EPs)
    try {
      const query = encodeURIComponent(`${cleanArtist} ${cleanAlbum}`);
      const res = await fetch(`https://itunes.apple.com/search?term=${query}&limit=3`);
      if (res.ok) {
        const data = await res.json();
        const results = data?.results || [];
        for (const item of results) {
          const art = item?.artworkUrl100;
          if (art && !isGifImage(art)) {
            return art.replace("100x100bb.jpg", "600x600bb.jpg");
          }
        }
      }
    } catch (e) {}

    // 3. Try Last.fm album search for an alternative non-gif image
    try {
      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(cleanAlbum)}&api_key=${apiKey}&format=json&limit=6`);
      if (res.ok) {
        const data = await res.json();
        const matches = data?.results?.albummatches?.album || [];
        const matchList = Array.isArray(matches) ? matches : [matches];
        for (const m of matchList) {
          const imgs = m?.image || [];
          const imgList = Array.isArray(imgs) ? imgs : [imgs];
          const urls = imgList.map((i) => (i?.["#text"] || "").trim()).filter(Boolean);
          const validUrls = urls.filter((u) => !u.includes("2a96cbd8b46e442fc41c2b86b821562f") && !u.includes("noimage") && !isGifImage(u));
          if (validUrls.length) {
            return validUrls[validUrls.length - 1];
          }
        }
      }
    } catch (e) {}

    // 4. If none available, leave the original GIF
    return fallbackUrl;
  }

  // Preload album covers with progress callback until targetCount verified albums are ready
  async function preloadAlbumCovers(albums, targetCount, onProgress) {
    const verified = [];
    const remaining = albums.slice();
    const concurrency = 8;
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < remaining.length && verified.length < targetCount) {
        const alb = remaining[nextIdx++];
        if (!alb || !alb.image) continue;
        if (isGifImage(alb.image)) {
          alb.image = await resolveStillAlbumImage(alb.artist, alb.name, alb.image);
        }
        const ok = await preloadImage(alb.image);
        if (ok && verified.length < targetCount) {
          verified.push(alb);
          if (typeof onProgress === "function") {
            onProgress(verified.length, targetCount);
          }
        }
      }
    }

    const workerCount = Math.min(concurrency, remaining.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const verifiedSet = new Set(verified);
    const rest = remaining.filter((a) => !verifiedSet.has(a));
    return verified.concat(rest);
  }

  // Fetch top albums worldwide (candidate pool)
  async function fetchTopAlbums() {
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
      const artistUrl = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&api_key=${apiKey}&format=json&limit=160`;
      const artistRes = await fetch(artistUrl);
      const artistData = await artistRes.json();
      const artists = artistData?.artists?.artist || [];

      const albumPromises = artists.map(async (art, idx) => {
        try {
          const aName = encodeURIComponent(art.name);
          const aUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettopalbums&artist=${aName}&api_key=${apiKey}&format=json&limit=2`;
          const aRes = await fetch(aUrl);
          const aData = await aRes.json();
          const topalbs = aData?.topalbums?.album || [];
          const albumList = Array.isArray(topalbs) ? topalbs : [topalbs];
          for (const alb of albumList) {
            if (!alb) continue;
            const images = alb.image || [];
            const imgList = Array.isArray(images) ? images : [images];
            const urls = imgList.map((img) => (img?.["#text"] || "").trim()).filter(Boolean);
            const validUrls = urls.filter((u) => !u.includes("2a96cbd8b46e442fc41c2b86b821562f") && !u.includes("noimage"));
            if (!validUrls.length) continue;

            return {
              rank: idx + 1,
              name: alb.name || "",
              artist: art.name || "",
              playcount: Number(alb.playcount) || Number(art.playcount) || 0,
              image: validUrls[validUrls.length - 1]
            };
          }
          return null;
        } catch (err) {
          return null;
        }
      });

      const resolved = await Promise.all(albumPromises);
      return resolved.filter(Boolean);
    } catch (err) {
      console.error("Failed to fetch live Last.fm top albums", err);
      return [];
    }
  }

  const fetchTop50Albums = fetchTopAlbums;

  // Fetch top albums for a specific Last.fm user (candidate pool up to 200)
  async function fetchUserAlbums(username) {
    const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=200&period=overall`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.message || "User not found on Last.fm");
    }
    const rawAlbums = data?.topalbums?.album || [];
    if (!rawAlbums.length) {
      throw new Error("No scrobbled albums found for this user.");
    }

    const albums = [];
    for (const item of rawAlbums) {
      const images = item.image || [];
      const imgList = Array.isArray(images) ? images : [images];
      const urls = imgList.map((img) => (img?.["#text"] || "").trim()).filter(Boolean);
      const validUrls = urls.filter((u) => !u.includes("2a96cbd8b46e442fc41c2b86b821562f") && !u.includes("noimage"));
      if (!validUrls.length) continue;

      const artistName = item.artist?.name || (typeof item.artist === "string" ? item.artist : "Unknown Artist");
      albums.push({
        name: item.name || "Unknown Album",
        artist: artistName,
        playcount: Number(item.playcount) || 0,
        image: validUrls[validUrls.length - 1],
        url: item.url || "",
        user: username
      });
    }

    if (!albums.length) {
      throw new Error("No album artwork found for this user's scrobbles.");
    }

    // Replace any gif covers with still pictures if available
    const gifAlbums = albums.filter((a) => isGifImage(a.image));
    if (gifAlbums.length > 0) {
      await Promise.all(
        gifAlbums.map(async (alb) => {
          alb.image = await resolveStillAlbumImage(alb.artist, alb.name, alb.image);
        })
      );
    }

    return albums;
  }

  const fetchUserTop50Albums = fetchUserAlbums;

  // Album detail caching and modal display
  const albumDetailCache = new Map();

  async function fetchAlbumInfo(artist, albumName, username) {
    const key = username
      ? `${username.toLowerCase()}|${artist.toLowerCase()}|${albumName.toLowerCase()}`
      : `${artist.toLowerCase()}|${albumName.toLowerCase()}`;
    if (albumDetailCache.has(key)) return albumDetailCache.get(key);
    try {
      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      let url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(albumName)}&format=json`;
      if (username) {
        url += `&username=${encodeURIComponent(username)}`;
      }
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

  const userFavTrackCache = new Map();

  async function fetchUserFavoriteTrack(artist, albumName, username, albumInfo) {
    const key = `${username.toLowerCase()}|${artist.toLowerCase()}|${albumName.toLowerCase()}`;
    if (userFavTrackCache.has(key)) return userFavTrackCache.get(key);

    try {
      const rawTracks = albumInfo?.tracks?.track;
      if (!rawTracks) return null;
      const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
      if (!trackList.length) return null;

      const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
      // Check up to 15 tracks to keep response times fast and avoid API rate limiting
      const tracksToCheck = trackList.slice(0, 15);
      const trackPromises = tracksToCheck.map(async (t) => {
        try {
          const tUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(t.name)}&username=${encodeURIComponent(username)}&format=json`;
          const tRes = await fetch(tUrl);
          if (!tRes.ok) return null;
          const tData = await tRes.json();
          const cnt = Number(tData?.track?.userplaycount) || 0;
          return { name: t.name, playcount: cnt };
        } catch (e) {
          return null;
        }
      });

      const results = (await Promise.all(trackPromises)).filter(Boolean);
      if (!results.length) return null;

      results.sort((a, b) => b.playcount - a.playcount);
      const top = results[0];
      if (top && top.playcount > 0) {
        userFavTrackCache.set(key, top);
        return top;
      }
      return null;
    } catch (err) {
      console.warn("Could not determine user favorite track:", err);
      return null;
    }
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
    const rankBadge = album.rank
      ? (album.user
          ? `#${album.rank} on ${album.user}'s Last.fm`
          : (album.genre
              ? `#${album.rank} in ${album.genre} on Last.fm`
              : `#${album.rank} Worldwide on Last.fm`))
      : "Featured on Last.fm";

    const statsHtml = album.user
      ? `
        <div class="album-modal-stats stats-user-mode">
          <div class="album-modal-stat-box box-scrobbles">
            <div class="album-modal-stat-label">${album.user}'s Scrobbles</div>
            <div class="album-modal-stat-value">${playcountStr}</div>
          </div>
          <div class="album-modal-stat-box box-fav-track">
            <div class="album-modal-stat-label">Favorite Track</div>
            <div class="album-modal-stat-value fav-track-title" id="modal-fav-track">
              <span class="fav-track-name" style="color: #a1a1aa; font-weight: normal; font-size: 0.85rem;">loading favorite track...</span>
            </div>
          </div>
        </div>
      `
      : `
        <div class="album-modal-stats">
          <div class="album-modal-stat-box">
            <div class="album-modal-stat-label">Total Scrobbles</div>
            <div class="album-modal-stat-value" id="modal-scrobbles">${playcountStr}</div>
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
      `;

    const userLastFmUrl = album.user
      ? `https://www.last.fm/user/${encodeURIComponent(album.user)}/library/music/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)}`
      : `https://www.last.fm/music/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)}`;
    const userLastFmText = album.user
      ? `View on ${album.user}'s Last.fm &rarr;`
      : "View on Last.fm &rarr;";

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
      ${statsHtml}
      <div class="album-modal-wiki-title">About this album</div>
      <div class="album-modal-wiki" id="modal-wiki">Fetching description from Last.fm...</div>
      <div class="album-modal-footer">
        <a class="album-modal-lastfm-link" id="modal-lastfm-link" href="${userLastFmUrl}" target="_blank" rel="noopener">
          ${userLastFmText}
        </a>
      </div>
    `;

    modal.classList.add("active");

    if (isGifImage(imgUrl)) {
      resolveStillAlbumImage(artistName, albumName, imgUrl).then((still) => {
        if (still && still !== imgUrl) {
          const mImg = content.querySelector(".album-modal-img");
          if (mImg) mImg.src = still;
          album.image = still;
        }
      });
    }

    fetchAlbumInfo(artistName, albumName, album.user).then((info) => {
      if (!modal.classList.contains("active")) return;
      const listenersEl = document.getElementById("modal-listeners");
      const ratioEl = document.getElementById("modal-ratio");
      const tagsEl = document.getElementById("modal-tags");
      const wikiEl = document.getElementById("modal-wiki");
      const linkEl = document.getElementById("modal-lastfm-link");

      if (album.user) {
        fetchUserFavoriteTrack(artistName, albumName, album.user, info).then((fav) => {
          if (!modal.classList.contains("active")) return;
          const favEl = document.getElementById("modal-fav-track");
          if (!favEl) return;
          if (fav && fav.name && fav.playcount > 0) {
            favEl.setAttribute("title", `${fav.name} (${fav.playcount.toLocaleString()} plays)`);
            favEl.innerHTML = `
              <span class="fav-track-name">${fav.name}</span>
              <span class="fav-track-count">${fav.playcount.toLocaleString()} ${fav.playcount === 1 ? "play" : "plays"}</span>
            `;
          } else {
            favEl.innerHTML = `<span class="fav-track-name" style="color: #71717a; font-weight: normal; font-size: 0.85rem;">no track scrobbles recorded</span>`;
          }
        });
      }

      if (info) {
        const listenersNum = Number(info.listeners) || 0;
        const globalPlaycount = Number(info.playcount) || playcountNum;
        const scrobblesEl = document.getElementById("modal-scrobbles");
        if (scrobblesEl && globalPlaycount) {
          scrobblesEl.textContent = globalPlaycount.toLocaleString();
        }
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
        if (info.url && linkEl && !album.user) {
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

  // Shared simulation runner factory
  function createAlbumSimulation({
    mountElement,
    albums,
    titleText,
    subtitleText,
    onChangeUser,
    initialTargetCount = 50,
    tabName = "home"
  }) {
    let simulation = null;
    let nodes = [];
    let cancelled = false;
    let spawnTimer = null;
    let focusedItem = null;
    let targetCount = Math.max(5, initialTargetCount);

    // Each simulation owns its own instancePhysics
    // Home tab ALWAYS uses defaultPhysics; scrobbles tab uses customizable scrobblesPhysics
    let instancePhysics = Object.assign(
      {},
      tabName === "scrobbles" ? getScrobblesPhysics() : defaultPhysics
    );

    const nodeSize = 54;
    const getNodeGravity = (d) => {
      const dyn = instancePhysics.gravityDynamics !== undefined ? instancePhysics.gravityDynamics : 1.0;
      const scale = d?.size ? Math.pow(d.size / nodeSize, 2.8 * dyn) : 1;
      return instancePhysics.gravity * scale;
    };

    mountElement.innerHTML = `
      <div class="simulation-chart-container" style="position: relative; width: 100%; height: 100vh; min-height: 500px; margin: 0 auto; user-select: none; overflow: hidden; display: block;">
        <div class="simulation-header">
          <div class="simulation-title">${titleText}</div>
          <div class="simulation-subtitle">${subtitleText}</div>
        </div>
        <div class="chart-backdrop-overlay" style="position: absolute; inset: 0; background: rgba(0, 0, 0, 0.78); opacity: 0; pointer-events: none; transition: opacity 0.35s ease; z-index: 1000;"></div>
      </div>
    `;

    const container = mountElement.querySelector(".simulation-chart-container");
    const backdropOverlay = container.querySelector(".chart-backdrop-overlay");

    let width = Math.max(300, Math.floor(container.clientWidth || window.innerWidth));
    let height = Math.max(500, Math.floor(window.innerHeight));
    let centerY = (height + 120) / 2;
    container.style.height = `${height}px`;

    function updateDimensions() {
      if (!container || !container.isConnected) return;
      if (container.offsetWidth === 0 && container.offsetHeight === 0) return;
      width = Math.max(300, Math.floor(container.clientWidth || window.innerWidth));
      height = Math.max(500, Math.floor(window.innerHeight));
      centerY = (height + 120) / 2;
      container.style.height = `${height}px`;

      if (simulation) {
        simulation
          .force("center", d3.forceCenter(width / 2, centerY))
          .force("x", d3.forceX(width / 2).strength(getNodeGravity))
          .force("y", d3.forceY(centerY).strength(getNodeGravity));
        simulation.alpha(0.2).restart();
      }
    }

    window.addEventListener("resize", updateDimensions);

    // Candidate albums pool sorted by playcount descending
    const candidateAlbums = albums.slice().sort((a, b) => (Number(b.playcount) || 0) - (Number(a.playcount) || 0));
    candidateAlbums.forEach((alb, i) => { alb.rank = i + 1; });

    const playcounts = candidateAlbums.slice(0, 160).map((a) => Number(a.playcount) || 0);
    const minP = playcounts.length ? Math.min(...playcounts) : 0;
    const maxP = playcounts.length ? Math.max(...playcounts) : 1;
    const minSqrt = Math.sqrt(Math.max(0, minP));
    const maxSqrt = Math.sqrt(Math.max(0, maxP));

    function getAlbumSize(alb) {
      const p = Number(alb.playcount) || 0;
      const sqrtP = Math.sqrt(Math.max(0, p));
      const ratio = (maxSqrt - minSqrt > 0) ? (sqrtP - minSqrt) / (maxSqrt - minSqrt) : 0.5;
      const midSize = 54;
      const dyn = (instancePhysics.sizeScale !== undefined) ? instancePhysics.sizeScale : 1.0;
      const diff = (Math.pow(ratio, 1.15) * 70 - 28) * dyn;
      return Math.max(16, Math.min(130, Math.round(midSize + diff)));
    }

    const failedAlbumKeys = new Set();
    const prefetchedKeys = new Set();
    let candidateIndex = 0;

    function getAlbumKey(alb) {
      if (!alb) return "";
      const art = typeof alb.artist === "object" ? (alb.artist.name || "") : (alb.artist || "");
      return `${art.toLowerCase().trim()}||${(alb.name || "").toLowerCase().trim()}`;
    }

    function isAlbumValid(alb) {
      if (!alb || !alb.image) return false;
      const url = String(alb.image).trim();
      if (!url) return false;
      if (url.includes("2a96cbd8b46e442fc41c2b86b821562f") || url.includes("noimage")) return false;
      if (failedAlbumKeys.has(getAlbumKey(alb))) return false;
      return true;
    }

    // Warm the browser image cache in the background for upcoming candidate albums
    function prefetchCandidatesAhead(count = 25) {
      for (let i = candidateIndex; i < candidateAlbums.length && i < candidateIndex + count; i++) {
        const alb = candidateAlbums[i];
        if (isAlbumValid(alb)) {
          const key = getAlbumKey(alb);
          if (!prefetchedKeys.has(key)) {
            prefetchedKeys.add(key);
            const preload = new Image();
            preload.referrerPolicy = "no-referrer";
            preload.src = alb.image;
          }
        }
      }
    }

    // Pick next candidate with a valid cover URL
    function getNextCandidate() {
      while (candidateIndex < candidateAlbums.length) {
        const alb = candidateAlbums[candidateIndex++];
        if (isAlbumValid(alb)) {
          return alb;
        }
      }
      return null;
    }

    // Create D3 Force Simulation
    nodes = [];
    simulation = d3.forceSimulation(nodes)
      .force("center", d3.forceCenter(width / 2, centerY))
      .force("x", d3.forceX(width / 2).strength(getNodeGravity))
      .force("y", d3.forceY(centerY).strength(getNodeGravity))
      .force("charge", d3.forceManyBody().strength(instancePhysics.attraction).distanceMax(140))
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
            const s = (a.size + b.size) / 2 + instancePhysics.minDistance;
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

        const pad = 8;
        const topPad = 86;
        for (const d of nodes) {
          const half = d.size / 2;
          d.x = Math.max(half + pad, Math.min(width - half - pad, d.x));
          d.y = Math.max(half + topPad, Math.min(height - half - pad, d.y));
          if (d.el) {
            d.el.style.transform = `translate(${d.x - half}px, ${d.y - half}px)`;
          }
        }
      });

    if (backdropOverlay) {
      backdropOverlay.addEventListener("click", () => {
        if (focusedItem) {
          deactivateFocus(focusedItem.node, focusedItem.el);
        }
      });
      backdropOverlay.addEventListener("mouseenter", () => {
        if (focusedItem) {
          deactivateFocus(focusedItem.node, focusedItem.el);
        }
      });
    }

    container.addEventListener("mouseleave", () => {
      if (focusedItem) {
        deactivateFocus(focusedItem.node, focusedItem.el);
      }
    });

    function activateFocus(node, nodeEl, album) {
      if (focusedItem) deactivateFocus(focusedItem.node, focusedItem.el);
      focusedItem = { node, el: nodeEl, album };
      // Pin node position so it does not drift under cursor while reading/clicking
      node.fx = node.x;
      node.fy = node.y;

      if (backdropOverlay) {
        backdropOverlay.style.opacity = "1";
        backdropOverlay.style.pointerEvents = "auto";
        backdropOverlay.style.cursor = "pointer";
      }
      nodeEl.classList.add("album-focused");

      const isNearBottom = node.y > height * 0.55;
      const topOrBottom = isNearBottom
        ? `bottom: calc(50% + ${Math.round(node.size * 1.1 + 14)}px);`
        : `top: calc(50% + ${Math.round(node.size * 1.1 + 14)}px);`;

      const cardWidth = 260;
      const idealCenterX = Math.max(cardWidth / 2 + 16, Math.min(width - cardWidth / 2 - 16, node.x));
      const deltaX = Math.round(idealCenterX - node.x);

      const playcountStr = Number(album.playcount).toLocaleString();
      const rankSubtext = album.user ? `#${album.rank} on ${album.user}'s last.fm` : `#${album.rank} on last.fm`;

      const info = document.createElement("div");
      info.className = "album-focus-info";
      info.style.setProperty("--shift-x", `${deltaX}px`);
      info.style.cssText = `position: absolute; ${topOrBottom} left: 50%; width: ${cardWidth}px; text-align: center; color: #ffffff; pointer-events: auto; cursor: pointer; z-index: 1003; --shift-x: ${deltaX}px; animation: focusFadeIn 0.25s ease forwards;`;
      info.innerHTML = `
        <div style="font-weight: 700; font-size: 0.95rem; line-height: 1.25; margin-bottom: 2px; color: #ffffff; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.name}</div>
        <div style="font-size: 0.85rem; color: #ffffff; margin-bottom: 2px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.artist}</div>
        <div style="font-size: 0.8rem; color: #ffffff; margin-bottom: 3px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">scrobbled ${playcountStr} times</div>
        <div style="font-size: 0.76rem; color: #adb5bd; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${rankSubtext}</div>
        <div class="album-focus-hint">click to view album info &rarr;</div>
      `;
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        openAlbumModal(album);
        deactivateFocus(node, nodeEl);
      });
      nodeEl.appendChild(info);
    }

    function deactivateFocus(node, nodeEl) {
      if (focusedItem && (focusedItem.el === nodeEl || focusedItem.node === node || !nodeEl)) {
        focusedItem = null;
      }
      // Release pinned position safely
      if (node && !node.__isDragging) {
        node.fx = null;
        node.fy = null;
      }
      if (backdropOverlay) {
        backdropOverlay.style.opacity = "0";
        backdropOverlay.style.pointerEvents = "none";
        backdropOverlay.style.cursor = "default";
      }
      if (nodeEl) {
        nodeEl.classList.remove("album-focused");
        const info = nodeEl.querySelector(".album-focus-info");
        if (info) info.remove();
      }
    }

    function removeNode(node) {
      const idx = nodes.indexOf(node);
      if (idx !== -1) {
        nodes.splice(idx, 1);
      }
      if (focusedItem && focusedItem.node === node) {
        deactivateFocus(node, node.el);
      }
      if (node.el) {
        node.el.style.transition = "transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease";
        node.el.style.opacity = "0";
        node.el.style.transform += " scale(0.15)";
        setTimeout(() => {
          if (node.el && node.el.parentNode) {
            node.el.parentNode.removeChild(node.el);
          }
        }, 280);
      }
    }

    function addNode(album) {
      const size = getAlbumSize(album);
      const angle = (nodes.length * 0.6) + (Math.random() - 0.5) * 0.4;
      const dist = nodes.length < 5
        ? (15 + Math.random() * 20)
        : (75 + Math.sqrt(nodes.length) * 26 + Math.random() * 15);

      const node = {
        id: nodes.length + Math.random(),
        size: size,
        radius: (size * 0.5) + (instancePhysics.minDistance * 0.5),
        album: album,
        x: width / 2 + Math.cos(angle) * dist,
        y: centerY + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2
      };

      const nodeEl = document.createElement("div");
      nodeEl.className = "album-node";
      nodeEl.style.cssText = `position: absolute; top: 0; left: 0; width: ${size}px; height: ${size}px; cursor: grab; will-change: transform;`;

      const inner = document.createElement("div");
      inner.className = "album-card-inner";

      const img = document.createElement("img");
      img.referrerPolicy = "no-referrer";
      img.loading = "eager";
      img.decoding = "async";
      img.alt = album.name || "Album";
      img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";

      img.onerror = () => {
        // If image failed to load in the browser, skip this album entirely and add a replacement immediately
        const key = getAlbumKey(album);
        failedAlbumKeys.add(key);
        removeNode(node);
        simulation.nodes(nodes);
        simulation.alpha(0.3).restart();
        if (nodes.length < targetCount && !cancelled) {
          const replacement = getNextCandidate();
          if (replacement && !cancelled) {
            addNode(replacement);
            simulation.nodes(nodes);
            simulation.alpha(0.3).restart();
          }
        }
      };
      img.src = album.image;

      inner.appendChild(img);
      nodeEl.appendChild(inner);

      let hoverTimeout = null;
      let leaveTimeout = null;
      let isHovering = false;
      let isDragging = false;
      let dragMoved = false;

      node.__isDragging = false;
      nodeEl.__albumData = album;

      nodeEl.addEventListener("mouseenter", () => {
        isHovering = true;
        if (leaveTimeout) {
          clearTimeout(leaveTimeout);
          leaveTimeout = null;
        }
        // If another album is currently focused, dismiss it immediately
        if (focusedItem && focusedItem.el !== nodeEl) {
          deactivateFocus(focusedItem.node, focusedItem.el);
        }
        if (!nodeEl.classList.contains("album-focused") && !isDragging) {
          hoverTimeout = setTimeout(() => {
            if (isHovering && !isDragging) {
              activateFocus(node, nodeEl, album);
            }
          }, 320);
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
          }, 220);
        }
      });

      d3.select(nodeEl).call(
        d3.drag()
          .filter((event) => !event.ctrlKey && !event.button)
          .on("start", (event) => {
            isDragging = true;
            node.__isDragging = true;
            isHovering = false;
            dragMoved = false;
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
              hoverTimeout = null;
            }
            if (leaveTimeout) {
              clearTimeout(leaveTimeout);
              leaveTimeout = null;
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
            if (Math.abs(event.dx) > 3 || Math.abs(event.dy) > 3) {
              dragMoved = true;
            }
            node.fx = event.x;
            node.fy = event.y;
          })
          .on("end", (event) => {
            isDragging = false;
            node.__isDragging = false;
            if (!event.active) simulation.alphaTarget(0);
            if (!nodeEl.classList.contains("album-focused")) {
              node.fx = null;
              node.fy = null;
            }
            nodeEl.style.cursor = "grab";
            nodeEl.style.zIndex = "";
          })
      );

      nodeEl.addEventListener("click", (e) => {
        if (dragMoved) return;
        e.stopPropagation();
        openAlbumModal(album);
        if (nodeEl.classList.contains("album-focused")) {
          deactivateFocus(node, nodeEl);
        }
      });

      node.el = nodeEl;
      nodes.push(node);
      container.appendChild(nodeEl);
      simulation.nodes(nodes);
      simulation.alpha(0.65).restart();
    }

    let isSpawning = false;

    function spawnLoop() {
      if (cancelled || isSpawning || nodes.length >= targetCount) {
        return;
      }
      isSpawning = true;
      prefetchCandidatesAhead(30);

      function step() {
        if (cancelled || nodes.length >= targetCount) {
          isSpawning = false;
          spawnTimer = null;
          return;
        }

        const alb = getNextCandidate();
        if (!alb) {
          isSpawning = false;
          spawnTimer = null;
          return;
        }

        addNode(alb);
        prefetchCandidatesAhead(20);

        if (nodes.length < targetCount) {
          const progress = nodes.length / Math.max(1, targetCount);
          // Albums pop in slowly at first (~265ms), then load faster and faster down to ~14ms
          const delay = Math.round(14 + 250 * Math.pow(1 - progress, 2.5));
          spawnTimer = setTimeout(step, delay);
        } else {
          isSpawning = false;
          spawnTimer = null;
        }
      }

      step();
    }

    function setTargetCount(newCount) {
      targetCount = Math.max(5, Math.min(100, newCount));
      prefetchCandidatesAhead(35);

      if (nodes.length < targetCount) {
        spawnLoop();
      } else if (nodes.length > targetCount) {
        const excess = nodes.length - targetCount;
        const toRemove = nodes.slice().sort((a, b) => (b.album?.rank || 0) - (a.album?.rank || 0)).slice(0, excess);
        for (const n of toRemove) {
          removeNode(n);
        }
        simulation.nodes(nodes);
        simulation.alpha(0.35).restart();
      }
    }

    // Start initial spawn sequence
    spawnLoop();

    // Listen to physics adjustments from settings ONLY for scrobbles tab
    const onPhysicsChange = (e) => {
      if (tabName !== "scrobbles") return;
      const p = e?.detail?.physics || e?.detail || window.__scrobblesPhysics;
      if (!p || !simulation) return;
      instancePhysics = Object.assign({}, p);

      for (const d of nodes) {
        d.size = getAlbumSize(d.album);
        if (d.el) {
          d.el.style.width = `${d.size}px`;
          d.el.style.height = `${d.size}px`;
          const half = d.size / 2;
          d.el.style.transform = `translate(${d.x - half}px, ${d.y - half}px)`;
        }
        d.radius = (d.size * 0.5) + (instancePhysics.minDistance * 0.5);
      }
      simulation.force("charge", d3.forceManyBody().strength(instancePhysics.attraction).distanceMax(140));
      simulation.force("collide", d3.forceCollide().radius((d) => d.radius).strength(0.8).iterations(3));
      simulation.force("x", d3.forceX(width / 2).strength(getNodeGravity));
      simulation.force("y", d3.forceY(centerY).strength(getNodeGravity));
      simulation.alpha(0.35).restart();
    };

    if (tabName === "scrobbles") {
      window.addEventListener("chartfm-physics-change", onPhysicsChange);
    }

    function destroy() {
      cancelled = true;
      if (spawnTimer) {
        clearTimeout(spawnTimer);
        spawnTimer = null;
      }
      if (simulation) {
        simulation.stop();
        simulation = null;
      }
      window.removeEventListener("resize", updateDimensions);
      if (tabName === "scrobbles") {
        window.removeEventListener("chartfm-physics-change", onPhysicsChange);
      }
    }

    return {
      refresh: updateDimensions,
      destroy: destroy,
      setTargetCount: setTargetCount
    };
  }

  // --- Global Event Listener for Album Count Changes from Settings ---
  window.addEventListener("chartfm-count-change", (e) => {
    const detail = e.detail;
    if (!detail) return;
    if (detail.tab === "home" && homeInstance) {
      homeInstance.setTargetCount(detail.count);
    } else if (detail.tab === "scrobbles" && userInstance) {
      userInstance.setTargetCount(detail.count);
    }
  });

  // --- Mini Genre Simulation Factory ---
  function createMiniGenreSimulation({ mountElement, albums, genreName }) {
    if (!mountElement) return null;
    let nodes = [];
    let isSpawning = false;
    let spawnTimer = null;
    let cancelled = false;
    let focusedItem = null;

    let width = Math.max(200, mountElement.clientWidth || 340);
    let height = Math.max(200, mountElement.clientHeight || 440);
    let centerX = width / 2;
    let centerY = (height + 42) / 2;

    const simulation = d3
      .forceSimulation(nodes)
      .alphaDecay(0.02)
      .velocityDecay(0.38)
      .force("center", d3.forceCenter(centerX, centerY))
      .force("charge", d3.forceManyBody().strength(-15).distanceMax(140))
      .force("collide", d3.forceCollide((d) => (d.size * 0.5) + 2.5).strength(0.85).iterations(2))
      .force("x", d3.forceX(centerX).strength(0.065))
      .force("y", d3.forceY(centerY).strength(0.065));

    function updateDims() {
      if (!mountElement || !mountElement.isConnected) return;
      width = Math.max(200, mountElement.clientWidth || 340);
      height = Math.max(200, mountElement.clientHeight || 440);
      centerX = width / 2;
      centerY = (height + 42) / 2;
      simulation
        .force("center", d3.forceCenter(centerX, centerY))
        .force("x", d3.forceX(centerX).strength(0.065))
        .force("y", d3.forceY(centerY).strength(0.065));
      simulation.alpha(0.2).restart();
    }

    window.addEventListener("resize", updateDims);

    const backdropOverlay = document.createElement("div");
    backdropOverlay.className = "chart-backdrop-overlay";
    backdropOverlay.style.cssText = "position: absolute; inset: 0; background: rgba(0, 0, 0, 0.78); opacity: 0; pointer-events: none; transition: opacity 0.35s ease; z-index: 1000;";
    mountElement.appendChild(backdropOverlay);

    backdropOverlay.addEventListener("click", () => {
      if (focusedItem) deactivateMiniFocus(focusedItem.node, focusedItem.el);
    });

    mountElement.addEventListener("mouseleave", () => {
      if (focusedItem) deactivateMiniFocus(focusedItem.node, focusedItem.el);
    });

    function activateMiniFocus(node, nodeEl, album) {
      if (focusedItem) deactivateMiniFocus(focusedItem.node, focusedItem.el);
      focusedItem = { node, el: nodeEl, album };
      if (backdropOverlay) {
        backdropOverlay.style.opacity = "1";
        backdropOverlay.style.pointerEvents = "auto";
        backdropOverlay.style.cursor = "pointer";
      }
      nodeEl.classList.add("album-focused");

      const isNearBottom = node.y > height * 0.52;
      const topOrBottom = isNearBottom
        ? `bottom: calc(50% + ${Math.round(node.size * 0.95 + 10)}px);`
        : `top: calc(50% + ${Math.round(node.size * 0.95 + 10)}px);`;

      const cardWidth = 210;
      const idealCenterX = Math.max(cardWidth / 2 + 10, Math.min(width - cardWidth / 2 - 10, node.x));
      const deltaX = Math.round(idealCenterX - node.x);

      const playcountNum = Number(album.playcount) || 0;
      const playcountStr = playcountNum.toLocaleString();
      const rankSubtext = `#${album.rank} in ${genreName || "Genre"} on Last.fm`;

      const info = document.createElement("div");
      info.className = "album-focus-info mini-focus-info";
      info.style.setProperty("--shift-x", `${deltaX}px`);
      info.style.cssText = `position: absolute; ${topOrBottom} left: 50%; width: ${cardWidth}px; text-align: center; color: #ffffff; pointer-events: auto; cursor: pointer; z-index: 1003; --shift-x: ${deltaX}px; animation: focusFadeIn 0.22s ease forwards;`;
      info.innerHTML = `
        <div style="font-weight: 700; font-size: 0.88rem; line-height: 1.25; margin-bottom: 2px; color: #ffffff; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.name}</div>
        <div style="font-size: 0.78rem; color: #ffffff; margin-bottom: 2px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${album.artist}</div>
        ${playcountNum ? `<div style="font-size: 0.76rem; color: #ffffff; margin-bottom: 3px; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">scrobbled ${playcountStr} times</div>` : ""}
        <div style="font-size: 0.74rem; color: #adb5bd; text-shadow: 0 2px 8px rgba(0,0,0,0.95);">${rankSubtext}</div>
        <div class="album-focus-hint" style="font-size: 0.7rem;">click to view album info &rarr;</div>
      `;
      nodeEl.appendChild(info);
    }

    function deactivateMiniFocus(node, nodeEl) {
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

    simulation.on("tick", () => {
      const pad = 12;
      const topPad = 54;
      const btmPad = 12;
      for (const d of nodes) {
        const half = d.size / 2;
        d.x = Math.max(half + pad, Math.min(width - half - pad, d.x));
        d.y = Math.max(half + topPad, Math.min(height - half - btmPad, d.y));
        if (d.el) {
          d.el.style.transform = `translate(${d.x - half}px, ${d.y - half}px)`;
        }
      }
    });

    const targetList = (albums || []).slice(0, 25);
    const targetCount = targetList.length;

    function addMiniNode(album) {
      if (cancelled) return;
      const rank = album.rank || (nodes.length + 1);
      const size = Math.round(56 - ((rank - 1) / 24) * 22);
      const angle = Math.random() * Math.PI * 2;
      const dist = nodes.length < 3 ? 12 + Math.random() * 18 : 42 + Math.sqrt(nodes.length) * 14;

      const node = {
        id: nodes.length + Math.random(),
        size: size,
        album: album,
        x: centerX + Math.cos(angle) * dist,
        y: centerY + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5
      };

      const nodeEl = document.createElement("div");
      nodeEl.className = "album-node mini-album-node";
      nodeEl.style.cssText = `position: absolute; top: 0; left: 0; width: ${size}px; height: ${size}px; cursor: grab; will-change: transform;`;

      const inner = document.createElement("div");
      inner.className = "album-card-inner";

      const img = document.createElement("img");
      img.referrerPolicy = "no-referrer";
      img.loading = "lazy";
      img.alt = "";
      img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 3px; pointer-events: none; -webkit-user-drag: none; user-select: none;";
      img.src = album.image;

      inner.appendChild(img);
      nodeEl.appendChild(inner);

      let isDragging = false;
      let dragMoved = false;
      let isHovering = false;
      let hoverTimeout = null;
      let leaveTimeout = null;

      nodeEl.addEventListener("mouseenter", () => {
        isHovering = true;
        if (leaveTimeout) {
          clearTimeout(leaveTimeout);
          leaveTimeout = null;
        }
        if (!nodeEl.classList.contains("album-focused") && !isDragging) {
          hoverTimeout = setTimeout(() => {
            if (isHovering && !isDragging) {
              activateMiniFocus(node, nodeEl, album);
            }
          }, 320);
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
              deactivateMiniFocus(node, nodeEl);
            }
          }, 300);
        }
      });

      d3.select(nodeEl).call(
        d3.drag()
          .on("start", (event) => {
            isDragging = true;
            dragMoved = false;
            if (hoverTimeout) {
              clearTimeout(hoverTimeout);
              hoverTimeout = null;
            }
            if (nodeEl.classList.contains("album-focused")) {
              deactivateMiniFocus(node, nodeEl);
            }
            if (!event.active) simulation.alphaTarget(0.3).restart();
            node.fx = node.x;
            node.fy = node.y;
            nodeEl.style.cursor = "grabbing";
            nodeEl.style.zIndex = "50";
          })
          .on("drag", (event) => {
            if (Math.abs(event.dx) > 1 || Math.abs(event.dy) > 1) dragMoved = true;
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
        e.stopPropagation();
        openAlbumModal(album);
        if (nodeEl.classList.contains("album-focused")) {
          deactivateMiniFocus(node, nodeEl);
        }
      });

      node.el = nodeEl;
      nodes.push(node);
      mountElement.appendChild(nodeEl);
      simulation.nodes(nodes);
      simulation.alpha(0.55).restart();
    }

    function spawnMiniLoop() {
      if (cancelled || isSpawning || nodes.length >= targetCount) return;
      isSpawning = true;

      function step() {
        if (cancelled || nodes.length >= targetCount) {
          isSpawning = false;
          spawnTimer = null;
          return;
        }
        const alb = targetList[nodes.length];
        if (!alb) {
          isSpawning = false;
          spawnTimer = null;
          return;
        }
        addMiniNode(alb);
        if (nodes.length < targetCount) {
          const progress = nodes.length / Math.max(1, targetCount);
          const delay = Math.round(18 + 180 * Math.pow(1 - progress, 2.2));
          spawnTimer = setTimeout(step, delay);
        } else {
          isSpawning = false;
          spawnTimer = null;
        }
      }
      step();
    }

    spawnMiniLoop();

    return {
      destroy() {
        cancelled = true;
        if (spawnTimer) clearTimeout(spawnTimer);
        if (focusedItem) deactivateMiniFocus(focusedItem.node, focusedItem.el);
        simulation.stop();
        window.removeEventListener("resize", updateDims);
      }
    };
  }

  let genreSimInstances = [];

  async function initGenreSimulations() {
    let genreData = null;
    try {
      const res = await fetch("genres_top25.json");
      if (res.ok) {
        genreData = await res.json();
      }
    } catch (e) {
      console.warn("Could not load genres_top25.json", e);
    }
    if (!genreData) return;

    const genreNames = { rock: "Rock", electronic: "Electronic", pop: "Pop", indie: "Indie" };
    const genres = ["rock", "electronic", "pop", "indie"];
    for (const g of genres) {
      const mount = document.getElementById(`genre-sim-${g}`);
      const list = genreData[g];
      const gName = genreNames[g] || g;
      if (mount && list && list.length) {
        list.forEach((alb) => { alb.genre = gName; });
        const sim = createMiniGenreSimulation({ mountElement: mount, albums: list, genreName: gName });
        if (sim) genreSimInstances.push(sim);
      }
    }
  }

  // --- Home Tab Simulation Instance ---
  let homeInstance = null;
  let isHomeInitialized = false;

  window.initHomeTopAlbums = async function () {
    const homeView = document.getElementById("home-tab-view");
    if (!homeView || isHomeInitialized) return;
    isHomeInitialized = true;

    let chartContainer = homeView.querySelector("#home-chart-container");
    if (!chartContainer) {
      chartContainer = document.createElement("div");
      chartContainer.id = "home-chart-container";
      homeView.prepend(chartContainer);
    }

    chartContainer.innerHTML = `
      <div style="position: relative; width: 100%; height: 100vh; min-height: 500px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
        <div class="chart-loading-indicator" style="color: #a1a1aa; font-style: italic; font-size: 0.9rem; letter-spacing: 0.5px; pointer-events: none; user-select: none;">
          loading top albums<span class="loading-dot-1">.</span><span class="loading-dot-2">.</span><span class="loading-dot-3">.</span>
        </div>
        <div id="home-covers-progress" style="font-size: 0.8rem; color: #71717a; font-variant-numeric: tabular-nums;">
          0 / 50
        </div>
      </div>
    `;

    const albums = await fetchTopAlbums();
    if (!albums || !albums.length) {
      chartContainer.innerHTML = `<div style="text-align: center; color: #888; padding-top: 100px;">unable to load top albums currently.</div>`;
      return;
    }

    const initialCount = (window.__chartCounts && window.__chartCounts.home !== undefined) ? window.__chartCounts.home : 50;

    const homeProgressEl = chartContainer.querySelector("#home-covers-progress");
    const verifiedAlbums = await preloadAlbumCovers(albums, initialCount, (loaded, target) => {
      if (homeProgressEl) homeProgressEl.textContent = `${loaded} / ${target}`;
    });

    homeInstance = createAlbumSimulation({
      mountElement: chartContainer,
      albums: verifiedAlbums,
      titleText: "Last.fm's Top 50 Albums",
      subtitleText: "hover over an album for info, click on it to view more",
      initialTargetCount: initialCount,
      tabName: "home"
    });

    window.refreshHomeChartDimensions = homeInstance.refresh;

    // Initialize 2x2 top genres mini simulations
    initGenreSimulations();
  };

  // --- User Scrobbles Tab Simulation Instance ---
  let userInstance = null;

  window.initUserTopAlbums = async function (username, mountElement, onChangeUser) {
    if (userInstance) {
      userInstance.destroy();
      userInstance = null;
    }

    mountElement.innerHTML = `
      <div style="position: relative; width: 100%; height: 100vh; min-height: 500px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
        <div class="chart-loading-indicator" style="color: #a1a1aa; font-style: italic; font-size: 0.9rem; letter-spacing: 0.5px; pointer-events: none; user-select: none;">
          fetching ${username}'s scrobbles<span class="loading-dot-1">.</span><span class="loading-dot-2">.</span><span class="loading-dot-3">.</span>
        </div>
      </div>
    `;

    const albums = await fetchUserAlbums(username);
    if (!albums || !albums.length) {
      throw new Error("No album artwork found for this user's scrobbles.");
    }

    const initialCount = (window.__chartCounts && window.__chartCounts.scrobbles !== undefined) ? window.__chartCounts.scrobbles : 50;
    // Preload up to 100 candidate album covers so all 100 are ready before starting the simulation
    const preloadTarget = Math.min(100, albums.length);

    // Loading screen to preload all album covers before simulation pops in
    mountElement.innerHTML = `
      <div style="position: relative; width: 100%; height: 100vh; min-height: 500px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
        <div class="chart-loading-indicator" style="color: #a1a1aa; font-style: italic; font-size: 0.9rem; letter-spacing: 0.5px; pointer-events: none; user-select: none;">
          loading ${username}'s album covers<span class="loading-dot-1">.</span><span class="loading-dot-2">.</span><span class="loading-dot-3">.</span>
        </div>
        <div id="user-covers-progress" style="font-size: 0.8rem; color: #71717a; font-variant-numeric: tabular-nums;">
          0 / ${preloadTarget}
        </div>
      </div>
    `;

    const progressEl = mountElement.querySelector("#user-covers-progress");
    const verifiedAlbums = await preloadAlbumCovers(albums, preloadTarget, (loaded, target) => {
      if (progressEl) progressEl.textContent = `${loaded} / ${target}`;
    });

    userInstance = createAlbumSimulation({
      mountElement: mountElement,
      albums: verifiedAlbums,
      titleText: `${username.toLowerCase()}'s most scrobbled albums`,
      subtitleText: "hover over an album for info, click on it to view more",
      initialTargetCount: initialCount,
      tabName: "scrobbles",
      onChangeUser: () => {
        if (userInstance) {
          userInstance.destroy();
          userInstance = null;
        }
        if (typeof onChangeUser === "function") onChangeUser();
      }
    });

    window.refreshScrobblesChartDimensions = userInstance.refresh;
  };
})();
