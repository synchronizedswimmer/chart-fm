// artist-orbit.js - Album Solar System Orbit visualization with Planet Jump Animation
(function () {
  const apiKey = "b914193d6c62aabcd83adf2b6c457a5f";
  const defaultArtist = "Radiohead";
  const defaultAlbum = "OK Computer";

  let animFrameId = null;
  let isRunning = false;
  let currentCenter = {
    album: defaultAlbum,
    artist: defaultArtist,
    image: ""
  };
  let orbitingBodies = [];
  let pendingBodies = null;
  let orbitCanvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let isHoveringNode = null;
  let isHoveringCenter = false;
  let mousePos = { x: -1000, y: -1000 };

  // Jump Animation Transition State
  let transitionState = null;
  let newBodiesFadeAlpha = 1.0;

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Cache to avoid refetching
  const cache = new Map();

  function isValidCoverUrl(url) {
    if (!url || typeof url !== "string") return false;
    const u = url.trim();
    if (!u) return false;
    if (
      u.includes("2a96cbd8b46e442fc41c2b86b821562f") ||
      u.includes("4128a6012f5249679470c0e7197799b3") ||
      u.includes("noimage") ||
      u.includes("default_album") ||
      u.includes("placeholder") ||
      u.endsWith("/avatar170s/") ||
      u.endsWith(".gif")
    ) {
      return false;
    }
    return true;
  }

  function getAlbumCoverFromList(images) {
    if (typeof images === "string" && isValidCoverUrl(images)) return images;
    if (!Array.isArray(images)) return "";
    const large = images[3]?.["#text"] || images[2]?.["#text"] || images[1]?.["#text"] || "";
    return isValidCoverUrl(large) ? large : "";
  }

  async function fetchRecommendedAlbums(artistName, albumName) {
    const cleanArtist = (artistName || defaultArtist).trim();
    const cleanAlbum = (albumName || defaultAlbum).trim();
    const cacheKey = `${cleanArtist.toLowerCase()}|${cleanAlbum.toLowerCase()}`;

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    try {
      const results = [];
      const seen = new Set();
      seen.add(cleanAlbum.toLowerCase());

      // 1. Fetch sister albums by the SAME artist
      try {
        const topAlbumsRes = await fetch(
          `https://ws.audioscrobbler.com/2.0/?method=artist.gettopalbums&artist=${encodeURIComponent(cleanArtist)}&api_key=${apiKey}&format=json&limit=6`
        );
        const topData = await topAlbumsRes.json();
        const rawList = topData?.topalbums?.album || [];
        const albumList = Array.isArray(rawList) ? rawList : [rawList];

        for (const item of albumList) {
          if (!item?.name) continue;
          const lower = item.name.trim().toLowerCase();
          if (seen.has(lower)) continue;

          const cover = getAlbumCoverFromList(item.image);
          if (!cover) continue;

          seen.add(lower);
          results.push({
            album: item.name.trim(),
            artist: cleanArtist,
            image: cover,
            match: 0.98,
            type: "sister",
            playcount: Number(item.playcount) || 0
          });
          if (results.length >= 2) break;
        }
      } catch (err) {
        console.warn("Could not fetch sister albums:", err);
      }

      // 2. Fetch recommended albums from SIMILAR artists
      try {
        const simUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(cleanArtist)}&api_key=${apiKey}&format=json&limit=10`;
        const simRes = await fetch(simUrl);
        const simData = await simRes.json();
        const rawArtists = simData?.similarartists?.artist || [];
        const simArtists = (Array.isArray(rawArtists) ? rawArtists : [rawArtists]).slice(0, 7);

        const simAlbumPromises = simArtists.map(async (art) => {
          try {
            const aUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettopalbums&artist=${encodeURIComponent(art.name)}&api_key=${apiKey}&format=json&limit=3`;
            const aRes = await fetch(aUrl);
            const aData = await aRes.json();
            const albums = aData?.topalbums?.album || [];
            const aList = Array.isArray(albums) ? albums : [albums];
            const valid = aList.find((a) => a?.name && getAlbumCoverFromList(a.image));
            if (!valid) return null;

            return {
              album: valid.name.trim(),
              artist: art.name,
              image: getAlbumCoverFromList(valid.image),
              match: parseFloat(art.match) || 0.75,
              type: "similar",
              playcount: Number(valid.playcount) || 0
            };
          } catch {
            return null;
          }
        });

        const simResults = (await Promise.all(simAlbumPromises)).filter(Boolean);
        for (const sim of simResults) {
          const lower = sim.album.toLowerCase();
          if (!seen.has(lower)) {
            seen.add(lower);
            results.push(sim);
          }
        }
      } catch (err) {
        console.warn("Could not fetch similar artists albums:", err);
      }

      cache.set(cacheKey, results);
      return results;
    } catch (err) {
      console.warn("Error fetching recommended albums:", err);
      return [];
    }
  }

  // Preload images into Image objects
  const imageCache = new Map();
  function getImage(src) {
    if (!src) return null;
    if (imageCache.has(src)) return imageCache.get(src);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    imageCache.set(src, img);
    return img;
  }

  // Sort albums by similarity, assign dedicated radius per album, and scale size by match
  function setupOrbitBodies(albumList) {
    const bodies = [];
    if (!albumList || albumList.length === 0) return bodies;

    // 1. Sort by similarity descending (highest match closest to center)
    const sorted = [...albumList]
      .sort((a, b) => (b.match || 0.5) - (a.match || 0.5))
      .slice(0, 7); // keep top 6-7 clean orbits

    const count = sorted.length;
    // Dedicated radius for each planet: from 0.19 to 0.44 of minDim
    const minRadius = 0.19;
    const maxRadius = 0.44;

    sorted.forEach((item, index) => {
      const radiusRatio = count === 1 
        ? 0.28 
        : minRadius + (index / Math.max(1, count - 1)) * (maxRadius - minRadius);

      // Keplerian orbital speed: inner orbits move faster than outer ones
      const speed = 0.0075 / Math.sqrt(1 + index * 0.75);

      // Stagger angles so planets are evenly spread around the sun
      const baseAngle = (index / count) * Math.PI * 2 + (index * 0.9);

      // Scale planet size based on similarity match: 34px (lower similarity) to 58px (highest similarity)
      const matchScore = Math.max(0.2, Math.min(1.0, item.match || 0.6));
      const planetDiameter = Math.round(34 + matchScore * 24);

      bodies.push({
        ...item,
        orbitIndex: index,
        baseRadiusRatio: radiusRatio,
        speed: speed,
        angle: baseAngle,
        size: planetDiameter,
        imgEl: getImage(item.image)
      });
    });

    return bodies;
  }

  function drawOrbitRings(cx, cy, minDim) {
    if (!orbitingBodies || orbitingBodies.length === 0) return;

    orbitingBodies.forEach((body) => {
      const r = minDim * body.baseRadiusRatio;
      const isBodyHovered = isHoveringNode === body;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = isBodyHovered ? "rgba(56, 189, 248, 0.45)" : "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = isBodyHovered ? 1.6 : 1.0;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  function drawSun(cx, cy, sunRadius, centerData, isHovered = false) {
    if (!centerData) return;

    // Sun Radial Glow
    const glowScale = isHovered ? 1.9 : 1.7;
    const gradient = ctx.createRadialGradient(cx, cy, sunRadius * 0.7, cx, cy, sunRadius * glowScale);
    gradient.addColorStop(0, isHovered ? "rgba(255, 255, 255, 0.3)" : "rgba(255, 255, 255, 0.22)");
    gradient.addColorStop(0.5, isHovered ? "rgba(125, 211, 252, 0.12)" : "rgba(230, 230, 255, 0.06)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, sunRadius * glowScale, 0, Math.PI * 2);
    ctx.fill();

    // Center Image
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, sunRadius, 0, Math.PI * 2);
    ctx.clip();
    const sunImg = getImage(centerData.image);
    if (sunImg && sunImg.complete && sunImg.naturalWidth > 0) {
      ctx.drawImage(sunImg, cx - sunRadius, cy - sunRadius, sunRadius * 2, sunRadius * 2);
    } else {
      ctx.fillStyle = "#27272a";
      ctx.fill();
    }
    ctx.restore();

    // Sun border
    ctx.beginPath();
    ctx.arc(cx, cy, sunRadius, 0, Math.PI * 2);
    ctx.strokeStyle = isHovered ? "#38bdf8" : "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = isHovered ? 3 : 2.5;
    ctx.stroke();
  }

  function drawSunLabels(cx, cy, sunRadius, album, artist, isHovered = false) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const displayAlbum = (album || "").length > 28 ? album.slice(0, 26) + "…" : (album || "");

    // Highlight text on hover
    ctx.font = "bold 15px Inter, system-ui, sans-serif";
    ctx.fillStyle = isHovered ? "#38bdf8" : "#ffffff";
    ctx.fillText(displayAlbum, cx, cy + sunRadius + 10);

    // Subtle underline on hover to signal clickability
    if (isHovered) {
      const textW = ctx.measureText(displayAlbum).width;
      ctx.beginPath();
      ctx.moveTo(cx - textW / 2, cy + sunRadius + 27);
      ctx.lineTo(cx + textW / 2, cy + sunRadius + 27);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = isHovered ? "#bae6fd" : "#a1a1aa";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(artist || "", cx, cy + sunRadius + 30);
  }

  function drawBodies(cx, cy, minDim, isFading = false) {
    let hovered = null;

    orbitingBodies.forEach((body) => {
      body.angle += body.speed;
      const r = minDim * body.baseRadiusRatio;
      const px = cx + Math.cos(body.angle) * r;
      const py = cy + Math.sin(body.angle) * r;
      body.currentX = px;
      body.currentY = py;

      // Check hover only if not in transition
      if (!isFading && !transitionState) {
        const dist = Math.hypot(mousePos.x - px, mousePos.y - py);
        if (dist <= body.size / 2 + 6) hovered = body;
      }

      const isHovered = hovered === body;
      const renderSize = isHovered ? body.size * 1.25 : body.size;
      const radius = renderSize / 2;

      // Planet Glow on hover
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(px, py, radius * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
        ctx.fill();
      }

      // Planet Album Image
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.clip();
      if (body.imgEl && body.imgEl.complete && body.imgEl.naturalWidth > 0) {
        ctx.drawImage(body.imgEl, px - radius, py - radius, renderSize, renderSize);
      } else {
        ctx.fillStyle = "#3f3f46";
        ctx.fill();
      }
      ctx.restore();

      // Planet Border
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.strokeStyle = isHovered ? "#ffffff" : "rgba(255, 255, 255, 0.28)";
      ctx.lineWidth = isHovered ? 2.2 : 1.2;
      ctx.stroke();

      // Tooltip on Hover
      if (isHovered) {
        const matchLabel = body.type === "sister" ? "Same Artist" : `${Math.round(body.match * 100)}% match`;
        const line1 = body.album.length > 25 ? body.album.slice(0, 23) + "…" : body.album;
        const line2 = `by ${body.artist} · ${matchLabel}`;

        ctx.font = "bold 12px Inter, system-ui, sans-serif";
        const w1 = ctx.measureText(line1).width;
        ctx.font = "11px Inter, system-ui, sans-serif";
        const w2 = ctx.measureText(line2).width;

        const maxW = Math.max(w1, w2);
        const pad = 10;
        const boxW = maxW + pad * 2;
        const boxH = 40;
        const boxX = px - boxW / 2;
        const boxY = py - radius - boxH - 8;

        ctx.fillStyle = "rgba(18, 18, 22, 0.94)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = "bold 12px Inter, system-ui, sans-serif";
        ctx.fillText(line1, px, boxY + 6);

        ctx.fillStyle = "#a1a1aa";
        ctx.font = "11px Inter, system-ui, sans-serif";
        ctx.fillText(line2, px, boxY + 22);
      }
    });

    if (!isFading) {
      isHoveringNode = hovered;
    }
  }

  function draw() {
    if (!ctx || !orbitCanvas) return;
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const sunRadius = Math.max(48, minDim * 0.078);

    // Center hover detection (circle + title/artist labels)
    const distToCenter = Math.hypot(mousePos.x - cx, mousePos.y - cy);
    const isOverSunCircle = distToCenter <= sunRadius;
    const isOverSunText = Math.abs(mousePos.x - cx) <= 170 && mousePos.y >= cy + sunRadius + 6 && mousePos.y <= cy + sunRadius + 48;
    isHoveringCenter = !transitionState && (isOverSunCircle || isOverSunText);

    if (transitionState) {
      const now = performance.now();
      const elapsed = now - transitionState.startTime;
      const progress = Math.min(1, elapsed / transitionState.duration);
      const ease = easeInOutCubic(progress);

      const currX = transitionState.startX + (transitionState.targetX - transitionState.startX) * ease;
      const currY = transitionState.startY + (transitionState.targetY - transitionState.startY) * ease;
      const currR = transitionState.startRadius + (transitionState.targetRadius - transitionState.startRadius) * ease;

      // 1. Draw old orbital tracks and planets fading out
      const fadeOut = Math.max(0, 1 - ease * 1.6);
      if (fadeOut > 0) {
        ctx.save();
        ctx.globalAlpha = fadeOut;
        drawOrbitRings(cx, cy, minDim);
        drawBodies(cx, cy, minDim, true);
        ctx.restore();
      }

      // 2. Draw old Sun fading out into space
      const oldSunFade = Math.max(0, 1 - ease * 1.5);
      if (oldSunFade > 0 && transitionState.oldCenter) {
        ctx.save();
        ctx.globalAlpha = oldSunFade;
        drawSun(cx, cy, sunRadius * (1 - ease * 0.2), transitionState.oldCenter, false);
        ctx.restore();
      }

      // 3. Stardust trail behind the flying planet
      transitionState.trail.push({ x: currX, y: currY, r: currR * 0.75 });
      if (transitionState.trail.length > 12) transitionState.trail.shift();

      transitionState.trail.forEach((pt, i) => {
        const trAlpha = (i / transitionState.trail.length) * 0.28 * (1 - progress * 0.5);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * (0.6 + 0.4 * (i / transitionState.trail.length)), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${trAlpha})`;
        ctx.fill();
      });

      // 4. Gravitational shockwave ring expanding as the planet reaches the center
      if (progress > 0.5) {
        const waveP = (progress - 0.5) / 0.5;
        const waveR = sunRadius + waveP * minDim * 0.42;
        const waveAlpha = (1 - waveP) * 0.45;
        ctx.beginPath();
        ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${waveAlpha})`;
        ctx.lineWidth = Math.max(1, 3 * (1 - waveP));
        ctx.stroke();
      }

      // 5. Draw the Flying Planet (morphing and expanding into the new Sun)
      const glowScale = 1.0 + ease * 0.7;
      const gradient = ctx.createRadialGradient(currX, currY, currR * 0.7, currX, currY, currR * 1.7 * glowScale);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${0.18 + ease * 0.18})`);
      gradient.addColorStop(0.5, "rgba(230, 230, 255, 0.06)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(currX, currY, currR * 1.7 * glowScale, 0, Math.PI * 2);
      ctx.fill();

      // Flying Planet Image
      ctx.save();
      ctx.beginPath();
      ctx.arc(currX, currY, currR, 0, Math.PI * 2);
      ctx.clip();
      const pImg = getImage(transitionState.image) || transitionState.imgEl;
      if (pImg && pImg.complete && pImg.naturalWidth > 0) {
        ctx.drawImage(pImg, currX - currR, currY - currR, currR * 2, currR * 2);
      } else {
        ctx.fillStyle = "#3f3f46";
        ctx.fill();
      }
      ctx.restore();

      // Flying Planet border
      ctx.beginPath();
      ctx.arc(currX, currY, currR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + ease * 0.35})`;
      ctx.lineWidth = 1.5 + ease * 1.2;
      ctx.stroke();

      // Center title text fading in
      if (progress > 0.4) {
        const textAlpha = (progress - 0.4) / 0.6;
        ctx.save();
        ctx.globalAlpha = textAlpha;
        drawSunLabels(cx, cy, sunRadius, transitionState.album, transitionState.artist, false);
        ctx.restore();
      }

      if (progress >= 1) {
        transitionState = null;
        newBodiesFadeAlpha = 0;
        if (pendingBodies) {
          orbitingBodies = pendingBodies;
          pendingBodies = null;
        }
      }
    } else {
      // Normal rendering
      drawOrbitRings(cx, cy, minDim);
      drawSun(cx, cy, sunRadius, currentCenter, isHoveringCenter);
      drawSunLabels(cx, cy, sunRadius, currentCenter.album, currentCenter.artist, isHoveringCenter);

      // Smooth fade-in of newly spawned planets
      if (newBodiesFadeAlpha < 1.0) {
        newBodiesFadeAlpha = Math.min(1.0, newBodiesFadeAlpha + 0.04);
      }
      ctx.save();
      ctx.globalAlpha = newBodiesFadeAlpha;
      drawBodies(cx, cy, minDim);
      ctx.restore();
    }

    orbitCanvas.style.cursor = (isHoveringNode || isHoveringCenter) ? "pointer" : "default";

    if (isRunning) {
      animFrameId = requestAnimationFrame(draw);
    }
  }

  function resize() {
    if (!orbitCanvas || !orbitCanvas.parentElement) return;
    const rect = orbitCanvas.parentElement.getBoundingClientRect();
    width = rect.width;
    height = Math.max(540, window.innerHeight - 200);
    const dpr = window.devicePixelRatio || 1;
    orbitCanvas.width = width * dpr;
    orbitCanvas.height = height * dpr;
    orbitCanvas.style.width = `${width}px`;
    orbitCanvas.style.height = `${height}px`;
    ctx = orbitCanvas.getContext("2d");
    ctx.scale(dpr, dpr);
  }

  function startPlanetTransition(planet) {
    if (transitionState) return;

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const sunRadius = Math.max(48, minDim * 0.078);

    transitionState = {
      startTime: performance.now(),
      duration: 650,
      startX: planet.currentX || cx,
      startY: planet.currentY || cy,
      startRadius: planet.size / 2,
      targetRadius: sunRadius,
      targetX: cx,
      targetY: cy,
      album: planet.album,
      artist: planet.artist,
      image: planet.image,
      imgEl: planet.imgEl,
      oldCenter: Object.assign({}, currentCenter),
      trail: []
    };

    // Parallel load for new recommendations
    loadAlbumOrbit(
      {
        album: planet.album,
        artist: planet.artist,
        image: planet.image
      },
      /* isTransition = */ true
    );
  }

  async function loadAlbumOrbit(target, isTransition = false) {
    if (!target) target = { album: defaultAlbum, artist: defaultArtist };
    const cleanAlbum = target.album || target.name || defaultAlbum;
    const cleanArtist = target.artist || defaultArtist;

    currentCenter = {
      album: cleanAlbum,
      artist: cleanArtist,
      image: target.image || ""
    };

    const statusEl = document.getElementById("orbit-status-text");
    if (statusEl) {
      statusEl.innerHTML = `Finding recommended albums for <strong style="color: #fff;">${currentCenter.album}</strong>...`;
    }

    // If center didn't have a cover image, fetch it
    if (!currentCenter.image) {
      try {
        const albRes = await fetch(
          `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(currentCenter.artist)}&album=${encodeURIComponent(currentCenter.album)}&api_key=${apiKey}&format=json`
        );
        const albData = await albRes.json();
        const img = getAlbumCoverFromList(albData?.album?.image);
        if (img) currentCenter.image = img;
      } catch {}
    }

    const recommendedList = await fetchRecommendedAlbums(currentCenter.artist, currentCenter.album);
    const newBodies = setupOrbitBodies(recommendedList);

    if (isTransition && transitionState) {
      pendingBodies = newBodies;
    } else {
      orbitingBodies = newBodies;
      newBodiesFadeAlpha = 0;
    }

    if (statusEl) {
      statusEl.innerHTML = `Orbiting around <strong style="color: #fff;">${currentCenter.album}</strong> by ${currentCenter.artist} &middot; Click any planet to jump to its recommendations`;
    }
  }

  async function searchAndLoadAlbumOrbit(albumQuery) {
    const q = (albumQuery || "").trim();
    if (!q) return;

    const statusEl = document.getElementById("orbit-status-text");
    if (statusEl) {
      statusEl.innerHTML = `Searching for <strong style="color: #fff;">"${q}"</strong>...`;
    }

    try {
      const res = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(q)}&api_key=${apiKey}&format=json&limit=3`
      );
      const data = await res.json();
      const raw = data?.results?.albummatches?.album || [];
      const matches = Array.isArray(raw) ? raw : [raw];
      const match = matches[0];

      if (match && match.name) {
        const cover = getAlbumCoverFromList(match.image);
        loadAlbumOrbit({
          album: match.name,
          artist: match.artist,
          image: cover
        });
        const input = document.getElementById("album-orbit-input");
        if (input) input.value = `${match.name} - ${match.artist}`;
      } else {
        if (statusEl) {
          statusEl.innerHTML = `No album matches found for <strong style="color: #fff;">"${q}"</strong>. Try another search!`;
        }
      }
    } catch (err) {
      console.warn("Search album failed:", err);
    }
  }

  function initAlbumOrbit() {
    const container = document.getElementById("album-orbit-mount");
    if (!container) return;

    container.innerHTML = "";
    orbitCanvas = document.createElement("canvas");
    orbitCanvas.className = "artist-orbit-canvas";
    container.appendChild(orbitCanvas);

    resize();
    window.addEventListener("resize", resize);

    orbitCanvas.addEventListener("mousemove", (e) => {
      const rect = orbitCanvas.getBoundingClientRect();
      mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    });

    orbitCanvas.addEventListener("mouseleave", () => {
      mousePos = { x: -1000, y: -1000 };
    });

    orbitCanvas.addEventListener("click", () => {
      if (transitionState) return;

      if (isHoveringNode) {
        // Trigger smooth jump animation to clicked recommended album!
        startPlanetTransition(isHoveringNode);
      } else if (isHoveringCenter) {
        // Clicked center album cover OR the album title / artist text underneath
        if (typeof window.openAlbumModal === "function") {
          window.openAlbumModal({
            name: currentCenter.album,
            artist: currentCenter.artist,
            image: currentCenter.image
          });
        }
      }
    });

    // Start rendering loop
    isRunning = true;
    animFrameId = requestAnimationFrame(draw);

    // Initial load
    const initialTarget = window.selectedOrbitAlbum || { album: defaultAlbum, artist: defaultArtist };
    loadAlbumOrbit(initialTarget);
  }

  window.loadAlbumOrbit = loadAlbumOrbit;
  window.initAlbumOrbit = initAlbumOrbit;
  window.searchAndLoadAlbumOrbit = searchAndLoadAlbumOrbit;

  // Backward compatibility aliases
  window.loadArtistOrbit = loadAlbumOrbit;
  window.initArtistOrbit = initAlbumOrbit;
})();
