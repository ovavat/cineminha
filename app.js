/**
 * Ovavat (Cineminha do Ovavat) — Jogo Diário de 5 Fases
 * Sincronizado automaticamente com a planilha oficial de reviews das quintas-feiras.
 */

const SHEET_ID = "1tc1H0_WYPXklo5YnFsU8CJ9trZKHK9Yd6oJnDHWZUFE";
const GVIZ_JSON_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
const GVIZ_JSONP_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=responseHandler:__ovavatSheetCallback`;

const TOTAL_PHASES = 5;
const LAUNCH_DATE_STR = "2026-11-15"; // Desafio #1 oficial do Cineminha do Ovavat (histórico do beta anterior removido)
const COLLECTION_START_DATE = "2026-11-15"; // Só considera partidas/filmes/acertos/streak a partir do Desafio #1
const HINT_HALF_POINT_START_DATE = "2026-11-20"; // A partir de 20/11, acertos amarelos (2ª dica) valem 0.5 ponto no ranking

const SUPABASE_URL = "https://riyvxpgyouxyljhfqknj.supabase.co";
const SUPABASE_KEY = "sb_publishable_QkT0GDOivwCnfeBfVQ6nJw_e-CoJ_ic";

const GOOGLE_FORM_ID = "1FAIpQLSdETTJrAbgkLuMhNYVPXaVfIXWdNHgwIZosPoCVU2n6vuUIIQ";
const GOOGLE_FORM_VIEW_URL = `https://docs.google.com/forms/d/e/${GOOGLE_FORM_ID}/viewform`;
const GOOGLE_FORM_RESPONSE_URL = `https://docs.google.com/forms/d/e/${GOOGLE_FORM_ID}/formResponse`;
const RATE_WINDOW_DURATION_MS = 30 * 60 * 1000; // 30 minutos após a 1ª review do filme na planilha

const STORAGE_KEYS = {
  STATS: "ovavat_stats_v1",
  DAILY_PROGRESS: "ovavat_daily_v1",
  POKEDEX: "ovavat_pokedex_v2",
  PROFILE_SESSION: "ovavat_profile_session_v1",
  SHEET_CACHE: "ovavat_sheet_cache_v4",
  POSTER_CACHE: "ovavat_poster_cache_v9_wikidata_ptbr",
  THEME: "ovavat_theme_v2_light",
  PWA_DISMISSED_DATE: "ovavat_pwa_dismissed_v1",
  FORM_MOVIE: "ovavat_form_movie_v1",
  FORM_VOTER: "ovavat_form_voter_v2_popup",
  FORM_VOTED_MOVIE: "ovavat_form_voted_movie_v1"
};

// Estado em memória
const state = {
  todayStr: "",        // YYYY-MM-DD (America/Sao_Paulo)
  displayDateStr: "",  // DD/MM/YYYY
  shortDateStr: "",    // DD/MM
  editionNumber: 1,
  allReviews: [],
  allMovies: [],
  dailyPhases: [],     // Array de 5 objetos: { reviewObj, extraReviews, options: [4 strings], correctIndex }
  currentPhase: 0,     // 0..4
  answers: [],         // Array de { selectedIndex, correct, usedHint, movie, author, review }
  phaseHints: {},      // Mapa { [phaseIdx]: { usedHint: true, reviewIdx: 1 } }
  completed: false,
  dailyStartedAt: 0,   // Timestamp (ms) de quando a 1ª resposta do dia foi dada (garante que o 1º jogo do dia prevaleça)
  activeTab: "game",
  pokedexFilter: "all",
  pokedexPreviewAll: false,
  pokedexTodosClicks: 0,
  pokedex: {},         // Mapa { [movieName]: { unlockedAt, usedHint } }
  profileSession: null, // { username, displayName, pinHash }
  authMode: "login",   // "login" | "register"
  rateMovieTitle: "Nome Próprio",
  rateSelectedVoter: "Outre",
  rateFetchingMovie: false,
  posterMemoryCache: {},
  posterInflight: {},
  deferredInstallPrompt: null,
  gyro: {
    active3D: false,
    targetRx: 0,
    targetRy: 0,
    currentRx: 0,
    currentRy: 0,
    pointerInteracting: false,
    lastDragDist: 0,
    rafId: null
  }
};

// ============================================================================
// 1. TEMA CLARO / ESCURO (LIGHT MODE COMO PADRÃO)
// ============================================================================

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEYS.THEME) || "light";
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEYS.THEME, theme);

  const sunIcon = document.getElementById("icon-sun");
  const moonIcon = document.getElementById("icon-moon");
  const metaTheme = document.getElementById("meta-theme-color");

  if (theme === "light") {
    sunIcon?.classList.add("hidden");
    moonIcon?.classList.remove("hidden");
    if (metaTheme) metaTheme.setAttribute("content", "#F2F2F7");
  } else {
    sunIcon?.classList.remove("hidden");
    moonIcon?.classList.add("hidden");
    if (metaTheme) metaTheme.setAttribute("content", "#000000");
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
}

// ============================================================================
// 2. DETECÇÃO DE WEBAPP (STANDALONE) E POPUP DE ATALHO APENAS NO CELULAR
// ============================================================================

function isRunningAsWebApp() {
  return Boolean(
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches) ||
    window.navigator.standalone === true ||
    document.referrer.includes("android-app://")
  );
}

function getMobilePlatform() {
  const ua = navigator.userAgent || navigator.vendor || window.opera || "";
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);

  if (isIOS) return "ios";
  if (isAndroid) return "android";
  return null; // Retorna null em qualquer PC / Desktop
}

function initWebAppInstallPrompt() {
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    const nativeBtn = document.getElementById("btn-pwa-native-install");
    if (nativeBtn) nativeBtn.classList.remove("hidden");
  });

  const platform = getMobilePlatform();
  if (!platform || isRunningAsWebApp()) {
    return;
  }

  const dismissedDate = localStorage.getItem(STORAGE_KEYS.PWA_DISMISSED_DATE);
  if (dismissedDate === state.todayStr) {
    return;
  }

  const iosSteps = document.getElementById("pwa-ios-steps");
  const androidSteps = document.getElementById("pwa-android-steps");

  if (platform === "ios") {
    iosSteps?.classList.remove("hidden");
    androidSteps?.classList.add("hidden");
  } else {
    iosSteps?.classList.add("hidden");
    androidSteps?.classList.remove("hidden");
  }

  setTimeout(() => {
    if (!isRunningAsWebApp()) {
      document.getElementById("modal-pwa-install")?.classList.remove("hidden");
    }
  }, 900);
}

// ============================================================================
// 3. BOX DE DVD 3D INTERATIVO COM DEDO / MOUSE (SEM MOSTRAR O VERSO)
// ============================================================================

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function initDvd3dInteractions() {
  const stage = document.getElementById("dvd-stage");
  const shelfStage = document.getElementById("summary-shelf-stage");
  const pokedexInspectStage = document.getElementById("pokedex-inspect-stage");
  const rateDvdStage = document.getElementById("rate-dvd-stage");

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartRx = 0;
  let dragStartRy = 0;

  function beginDrag(clientX, clientY) {
    if (!state.gyro.active3D) return;
    isDragging = true;
    state.gyro.pointerInteracting = true;
    state.gyro.lastDragDist = 0;
    dragStartX = clientX;
    dragStartY = clientY;
    dragStartRx = state.gyro.currentRx;
    dragStartRy = state.gyro.currentRy;
  }

  function moveDrag(clientX, clientY) {
    if (!state.gyro.active3D || !isDragging) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    const dist = Math.hypot(dx, dy);
    if (dist > state.gyro.lastDragDist) {
      state.gyro.lastDragDist = dist;
    }

    state.gyro.targetRy = clamp(dragStartRy + dx * 0.45, -28, 28);
    state.gyro.targetRx = clamp(dragStartRx - dy * 0.36, -20, 20);
  }

  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    state.gyro.pointerInteracting = false;
  }

  [stage, shelfStage, pokedexInspectStage, rateDvdStage].forEach(el => {
    if (!el) return;

    // Impede o navegador de tentar "arrastar o arquivo da imagem" ao clicar e puxar com o mouse
    el.addEventListener("dragstart", e => {
      e.preventDefault();
    });

    el.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      beginDrag(e.clientX, e.clientY);
    });

    el.addEventListener(
      "touchstart",
      e => {
        if (e.touches && e.touches.length === 1) {
          beginDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: true }
    );

    el.addEventListener(
      "touchmove",
      e => {
        if (isDragging && e.touches && e.touches.length === 1) {
          moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: true }
    );

    el.addEventListener("touchend", endDrag, { passive: true });
    el.addEventListener("touchcancel", endDrag, { passive: true });
  });

  window.addEventListener("pointermove", e => {
    if (isDragging) {
      moveDrag(e.clientX, e.clientY);
    }
  });
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("blur", endDrag);
}

function startDvd3dAnimationLoop() {
  if (state.gyro.rafId) cancelAnimationFrame(state.gyro.rafId);

  const boxEl = document.getElementById("dvd-box-3d");
  const shadowEl = document.getElementById("dvd-shadow");
  const shelfStageEl = document.getElementById("summary-shelf-stage");
  const pokedexBoxEl = document.getElementById("pokedex-inspect-box");
  const pokedexShadowEl = document.getElementById("pokedex-inspect-shadow");
  const rateBoxEl = document.getElementById("rate-dvd-box");
  const rateShadowEl = document.getElementById("rate-dvd-shadow");
  const startTime = performance.now();

  function tick(now) {
    if (!state.gyro.active3D) return;

    // Enquanto o usuário não está arrastando com o dedo/mouse, mantém o movimento suave de vitrine 3D
    if (!state.gyro.pointerInteracting) {
      const t = (now - startTime) * 0.0018;
      state.gyro.targetRy = -14 + Math.sin(t) * 10; // Oscila entre -24° e -4° mostrando a lombada do DVD
      state.gyro.targetRx = 4 + Math.cos(t * 0.8) * 5;
    }

    // Interpolação suave (lerp)
    state.gyro.currentRx += (state.gyro.targetRx - state.gyro.currentRx) * 0.16;
    state.gyro.currentRy += (state.gyro.targetRy - state.gyro.currentRy) * 0.16;

    const rx = clamp(state.gyro.currentRx, -20, 20);
    const ry = clamp(state.gyro.currentRy, -28, 28);
    const glareX = clamp(50 - ry * 1.6, 10, 90);
    const glareY = clamp(45 + rx * 1.8, 10, 90);

    if (boxEl) {
      boxEl.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      boxEl.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      boxEl.style.setProperty("--glare-x", `${glareX.toFixed(1)}%`);
      boxEl.style.setProperty("--glare-y", `${glareY.toFixed(1)}%`);
    }

    if (pokedexBoxEl) {
      pokedexBoxEl.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      pokedexBoxEl.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      pokedexBoxEl.style.setProperty("--glare-x", `${glareX.toFixed(1)}%`);
      pokedexBoxEl.style.setProperty("--glare-y", `${glareY.toFixed(1)}%`);
    }

    if (rateBoxEl) {
      rateBoxEl.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      rateBoxEl.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      rateBoxEl.style.setProperty("--glare-x", `${glareX.toFixed(1)}%`);
      rateBoxEl.style.setProperty("--glare-y", `${glareY.toFixed(1)}%`);
    }

    if (shelfStageEl) {
      const elapsed = now - startTime;
      const shelfBoxes = shelfStageEl.querySelectorAll(".shelf-dvd-box");
      shelfBoxes.forEach((dvdBox, idx) => {
        const isFocused = dvdBox.parentElement?.classList.contains("active");

        if (isFocused) {
          // O DVD em foco responde 100% ao giroscópio / toque (igual ao DVD das fases)
          dvdBox.style.setProperty("--dvd-rx", `${rx.toFixed(2)}deg`);
          dvdBox.style.setProperty("--dvd-ry", `${ry.toFixed(2)}deg`);
          dvdBox.style.setProperty("--dvd-ty", `0px`);
          dvdBox.style.setProperty("--dvd-glare-x", `${glareX.toFixed(1)}%`);
          dvdBox.style.setProperty("--dvd-glare-y", `${glareY.toFixed(1)}%`);
        } else {
          // Os DVDs de trás NÃO são afetados pelo giroscópio e se movem bem devagar
          const freq = 0.00042 + idx * 0.00007;
          const phase = idx * 1.45;
          const indRy = -11 + Math.sin(elapsed * freq + phase) * 1.6;
          const indRx = 3 + Math.cos(elapsed * (freq * 0.85) + phase * 1.3) * 1.0;
          const floatY = Math.sin(elapsed * (freq * 1.1) + idx * 2.1) * 0.5;
          const indGlareX = clamp(50 - indRy * 1.4, 15, 85);
          const indGlareY = clamp(45 + indRx * 1.5, 15, 85);

          dvdBox.style.setProperty("--dvd-rx", `${indRx.toFixed(2)}deg`);
          dvdBox.style.setProperty("--dvd-ry", `${indRy.toFixed(2)}deg`);
          dvdBox.style.setProperty("--dvd-ty", `${floatY.toFixed(2)}px`);
          dvdBox.style.setProperty("--dvd-glare-x", `${indGlareX.toFixed(1)}%`);
          dvdBox.style.setProperty("--dvd-glare-y", `${indGlareY.toFixed(1)}%`);
        }
      });
    }

    if (shadowEl) {
      const shadowX = clamp(-ry * 0.45, -12, 12);
      shadowEl.style.setProperty("--shadow-x", `${shadowX.toFixed(1)}px`);
    }
    if (pokedexShadowEl) {
      const shadowX = clamp(-ry * 0.45, -12, 12);
      pokedexShadowEl.style.setProperty("--shadow-x", `${shadowX.toFixed(1)}px`);
    }
    if (rateShadowEl) {
      const shadowX = clamp(-ry * 0.45, -12, 12);
      rateShadowEl.style.setProperty("--shadow-x", `${shadowX.toFixed(1)}px`);
    }

    state.gyro.rafId = requestAnimationFrame(tick);
  }

  state.gyro.rafId = requestAnimationFrame(tick);
}

function setDvd3dMode(enable3D) {
  const stage = document.getElementById("dvd-stage");
  if (!stage) return;

  state.gyro.active3D = enable3D;
  state.gyro.pointerInteracting = false;

  if (enable3D) {
    stage.classList.remove("flat-mode");
    state.gyro.currentRx = 0;
    state.gyro.currentRy = 0;
    state.gyro.targetRx = 0;
    state.gyro.targetRy = 0;
    startDvd3dAnimationLoop();
  } else {
    stage.classList.add("flat-mode");
    if (state.gyro.rafId) {
      cancelAnimationFrame(state.gyro.rafId);
      state.gyro.rafId = null;
    }
  }
}

// ============================================================================
// 4. UTILITÁRIOS DE DATA E SEED DETERMINÍSTICO
// ============================================================================

function getBrazilDateParts() {
  try {
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = formatter.formatToParts(new Date());
    const day = parts.find(p => p.type === "day").value;
    const month = parts.find(p => p.type === "month").value;
    const year = parts.find(p => p.type === "year").value;
    return {
      iso: `${year}-${month}-${day}`,
      brFull: `${day}/${month}/${year}`,
      brShort: `${day}/${month}`
    };
  } catch (e) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return {
      iso: `${y}-${m}-${d}`,
      brFull: `${d}/${m}/${y}`,
      brShort: `${d}/${m}`
    };
  }
}

function computeEditionNumber(isoDate) {
  const [y1, m1, d1] = LAUNCH_DATE_STR.split("-").map(Number);
  const [y2, m2, d2] = isoDate.split("-").map(Number);
  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);
  const diffDays = Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

function getYesterdayIso(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function parseBrDateToIso(dateFormatted) {
  if (!dateFormatted) return "";
  const match = String(dateFormatted).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return "";
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function parseBrDateTimeMs(dateFormatted) {
  if (!dateFormatted) return Infinity;
  const match = String(dateFormatted).match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return Infinity;
  const [, dd, mm, yyyy, hh = "0", min = "0", ss = "0"] = match;
  // Converte o horário da planilha (Brasília, UTC-3) para epoch real em ms (comparável com Date.now())
  return Date.UTC(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh) + 3,
    Number(min),
    Number(ss)
  );
}

function cyrb32(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(array, rng) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================================
// 5. LEITURA E PARSE DA PLANILHA GOOGLE SHEETS (2024, 2025, 2026+)
// ============================================================================

function parseGvizTable(table) {
  const rows = (table && table.rows) || [];
  const validReviews = [];
  const movieFirstMeta = new Map();
  const movieScores = new Map();

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].c;
    if (!c) continue;

    const dateFormatted = c[0] ? (c[0].f || String(c[0].v || "")).trim() : "";
    const movie = c[1] && c[1].v != null ? String(c[1].v).trim() : "";
    const author = c[3] && c[3].v != null ? String(c[3].v).trim() : "Anônimo";

    if (!movie) continue;
    const rowIso = parseBrDateToIso(dateFormatted);
    const rowTs = parseBrDateTimeMs(dateFormatted);
    const prevMeta = movieFirstMeta.get(movie);
    if (!prevMeta || rowTs < prevMeta.firstTs) {
      movieFirstMeta.set(movie, {
        firstIso: rowIso || (prevMeta ? prevMeta.firstIso : ""),
        firstTs: rowTs,
        firstRowIdx: prevMeta ? Math.min(prevMeta.firstRowIdx, i) : i
      });
    }

    // Coluna C (c[2]): Nota de 0 a 10 dada para o filme
    if (c[2] && c[2].v != null) {
      const numericGrade = Number(String(c[2].v).replace(",", "."));
      if (!Number.isNaN(numericGrade) && numericGrade >= 0 && numericGrade <= 10) {
        const prev = movieScores.get(movie) || { sum: 0, count: 0 };
        prev.sum += numericGrade;
        prev.count += 1;
        movieScores.set(movie, prev);
      }
    }

    const colF = c[5] && c[5].v != null ? String(c[5].v).trim() : "";
    const colG = c[6] && c[6].v != null ? String(c[6].v).trim() : "";

    const isColFNumeric = /^-?\d+([.,]\d+)?$/.test(colF);

    let reviewText = "";
    if (colG !== "") {
      reviewText = colG;
    } else if (colF !== "" && !isColFNumeric) {
      reviewText = colF;
    }

    if (!reviewText || reviewText.trim().length === 0) {
      continue;
    }

    validReviews.push({
      id: i,
      date: dateFormatted,
      movie,
      author: author || "Amigo",
      review: reviewText.trim()
    });
  }

  // Ordena e numera os filmes pela data/hora em que a primeira review foi adicionada (#001 = mais antigo)
  const movies = Array.from(movieFirstMeta.entries())
    .sort((a, b) => {
      if (a[1].firstTs !== b[1].firstTs) return a[1].firstTs - b[1].firstTs;
      return a[1].firstRowIdx - b[1].firstRowIdx;
    })
    .map(([title, meta]) => {
      const sc = movieScores.get(title);
      const avgRating = sc && sc.count > 0 ? sc.sum / sc.count : null;
      const ratingCount = sc ? sc.count : 0;
      return {
        title,
        firstIso: meta.firstIso,
        firstTs: meta.firstTs,
        avgRating,
        ratingCount
      };
    });

  return {
    reviews: validReviews,
    movies
  };
}

function fetchSheetViaJsonp(timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timeout ao carregar planilha via JSONP"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window.__ovavatSheetCallback = function (response) {
      if (settled) return;
      settled = true;
      cleanup();
      if (response && response.status === "ok" && response.table) {
        resolve(parseGvizTable(response.table));
      } else {
        reject(new Error("Resposta inválida do Google Sheets"));
      }
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Erro de rede ao carregar script da planilha"));
    };

    script.src = `${GVIZ_JSONP_URL}&_t=${Date.now()}`;
    document.head.appendChild(script);
  });
}

async function fetchSheetViaFetch() {
  const res = await fetch(`${GVIZ_JSON_URL}&_t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Formato GVIZ inesperado");
  const json = JSON.parse(text.slice(start, end + 1));
  return parseGvizTable(json.table);
}

async function loadReviewsDataset() {
  try {
    const data = await fetchSheetViaFetch();
    if (data.reviews.length >= TOTAL_PHASES) {
      localStorage.setItem(STORAGE_KEYS.SHEET_CACHE, JSON.stringify(data));
      return data;
    }
  } catch (_) {
    try {
      const data = await fetchSheetViaJsonp();
      if (data.reviews.length >= TOTAL_PHASES) {
        localStorage.setItem(STORAGE_KEYS.SHEET_CACHE, JSON.stringify(data));
        return data;
      }
    } catch (errJsonp) {
      console.warn("Usando cache local da planilha:", errJsonp);
    }
  }

  try {
    const cached = localStorage.getItem(STORAGE_KEYS.SHEET_CACHE);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.reviews && parsed.reviews.length >= TOTAL_PHASES) {
        return parsed;
      }
    }
  } catch (_) {}

  const fallbackReviews = window.OVAVAT_FALLBACK_REVIEWS || [];
  const fallbackMovies = Array.from(new Set(fallbackReviews.map(r => r.movie)));
  return { reviews: fallbackReviews, movies: fallbackMovies };
}

// ============================================================================
// 6. CENSURA INTELIGENTE DO NOME DO FILME NA REVIEW
// ============================================================================

function stripAccentsWithMap(str) {
  let norm = "";
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i].normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (let j = 0; j < ch.length; j++) {
      norm += ch[j].toLowerCase();
      map.push(i);
    }
  }
  return { norm, map };
}

function buildSearchTermsForMovie(movieTitle) {
  const terms = new Set();
  const clean = movieTitle.trim();
  if (!clean) return [];

  terms.add(clean);

  const noPunct = clean.replace(/[!?.,]+$/g, "").trim();
  if (noPunct.length >= 3) terms.add(noPunct);

  const withoutArticle = noPunct.replace(/^(o|a|os|as|um|uma)\s+/i, "").trim();
  if (withoutArticle.length >= 4) {
    terms.add(withoutArticle);
  }

  const withoutSeq = noPunct.replace(/\s+\d+$/, "").trim();
  if (withoutSeq.length >= 4) {
    terms.add(withoutSeq);
  }

  const segments = clean.split(/[:\-–,]/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (seg.length >= 4) {
      terms.add(seg);
      const segNoArt = seg.replace(/^(o|a|os|as|um|uma)\s+/i, "").trim();
      if (segNoArt.length >= 5) terms.add(segNoArt);
    }
  }

  return Array.from(terms)
    .map(t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim())
    .filter(t => t.length >= 3)
    .sort((a, b) => b.length - a.length);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatReviewHtml(reviewText, movieTitle, isRevealed = false) {
  const { norm, map } = stripAccentsWithMap(reviewText);
  const terms = buildSearchTermsForMovie(movieTitle);
  const intervals = [];

  for (const term of terms) {
    if (!term) continue;
    let startIndex = 0;
    while (startIndex < norm.length) {
      const idx = norm.indexOf(term, startIndex);
      if (idx === -1) break;

      const endIdx = idx + term.length - 1;
      const prevChar = idx > 0 ? norm[idx - 1] : " ";
      const nextChar = endIdx + 1 < norm.length ? norm[endIdx + 1] : " ";
      const isWordBoundaryStart = !/[a-z0-9]/.test(prevChar);
      const isWordBoundaryEnd = !/[a-z0-9]/.test(nextChar);

      if (term.length > 5 || (isWordBoundaryStart && isWordBoundaryEnd)) {
        const origStart = map[idx];
        const origEnd = map[endIdx] + 1;

        const overlaps = intervals.some(iv => !(origEnd <= iv.start || origStart >= iv.end));
        if (!overlaps) {
          intervals.push({ start: origStart, end: origEnd });
        }
      }

      startIndex = idx + 1;
    }
  }

  if (intervals.length === 0) {
    return escapeHtml(reviewText);
  }

  intervals.sort((a, b) => a.start - b.start);

  let html = "";
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.start > cursor) {
      html += escapeHtml(reviewText.slice(cursor, iv.start));
    }
    const matchedOriginal = reviewText.slice(iv.start, iv.end);
    if (isRevealed) {
      html += `<span class="revealed-token">${escapeHtml(matchedOriginal)}</span>`;
    } else {
      html += `<span class="redacted-token" title="Nome do filme oculto">████████</span>`;
    }
    cursor = iv.end;
  }
  if (cursor < reviewText.length) {
    html += escapeHtml(reviewText.slice(cursor));
  }

  return html;
}

// ============================================================================
// 7. SORTEIO DAS 5 FASES DIÁRIAS (100% IGUAL PARA TODO MUNDO NO DIA)
// ============================================================================

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function getReviewUniqueKey(rev) {
  return `${String(rev?.movie || "").trim()}||${String(rev?.review || "").trim()}`;
}

const PINNED_DAILY_REVIEWS = {
  "2026-11-15": [
    { movie: "Um Ano Inesquecível: Outono", reviewPrefix: "esperando o wesley com meu ifood", correctIdx: 3 },
    { movie: "O Invasor", reviewPrefix: "Eu vc e esse filme ngm presta", correctIdx: 2 },
    { movie: "Amor.com", reviewPrefix: "Sasa e cellbit the movie", correctIdx: 0 },
    { movie: "Matou a Família e Foi ao Cinema", reviewPrefix: "bb = ladrao de calcinha?", correctIdx: 1 },
    { movie: "Muleque Té Doido 4", reviewPrefix: "Cinema.", correctIdx: 0 }
  ],
  "2026-11-16": [
    { movie: "Enaldinho e o Mistério da Lagoa", reviewPrefix: "nah they fucking", correctIdx: 1 },
    { movie: "Hoje Eu Quero Voltar Sozinho", reviewPrefix: "gi, se a gente fosse um eclipse", correctIdx: 2 },
    { movie: "Um Ano Inesquecível: Inverno", reviewPrefix: "Every fish in the sea", correctIdx: 2 },
    { movie: "Abrigo Nuclear", reviewPrefix: "O fallout brasileiro eh foda", correctIdx: 0 },
    { movie: "Quinze Dias", reviewPrefix: "🤢🤮🤮", correctIdx: 3 }
  ]
};

function resolvePinnedReviewsForDay(reviews, dayIso) {
  const specs = PINNED_DAILY_REVIEWS[dayIso];
  if (!specs) return null;
  return specs.map((spec, idx) => {
    const found =
      reviews.find(
        r => r.movie === spec.movie && String(r.review || "").trim().startsWith(spec.reviewPrefix)
      ) ||
      reviews.find(r => r.movie === spec.movie) ||
      {
        id: idx,
        date: "01/01/2025",
        movie: spec.movie,
        author: "Cineminha",
        review: spec.reviewPrefix
      };
    return { reviewObj: found, correctIdx: spec.correctIdx };
  });
}

function pickDayReviewsAvoidingRecent(reviewsPool, dayIso, blockedKeys) {
  const pinned = resolvePinnedReviewsForDay(reviewsPool, dayIso);
  if (pinned) return pinned.map(p => p.reviewObj);

  const daySeed = `cineminha-ovavat-${dayIso}`;
  const ranked = reviewsPool
    .slice()
    .sort((a, b) => {
      const ha = cyrb32(`${daySeed}|rev|${a.movie}|${a.author}|${a.review}`);
      const hb = cyrb32(`${daySeed}|rev|${b.movie}|${b.author}|${b.review}`);
      if (ha !== hb) return ha - hb;
      return a.movie.localeCompare(b.movie);
    });

  const selected = [];
  const usedMoviesToday = new Set();

  // 1ª passada: filmes distintos + reviews que NÃO apareceram nos últimos 30 dias
  for (const rev of ranked) {
    if (!usedMoviesToday.has(rev.movie) && !blockedKeys.has(getReviewUniqueKey(rev))) {
      usedMoviesToday.add(rev.movie);
      selected.push(rev);
      if (selected.length === TOTAL_PHASES) break;
    }
  }

  // Fallback caso o acervo inteiro fique abaixo de 5 fases disponíveis
  if (selected.length < TOTAL_PHASES) {
    for (const rev of ranked) {
      if (!usedMoviesToday.has(rev.movie)) {
        usedMoviesToday.add(rev.movie);
        selected.push(rev);
        if (selected.length === TOTAL_PHASES) break;
      }
    }
  }

  if (selected.length < TOTAL_PHASES) {
    for (const rev of ranked) {
      if (!selected.includes(rev)) {
        selected.push(rev);
        if (selected.length === TOTAL_PHASES) break;
      }
    }
  }

  return selected;
}

function buildDailyChallenge(reviews, allMovies, dateIso) {
  const eligibleReviews = reviews.filter(r => {
    const rIso = parseBrDateToIso(r.date);
    return !rIso || rIso < dateIso;
  });

  const pool = eligibleReviews.length >= TOTAL_PHASES ? eligibleReviews : reviews;
  const seedKey = `cineminha-ovavat-${dateIso}`;

  const normalizedMovies = allMovies.map(m =>
    typeof m === "string" ? { title: m, firstIso: "" } : m
  );
  const eligibleMovieTitles = normalizedMovies
    .filter(m => !m.firstIso || m.firstIso < dateIso)
    .map(m => m.title);
  const moviePool = eligibleMovieTitles.length >= 4
    ? eligibleMovieTitles
    : normalizedMovies.map(m => m.title);

  // Para dias fixados (15/11 e 16/11), preserva exatamente as perguntas e posições originais
  const pinnedForDate = resolvePinnedReviewsForDay(reviews, dateIso);
  if (pinnedForDate) {
    return pinnedForDate.map(({ reviewObj, correctIdx }, phaseIdx) => {
      const wrongPool = moviePool
        .filter(m => m !== reviewObj.movie)
        .sort((a, b) => cyrb32(`${seedKey}|opt|${phaseIdx}|${a}`) - cyrb32(`${seedKey}|opt|${phaseIdx}|${b}`));
      const distractors = wrongPool.slice(0, 3);
      const options = [];
      let dPtr = 0;
      for (let slot = 0; slot < 4; slot++) {
        options.push(slot === correctIdx ? reviewObj.movie : (distractors[dPtr++] || reviewObj.movie));
      }

      const extraRng = mulberry32(cyrb32(`${seedKey}-extra-reviews-${phaseIdx}-${reviewObj.movie}`));
      const sameMovieOthers = pool.filter(
        r => r.movie === reviewObj.movie && r.review.trim() !== reviewObj.review.trim()
      );
      const extraReviews = seededShuffle(sameMovieOthers, extraRng).slice(0, 1);

      return {
        reviewObj,
        extraReviews,
        options,
        correctIndex: correctIdx
      };
    });
  }

  // Garante que nenhuma review se repita em no mínimo 30 dias (se o filme repetir, usa outra review)
  const NO_REPEAT_DAYS = 30;
  const historyStartIso = addDaysIso(dateIso, -NO_REPEAT_DAYS);
  const firstTrackableIso = historyStartIso > LAUNCH_DATE_STR ? historyStartIso : LAUNCH_DATE_STR;
  const recentQueue = []; // Lista cronológica [{ dayIso, keys }] dos últimos 30 dias
  const blockedReviewKeys = new Set();

  for (let dIso = firstTrackableIso; dIso < dateIso; dIso = addDaysIso(dIso, 1)) {
    const windowCutoff = addDaysIso(dIso, -NO_REPEAT_DAYS);
    while (recentQueue.length > 0 && recentQueue[0].dayIso <= windowCutoff) {
      const expired = recentQueue.shift();
      expired.keys.forEach(k => blockedReviewKeys.delete(k));
    }

    const dayPool = reviews.filter(r => {
      const rIso = parseBrDateToIso(r.date);
      return !rIso || rIso < dIso;
    });
    const chosen = pickDayReviewsAvoidingRecent(
      dayPool.length >= TOTAL_PHASES ? dayPool : reviews,
      dIso,
      blockedReviewKeys
    );
    const chosenKeys = chosen.map(getReviewUniqueKey);
    chosenKeys.forEach(k => blockedReviewKeys.add(k));
    recentQueue.push({ dayIso: dIso, keys: chosenKeys });
  }

  // Limpa qualquer dia que tenha mais de 30 dias de diferença para `dateIso`
  const todayCutoff = addDaysIso(dateIso, -NO_REPEAT_DAYS);
  while (recentQueue.length > 0 && recentQueue[0].dayIso <= todayCutoff) {
    const expired = recentQueue.shift();
    expired.keys.forEach(k => blockedReviewKeys.delete(k));
  }
  blockedReviewKeys.clear();
  recentQueue.forEach(item => item.keys.forEach(k => blockedReviewKeys.add(k)));

  const selectedReviews = pickDayReviewsAvoidingRecent(pool, dateIso, blockedReviewKeys);

  return selectedReviews.map((reviewObj, phaseIdx) => {
    const wrongPool = moviePool
      .filter(m => m !== reviewObj.movie)
      .sort((a, b) => cyrb32(`${seedKey}|opt|${phaseIdx}|${a}`) - cyrb32(`${seedKey}|opt|${phaseIdx}|${b}`));
    const distractors = wrongPool.slice(0, 3);
    const options = [reviewObj.movie, ...distractors].sort(
      (a, b) => cyrb32(`${seedKey}|slot|${phaseIdx}|${a}`) - cyrb32(`${seedKey}|slot|${phaseIdx}|${b}`)
    );
    const correctIndex = options.indexOf(reviewObj.movie);

    // Review extra do mesmo filme (também evitando reviews usadas nos últimos 30 dias sempre que houver outra)
    const extraRng = mulberry32(cyrb32(`${seedKey}-extra-reviews-${phaseIdx}-${reviewObj.movie}`));
    const sameMovieOthers = pool.filter(
      r => r.movie === reviewObj.movie && r.review.trim() !== reviewObj.review.trim()
    );
    const freshSameMovieOthers = sameMovieOthers.filter(r => !blockedReviewKeys.has(getReviewUniqueKey(r)));
    const extraPool = freshSameMovieOthers.length > 0 ? freshSameMovieOthers : sameMovieOthers;
    const extraReviews = seededShuffle(extraPool, extraRng).slice(0, 1);

    return {
      reviewObj,
      extraReviews,
      options,
      correctIndex
    };
  });
}

// ============================================================================
// 8. BUSCA DE CARTAZES (CINEMETA API + WIKIPEDIA + IMDB JSONP + ITUNES)
// ============================================================================

function loadPosterCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.POSTER_CACHE);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...saved, ...(window.OVAVAT_POSTERS || {}) };
  } catch (_) {
    return { ...(window.OVAVAT_POSTERS || {}) };
  }
}

function savePosterToCache(movieTitle, url) {
  if (!url) return;
  state.posterMemoryCache[movieTitle] = url;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.POSTER_CACHE);
    const saved = raw ? JSON.parse(raw) : {};
    saved[movieTitle] = url;
    localStorage.setItem(STORAGE_KEYS.POSTER_CACHE, JSON.stringify(saved));
  } catch (_) {}
}

function probePosterImage(url, timeoutMs = 4500) {
  if (!url || !isUsablePosterUrl(url)) {
    return Promise.resolve({ ok: false, isPortrait: false, width: 0, height: 0 });
  }
  return new Promise(resolve => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, isPortrait: false, width: 0, height: 0 });
    }, timeoutMs);

    img.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      const ok = w > 40 && h > 40;
      // Cartazes oficiais têm proporção vertical (altura >= 1.12x largura)
      const isPortrait = ok && h >= w * 1.12;
      resolve({ ok, isPortrait, width: w, height: h });
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, isPortrait: false, width: 0, height: 0 });
    };
    img.src = url;
  });
}

function normalizeTitleStrict(str) {
  return String(str || "")
    .replace(/\([^)]*\)/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameMovieTitle(candidateTitle, targetMovieTitle, optionalHint = "") {
  const rawCandLower = String(candidateTitle || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (rawCandLower.includes("desambiguacao") || rawCandLower.includes("disambiguation")) {
    return false;
  }

  // Se o hint exige um ano específico entre parênteses, ex: "(1991)", e o candidato tem outro ano ou não tem quando existe homônimo
  const hintYearMatch = String(optionalHint || "").match(/\(.*?\b(19\d{2}|20\d{2})\b.*?\)/);
  const candYearMatch = String(candidateTitle || "").match(/\(.*?\b(19\d{2}|20\d{2})\b.*?\)/);
  if (hintYearMatch && candYearMatch && hintYearMatch[1] !== candYearMatch[1]) {
    return false;
  }

  const cand = normalizeTitleStrict(candidateTitle);
  const targ = normalizeTitleStrict(targetMovieTitle);
  const hintNorm = optionalHint ? normalizeTitleStrict(optionalHint) : "";

  if (!cand || !targ) return false;
  if (cand === targ) return true;
  if (hintNorm && cand === hintNorm) return true;

  const candNoOFilme = cand.replace(/\bo filme\b/g, "").replace(/\s+/g, " ").trim();
  const targNoOFilme = targ.replace(/\bo filme\b/g, "").replace(/\s+/g, " ").trim();
  if (candNoOFilme === targNoOFilme) return true;

  const candWords = cand.split(" ");
  const targWords = targ.split(" ");
  if (candWords.length >= 2 && targWords.length >= 2 && cand.length >= 8 && targ.length >= 8) {
    if (cand.startsWith(targ + " ") || targ.startsWith(cand + " ")) {
      const targNumbers = targ.match(/\b\d+\b/g) || [];
      const candNumbers = cand.match(/\b\d+\b/g) || [];
      if (targNumbers.join(",") === candNumbers.join(",")) {
        return true;
      }
    }
  }

  return false;
}

function isUsablePosterUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (
    lower.endsWith(".svg") ||
    lower.includes("flag_of_") ||
    lower.includes("commons-logo") ||
    lower.includes("question_book") ||
    lower.includes("disambig") ||
    lower.includes("crystal_clear") ||
    lower.includes("ambox") ||
    lower.includes("wikidata-logo") ||
    lower.includes("no_free_image") ||
    lower.includes("sem_imagem") ||
    lower.includes("substituir") ||
    lower.includes("replace_this_image")
  ) {
    return false;
  }
  return true;
}

async function fetchCinemetaCandidates(movieTitle, knownImdbId = null, expectedYear = null) {
  const urls = [];

  if (knownImdbId && String(knownImdbId).startsWith("tt")) {
    const byId = await fetchImdbPosterByIdOrQuery(knownImdbId);
    if (byId) urls.push(byId);
    urls.push(`https://images.metahub.space/poster/medium/${knownImdbId}/img`);
    try {
      const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${knownImdbId}.json`);
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        if (metaData?.meta?.poster && !urls.includes(metaData.meta.poster)) {
          urls.push(metaData.meta.poster);
        }
      }
    } catch (_) {}
    // Se já temos o ID exato do IMDb do filme, não faz busca genérica por nome para não misturar homônimos (ex: versão de 1969 vs 1991)
    if (urls.length > 0) {
      return urls;
    }
  }

  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const endpoints = [
    `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(cleanTitle)}.json`,
    `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(cleanTitle)}.json`
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const metas = (data && data.metas) || [];
      if (metas.length === 0) continue;

      const exact = metas.find(m => isSameMovieTitle(m.name, cleanTitle));
      let candidates = exact ? [exact, ...metas.filter(m => m !== exact)] : metas.slice(0, 2);
      if (expectedYear) {
        const yearMatches = candidates.filter(m => {
          const y = parseInt(String(m.releaseInfo || "").slice(0, 4), 10);
          return y && Math.abs(y - expectedYear) <= 1;
        });
        if (yearMatches.length > 0) {
          candidates = yearMatches;
        }
      }

      for (const meta of candidates) {
        const targNums = normalizeTitleStrict(cleanTitle).match(/\b\d+\b/g) || [];
        const candNums = normalizeTitleStrict(meta.name || "").match(/\b\d+\b/g) || [];
        if (targNums.length > 0 && candNums.length > 0 && targNums.join(",") !== candNums.join(",")) {
          continue;
        }

        if (meta.poster) urls.push(meta.poster);
        if (meta.id && String(meta.id).startsWith("tt")) {
          urls.push(`https://images.metahub.space/poster/medium/${meta.id}/img`);
          const byId = await fetchImdbPosterByIdOrQuery(meta.id);
          if (byId) urls.push(byId);
        }
      }
    } catch (_) {}
  }
  return urls;
}

function fetchImdbV2Jsonp(queryStr, timeoutMs = 4500) {
  return new Promise(resolve => {
    const norm = queryStr
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!norm) return resolve([]);

    const firstChar = norm[0];
    const cbName = `imdb$${norm}`;
    const script = document.createElement("script");
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve([]);
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      try {
        delete window[cbName];
      } catch (_) {
        window[cbName] = undefined;
      }
    }

    window[cbName] = function (data) {
      if (done) return;
      done = true;
      cleanup();
      resolve((data && data.d) || []);
    };

    script.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve([]);
    };

    script.src = `https://v2.sg.media-imdb.com/suggests/${firstChar}/${norm}.json`;
    document.head.appendChild(script);
  });
}

async function fetchImdbPosterByIdOrQuery(queryOrTtId) {
  const clean = queryOrTtId.replace(/#/g, "").trim();
  const isTtId = /^tt\d+$/i.test(clean);

  try {
    const items = await fetchImdbV2Jsonp(clean);
    const titleItems = items.filter(
      it => it.id && String(it.id).startsWith("tt") && it.i && (it.i[0] || it.i.imageUrl)
    );
    if (titleItems.length > 0) {
      const exact = isTtId
        ? titleItems.find(it => String(it.id).toLowerCase() === clean.toLowerCase()) || titleItems[0]
        : titleItems.find(it => isSameMovieTitle(it.l, clean));
      if (exact) {
        const rawUrl = Array.isArray(exact.i) ? exact.i[0] : exact.i.imageUrl;
        if (rawUrl) {
          return rawUrl.replace(/\._V1_.*\.jpg$/i, "._V1_SX500.jpg");
        }
      }
    }
  } catch (_) {}

  const targetUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(clean)}.json`;
  const proxyUrls = [
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  for (const url of proxyUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const items = (data && data.d) || [];

      const titleItems = items.filter(
        it => it.id && String(it.id).startsWith("tt") && it.i && it.i.imageUrl
      );
      if (titleItems.length === 0) continue;

      const exact = isTtId
        ? titleItems.find(it => String(it.id).toLowerCase() === clean.toLowerCase()) || titleItems[0]
        : titleItems.find(it => isSameMovieTitle(it.l, clean));
      if (exact && exact.i && exact.i.imageUrl) {
        return exact.i.imageUrl.replace(/\._V1_.*\.jpg$/i, "._V1_SX500.jpg");
      }
    } catch (_) {}
  }

  return null;
}

async function extractInfoboxDataFromPageId(pageId, lang = "pt") {
  try {
    const parseUrl = `https://${lang}.wikipedia.org/w/api.php?action=parse&origin=*&format=json&pageid=${pageId}&prop=text`;
    const res = await fetch(parseUrl);
    if (!res.ok) return { images: [], imdbId: null, year: null };
    const data = await res.json();
    const html = data?.parse?.text?.["*"];
    if (!html) return { images: [], imdbId: null, year: null };

    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d{6,10})/i);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const infoboxEl = doc.querySelector(".infobox, .infobox_v2, table.infobox");
    const infoboxText = (infoboxEl?.textContent || "").toLowerCase();
    if (
      infoboxText.includes("nascimento") &&
      infoboxText.includes("ocupação") &&
      !infoboxText.includes("direção") &&
      !infoboxText.includes("lançamento")
    ) {
      return { images: [], imdbId: null, year: null };
    }

    const yearMatch = infoboxText.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    const images = [];
    const imgs = doc.querySelectorAll(".infobox img, .infobox_v2 img, table.infobox img");
    for (const img of imgs) {
      const width = parseInt(img.getAttribute("width") || "0", 10);
      if (width > 0 && width < 90) continue;

      let src = img.getAttribute("src") || "";
      if (!src) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!isUsablePosterUrl(src)) continue;

      // Em imagens fair-use da Wikipedia PT (como Amorpontocom.jpg), a resolução original
      // costuma ser < 500px (ex: 233px ou 250px), e forçar /500px- gera erro 404 no Wikimedia.
      // Por isso, extraímos primeiro a URL original sem redimensionamento, depois tentamos 500px,
      // e mantemos a miniatura original da infobox como garantia 100% funcional.
      const origFromThumb = src.replace(
        /\/thumb\/([a-f0-9]\/[a-f0-9]{2}\/[^/]+)\/\d+px-[^/]+$/i,
        "/$1"
      );
      if (origFromThumb !== src && /\.(jpe?g|png|webp)$/i.test(origFromThumb)) {
        images.push(origFromThumb);
      }
      const scaled500 = src.replace(/\/(\d+)px-/, "/500px-");
      if (scaled500 !== src) {
        images.push(scaled500);
      }
      if (!images.includes(src)) {
        images.push(src);
      }
    }
    return { images, imdbId, year };
  } catch (_) {}
  return { images: [], imdbId: null, year: null };
}

async function fetchWikidataImdbAndYear(wikibaseItem) {
  if (!wikibaseItem) return { imdbId: null, year: null };
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&origin=*&format=json&ids=${encodeURIComponent(wikibaseItem)}&props=claims`;
    const res = await fetch(url);
    if (!res.ok) return { imdbId: null, year: null };
    const data = await res.json();
    const claims = data?.entities?.[wikibaseItem]?.claims;
    if (!claims) return { imdbId: null, year: null };

    let imdbId = null;
    const p345 = claims.P345?.[0]?.mainsnak?.datavalue?.value;
    if (p345 && String(p345).startsWith("tt")) {
      imdbId = String(p345);
    }

    let year = null;
    const p577 = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time;
    if (p577) {
      const m = String(p577).match(/\b(19\d{2}|20\d{2})\b/);
      if (m) year = parseInt(m[1], 10);
    }

    return { imdbId, year };
  } catch (_) {}
  return { imdbId: null, year: null };
}

async function fetchWikipediaCandidates(movieTitle, lang = "pt") {
  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const hint =
    (window.OVAVAT_MOVIE_SEARCH_HINTS && window.OVAVAT_MOVIE_SEARCH_HINTS[movieTitle]) || "";

  const queries = [
    hint,
    `${cleanTitle} (filme)`,
    `${cleanTitle} (telefilme)`,
    cleanTitle
  ].filter(Boolean);

  const imageUrls = [];
  let foundImdbId = null;
  let foundYear = null;

  for (const q of queries) {
    const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&origin=*&format=json&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=pageimages|pageprops&piprop=thumbnail|original&pithumbsize=600&pilicense=any`;

    const res = await fetch(endpoint);
    if (!res.ok) continue;
    const data = await res.json();
    if (!data?.query?.pages) continue;

    const pages = Object.values(data.query.pages).sort((a, b) => {
      const aExactHint = hint && String(a.title || "").toLowerCase() === hint.toLowerCase() ? 0 : 1;
      const bExactHint = hint && String(b.title || "").toLowerCase() === hint.toLowerCase() ? 0 : 1;
      if (aExactHint !== bExactHint) return aExactHint - bExactHint;
      const aExactQ = String(a.title || "").toLowerCase() === q.toLowerCase() ? 0 : 1;
      const bExactQ = String(b.title || "").toLowerCase() === q.toLowerCase() ? 0 : 1;
      if (aExactQ !== bExactQ) return aExactQ - bExactQ;
      return (a.index || 99) - (b.index || 99);
    });

    for (const page of pages) {
      if (!isSameMovieTitle(page.title, cleanTitle, hint)) {
        continue;
      }

      // Prioriza primeiro a imagem da Infobox da Wikipedia PT (que é o cartaz brasileiro oficial)
      const info = await extractInfoboxDataFromPageId(page.pageid, lang);
      if (info.imdbId && !foundImdbId) {
        foundImdbId = info.imdbId;
      }
      if (info.year && !foundYear) {
        foundYear = info.year;
      }
      if (!foundImdbId && page.pageprops?.wikibase_item) {
        const wd = await fetchWikidataImdbAndYear(page.pageprops.wikibase_item);
        if (wd.imdbId) foundImdbId = wd.imdbId;
        if (wd.year && !foundYear) foundYear = wd.year;
      }
      for (const u of info.images) {
        if (!imageUrls.includes(u)) imageUrls.push(u);
      }

      const origImg = page.original && page.original.source;
      if (isUsablePosterUrl(origImg) && !imageUrls.includes(origImg)) {
        imageUrls.push(origImg);
      }
      const thumbImg = page.thumbnail && page.thumbnail.source;
      if (isUsablePosterUrl(thumbImg) && !imageUrls.includes(thumbImg)) {
        imageUrls.push(thumbImg);
      }

      if (imageUrls.length > 0 || foundImdbId) {
        return { imageUrls, imdbId: foundImdbId, year: foundYear };
      }
    }
  }

  return { imageUrls, imdbId: foundImdbId, year: foundYear };
}

async function fetchPosterFromItunes(movieTitle, expectedYear = null) {
  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&country=BR&lang=pt_br&media=movie&entity=movie&limit=8`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;

  const matchingTitles = data.results.filter(item => isSameMovieTitle(item.trackName, cleanTitle));
  if (matchingTitles.length === 0) return null;

  let chosen = matchingTitles[0];
  if (expectedYear) {
    const byYear = matchingTitles.find(item => {
      if (!item.releaseDate) return false;
      const itemYear = parseInt(String(item.releaseDate).slice(0, 4), 10);
      return Math.abs(itemYear - expectedYear) <= 1;
    });
    if (byYear) {
      chosen = byYear;
    } else if (cleanTitle.split(/\s+/).length <= 2) {
      // Se o título é curto/ambíguo e o ano da loja não bate com o filme real, ignora para não pegar filme homônimo errado!
      return null;
    }
  }

  if (chosen && chosen.artworkUrl100) {
    return chosen.artworkUrl100.replace("100x100bb", "600x900bb");
  }
  return null;
}

async function resolveMoviePoster(movieTitle) {
  if (!movieTitle) return null;
  if (state.posterMemoryCache[movieTitle]) {
    return state.posterMemoryCache[movieTitle];
  }
  if (state.posterInflight[movieTitle]) {
    return state.posterInflight[movieTitle];
  }

  const promise = (async () => {
    let fallbackNonPortraitUrl = null;

    async function checkCandidate(url) {
      if (!url) return null;
      const probe = await probePosterImage(url);
      if (!probe.ok) return null;
      if (probe.isPortrait) {
        return url; // É um cartaz vertical real!
      }
      if (!fallbackNonPortraitUrl) {
        fallbackNonPortraitUrl = url;
      }
      return null;
    }

    // 1. Wikipedia PT-BR em 1º lugar (prioriza o cartaz brasileiro da Infobox + descobre ano e ID exato do IMDb)
    let wikiImdbId = null;
    let wikiYear = null;
    try {
      const wikiPt = await fetchWikipediaCandidates(movieTitle, "pt");
      wikiImdbId = wikiPt.imdbId;
      wikiYear = wikiPt.year;
      for (const candidateUrl of wikiPt.imageUrls) {
        const portrait = await checkCandidate(candidateUrl);
        if (portrait) {
          savePosterToCache(movieTitle, portrait);
          return portrait;
        }
      }
    } catch (_) {}

    // 2. Apple TV / iTunes Store Brasil (country=BR&lang=pt_br — cartazes oficiais em português brasileiro, validando o ano)
    try {
      const itunesUrl = await fetchPosterFromItunes(movieTitle, wikiYear);
      const portrait = await checkCandidate(itunesUrl);
      if (portrait) {
        savePosterToCache(movieTitle, portrait);
        return portrait;
      }
    } catch (_) {}

    // 3. Cinemeta API + Metahub (usando o ID exato do IMDb extraído da Wikipedia PT/Wikidata ou o título)
    try {
      const cinemetaUrls = await fetchCinemetaCandidates(movieTitle, wikiImdbId, wikiYear);
      for (const candidateUrl of cinemetaUrls) {
        const portrait = await checkCandidate(candidateUrl);
        if (portrait) {
          savePosterToCache(movieTitle, portrait);
          return portrait;
        }
      }
    } catch (_) {}

    // 4. IMDb Suggest API (busca direta pelo ID exato do filme ou título)
    try {
      if (wikiImdbId) {
        const imdbById = await fetchImdbPosterByIdOrQuery(wikiImdbId);
        const portrait = await checkCandidate(imdbById);
        if (portrait) {
          savePosterToCache(movieTitle, portrait);
          return portrait;
        }
      }
      const imdbByTitle = await fetchImdbPosterByIdOrQuery(movieTitle);
      const portrait = await checkCandidate(imdbByTitle);
      if (portrait) {
        savePosterToCache(movieTitle, portrait);
        return portrait;
      }
    } catch (_) {}

    // 5. Último recurso caso nenhum cartaz vertical exista em nenhuma fonte
    if (fallbackNonPortraitUrl) {
      savePosterToCache(movieTitle, fallbackNonPortraitUrl);
      return fallbackNonPortraitUrl;
    }

    return null;
  })();

  state.posterInflight[movieTitle] = promise;
  const res = await promise;
  delete state.posterInflight[movieTitle];
  return res;
}

function preloadDailyPosters() {
  for (const phase of state.dailyPhases) {
    for (const optMovie of phase.options) {
      resolveMoviePoster(optMovie);
    }
  }
}

// ============================================================================
// 9. PERSISTÊNCIA DE STREAKS, PROGRESSO DO DIA E RESET DE TESTE
// ============================================================================

function sanitizePokedexMap(rawPokedex) {
  const clean = {};
  if (!rawPokedex || typeof rawPokedex !== "object") return clean;
  for (const [mv, info] of Object.entries(rawPokedex)) {
    if (!mv || !info || typeof info !== "object") continue;
    const unlockedAt = String(info.unlockedAt || "");
    if (unlockedAt && unlockedAt >= COLLECTION_START_DATE) {
      clean[mv] = {
        unlockedAt,
        usedHint: Boolean(info.usedHint)
      };
    }
  }
  return clean;
}

function sanitizeStatsObject(rawStats) {
  const st = rawStats && typeof rawStats === "object" ? { ...rawStats } : {};
  const rawHist = st.history && typeof st.history === "object" ? st.history : {};
  const cleanHist = {};

  for (const [dt, entry] of Object.entries(rawHist)) {
    if (dt >= COLLECTION_START_DATE && entry) {
      cleanHist[dt] = normalizeHistoryEntry(entry);
    }
  }

  const validDates = Object.keys(cleanHist).sort();
  let totalCorrect = 0;
  const dist = [0, 0, 0, 0, 0, 0];
  let histStreak = 0;
  let histMaxStreak = 0;
  let prevDate = null;

  for (const dt of validDates) {
    const entry = cleanHist[dt];
    const sc = Math.min(5, Math.max(0, Math.round(Number(entry.score) || 0)));
    const hints =
      dt >= HINT_HALF_POINT_START_DATE && typeof entry.hintsUsed === "number"
        ? Math.min(sc, Math.max(0, entry.hintsUsed))
        : 0;
    totalCorrect += sc - hints * 0.5;
    dist[sc] = (dist[sc] || 0) + 1;

    if (prevDate && getYesterdayIso(dt) === prevDate) {
      histStreak += 1;
    } else {
      histStreak = 1;
    }
    if (histStreak > histMaxStreak) {
      histMaxStreak = histStreak;
    }
    prevDate = dt;
  }

  totalCorrect = Math.round(totalCorrect * 2) / 2;

  const lastCompletedDate = validDates.length > 0 ? validDates[validDates.length - 1] : null;
  const refToday = state.todayStr || getBrazilDateParts().iso;
  const refYesterday = getYesterdayIso(refToday);

  // Se a pessoa não jogou nem hoje nem ontem, a streak foi perdida e zera (0) nela e no ranking!
  const isStreakAlive = Boolean(
    lastCompletedDate &&
    (lastCompletedDate === refToday || lastCompletedDate === refYesterday)
  );

  const currentStreak = isStreakAlive ? histStreak : 0;
  const maxStreak = histMaxStreak;
  const played = validDates.length;
  const formVoterPicked =
    st.formVoterPicked && typeof st.formVoterPicked === "string" && FORM_VOTER_NAMES.includes(st.formVoterPicked)
      ? st.formVoterPicked
      : null;
  const formVotedMovie =
    st.formVotedMovie && typeof st.formVotedMovie === "string" && st.formVotedMovie.trim().length >= 2
      ? st.formVotedMovie.trim()
      : null;

  return {
    played,
    totalCorrect,
    currentStreak,
    maxStreak,
    lastCompletedDate,
    distribution: dist,
    history: cleanHist,
    formVoterPicked,
    formVotedMovie
  };
}

function getStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STATS);
    if (raw) {
      return sanitizeStatsObject(JSON.parse(raw));
    }
  } catch (_) {}
  return {
    played: 0,
    totalCorrect: 0,
    currentStreak: 0,
    maxStreak: 0,
    lastCompletedDate: null,
    distribution: [0, 0, 0, 0, 0, 0],
    history: {},
    formVoterPicked: null,
    formVotedMovie: null
  };
}

function saveStats(stats) {
  try {
    localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(sanitizeStatsObject(stats)));
  } catch (_) {}
}

function recordDailyCompletion(score) {
  const stats = getStats();
  if (!stats.history || typeof stats.history !== "object") {
    stats.history = {};
  }
  const startedAt = state.dailyStartedAt || Date.now();
  const unlockedToday = state.answers
    .filter(a => a && a.correct && a.movie)
    .map(a => a.movie);
  const hintsUsedToday = state.answers.filter(a => a && a.correct && a.usedHint).length;

  // Se já existe um jogo registrado hoje em stats.history com startedAt menor, preserva o primeiro!
  const existingEntry = stats.history[state.todayStr];
  const existingTs =
    existingEntry && typeof existingEntry === "object"
      ? Number(existingEntry.startedAt) || Infinity
      : Infinity;

  if (!existingEntry || startedAt <= existingTs) {
    stats.history[state.todayStr] = {
      score,
      hintsUsed: hintsUsedToday,
      startedAt,
      movies: unlockedToday
    };
  }

  if (stats.lastCompletedDate === state.todayStr) {
    saveStats(stats);
    return stats;
  }

  stats.played += 1;
  stats.totalCorrect += score;

  const yesterdayIso = getYesterdayIso(state.todayStr);
  if (stats.lastCompletedDate === yesterdayIso) {
    stats.currentStreak += 1;
  } else {
    stats.currentStreak = 1;
  }

  if (stats.currentStreak > stats.maxStreak) {
    stats.maxStreak = stats.currentStreak;
  }

  if (!Array.isArray(stats.distribution) || stats.distribution.length < 6) {
    stats.distribution = [0, 0, 0, 0, 0, 0];
  }
  stats.distribution[score] = (stats.distribution[score] || 0) + 1;
  stats.lastCompletedDate = state.todayStr;

  saveStats(stats);
  return stats;
}

function loadDailyProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DAILY_PROGRESS);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.date === state.todayStr) {
      return data;
    }
  } catch (_) {}
  return null;
}

function saveDailyProgress() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.DAILY_PROGRESS,
      JSON.stringify({
        date: state.todayStr,
        currentPhase: state.currentPhase,
        answers: state.answers,
        phaseHints: state.phaseHints,
        completed: state.completed,
        startedAt: state.dailyStartedAt || 0
      })
    );
  } catch (_) {}
}

function loadPokedex() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.POKEDEX);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return sanitizePokedexMap(parsed);
      }
    }
  } catch (_) {}
  return {};
}

function savePokedex() {
  try {
    state.pokedex = sanitizePokedexMap(state.pokedex);
    localStorage.setItem(STORAGE_KEYS.POKEDEX, JSON.stringify(state.pokedex));
  } catch (_) {}
}

function unlockMovieInPokedex(movieName, usedHint = false, dateStr = state.todayStr) {
  if (!movieName || !dateStr || dateStr < COLLECTION_START_DATE) return;
  const existing = state.pokedex[movieName];
  if (!existing) {
    state.pokedex[movieName] = {
      unlockedAt: dateStr,
      usedHint: Boolean(usedHint)
    };
  } else if (existing.usedHint && !usedHint) {
    existing.usedHint = false;
  }
  savePokedex();
}

function getMovieFromAnswer(ans, idx, dateStr) {
  if (!ans) return null;
  if (ans.movie) return ans.movie;
  if (dateStr === state.todayStr && state.dailyPhases[idx]?.reviewObj?.movie) {
    return state.dailyPhases[idx].reviewObj.movie;
  }
  return null;
}

function syncPokedexFromProgress() {
  state.pokedex = loadPokedex();
  let changed = false;

  // 1. Garante que qualquer filme acertado em state.answers (memória atual de hoje) esteja com .movie preenchido e na Coleção
  if (state.todayStr >= COLLECTION_START_DATE && Array.isArray(state.answers) && state.answers.length > 0) {
    state.answers.forEach((ans, idx) => {
      if (!ans) return;
      const mv = getMovieFromAnswer(ans, idx, state.todayStr);
      if (mv && !ans.movie) {
        ans.movie = mv;
      }
      if (ans.correct && mv && !state.pokedex[mv]) {
        state.pokedex[mv] = {
          unlockedAt: state.todayStr,
          usedHint: Boolean(ans.usedHint)
        };
        changed = true;
      }
    });
  }

  // 2. Desbloqueia os filmes com resposta exata confirmada em ovavat_daily_v1 (apenas a partir de COLLECTION_START_DATE)
  try {
    const rawDaily = localStorage.getItem(STORAGE_KEYS.DAILY_PROGRESS);
    if (rawDaily) {
      const dailyData = JSON.parse(rawDaily);
      const dailyDate = dailyData?.date || state.todayStr;
      if (dailyDate >= COLLECTION_START_DATE) {
        const ansList = dailyData?.answers || [];
        ansList.forEach((ans, idx) => {
          if (!ans || !ans.correct) return;
          const mv = getMovieFromAnswer(ans, idx, dailyDate);
          if (mv && !state.pokedex[mv]) {
            state.pokedex[mv] = {
              unlockedAt: dailyDate,
              usedHint: Boolean(ans.usedHint)
            };
            changed = true;
          }
        });

        // Registra também a nota confirmada desse dia no histórico por data (preservando o primeiro jogado)
        if (dailyData?.completed && ansList.length > 0) {
          const stats = getStats();
          if (!stats.history || typeof stats.history !== "object") {
            stats.history = {};
          }
          const dayScore = ansList.filter(a => a && a.correct).length;
          const dayHintsUsed = ansList.filter(a => a && a.correct && a.usedHint).length;
          const dayMovies = ansList
            .map((a, i) => (a && a.correct ? getMovieFromAnswer(a, i, dailyDate) : null))
            .filter(Boolean);
          const dayTs = Number(dailyData.startedAt) || Date.now();
          if (!stats.history[dailyDate]) {
            stats.history[dailyDate] = {
              score: dayScore,
              hintsUsed: dayHintsUsed,
              startedAt: dayTs,
              movies: dayMovies
            };
            saveStats(stats);
          } else if (typeof stats.history[dailyDate] === "object") {
            let histUpdated = false;
            if (
              (!stats.history[dailyDate].movies || stats.history[dailyDate].movies.length === 0) &&
              dayMovies.length > 0
            ) {
              stats.history[dailyDate].movies = dayMovies;
              histUpdated = true;
            }
            if (typeof stats.history[dailyDate].hintsUsed !== "number") {
              stats.history[dailyDate].hintsUsed = dayHintsUsed;
              histUpdated = true;
            }
            if (histUpdated) {
              saveStats(stats);
            }
          }
        }
      }
    }
  } catch (_) {}

  // 3. Garante que qualquer filme registrado em stats.history[dt].movies (a partir de COLLECTION_START_DATE) esteja na Coleção
  //    e remove eventuais DVDs "fantasmas" cuja data já tem histórico fechado sem aquele filme
  try {
    const stats = getStats();
    if (stats.history && typeof stats.history === "object") {
      const validHistoryMovies = new Set();
      for (const [dt, entry] of Object.entries(stats.history)) {
        if (dt >= COLLECTION_START_DATE && entry && Array.isArray(entry.movies)) {
          entry.movies.forEach(mv => {
            if (!mv) return;
            validHistoryMovies.add(mv);
            if (!state.pokedex[mv]) {
              state.pokedex[mv] = {
                unlockedAt: dt,
                usedHint: false
              };
              changed = true;
            }
          });
        }
      }

      for (const [mv, info] of Object.entries(state.pokedex)) {
        const dt = info && info.unlockedAt ? String(info.unlockedAt) : "";
        const histEntry = dt ? stats.history[dt] : null;
        if (
          histEntry &&
          Array.isArray(histEntry.movies) &&
          !validHistoryMovies.has(mv)
        ) {
          delete state.pokedex[mv];
          changed = true;
        }
      }
    }
  } catch (_) {}

  if (changed) {
    savePokedex();
  }
}

function resetDailyGameForTesting() {
  localStorage.removeItem(STORAGE_KEYS.DAILY_PROGRESS);
  state.currentPhase = 0;
  state.answers = [];
  state.phaseHints = {};
  state.completed = false;
  state.dailyStartedAt = 0;
  setDvd3dMode(false);

  document.getElementById("summary-view").classList.add("hidden");
  document.getElementById("game-view").classList.remove("hidden");
  document.getElementById("modal-reset").classList.add("hidden");

  renderCurrentPhase();
  showToast("Partida reiniciada! 🔄");
}

// ============================================================================
// 10. INTERFACE E RENDERIZAÇÃO
// ============================================================================

function updateHeaderStats() {
  const stats = getStats();
  document.getElementById("header-streak").textContent = String(stats.currentStreak);
  document.getElementById("edition-badge").textContent = `Desafio #${state.editionNumber}`;
  document.getElementById("header-date").textContent = state.displayDateStr;
}

function getAnswerEmoji(ans) {
  if (!ans || !ans.correct) return "🟥";
  return ans.usedHint ? "🟨" : "🟩";
}

function getActiveReviewForPhase(phaseIndex) {
  const phaseData = state.dailyPhases[phaseIndex];
  if (!phaseData) return null;
  const allReviewsForPhase = [phaseData.reviewObj, ...(phaseData.extraReviews || [])];
  const hintState = state.phaseHints[phaseIndex];
  const idx = hintState && typeof hintState.reviewIdx === "number" ? hintState.reviewIdx : 0;
  return allReviewsForPhase[idx] || phaseData.reviewObj;
}

function handleRequestAnotherReview() {
  const phaseIndex = state.currentPhase;
  if (state.answers[phaseIndex]) return;

  const phaseData = state.dailyPhases[phaseIndex];
  if (!phaseData) return;

  const allReviewsForPhase = [phaseData.reviewObj, ...(phaseData.extraReviews || [])];
  if (allReviewsForPhase.length <= 1) {
    showToast("Este filme só tem 1 review cadastrada!");
    return;
  }

  // Permite pedir apenas 1 review extra por fase
  if (state.phaseHints[phaseIndex]?.usedHint) {
    return;
  }

  state.phaseHints[phaseIndex] = {
    usedHint: true,
    reviewIdx: 1
  };

  saveDailyProgress();
  renderCurrentPhase();
}

function renderProgressPills() {
  const bars = document.querySelectorAll(".seg-bar");
  bars.forEach((bar, idx) => {
    bar.className = "seg-bar";
    const ans = state.answers[idx];
    if (ans) {
      if (ans.correct) {
        bar.classList.add(ans.usedHint ? "correct-hint" : "correct");
      } else {
        bar.classList.add("wrong");
      }
    } else if (idx === state.currentPhase && !state.completed) {
      bar.classList.add("active");
    }
  });

  const phaseLabel = document.getElementById("phase-label");
  if (state.completed) {
    phaseLabel.textContent = "Desafio Concluído";
  } else {
    phaseLabel.textContent = `Fase ${state.currentPhase + 1} de ${TOTAL_PHASES}`;
  }
}

function renderCurrentPhase() {
  renderProgressPills();

  const phaseIndex = state.currentPhase;
  const phaseData = state.dailyPhases[phaseIndex];
  if (!phaseData) return;

  const { options, correctIndex } = phaseData;
  const existingAnswer = state.answers[phaseIndex];
  const activeReviewObj = getActiveReviewForPhase(phaseIndex) || phaseData.reviewObj;
  const allReviewsForPhase = [phaseData.reviewObj, ...(phaseData.extraReviews || [])];
  const hintState = state.phaseHints[phaseIndex] || { usedHint: false, reviewIdx: 0 };
  const usedHint = existingAnswer ? Boolean(existingAnswer.usedHint) : Boolean(hintState.usedHint);

  const eyebrowBadge = document.getElementById("review-eyebrow-badge");
  const anotherBtn = document.getElementById("btn-another-review");

  if (eyebrowBadge) {
    if (usedHint) {
      eyebrowBadge.className = "eyebrow-badge hint-active";
      eyebrowBadge.textContent = "Review Extra";
    } else {
      eyebrowBadge.className = "eyebrow-badge";
      eyebrowBadge.textContent = "Review";
    }
  }

  if (anotherBtn) {
    if (existingAnswer || usedHint) {
      anotherBtn.classList.add("hidden");
    } else if (allReviewsForPhase.length <= 1) {
      anotherBtn.classList.remove("hidden");
      anotherBtn.disabled = true;
    } else {
      anotherBtn.classList.remove("hidden");
      anotherBtn.disabled = false;
    }
  }

  const reviewTextEl = document.getElementById("review-text");
  const displayedReview = existingAnswer && existingAnswer.review ? existingAnswer.review : activeReviewObj.review;
  const displayedMovieForRedaction = existingAnswer && existingAnswer.movie ? existingAnswer.movie : activeReviewObj.movie;
  reviewTextEl.innerHTML = formatReviewHtml(
    displayedReview,
    displayedMovieForRedaction,
    Boolean(existingAnswer)
  );

  const revealCard = document.getElementById("reveal-card");
  if (!existingAnswer) {
    revealCard.classList.add("hidden");
    setDvd3dMode(false);
  }

  const optionsGrid = document.getElementById("options-grid");
  optionsGrid.innerHTML = "";

  options.forEach((movieOption, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-poster-card";
    btn.type = "button";

    let statusHtml = "";
    if (existingAnswer) {
      btn.disabled = true;
      if (idx === correctIndex) {
        btn.classList.add(existingAnswer.correct && existingAnswer.usedHint ? "correct-hint" : "correct");
        statusHtml = `<span class="opt-status-icon">✓</span>`;
      } else if (idx === existingAnswer.selectedIndex && !existingAnswer.correct) {
        btn.classList.add("wrong");
        statusHtml = `<span class="opt-status-icon">✕</span>`;
      } else {
        btn.classList.add("dimmed");
      }
    } else {
      btn.addEventListener("click", () => handleSelectOption(idx));
    }

    const skelId = `opt-skel-${phaseIndex}-${idx}`;
    const imgId = `opt-img-${phaseIndex}-${idx}`;
    const fbId = `opt-fb-${phaseIndex}-${idx}`;

    btn.innerHTML = `
      <div class="opt-poster-wrap">
        <div id="${skelId}" class="poster-skeleton"></div>
        <img id="${imgId}" class="opt-poster-img hidden" alt="${escapeHtml(movieOption)}" referrerpolicy="no-referrer" />
        <div id="${fbId}" class="poster-fallback hidden">
          <span class="poster-fallback-icon">🎬</span>
          <span class="poster-fallback-title">${escapeHtml(movieOption)}</span>
        </div>
      </div>
      <div class="opt-title-bar">
        <span class="opt-movie-title">${escapeHtml(movieOption)}</span>
        ${statusHtml}
      </div>
    `;

    optionsGrid.appendChild(btn);

    // Carrega o cartaz de cada uma das 4 opções
    resolveMoviePoster(movieOption).then(url => {
      const skelEl = document.getElementById(skelId);
      const imgEl = document.getElementById(imgId);
      const fbEl = document.getElementById(fbId);
      if (!imgEl || !skelEl || !fbEl) return;

      if (url) {
        imgEl.onload = () => {
          skelEl.classList.add("hidden");
          fbEl.classList.add("hidden");
          imgEl.classList.remove("hidden");
        };
        imgEl.onerror = () => {
          skelEl.classList.add("hidden");
          imgEl.classList.add("hidden");
          fbEl.classList.remove("hidden");
        };
        imgEl.src = url;
      } else {
        skelEl.classList.add("hidden");
        imgEl.classList.add("hidden");
        fbEl.classList.remove("hidden");
      }
    });
  });

  if (existingAnswer) {
    showRevealCard(phaseData, existingAnswer.correct, Boolean(existingAnswer.usedHint));
  }
}

async function showRevealCard(phaseData, isCorrect, usedHint = false) {
  const activeReviewObj = getActiveReviewForPhase(state.currentPhase) || phaseData.reviewObj;
  const existingAnswer = state.answers[state.currentPhase];
  const revealedMovie = existingAnswer && existingAnswer.movie ? existingAnswer.movie : activeReviewObj.movie;
  const revealedAuthor = existingAnswer && existingAnswer.author ? existingAnswer.author : activeReviewObj.author;
  const revealCard = document.getElementById("reveal-card");
  const badge = document.getElementById("reveal-badge");
  const titleEl = document.getElementById("reveal-movie-title");
  const authorEl = document.getElementById("reveal-author-name");
  const nextBtnText = document.getElementById("btn-next-text");

  const skeleton = document.getElementById("poster-skeleton");
  const posterImg = document.getElementById("reveal-poster");
  const fallbackBox = document.getElementById("poster-fallback");
  const fallbackTitle = document.getElementById("poster-fallback-title");
  const dvdBox3d = document.getElementById("dvd-box-3d");

  if (dvdBox3d) {
    dvdBox3d.classList.remove("is-shiny", "is-foil", "is-especial");
    const rarity = getMovieRarityTier(revealedMovie);
    if (rarity) dvdBox3d.classList.add(`is-${rarity}`);
  }

  if (isCorrect) {
    badge.className = `status-pill ${usedHint ? "correct-hint" : "correct"}`;
    badge.textContent = usedHint ? "🟨 Acertou (Com outra review)" : "✓ Acertou";
  } else {
    badge.className = "status-pill wrong";
    badge.textContent = "✕ Errou";
  }

  titleEl.textContent = revealedMovie;
  authorEl.textContent = revealedAuthor;

  if (state.currentPhase + 1 < TOTAL_PHASES) {
    nextBtnText.textContent = "Próxima Fase";
  } else {
    nextBtnText.textContent = "Ver Resultado";
  }

  skeleton.classList.remove("hidden");
  posterImg.classList.add("hidden");
  fallbackBox.classList.add("hidden");
  fallbackTitle.textContent = revealedMovie;

  // Sempre exibe o filme correto revelado no Box de DVD 3D com giroscópio (mesmo se a pessoa errar)
  setDvd3dMode(true);

  revealCard.classList.remove("hidden");

  const targetMovie = revealedMovie;
  const posterUrl = await resolveMoviePoster(targetMovie);

  const currentAnsNow = state.answers[state.currentPhase];
  const currentMovieNow = (currentAnsNow && currentAnsNow.movie) || state.dailyPhases[state.currentPhase]?.reviewObj?.movie;
  if (currentMovieNow !== targetMovie) return;

  if (posterUrl) {
    posterImg.onload = () => {
      skeleton.classList.add("hidden");
      fallbackBox.classList.add("hidden");
      posterImg.classList.remove("hidden");
    };
    posterImg.onerror = () => {
      skeleton.classList.add("hidden");
      posterImg.classList.add("hidden");
      fallbackBox.classList.remove("hidden");
    };
    posterImg.src = posterUrl;
  } else {
    skeleton.classList.add("hidden");
    posterImg.classList.add("hidden");
    fallbackBox.classList.remove("hidden");
  }
}

function handleSelectOption(selectedIndex) {
  if (state.answers[state.currentPhase]) return;

  if (!state.dailyStartedAt || state.answers.length === 0) {
    state.dailyStartedAt = Date.now();
  }

  const phaseData = state.dailyPhases[state.currentPhase];
  const activeReviewObj = getActiveReviewForPhase(state.currentPhase) || phaseData.reviewObj;
  const isCorrect = selectedIndex === phaseData.correctIndex;
  const usedHint = Boolean(state.phaseHints[state.currentPhase]?.usedHint);

  state.answers[state.currentPhase] = {
    selectedIndex,
    correct: isCorrect,
    usedHint,
    movie: activeReviewObj.movie,
    author: activeReviewObj.author,
    review: activeReviewObj.review
  };

  if (isCorrect) {
    unlockMovieInPokedex(activeReviewObj.movie, usedHint, state.todayStr);
  }

  if (state.answers.length === TOTAL_PHASES) {
    const totalScore = state.answers.filter(a => a && a.correct).length;
    recordDailyCompletion(totalScore);
    updateHeaderStats();
  }

  saveDailyProgress();
  renderCurrentPhase();
  pushSaveToCloud();
}

function handleNextPhase() {
  setDvd3dMode(false);
  if (state.currentPhase + 1 < TOTAL_PHASES) {
    state.currentPhase += 1;
    saveDailyProgress();
    renderCurrentPhase();
    pushSaveToCloud();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    state.completed = true;
    const totalScore = state.answers.filter(a => a && a.correct).length;
    recordDailyCompletion(totalScore);
    saveDailyProgress();
    updateHeaderStats();
    pushSaveToCloud();
    showSummaryView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ============================================================================
// 11. TELA DE RESUMO FINAL E COMPARTILHAMENTO NO WHATSAPP (MANTIDA IGUAL)
// ============================================================================

function getScoreSubtitle(score) {
  switch (score) {
    case 5: return "Gabaritou! Conhece cada pérola de quinta.";
    case 4: return "Quase perfeito! Memória afiada nas reviews.";
    case 3: return "Mandou bem! Passou de ano no Cineminha.";
    case 2: return "Deu pro gasto, mas faltou atenção.";
    case 1: return "Pelo menos uma salvou a honra de hoje.";
    default: return "Dormiu durante a sessão de quinta-feira?";
  }
}

function buildShareText() {
  const score = state.answers.filter(a => a && a.correct).length;
  const stats = getStats();
  const emojis = state.answers.map(a => getAnswerEmoji(a)).join(" ");

  return [
    `🍿 *Cineminha do Ovavat* #${state.editionNumber} (${state.shortDateStr})`,
    `🎯 Acertos: ${score}/${TOTAL_PHASES} | 🔥 Streak: ${stats.currentStreak}`,
    ``,
    emojis
  ].join("\n");
}

function renderSummaryDvdShelf() {
  const shelfStage = document.getElementById("summary-shelf-stage");
  const shelfCaptionBox = document.getElementById("summary-shelf-caption");
  const shelfCaption = document.getElementById("shelf-movie-name");
  if (!shelfStage) return;

  shelfStage.innerHTML = "";
  let activeIdx = 0; // Começa com a Fase 1 na camada mais à frente

  function selectShelfDvd(selectedIdx) {
    activeIdx = selectedIdx;
    const stageWidth = shelfStage.clientWidth || 300;
    // Posição horizontal fixa em ordem (Fase 1..5 da esquerda pra direita), contida dentro do box central
    const stepX = Math.max(36, Math.min(48, (stageWidth - 114) / 4));

    const items = shelfStage.querySelectorAll(".shelf-dvd-item");
    items.forEach((item, idx) => {
      const slotFromCenter = idx - 2; // -2, -1, 0, +1, +2 (sempre em ordem 1..5!)
      const distFromSelected = Math.abs(idx - selectedIdx);
      const isSelected = idx === selectedIdx;

      const tx = slotFromCenter * stepX;
      const ty = isSelected ? -6 : distFromSelected * 2;
      const tz = isSelected ? 38 : -distFromSelected * 14;
      const ry = isSelected ? 0 : slotFromCenter * -5;
      const rz = isSelected ? 0 : slotFromCenter * 2;
      const scale = isSelected ? 1.1 : 0.92;

      item.classList.toggle("active", isSelected);
      item.classList.toggle("is-left", idx < selectedIdx);
      item.style.zIndex = String(isSelected ? 30 : 20 - distFromSelected * 3);
      item.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, ${tz}px) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${scale})`;
      item.style.filter = isSelected ? "brightness(1.04)" : "brightness(0.84)";
    });

    const phase = state.dailyPhases[selectedIdx];
    const ans = state.answers[selectedIdx];
    if (phase && shelfCaption) {
      shelfCaption.textContent = (ans && ans.movie) ? ans.movie : phase.reviewObj.movie;
    }
    if (shelfCaptionBox) {
      shelfCaptionBox.classList.remove("correct", "correct-hint", "wrong");
      const statusClass = ans && ans.correct ? (ans.usedHint ? "correct-hint" : "correct") : "wrong";
      shelfCaptionBox.classList.add(statusClass);
    }
  }

  state.dailyPhases.forEach((phase, idx) => {
    const rev = phase.reviewObj;
    const ans = state.answers[idx];
    const displayedMovie = (ans && ans.movie) ? ans.movie : rev.movie;
    const rarity = getMovieRarityTier(displayedMovie);
    const rarityMeta = rarity ? RARITY_META[rarity] : null;
    const statusClass = ans && ans.correct ? (ans.usedHint ? "correct-hint" : "correct") : "wrong";
    const statusSymbol = ans && ans.correct ? "✓" : "✕";
    const imgId = `shelf-dvd-img-${idx}`;

    const item = document.createElement("div");
    item.className = `shelf-dvd-item${statusClass === "wrong" ? " is-wrong" : ""}${rarity ? ` rarity-${rarity}` : ""}`;
    item.innerHTML = `
      <div class="shelf-dvd-box">
        <div class="shelf-dvd-spine"><span>DVD</span></div>
        <div class="shelf-dvd-edge-right"></div>
        <div class="shelf-dvd-front">
          <div class="shelf-dvd-lip"><span>CINEMINHA</span></div>
          <div class="shelf-dvd-art">
            <img id="${imgId}" class="shelf-dvd-img" src="assets/icon.jpg" alt="${escapeHtml(displayedMovie)}" referrerpolicy="no-referrer" />
            <div class="shelf-dvd-glare"></div>
            <span class="shelf-status-dot ${statusClass}">${statusSymbol}</span>
          </div>
        </div>
      </div>
    `;

    item.addEventListener("click", () => {
      if (state.gyro.lastDragDist > 10) return;
      selectShelfDvd(idx);
    });

    shelfStage.appendChild(item);

    resolveMoviePoster(displayedMovie).then(url => {
      if (url) {
        const imgEl = document.getElementById(imgId);
        if (imgEl) imgEl.src = url;
      }
    });
  });

  selectShelfDvd(0);
}

async function showSummaryView() {
  setDvd3dMode(true);
  document.getElementById("loading-view").classList.add("hidden");
  document.getElementById("game-view").classList.add("hidden");
  document.getElementById("summary-view").classList.remove("hidden");

  renderProgressPills();
  renderSummaryDvdShelf();

  const score = state.answers.filter(a => a && a.correct).length;
  const stats = getStats();

  document.getElementById("summary-date-label").textContent = `Desafio #${state.editionNumber} • ${state.displayDateStr}`;
  document.getElementById("summary-score-title").textContent = `${score} de ${TOTAL_PHASES}`;
  document.getElementById("summary-score-subtitle").textContent = getScoreSubtitle(score);

  const emojiStrip = document.getElementById("summary-emoji-strip");
  emojiStrip.textContent = state.answers.map(a => getAnswerEmoji(a)).join("  ");

  const scoredDays = stats.history
    ? Object.keys(stats.history).filter(dt => dt >= COLLECTION_START_DATE).length
    : 0;
  const denomGames = scoredDays > 0 ? scoredDays : stats.played;
  const avgPercent = denomGames > 0
    ? Math.round((stats.totalCorrect / (denomGames * TOTAL_PHASES)) * 100)
    : 0;

  document.getElementById("stat-played").textContent = String(stats.played);
  document.getElementById("stat-win-rate").textContent = `${avgPercent}%`;
  document.getElementById("stat-streak").textContent = `🔥 ${stats.currentStreak}`;
  document.getElementById("stat-max-streak").textContent = String(stats.maxStreak);

  const recapList = document.getElementById("recap-list");
  recapList.innerHTML = "";

  for (let i = 0; i < state.dailyPhases.length; i++) {
    const phase = state.dailyPhases[i];
    const ans = state.answers[i];
    const rev = phase.reviewObj;
    const statusEmoji = getAnswerEmoji(ans);
    const displayedMovie = ans && ans.movie ? ans.movie : rev.movie;
    const displayedAuthor = ans && ans.author ? ans.author : rev.author;
    const displayedQuote = ans && ans.review ? ans.review : rev.review;

    const item = document.createElement("div");
    item.className = "recap-item";

    const imgId = `recap-poster-${i}`;
    item.innerHTML = `
      <img id="${imgId}" class="recap-poster" src="assets/icon.jpg" alt="${escapeHtml(displayedMovie)}" referrerpolicy="no-referrer" />
      <div class="recap-details">
        <div class="recap-movie-row">
          <span class="recap-movie">${statusEmoji} ${escapeHtml(displayedMovie)}</span>
          <span class="recap-author">por ${escapeHtml(displayedAuthor)}</span>
        </div>
        <p class="recap-quote">“${escapeHtml(displayedQuote)}”</p>
      </div>
    `;
    recapList.appendChild(item);

    resolveMoviePoster(displayedMovie).then(url => {
      if (url) {
        const imgEl = document.getElementById(imgId);
        if (imgEl) imgEl.src = url;
      }
    });
  }
}

function renderStatsModal() {
  const stats = getStats();
  const scoredDays = stats.history
    ? Object.keys(stats.history).filter(dt => dt >= COLLECTION_START_DATE).length
    : 0;
  const denomGames = scoredDays > 0 ? scoredDays : stats.played;
  const avgPercent = denomGames > 0
    ? Math.round((stats.totalCorrect / (denomGames * TOTAL_PHASES)) * 100)
    : 0;

  document.getElementById("modal-stat-played").textContent = String(stats.played);
  document.getElementById("modal-stat-win-rate").textContent = `${avgPercent}%`;
  document.getElementById("modal-stat-streak").textContent = `🔥 ${stats.currentStreak}`;
  document.getElementById("modal-stat-max-streak").textContent = String(stats.maxStreak);

  const distContainer = document.getElementById("dist-bars");
  distContainer.innerHTML = "";
  const dist = stats.distribution || [0, 0, 0, 0, 0, 0];
  const maxVal = Math.max(1, ...dist);

  for (let score = 5; score >= 0; score--) {
    const count = dist[score] || 0;
    const widthPct = Math.max(8, Math.round((count / maxVal) * 100));
    const row = document.createElement("div");
    row.className = "dist-row";
    row.innerHTML = `
      <span class="dist-label">${score}/5</span>
      <div class="dist-bar-track">
        <div class="dist-bar-fill" style="width: ${widthPct}%">${count}</div>
      </div>
    `;
    distContainer.appendChild(row);
  }
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2400);
}

// ============================================================================
// 11B. POKÉDEX DE FILMES (ESTILO POKÉMON GO COM DVDS 3D) & LIQUID GLASS NAV
// ============================================================================

function switchMainTab(tabName) {
  // Ao trocar de aba, desativa a visualização temporária de todos os DVDs (easter egg 10x em "Todos")
  state.pokedexPreviewAll = false;
  state.pokedexTodosClicks = 0;
  state.activeTab = tabName;
  const glider = document.getElementById("liquid-glass-glider");
  const btnGame = document.getElementById("nav-tab-game");
  const btnPokedex = document.getElementById("nav-tab-pokedex");
  const btnRate = document.getElementById("nav-tab-rate");
  const btnProfile = document.getElementById("nav-tab-profile");
  const progressSection = document.getElementById("progress-header-section");
  const gameView = document.getElementById("game-view");
  const summaryView = document.getElementById("summary-view");
  const pokedexView = document.getElementById("pokedex-view");
  const rateView = document.getElementById("rate-view");
  const profileView = document.getElementById("profile-view");

  if (glider) {
    // Efeito elástico rápido de gota líquida iOS 27 ao clicar ou soltar
    glider.classList.remove("is-dragging");
    glider.style.setProperty("--glider-sx", "1.14");
    glider.style.setProperty("--glider-sy", "0.91");
    clearTimeout(window.__gliderTimer);
    window.__gliderTimer = setTimeout(() => {
      glider.style.setProperty("--glider-sx", "1");
      glider.style.setProperty("--glider-sy", "1");
    }, 180);
  }

  btnGame?.classList.remove("active");
  btnPokedex?.classList.remove("active");
  btnRate?.classList.remove("active");
  btnProfile?.classList.remove("active");

  if (tabName === "pokedex") {
    if (glider) glider.style.setProperty("--glider-idx", "1");
    btnPokedex?.classList.add("active");

    progressSection?.classList.add("hidden");
    gameView?.classList.add("hidden");
    summaryView?.classList.add("hidden");
    rateView?.classList.add("hidden");
    profileView?.classList.add("hidden");
    pokedexView?.classList.remove("hidden");

    renderPokedexView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (tabName === "rate") {
    if (glider) glider.style.setProperty("--glider-idx", "2");
    btnRate?.classList.add("active");

    progressSection?.classList.add("hidden");
    gameView?.classList.add("hidden");
    summaryView?.classList.add("hidden");
    pokedexView?.classList.add("hidden");
    profileView?.classList.add("hidden");
    rateView?.classList.remove("hidden");

    setDvd3dMode(true);
    renderRateMovieView();
    if (!getSavedRateVoter() && !isCurrentRateMovieVoted() && !isCurrentRateMovieExpired()) {
      openRateVoterModal();
    }
    syncFormMovieFromGoogleForms();
    refreshSheetForRateView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (tabName === "profile") {
    if (glider) glider.style.setProperty("--glider-idx", "3");
    btnProfile?.classList.add("active");

    progressSection?.classList.add("hidden");
    gameView?.classList.add("hidden");
    summaryView?.classList.add("hidden");
    pokedexView?.classList.add("hidden");
    rateView?.classList.add("hidden");
    profileView?.classList.remove("hidden");

    renderProfileView();
    loadLeaderboardFromCloud();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    if (glider) glider.style.setProperty("--glider-idx", "0");
    btnGame?.classList.add("active");

    pokedexView?.classList.add("hidden");
    rateView?.classList.add("hidden");
    profileView?.classList.add("hidden");
    progressSection?.classList.remove("hidden");

    if (state.completed) {
      gameView?.classList.add("hidden");
      summaryView?.classList.remove("hidden");
      setDvd3dMode(true);
    } else {
      summaryView?.classList.add("hidden");
      gameView?.classList.remove("hidden");
      const hasAnswerInCurrent = Boolean(state.answers[state.currentPhase]);
      setDvd3dMode(hasAnswerInCurrent);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ============================================================================
// 11B-2. PÁGINA DE AVALIAÇÃO DA QUINTA-FEIRA (IMDB DO OVAVAT — GOOGLE FORMS)
// ============================================================================

const FORM_VOTER_NAMES = [
  "Derp",
  "Fruet",
  "Gio",
  "Geizu",
  "Gustavo",
  "Jacom",
  "Kobas",
  "Raio",
  "Tom",
  "Outre"
];

function getSavedRateVoter() {
  try {
    const localSaved = localStorage.getItem(STORAGE_KEYS.FORM_VOTER);
    if (localSaved && FORM_VOTER_NAMES.includes(localSaved)) {
      return localSaved;
    }
  } catch (_) {}

  try {
    const st = getStats();
    if (st && st.formVoterPicked && FORM_VOTER_NAMES.includes(st.formVoterPicked)) {
      return st.formVoterPicked;
    }
  } catch (_) {}

  return "";
}

function updateRateVoterUI(voterName) {
  const displayVoter = voterName && FORM_VOTER_NAMES.includes(voterName) ? voterName : "Outre";
  const pillLabel = document.getElementById("rate-voter-pill-label");
  const pillBtn = document.getElementById("btn-rate-voter-picker");
  if (pillLabel) {
    pillLabel.textContent = displayVoter;
  }
  if (pillBtn) {
    pillBtn.classList.toggle("has-voter", Boolean(getSavedRateVoter()));
  }

  document.querySelectorAll("#rate-names-grid .rate-name-chip").forEach(btn => {
    const isSel = btn.getAttribute("data-name") === displayVoter;
    btn.classList.toggle("active", isSel);
  });
}

function openRateVoterModal() {
  const activeVoter = state.rateSelectedVoter || "Outre";
  document.querySelectorAll("#rate-names-grid .rate-name-chip").forEach(btn => {
    const isSel = btn.getAttribute("data-name") === activeVoter;
    btn.classList.toggle("active", isSel);
  });
  document.getElementById("modal-rate-voter")?.classList.remove("hidden");
}

function selectRateVoter(voterName, options = {}) {
  const { persist = true, closeModal = false } = options;
  const chosen = voterName && FORM_VOTER_NAMES.includes(voterName) ? voterName : "Outre";
  state.rateSelectedVoter = chosen;

  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEYS.FORM_VOTER, chosen);
    } catch (_) {}

    const stats = getStats();
    if (stats.formVoterPicked !== chosen) {
      stats.formVoterPicked = chosen;
      saveStats(stats);
      if (state.profileSession) {
        pushSaveToCloud();
      }
    }
  }

  updateRateVoterUI(chosen);

  if (closeModal) {
    document.getElementById("modal-rate-voter")?.classList.add("hidden");
  }
}

function updateRateSliderUI(sliderId, val) {
  const slider = document.getElementById(sliderId);
  const numVal = Math.min(10, Math.max(0, Number(val) || 0));
  if (slider) {
    slider.value = String(numVal);
    slider.style.setProperty("--slider-pct", `${numVal * 10}%`);
  }

  if (sliderId === "rate-slider-nota") {
    const pill = document.getElementById("rate-val-nota");
    if (pill) pill.textContent = String(numVal);
    const starsEl = document.getElementById("rate-live-stars");
    if (starsEl) {
      starsEl.innerHTML = buildStarsSvgHtml(numVal / 2);
    }
  } else if (sliderId === "rate-slider-riso") {
    const pill = document.getElementById("rate-val-riso");
    if (pill) pill.textContent = String(numVal);
  } else if (sliderId === "rate-slider-lacre") {
    const pill = document.getElementById("rate-val-lacre");
    if (pill) pill.textContent = String(numVal);
  }

  const ticksRow = document.querySelector(`.rate-ticks-row[data-target="${sliderId}"]`);
  if (ticksRow) {
    ticksRow.querySelectorAll(".rate-tick").forEach(btn => {
      btn.classList.toggle("active", Number(btn.getAttribute("data-val")) === numVal);
    });
  }
}

function getVotedFormMovie() {
  try {
    const localMovie = localStorage.getItem(STORAGE_KEYS.FORM_VOTED_MOVIE);
    if (localMovie && localMovie.trim().length >= 2) {
      return localMovie.trim();
    }
  } catch (_) {}

  try {
    const st = getStats();
    if (st && st.formVotedMovie && st.formVotedMovie.trim().length >= 2) {
      return st.formVotedMovie.trim();
    }
  } catch (_) {}

  return "";
}

function isCurrentRateMovieVoted() {
  const currentMovie = (state.rateMovieTitle || "Nome Próprio").trim();
  const votedMovie = getVotedFormMovie();
  return Boolean(currentMovie && votedMovie && currentMovie === votedMovie);
}

function isCurrentRateMovieExpired() {
  const currentMovie = (state.rateMovieTitle || "Nome Próprio").trim();
  if (!currentMovie || !Array.isArray(state.allMovies)) return false;
  const movieObj = state.allMovies.find(m => getMovieTitle(m) === currentMovie);
  if (!movieObj || typeof movieObj.firstTs !== "number" || !Number.isFinite(movieObj.firstTs)) {
    return false;
  }
  return Date.now() - movieObj.firstTs >= RATE_WINDOW_DURATION_MS;
}

async function refreshSheetForRateView() {
  try {
    const fresh = await fetchSheetViaFetch().catch(() => fetchSheetViaJsonp());
    if (fresh && Array.isArray(fresh.movies) && fresh.movies.length > 0) {
      state.allReviews = fresh.reviews;
      state.allMovies = fresh.movies;
      try {
        localStorage.setItem(STORAGE_KEYS.SHEET_CACHE, JSON.stringify(fresh));
      } catch (_) {}
      if (state.activeTab === "rate") {
        renderRateMovieView();
      }
    }
  } catch (_) {}
}

function markRateMovieVoted(movieTitle) {
  const cleanTitle = String(movieTitle || "").trim();
  if (!cleanTitle) return;

  try {
    localStorage.setItem(STORAGE_KEYS.FORM_VOTED_MOVIE, cleanTitle);
  } catch (_) {}

  const stats = getStats();
  if (stats.formVotedMovie !== cleanTitle) {
    stats.formVotedMovie = cleanTitle;
    saveStats(stats);
    if (state.profileSession) {
      pushSaveToCloud();
    }
  }
}

function renderRateMovieView() {
  const movieName = state.rateMovieTitle || "Nome Próprio";
  const titleEl = document.getElementById("rate-movie-title");
  const imgEl = document.getElementById("rate-dvd-img");
  const boxEl = document.getElementById("rate-dvd-box");
  const formEl = document.getElementById("imdb-rate-form");
  const votedCardEl = document.getElementById("rate-voted-card");
  const votedMovieNameEl = document.getElementById("rate-voted-movie-name");
  const voterPickerBtn = document.getElementById("btn-rate-voter-picker");

  if (titleEl) {
    titleEl.textContent = movieName;
  }
  if (votedMovieNameEl) {
    votedMovieNameEl.textContent = movieName;
  }

  if (boxEl) {
    boxEl.classList.remove("is-shiny", "is-foil", "is-especial");
    const rarity = getMovieRarityTier(movieName);
    if (rarity) boxEl.classList.add(`is-${rarity}`);
  }

  if (imgEl) {
    const cachedUrl = state.posterMemoryCache[movieName];
    if (cachedUrl) {
      imgEl.src = cachedUrl;
    } else {
      imgEl.src = "assets/icon.jpg";
    }
    resolveMoviePoster(movieName).then(url => {
      if (url && state.rateMovieTitle === movieName) {
        imgEl.src = url;
      }
    });
  }

  const savedVoter = getSavedRateVoter();
  if (savedVoter) {
    selectRateVoter(savedVoter, { persist: false, closeModal: false });
  } else {
    state.rateSelectedVoter = "Outre";
    updateRateVoterUI("Outre");
  }

  const alreadyVoted = isCurrentRateMovieVoted();
  const windowExpired = !alreadyVoted && isCurrentRateMovieExpired();
  const eyebrowEl = document.getElementById("rate-eyebrow");
  const submitBtn = document.getElementById("btn-rate-submit");
  const submitText = document.getElementById("btn-rate-submit-text");
  const criticaEl = document.getElementById("rate-input-critica");

  if (eyebrowEl) {
    eyebrowEl.classList.toggle("is-expired", windowExpired);
  }
  if (boxEl) {
    boxEl.classList.toggle("is-expired", windowExpired);
  }
  if (formEl) {
    formEl.classList.toggle("hidden", alreadyVoted);
    formEl.classList.toggle("is-expired", windowExpired);
    formEl.querySelectorAll("input, textarea, button").forEach(el => {
      el.disabled = windowExpired;
    });
  }
  if (votedCardEl) {
    votedCardEl.classList.toggle("hidden", !alreadyVoted);
  }
  if (voterPickerBtn) {
    const lockPicker = alreadyVoted || windowExpired;
    voterPickerBtn.disabled = lockPicker;
    voterPickerBtn.classList.toggle("is-locked", alreadyVoted);
    voterPickerBtn.classList.toggle("is-expired", windowExpired);
  }
  if (submitBtn) {
    submitBtn.disabled = windowExpired;
  }
  if (submitText) {
    submitText.textContent = windowExpired
      ? "Votação encerrada"
      : "Enviar pro IMDb do Ovavat";
  }
  if (criticaEl) {
    criticaEl.placeholder = windowExpired
      ? "Tempo de votação deste filme encerrado."
      : "Escreva sua review...";
  }
  if (windowExpired) {
    document.getElementById("modal-rate-voter")?.classList.add("hidden");
  }

  updateRateSliderUI("rate-slider-nota", document.getElementById("rate-slider-nota")?.value ?? 0);
  updateRateSliderUI("rate-slider-riso", document.getElementById("rate-slider-riso")?.value ?? 0);
  updateRateSliderUI("rate-slider-lacre", document.getElementById("rate-slider-lacre")?.value ?? 0);
}

function parseMovieFromFormText(rawText) {
  if (!rawText) return null;
  // 1. Formato FB_PUBLIC_LOAD_DATA_ do HTML original do Google Forms: 2042866862,[["Nome do Filme"
  const fbMatch = rawText.match(/2042866862\s*,\s*\[\s*\[\s*"([^"]+)"/);
  if (fbMatch && fbMatch[1]) {
    return fbMatch[1].trim();
  }
  // 2. Formato Markdown do r.jina.ai: Filme 🎥 * ... <Nome do Filme> ... Nota⭐ *
  const mdMatch = rawText.match(/Filme\s*🎥\s*\*?\s+([^\r\n*]+?)\s+Nota\s*⭐/i);
  if (mdMatch && mdMatch[1]) {
    return mdMatch[1].trim();
  }
  return null;
}

async function syncFormMovieFromGoogleForms() {
  if (state.rateFetchingMovie) return;
  state.rateFetchingMovie = true;

  try {
    let detectedMovie = null;

    // Tentativa 1: r.jina.ai (rápido e com CORS liberado para GitHub Pages)
    try {
      const res = await fetch(`https://r.jina.ai/${GOOGLE_FORM_VIEW_URL}`, {
        cache: "no-store"
      });
      if (res.ok) {
        const text = await res.text();
        detectedMovie = parseMovieFromFormText(text);
      }
    } catch (_) {}

    // Tentativa 2: allorigins JSON
    if (!detectedMovie) {
      try {
        const enc = encodeURIComponent(GOOGLE_FORM_VIEW_URL);
        const res2 = await fetch(`https://api.allorigins.win/get?url=${enc}`, {
          cache: "no-store"
        });
        if (res2.ok) {
          const data = await res2.json();
          detectedMovie = parseMovieFromFormText(data && data.contents);
        }
      } catch (_) {}
    }

    if (detectedMovie && detectedMovie.length >= 2) {
      const changed = detectedMovie !== state.rateMovieTitle;
      state.rateMovieTitle = detectedMovie;
      try {
        localStorage.setItem(STORAGE_KEYS.FORM_MOVIE, detectedMovie);
      } catch (_) {}
      if (changed && state.activeTab === "rate") {
        renderRateMovieView();
      }
    }
  } finally {
    state.rateFetchingMovie = false;
  }
}

async function handleRateFormSubmit(e) {
  e.preventDefault();
  if (isCurrentRateMovieVoted() || isCurrentRateMovieExpired()) {
    renderRateMovieView();
    return;
  }
  if (!state.rateSelectedVoter) {
    openRateVoterModal();
    showToast("Escolha o seu nome para enviar! 👤");
    return;
  }

  const movieTitle = state.rateMovieTitle || "Nome Próprio";
  const nota = document.getElementById("rate-slider-nota")?.value ?? "0";
  const riso = document.getElementById("rate-slider-riso")?.value ?? "0";
  const lacre = document.getElementById("rate-slider-lacre")?.value ?? "0";
  const critica = document.getElementById("rate-input-critica")?.value || "";
  const submitBtn = document.getElementById("btn-rate-submit");
  const submitText = document.getElementById("btn-rate-submit-text");

  const params = new URLSearchParams();
  params.append("entry.1666559163", state.rateSelectedVoter);
  params.append("entry.2042866862", movieTitle);
  params.append("entry.294792027", String(nota));
  params.append("entry.1051937792", String(riso));
  params.append("entry.1049319748", String(lacre));
  params.append("entry.660204434", critica.trim());

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Enviando avaliação...";

  try {
    await fetch(GOOGLE_FORM_RESPONSE_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    markRateMovieVoted(movieTitle);
    showToast(`Avaliação de "${movieTitle}" enviada! 🎬`);
    const criticaEl = document.getElementById("rate-input-critica");
    if (criticaEl) criticaEl.value = "";
    updateRateSliderUI("rate-slider-nota", 0);
    updateRateSliderUI("rate-slider-riso", 0);
    updateRateSliderUI("rate-slider-lacre", 0);
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Enviar pro IMDb do Ovavat";
    renderRateMovieView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (_) {
    showToast("Erro de conexão ao enviar avaliação.");
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Enviar pro IMDb do Ovavat";
  }
}

function getMovieTitle(movieEntry) {
  if (!movieEntry) return "";
  return typeof movieEntry === "string" ? movieEntry : String(movieEntry.title || "");
}

function getMovieRarityTier(movieName) {
  const cleanName = String(movieName || "").trim();
  if (cleanName === "Lucicreide Vai pra Marte") return "especial";
  if (cleanName === "E Aí... Comeu?") return "foil";
  const movieObj = state.allMovies.find(m => getMovieTitle(m) === cleanName);
  if (movieObj && typeof movieObj.avgRating === "number" && movieObj.avgRating > 8.5) {
    return "shiny";
  }
  return null;
}

const RARITY_META = {
  shiny: { icon: "✨", label: "Raro", title: "Filme Raro • Nota > 8,5" },
  foil: { icon: "🪩", label: "Foil", title: "Carta Foil • E Aí... Comeu?" },
  especial: { icon: "🌀", label: "Especial", title: "Carta Especial • Lucicreide Vai pra Marte" }
};

function renderPokedexView() {
  syncPokedexFromProgress();

  const grid = document.getElementById("pokedex-grid");
  const countBadge = document.getElementById("pokedex-count-badge");
  const progressFill = document.getElementById("pokedex-progress-fill");
  if (!grid) return;

  const movieTitles = state.allMovies.map(getMovieTitle).filter(Boolean);
  const totalMovies = movieTitles.length;
  const realUnlockedCount = movieTitles.filter(title => Boolean(state.pokedex[title])).length;
  const unlockedCount = state.pokedexPreviewAll ? totalMovies : realUnlockedCount;
  const pct = totalMovies > 0 ? Math.round((unlockedCount / totalMovies) * 100) : 0;

  if (countBadge) {
    countBadge.textContent = `${unlockedCount} / ${totalMovies}`;
  }
  if (progressFill) {
    progressFill.style.width = `${pct}%`;
  }

  grid.innerHTML = "";

  // Mantém todos os filmes em ordem numérica (#001, #002, ...)
  const entries = movieTitles.map((movieName, idx) => ({
    movieName,
    idx,
    isUnlocked: Boolean(state.pokedex[movieName]) || Boolean(state.pokedexPreviewAll)
  }));

  entries.forEach(({ movieName, idx, isUnlocked }) => {
    if (state.pokedexFilter === "unlocked" && !isUnlocked) return;
    if (state.pokedexFilter === "locked" && isUnlocked) return;

    const numStr = `#${String(idx + 1).padStart(3, "0")}`;
    const rarity = isUnlocked ? getMovieRarityTier(movieName) : null;
    const rarityMeta = rarity ? RARITY_META[rarity] : null;
    const slot = document.createElement("div");
    slot.className = `pokedex-slot ${isUnlocked ? "unlocked" : "locked"}${rarity ? ` ${rarity}` : ""}`;

    if (isUnlocked) {
      const imgId = `pokedex-img-${idx}`;
      slot.innerHTML = `
        <div class="pokedex-slot-top">
          <span class="pokedex-num-badge">${numStr}</span>
          ${rarityMeta ? `<span class="pokedex-shiny-badge" title="${rarityMeta.title}">${rarityMeta.icon}</span>` : ""}
        </div>
        <div class="pokedex-mini-stage">
          <div class="pokedex-mini-dvd">
            <div class="pokedex-mini-spine"><span>DVD</span></div>
            <div class="pokedex-mini-front">
              <div class="pokedex-mini-lip"><span>CINEMINHA</span></div>
              <div class="pokedex-mini-art">
                <img id="${imgId}" class="pokedex-mini-img" src="assets/icon.jpg" alt="${escapeHtml(movieName)}" referrerpolicy="no-referrer" />
                <div class="pokedex-mini-glare"></div>
              </div>
            </div>
          </div>
        </div>
        <span class="pokedex-slot-name">${escapeHtml(movieName)}</span>
      `;

      slot.addEventListener("click", () => {
        openPokedexDvdModal(movieName, numStr);
      });

      resolveMoviePoster(movieName).then(url => {
        if (url) {
          const imgEl = document.getElementById(imgId);
          if (imgEl) imgEl.src = url;
        }
      });
    } else {
      // Ainda não descoberto: esconde o pôster e o nome do filme (estilo Pokémon GO)
      slot.innerHTML = `
        <div class="pokedex-slot-top">
          <span class="pokedex-num-badge">${numStr}</span>
        </div>
        <div class="pokedex-mystery-box" aria-label="Filme ainda não descoberto">
          <span class="pokedex-mystery-icon">?</span>
        </div>
        <span class="pokedex-slot-name">???</span>
      `;
    }

    grid.appendChild(slot);
  });
}

function buildStarsSvgHtml(starsOutOf5) {
  const starPath =
    "M12 2.2l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.1l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95L12 2.2z";
  let html = "";
  for (let i = 1; i <= 5; i++) {
    if (starsOutOf5 >= i) {
      // Estrela cheia
      html += `
        <svg class="pokedex-star full" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="${starPath}" fill="#FFB800" stroke="#FFB800" stroke-width="1.4" stroke-linejoin="round" />
        </svg>`;
    } else if (starsOutOf5 >= i - 0.5) {
      // Meia estrela
      const gradId = `half-star-grad-${i}`;
      html += `
        <svg class="pokedex-star half" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="50%" stop-color="#FFB800" />
              <stop offset="50%" stop-color="transparent" />
            </linearGradient>
          </defs>
          <path d="${starPath}" fill="url(#${gradId})" stroke="#FFB800" stroke-width="1.5" stroke-linejoin="round" />
        </svg>`;
    } else {
      // Estrela vazia
      html += `
        <svg class="pokedex-star empty" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="${starPath}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>`;
    }
  }
  return html;
}

function openPokedexDvdModal(movieName, numStr) {
  const modal = document.getElementById("modal-pokedex-dvd");
  const sheetEl = modal ? modal.querySelector(".pokedex-dvd-sheet") : null;
  const numEl = document.getElementById("pokedex-modal-num");
  const titleEl = document.getElementById("pokedex-modal-title");
  const hintEl = document.getElementById("pokedex-modal-hint");
  const imgEl = document.getElementById("pokedex-inspect-img");
  const reviewsEl = document.getElementById("pokedex-modal-reviews");
  if (!modal) return;

  const rarity = getMovieRarityTier(movieName);
  const rarityMeta = rarity ? RARITY_META[rarity] : null;
  if (sheetEl) {
    sheetEl.classList.remove("is-shiny", "is-foil", "is-especial");
    if (rarity) sheetEl.classList.add(`is-${rarity}`);
  }

  if (numEl) {
    numEl.className = `eyebrow-badge${rarity ? ` ${rarity}-eyebrow` : ""}`;
    numEl.textContent = rarityMeta ? `${rarityMeta.icon} ${numStr} • ${rarityMeta.label}` : numStr;
  }
  if (titleEl) titleEl.textContent = movieName;
  if (hintEl) {
    const unlockedInfo = state.pokedex[movieName];
    const isoDate = unlockedInfo && unlockedInfo.unlockedAt ? String(unlockedInfo.unlockedAt) : "";
    const dateMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
      hintEl.textContent = `Adquirido em ${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
    } else if (unlockedInfo) {
      hintEl.textContent = "Adquirido na coleção";
    } else {
      hintEl.textContent = "Ainda não adquirido (modo vitrine)";
    }
  }
  if (imgEl) {
    imgEl.src = "assets/icon.jpg";
    resolveMoviePoster(movieName).then(url => {
      if (url) imgEl.src = url;
    });
  }

  if (reviewsEl) {
    const movieObj = state.allMovies.find(m => getMovieTitle(m) === movieName);
    const avg = movieObj && typeof movieObj.avgRating === "number" ? movieObj.avgRating : null;
    const count = movieObj && movieObj.ratingCount ? movieObj.ratingCount : 0;

    if (avg != null) {
      // Converte nota 0..10 para 0..5 estrelas em passos de 0.5 (ex: 8,47 -> 4 estrelas; 4,21 -> 2 estrelas; 5,33 -> 2.5 estrelas)
      const stars = Math.round(avg) / 2;
      const avgFormatted = avg.toFixed(2).replace(".", ",");
      const starsFormatted = String(stars).replace(".", ",");
      reviewsEl.innerHTML = `
        <div class="pokedex-rating-box${rarity ? ` is-${rarity}` : ""}">
          <div class="pokedex-stars-row" aria-label="${starsFormatted} de 5 estrelas">
            ${buildStarsSvgHtml(stars)}
          </div>
          <div class="pokedex-rating-score-row">
            <span class="pokedex-rating-avg">${avgFormatted}</span>
            <span class="pokedex-rating-max">/ 10</span>
          </div>
          <span class="pokedex-rating-count">Média de ${count} ${count === 1 ? "nota" : "notas"}</span>
        </div>
      `;
    } else {
      reviewsEl.innerHTML = `
        <div class="pokedex-rating-box">
          <span class="pokedex-rating-count">Sem notas registradas</span>
        </div>
      `;
    }
  }

  setDvd3dMode(true);
  modal.classList.remove("hidden");
}

// ============================================================================
// 11C. PERFIL DO JOGADOR & SINCRONIZAÇÃO EM NUVEM (SUPABASE REST API)
// ============================================================================

function loadProfileSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROFILE_SESSION);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.username && parsed.pinHash) {
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}

function saveProfileSession(sessionObj) {
  state.profileSession = sessionObj;
  try {
    if (sessionObj) {
      localStorage.setItem(STORAGE_KEYS.PROFILE_SESSION, JSON.stringify(sessionObj));
    } else {
      localStorage.removeItem(STORAGE_KEYS.PROFILE_SESSION);
    }
  } catch (_) {}
}

function normalizeUsername(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .trim();
}

async function hashPin(pin, username) {
  const input = `ovavat_v1:${normalizeUsername(username)}:${String(pin || "").trim()}`;
  try {
    if (window.crypto && window.crypto.subtle) {
      const buf = new TextEncoder().encode(input);
      const digest = await window.crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch (_) {}
  // Fallback determinístico caso rode em contexto sem WebCrypto
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function getSupabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function normalizeHistoryEntry(rawEntry) {
  if (rawEntry && typeof rawEntry === "object") {
    const score = Math.min(5, Math.max(0, Math.round(Number(rawEntry.score) || 0)));
    const hintsUsed =
      typeof rawEntry.hintsUsed === "number"
        ? Math.min(score, Math.max(0, Math.round(rawEntry.hintsUsed)))
        : null;
    return {
      score,
      hintsUsed,
      startedAt: Number(rawEntry.startedAt) || Infinity,
      movies: Array.isArray(rawEntry.movies) ? rawEntry.movies : null
    };
  }
  return {
    score: Math.min(5, Math.max(0, Math.round(Number(rawEntry) || 0))),
    hintsUsed: null,
    startedAt: Infinity,
    movies: null
  };
}

function mergeCloudAndLocalData(cloudRow) {
  if (!cloudRow) return;

  // 1. Verifica o progresso de hoje primeiro (se houver 2 jogos separados hoje, prevalece APENAS o 1º que foi jogado!)
  const cloudDaily = (cloudRow.daily_progress && typeof cloudRow.daily_progress === "object")
    ? cloudRow.daily_progress
    : null;

  let forbiddenTodayMovies = new Set();

  if (cloudDaily && cloudDaily.date === state.todayStr) {
    const cloudAns = Array.isArray(cloudDaily.answers) ? cloudDaily.answers : [];
    const localAns = Array.isArray(state.answers) ? state.answers : [];
    const cloudAnsCount = cloudAns.length;
    const localAnsCount = localAns.length;
    const cloudTs = Number(cloudDaily.startedAt) || Infinity;
    const localTs = Number(state.dailyStartedAt) || Infinity;

    let useCloudToday = false;

    if (localAnsCount === 0 && cloudAnsCount > 0) {
      useCloudToday = true;
    } else if (localAnsCount > 0 && cloudAnsCount > 0) {
      if (cloudTs === localTs) {
        // Mesma sessão sincronizada entre aparelhos: avança para a fase mais adiantada
        if (cloudAnsCount > localAnsCount || (cloudDaily.completed && !state.completed)) {
          useCloudToday = true;
        }
      } else {
        // Duas partidas diferentes jogadas no mesmo dia em aparelhos distintos: vale APENAS a que foi jogada primeiro!
        useCloudToday = cloudTs <= localTs;
      }
    }

    const winningAns = useCloudToday ? cloudAns : localAns;
    const losingAns = useCloudToday ? localAns : cloudAns;
    const winningCorrectSet = new Set(
      winningAns
        .map((a, idx) => (a && a.correct ? getMovieFromAnswer(a, idx, state.todayStr) : null))
        .filter(Boolean)
    );
    if (winningCorrectSet.size > 0) {
      losingAns.forEach((a, idx) => {
        const mv = a && a.correct ? getMovieFromAnswer(a, idx, state.todayStr) : null;
        if (mv && !winningCorrectSet.has(mv)) {
          forbiddenTodayMovies.add(mv);
        }
      });
    }

    if (useCloudToday) {
      state.answers = cloudAns;
      state.currentPhase = cloudDaily.currentPhase || 0;
      state.phaseHints = cloudDaily.phaseHints || {};
      state.completed = Boolean(cloudDaily.completed);
      state.dailyStartedAt = Number(cloudDaily.startedAt) || state.dailyStartedAt || Date.now();
      saveDailyProgress();
    }
  }

  // 2. Mescla o histórico por data a partir de COLLECTION_START_DATE (se o mesmo dia existir nos 2 aparelhos, vale SEMPRE o que foi jogado primeiro!)
  const localStats = getStats();
  const cloudStats = sanitizeStatsObject(cloudRow.stats);

  const localHist = (localStats.history && typeof localStats.history === "object") ? localStats.history : {};
  const cloudHist = (cloudStats.history && typeof cloudStats.history === "object") ? cloudStats.history : {};
  const allHistDates = new Set(
    [...Object.keys(cloudHist), ...Object.keys(localHist)].filter(dt => dt >= COLLECTION_START_DATE)
  );
  const mergedHistory = {};
  const forbiddenPastMovies = new Set();

  for (const dt of allHistDates) {
    const hasCloud = Object.prototype.hasOwnProperty.call(cloudHist, dt);
    const hasLocal = Object.prototype.hasOwnProperty.call(localHist, dt);
    if (hasCloud && !hasLocal) {
      mergedHistory[dt] = normalizeHistoryEntry(cloudHist[dt]);
    } else if (hasLocal && !hasCloud) {
      mergedHistory[dt] = normalizeHistoryEntry(localHist[dt]);
    } else {
      const cEntry = normalizeHistoryEntry(cloudHist[dt]);
      const lEntry = normalizeHistoryEntry(localHist[dt]);
      const cloudWon = cEntry.startedAt <= lEntry.startedAt;
      const winner = cloudWon ? cEntry : lEntry;
      const loser = cloudWon ? lEntry : cEntry;
      mergedHistory[dt] = winner;

      if (Array.isArray(winner.movies) && Array.isArray(loser.movies)) {
        const winSet = new Set(winner.movies);
        loser.movies.forEach(mv => {
          if (!winSet.has(mv)) forbiddenPastMovies.add(mv);
        });
      }
    }
  }

  // 3. Mescla a Coleção de DVDs (removendo DVDs anteriores a COLLECTION_START_DATE e filmes de 2ª tentativa do mesmo dia)
  state.pokedex = sanitizePokedexMap(state.pokedex);
  const cloudPokedex = sanitizePokedexMap(cloudRow.pokedex);
  for (const [mv, info] of Object.entries(cloudPokedex)) {
    if (forbiddenTodayMovies.has(mv) || forbiddenPastMovies.has(mv)) continue;
    if (!state.pokedex[mv]) {
      state.pokedex[mv] = info;
    } else if (state.pokedex[mv].usedHint && info && !info.usedHint) {
      state.pokedex[mv].usedHint = false;
    }
  }
  for (const mv of [...forbiddenTodayMovies, ...forbiddenPastMovies]) {
    delete state.pokedex[mv];
  }
  savePokedex();

  // 4. Recalcula as estatísticas gerais exclusivamente a partir do Desafio #1 (COLLECTION_START_DATE)
  const resolvedFormVoter =
    cloudStats.formVoterPicked || localStats.formVoterPicked || getSavedRateVoter() || null;
  const curFormMovie = (state.rateMovieTitle || "Nome Próprio").trim();
  let resolvedVotedMovie =
    cloudStats.formVotedMovie || localStats.formVotedMovie || getVotedFormMovie() || null;
  if (cloudStats.formVotedMovie === curFormMovie || localStats.formVotedMovie === curFormMovie) {
    resolvedVotedMovie = curFormMovie;
  }

  const mergedStats = sanitizeStatsObject({
    history: mergedHistory,
    formVoterPicked: resolvedFormVoter,
    formVotedMovie: resolvedVotedMovie
  });
  saveStats(mergedStats);

  if (mergedStats.formVoterPicked) {
    state.rateSelectedVoter = mergedStats.formVoterPicked;
    try {
      localStorage.setItem(STORAGE_KEYS.FORM_VOTER, mergedStats.formVoterPicked);
    } catch (_) {}
    updateRateVoterUI(mergedStats.formVoterPicked);
  }
  if (mergedStats.formVotedMovie) {
    try {
      localStorage.setItem(STORAGE_KEYS.FORM_VOTED_MOVIE, mergedStats.formVotedMovie);
    } catch (_) {}
  }
  if (state.activeTab === "rate") {
    renderRateMovieView();
  }

  syncPokedexFromProgress();
  updateHeaderStats();
}

async function pushSaveToCloud() {
  if (!state.profileSession || !state.profileSession.username) return false;
  const { username, displayName, pinHash } = state.profileSession;

  const payload = {
    stats: getStats(),
    daily_progress: {
      date: state.todayStr,
      currentPhase: state.currentPhase,
      answers: state.answers,
      phaseHints: state.phaseHints,
      completed: state.completed,
      startedAt: state.dailyStartedAt || 0
    },
    pokedex: state.pokedex,
    updated_at: new Date().toISOString()
  };
  if (displayName) {
    payload.display_name = displayName;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&pin_hash=eq.${encodeURIComponent(pinHash)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: getSupabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function pullAndMergeCloudSave(showFeedback = false) {
  if (!state.profileSession || !state.profileSession.username) return false;
  const { username, pinHash } = state.profileSession;

  try {
    const safeCols = "username,display_name,stats,daily_progress,pokedex,updated_at";
    const url = `${SUPABASE_URL}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&pin_hash=eq.${encodeURIComponent(pinHash)}&select=${safeCols}`;
    const res = await fetch(url, {
      method: "GET",
      headers: getSupabaseHeaders()
    });
    if (!res.ok) return false;
    const rows = await res.json();
    const row = rows && rows[0];
    if (!row) {
      return false;
    }

    const wasCompleted = state.completed;
    const prevAnsCount = state.answers.length;

    state.profileSession.displayName = row.display_name || state.profileSession.displayName;
    saveProfileSession(state.profileSession);

    mergeCloudAndLocalData(row);
    await pushSaveToCloud();

    // Se o jogo de hoje avançou ou concluiu no outro aparelho, atualiza a tela
    if (state.activeTab === "game") {
      if (state.completed && !wasCompleted) {
        showSummaryView();
      } else if (state.answers.length !== prevAnsCount) {
        renderCurrentPhase();
      }
    } else if (state.activeTab === "pokedex") {
      renderPokedexView();
    } else if (state.activeTab === "profile") {
      renderProfileView();
    }

    if (showFeedback) {
      showToast("Save sincronizado com a nuvem! ☁️");
    }
    return true;
  } catch (_) {
    if (showFeedback) {
      showToast("Erro ao conectar na nuvem.");
    }
    return false;
  }
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  const btnLogin = document.getElementById("auth-tab-login");
  const btnRegister = document.getElementById("auth-tab-register");
  const segPill = document.getElementById("profile-auth-seg-pill");
  const displayGroup = document.getElementById("auth-displayname-group");
  const submitText = document.getElementById("btn-auth-submit-text");

  if (state.authMode === "register") {
    btnLogin?.classList.remove("active");
    btnRegister?.classList.add("active");
    segPill?.style.setProperty("--auth-seg-idx", "1");
    displayGroup?.classList.remove("hidden");
    if (submitText) submitText.textContent = "Criar Conta";
  } else {
    btnRegister?.classList.remove("active");
    btnLogin?.classList.add("active");
    segPill?.style.setProperty("--auth-seg-idx", "0");
    displayGroup?.classList.add("hidden");
    if (submitText) submitText.textContent = "Entrar na Conta";
  }
}

async function handleProfileAuthSubmit(e) {
  e.preventDefault();
  const rawUser = document.getElementById("auth-username")?.value || "";
  const rawDisplay = document.getElementById("auth-displayname")?.value || "";
  const rawPin = document.getElementById("auth-pin")?.value || "";
  const submitBtn = document.getElementById("btn-auth-submit");

  const username = normalizeUsername(rawUser);
  if (username.length < 2) {
    showToast("Digite um usuário válido (mín. 2 letras).");
    return;
  }
  if (rawPin.trim().length < 4) {
    showToast("O PIN/Senha deve ter pelo menos 4 caracteres.");
    return;
  }

  const pinHash = await hashPin(rawPin, username);
  if (submitBtn) submitBtn.disabled = true;

  try {
    // Verifica se o usuário já existe no Supabase (sem selecionar pin_hash)
    const checkUrl = `${SUPABASE_URL}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=username,display_name`;
    const checkRes = await fetch(checkUrl, {
      method: "GET",
      headers: getSupabaseHeaders()
    });
    if (!checkRes.ok) {
      showToast("Erro ao conectar com o servidor.");
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    const existingRows = await checkRes.json();
    const existing = existingRows && existingRows[0];

    if (state.authMode === "register") {
      if (existing) {
        showToast("Esse usuário já existe! Mude para 'Entrar'.");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const displayName = rawDisplay.trim() || rawUser.trim() || username;
      const newRow = {
        username,
        display_name: displayName,
        pin_hash: pinHash,
        stats: getStats(),
        daily_progress: {
          date: state.todayStr,
          currentPhase: state.currentPhase,
          answers: state.answers,
          phaseHints: state.phaseHints,
          completed: state.completed,
          startedAt: state.dailyStartedAt || 0
        },
        pokedex: state.pokedex,
        updated_at: new Date().toISOString()
      };

      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: getSupabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify(newRow)
      });

      if (!createRes.ok) {
        showToast("Não foi possível criar a conta.");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      saveProfileSession({ username, displayName, pinHash });
      showToast(`Conta @${username} criada e sincronizada! ☁️`);
    } else {
      if (!existing) {
        showToast("Usuário não encontrado! Clique em 'Criar Conta'.");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const safeCols = "username,display_name,stats,daily_progress,pokedex,updated_at";
      const authUrl = `${SUPABASE_URL}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&pin_hash=eq.${encodeURIComponent(pinHash)}&select=${safeCols}`;
      const authRes = await fetch(authUrl, {
        method: "GET",
        headers: getSupabaseHeaders()
      });
      const authRows = authRes.ok ? await authRes.json() : [];
      const authedRow = authRows && authRows[0];

      if (!authedRow) {
        showToast("PIN ou senha incorretos!");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const displayName = authedRow.display_name || username;
      saveProfileSession({ username, displayName, pinHash });
      mergeCloudAndLocalData(authedRow);
      await pushSaveToCloud();
      showToast(`Bem-vindo de volta, ${displayName}! ☁️`);
    }

    renderProfileView();
    loadLeaderboardFromCloud();
  } catch (_) {
    showToast("Erro de conexão ao autenticar.");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function renderProfileView() {
  const authCard = document.getElementById("profile-auth-card");
  const userCard = document.getElementById("profile-user-card");
  const connectedPill = document.getElementById("profile-connected-pill");
  const connectedUsernameEl = document.getElementById("profile-connected-username");
  const logoutTextEl = document.getElementById("btn-profile-logout-text");
  if (!authCard || !userCard) return;

  if (!state.profileSession || !state.profileSession.username) {
    authCard.classList.remove("hidden");
    userCard.classList.add("hidden");
    connectedPill?.classList.add("hidden");
    return;
  }

  authCard.classList.add("hidden");
  userCard.classList.remove("hidden");
  connectedPill?.classList.remove("hidden");

  const { username } = state.profileSession;
  if (connectedUsernameEl) {
    connectedUsernameEl.textContent = `@${username}`;
  }
  if (logoutTextEl) {
    logoutTextEl.textContent = `Desconectar (@${username})`;
  }
}

async function loadLeaderboardFromCloud() {
  const listEl = document.getElementById("leaderboard-list");
  if (!listEl) return;

  try {
    const url = `${SUPABASE_URL}/rest/v1/profiles?select=username,display_name,stats,daily_progress,pokedex,updated_at&limit=50`;
    const res = await fetch(url, {
      method: "GET",
      headers: getSupabaseHeaders()
    });
    if (!res.ok) return;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = `<p class="leaderboard-empty">Crie sua conta acima para inaugurar o ranking da galera!</p>`;
      return;
    }

    const parsed = rows.map(r => {
      const st = sanitizeStatsObject(r.stats);
      const pk = sanitizePokedexMap(r.pokedex);
      const dvds = Object.keys(pk).length;
      const histEntries = st.history ? Object.entries(st.history) : [];

      let rankingPoints = 0;
      if (histEntries.length > 0) {
        for (const [dt, entry] of histEntries) {
          const dayScore = Math.min(5, Math.max(0, Math.round(Number(entry.score) || 0)));
          if (dt < HINT_HALF_POINT_START_DATE) {
            // Antes de 20/11, todos os acertos (verdes ou amarelos) continuam valendo 1 ponto
            rankingPoints += dayScore;
          } else {
            // A partir de 20/11, acertos amarelos (2ª dica) valem 0.5 ponto
            let hints = 0;
            if (typeof entry.hintsUsed === "number") {
              hints = entry.hintsUsed;
            } else if (
              r.daily_progress &&
              r.daily_progress.date === dt &&
              Array.isArray(r.daily_progress.answers)
            ) {
              hints = r.daily_progress.answers.filter(a => a && a.correct && a.usedHint).length;
            } else if (Array.isArray(entry.movies)) {
              hints = entry.movies.filter(
                mv => pk[mv] && pk[mv].unlockedAt === dt && pk[mv].usedHint
              ).length;
            }
            hints = Math.min(dayScore, Math.max(0, hints));
            rankingPoints += dayScore - hints * 0.5;
          }
        }
        rankingPoints = Math.round(rankingPoints * 2) / 2;
      } else {
        rankingPoints = dvds;
      }

      const streak = st.currentStreak || 0;
      return {
        username: r.username,
        displayName: r.display_name || r.username,
        streak,
        dvds,
        totalCorrect: rankingPoints
      };
    });

    parsed.sort((a, b) => {
      if (b.totalCorrect !== a.totalCorrect) return b.totalCorrect - a.totalCorrect;
      return b.streak - a.streak;
    });

    listEl.innerHTML = "";
    let currentRank = 1;
    parsed.forEach((p, idx) => {
      if (idx > 0 && p.totalCorrect < parsed[idx - 1].totalCorrect) {
        currentRank = idx + 1;
      }
      const isMe = state.profileSession && state.profileSession.username === p.username;
      const isFirst = currentRank === 1;
      const rankBadge = currentRank === 1 ? "🥇" : currentRank === 2 ? "🥈" : currentRank === 3 ? "🥉" : `${currentRank}º`;
      const row = document.createElement("div");
      row.className = `leaderboard-item${isMe ? " is-me" : ""}${isFirst ? " is-first" : ""}`;
      row.innerHTML = `
        <span class="leaderboard-rank">${rankBadge}</span>
        <div class="leaderboard-user">
          <span class="leaderboard-name">${escapeHtml(p.displayName)}</span>
          <div class="leaderboard-meta-row">
            <span class="leaderboard-streak-badge" title="Streak ativa">🔥 ${p.streak}</span>
            <span class="leaderboard-streak-badge" title="DVDs colecionados">💿 ${p.dvds}</span>
          </div>
        </div>
        <div class="leaderboard-badges">
          <span class="leaderboard-score-pill">🎯 ${p.totalCorrect}</span>
        </div>
      `;
      listEl.appendChild(row);
    });
  } catch (_) {}
}

// ============================================================================
// 12. COUNTDOWN PARA MEIA-NOITE
// ============================================================================

function startCountdownTimer() {
  function update() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    const diff = Math.max(0, tomorrow - now);

    const hh = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");

    const el = document.getElementById("countdown-timer");
    if (el) el.textContent = `${hh}:${mm}:${ss}`;
  }
  update();
  setInterval(update, 1000);
}

// ============================================================================
// 13. INICIALIZAÇÃO E EVENTOS
// ============================================================================

function bindEvents() {
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-next").addEventListener("click", handleNextPhase);
  document.getElementById("btn-another-review")?.addEventListener("click", handleRequestAnotherReview);

  document.getElementById("btn-pwa-dismiss")?.addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEYS.PWA_DISMISSED_DATE, state.todayStr);
    document.getElementById("modal-pwa-install")?.classList.add("hidden");
  });

  document.getElementById("btn-pwa-native-install")?.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    document.getElementById("modal-pwa-install")?.classList.add("hidden");
  });

  // Botão secreto de Reset ao clicar 5 vezes seguidas no ícone do topo (com 2 etapas de confirmação)
  let logoClickCount = 0;
  let logoClickTimer = null;
  document.getElementById("brand-icon-trigger").addEventListener("click", () => {
    logoClickCount += 1;
    clearTimeout(logoClickTimer);

    if (logoClickCount >= 5) {
      logoClickCount = 0;
      document.getElementById("reset-step-1").classList.remove("hidden");
      document.getElementById("reset-step-2").classList.add("hidden");
      document.getElementById("modal-reset").classList.remove("hidden");
    } else {
      logoClickTimer = setTimeout(() => {
        logoClickCount = 0;
      }, 1800);
    }
  });

  document.getElementById("btn-reset-step1").addEventListener("click", () => {
    document.getElementById("reset-step-1").classList.add("hidden");
    document.getElementById("reset-step-2").classList.remove("hidden");
  });

  document.getElementById("btn-confirm-reset-same").addEventListener("click", () => {
    resetDailyGameForTesting();
  });

  document.getElementById("btn-cancel-reset").addEventListener("click", () => {
    document.getElementById("modal-reset").classList.add("hidden");
  });

  document.getElementById("btn-copy-result").addEventListener("click", async () => {
    const text = buildShareText();
    try {
      await navigator.clipboard.writeText(text);
      showToast("Resultado copiado! 📋");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Resultado copiado! 📋");
    }
  });

  document.getElementById("btn-share-whatsapp").addEventListener("click", () => {
    const text = buildShareText();
    const mobilePlatform = getMobilePlatform();
    if (mobilePlatform) {
      // No iOS/Android (especialmente dentro do WebApp), abre o protocolo nativo whatsapp://
      // direto na janela atual para não criar uma aba intermediária em branco ao voltar pro app!
      window.location.href = `whatsapp://send?text=${encodeURIComponent(text)}`;
    } else {
      const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
      window.open(waUrl, "_blank", "noopener,noreferrer");
    }
  });

  document.getElementById("btn-help").addEventListener("click", () => {
    document.getElementById("modal-help").classList.remove("hidden");
  });

  document.getElementById("btn-stats").addEventListener("click", () => {
    renderStatsModal();
    document.getElementById("modal-stats").classList.remove("hidden");
  });

  // Navegação Liquid Glass (Jogo / Coleção / Avaliar / Ranking) com suporte a toque E arraste contínuo da gota líquida iOS 27
  const navShell = document.getElementById("liquid-glass-shell");
  const navGlider = document.getElementById("liquid-glass-glider");
  const navTabs = ["game", "pokedex", "rate", "profile"];
  const navButtons = [
    document.getElementById("nav-tab-game"),
    document.getElementById("nav-tab-pokedex"),
    document.getElementById("nav-tab-rate"),
    document.getElementById("nav-tab-profile")
  ];

  let navDragState = {
    pointerDown: false,
    dragging: false,
    startX: 0,
    startIdx: 0,
    currentIdx: 0,
    suppressClickUntil: 0
  };

  function getTabIdxFromName(tabName) {
    if (tabName === "pokedex") return 1;
    if (tabName === "rate") return 2;
    if (tabName === "profile") return 3;
    return 0;
  }

  function computeContinuousIdxFromClientX(clientX) {
    if (!navShell) return 0;
    const rect = navShell.getBoundingClientRect();
    const pad = 4;
    const innerWidth = Math.max(1, rect.width - pad * 2);
    const pillWidth = innerWidth / 4;
    // Posição do centro da pílula seguindo o dedo
    const rawIdx = (clientX - rect.left - pad - pillWidth / 2) / pillWidth;
    // Resistência elástica sutil nas extremidades (rubber-band iOS)
    if (rawIdx < 0) return Math.max(-0.12, rawIdx * 0.25);
    if (rawIdx > 3) return Math.min(3.12, 3 + (rawIdx - 3) * 0.25);
    return rawIdx;
  }

  function highlightNavButtonAtIdx(roundedIdx) {
    navButtons.forEach((btn, i) => {
      if (!btn) return;
      btn.classList.toggle("active", i === roundedIdx);
    });
  }

  if (navShell && navGlider) {
    navShell.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      navDragState.pointerDown = true;
      navDragState.dragging = false;
      navDragState.startX = e.clientX;
      navDragState.startIdx = getTabIdxFromName(state.activeTab);
      navDragState.currentIdx = navDragState.startIdx;
    });

    navShell.addEventListener("pointermove", e => {
      if (!navDragState.pointerDown) return;
      const dx = Math.abs(e.clientX - navDragState.startX);
      if (!navDragState.dragging && dx > 6) {
        navDragState.dragging = true;
        try {
          navShell.setPointerCapture(e.pointerId);
        } catch (_) {}
        navGlider.classList.add("is-dragging");
        navGlider.style.setProperty("--glider-sx", "1.1");
        navGlider.style.setProperty("--glider-sy", "1.03");
      }

      if (navDragState.dragging) {
        const contIdx = computeContinuousIdxFromClientX(e.clientX);
        navDragState.currentIdx = contIdx;
        navGlider.style.setProperty("--glider-idx", contIdx.toFixed(3));
        const nearest = Math.max(0, Math.min(3, Math.round(contIdx)));
        highlightNavButtonAtIdx(nearest);
      }
    });

    const finishNavDrag = e => {
      if (!navDragState.pointerDown) return;
      const wasDragging = navDragState.dragging;
      navDragState.pointerDown = false;
      navDragState.dragging = false;

      if (wasDragging) {
        try {
          if (e && e.pointerId != null) navShell.releasePointerCapture(e.pointerId);
        } catch (_) {}
        navDragState.suppressClickUntil = Date.now() + 250;
        navGlider.classList.remove("is-dragging");
        const targetIdx = Math.max(0, Math.min(3, Math.round(navDragState.currentIdx)));
        const targetTab = navTabs[targetIdx] || "game";
        switchMainTab(targetTab);
      } else if (e && e.type === "pointerup") {
        // Clique/toque rápido sem arrastar: muda a página instantaneamente e desliza a gota rapidamente até o ícone clicado!
        const btn = e.target && e.target.closest ? e.target.closest(".liquid-nav-item") : null;
        let targetTab = btn ? btn.getAttribute("data-tab") : null;
        if (!targetTab) {
          const rect = navShell.getBoundingClientRect();
          const slotIdx = Math.max(0, Math.min(3, Math.floor(((e.clientX - rect.left) / Math.max(1, rect.width)) * 4)));
          targetTab = navTabs[slotIdx] || "game";
        }
        navDragState.suppressClickUntil = Date.now() + 250;
        switchMainTab(targetTab);
      }
    };

    navShell.addEventListener("pointerup", finishNavDrag);
    navShell.addEventListener("pointercancel", finishNavDrag);
  }

  document.getElementById("nav-tab-game")?.addEventListener("click", () => {
    if (Date.now() < navDragState.suppressClickUntil) return;
    switchMainTab("game");
  });
  document.getElementById("nav-tab-pokedex")?.addEventListener("click", () => {
    if (Date.now() < navDragState.suppressClickUntil) return;
    switchMainTab("pokedex");
  });
  document.getElementById("nav-tab-rate")?.addEventListener("click", () => {
    if (Date.now() < navDragState.suppressClickUntil) return;
    switchMainTab("rate");
  });
  document.getElementById("nav-tab-profile")?.addEventListener("click", () => {
    if (Date.now() < navDragState.suppressClickUntil) return;
    switchMainTab("profile");
  });

  // Eventos da aba Avaliar Filme (IMDb do Ovavat — Google Forms)
  document.getElementById("btn-rate-voter-picker")?.addEventListener("click", () => {
    openRateVoterModal();
  });

  document.querySelectorAll("#rate-names-grid .rate-name-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-name") || "";
      selectRateVoter(name, { persist: true, closeModal: true });
    });
  });

  ["rate-slider-nota", "rate-slider-riso", "rate-slider-lacre"].forEach(sliderId => {
    const sliderEl = document.getElementById(sliderId);
    sliderEl?.addEventListener("input", () => {
      updateRateSliderUI(sliderId, sliderEl.value);
    });
  });

  document.getElementById("imdb-rate-form")?.addEventListener("submit", handleRateFormSubmit);

  // Eventos da aba Perfil (Login / Criar Conta / Sincronizar / Sair)
  document.getElementById("auth-tab-login")?.addEventListener("click", () => {
    setAuthMode("login");
  });
  document.getElementById("auth-tab-register")?.addEventListener("click", () => {
    setAuthMode("register");
  });
  document.getElementById("profile-auth-form")?.addEventListener("submit", handleProfileAuthSubmit);

  document.getElementById("btn-profile-sync")?.addEventListener("click", () => {
    pullAndMergeCloudSave(true);
    loadLeaderboardFromCloud();
  });

  document.getElementById("btn-profile-logout")?.addEventListener("click", () => {
    saveProfileSession(null);
    renderProfileView();
    loadLeaderboardFromCloud();
    showToast("Você saiu da conta.");
  });

  // Sincroniza automaticamente quando a pessoa volta para a aba/app no celular ou PC
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.profileSession) {
      pullAndMergeCloudSave(false);
    }
  });

  // Filtros da Coleção (com Easter Egg: clicar 10x seguidas em "Todos" revela todos os filmes visualmente até trocar de aba)
  document.querySelectorAll("#pokedex-view .pokedex-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pokedex-view .pokedex-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.getAttribute("data-filter") || "all";
      state.pokedexFilter = filter;

      if (filter === "all") {
        state.pokedexTodosClicks = (state.pokedexTodosClicks || 0) + 1;
        if (state.pokedexTodosClicks >= 10) {
          state.pokedexTodosClicks = 0;
          state.pokedexPreviewAll = true;
          showToast("✨ Modo Vitrine: todos os DVDs visíveis!");
        }
      } else {
        state.pokedexTodosClicks = 0;
      }

      renderPokedexView();
    });
  });

  document.querySelectorAll(".modal-close").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-close");
      if (targetId) document.getElementById(targetId).classList.add("hidden");
    });
  });

  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", e => {
      if (e.target === backdrop) backdrop.classList.add("hidden");
    });
  });
}

async function initApp() {
  initTheme();
  initDvd3dInteractions();

  const dateParts = getBrazilDateParts();
  state.todayStr = dateParts.iso;
  state.displayDateStr = dateParts.brFull;
  state.shortDateStr = dateParts.brShort;
  state.editionNumber = computeEditionNumber(state.todayStr);
  state.posterMemoryCache = loadPosterCache();

  try {
    const cachedFormMovie = localStorage.getItem(STORAGE_KEYS.FORM_MOVIE);
    if (cachedFormMovie && cachedFormMovie.trim().length >= 2) {
      state.rateMovieTitle = cachedFormMovie.trim();
    }
  } catch (_) {}
  syncFormMovieFromGoogleForms();

  bindEvents();
  startCountdownTimer();
  initWebAppInstallPrompt();

  const dataset = await loadReviewsDataset();
  state.allReviews = dataset.reviews;
  state.allMovies = dataset.movies;

  updateHeaderStats();

  state.dailyPhases = buildDailyChallenge(
    state.allReviews,
    state.allMovies,
    state.todayStr
  );
  preloadDailyPosters();

  const savedDaily = loadDailyProgress();
  if (savedDaily) {
    state.currentPhase = savedDaily.currentPhase || 0;
    state.answers = savedDaily.answers || [];
    state.phaseHints = savedDaily.phaseHints || {};
    state.completed = Boolean(savedDaily.completed);
    state.dailyStartedAt =
      Number(savedDaily.startedAt) || (state.answers.length > 0 ? Date.now() : 0);
  }

  syncPokedexFromProgress();
  updateHeaderStats();

  // Carrega sessão do Perfil e sincroniza na nuvem com o Supabase automaticamente
  state.profileSession = loadProfileSession();
  if (state.profileSession) {
    pullAndMergeCloudSave(false);
  }

  document.getElementById("loading-view").classList.add("hidden");

  if (state.completed) {
    showSummaryView();
  } else {
    document.getElementById("game-view").classList.remove("hidden");
    renderCurrentPhase();
  }
}

document.addEventListener("DOMContentLoaded", initApp);
