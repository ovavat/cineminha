/**
 * Ovavat (Cineminha do Ovavat) — Jogo Diário de 5 Fases
 * Sincronizado automaticamente com a planilha oficial de reviews das quintas-feiras.
 */

const SHEET_ID = "1tc1H0_WYPXklo5YnFsU8CJ9trZKHK9Yd6oJnDHWZUFE";
const GVIZ_JSON_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
const GVIZ_JSONP_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=responseHandler:__ovavatSheetCallback`;

const TOTAL_PHASES = 5;
const LAUNCH_DATE_STR = "2026-11-13"; // Dia #1 do Cineminha do Ovavat

const STORAGE_KEYS = {
  STATS: "ovavat_stats_v1",
  DAILY_PROGRESS: "ovavat_daily_v1",
  SHEET_CACHE: "ovavat_sheet_cache_v1",
  POSTER_CACHE: "ovavat_poster_cache_v6_posters_only",
  THEME: "ovavat_theme_v2_light",
  PWA_DISMISSED_DATE: "ovavat_pwa_dismissed_v1"
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
  posterMemoryCache: {},
  posterInflight: {},
  deferredInstallPrompt: null,
  gyro: {
    enabled: false,
    listening: false,
    active3D: false,
    baseBeta: null,
    baseGamma: null,
    targetRx: 4,
    targetRy: -16,
    currentRx: 4,
    currentRy: -16,
    hasSensorData: false,
    pointerInteracting: false,
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
// 3. BOX DE DVD 3D COM GIROSCÓPIO (SEM MOSTRAR O VERSO)
// ============================================================================

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function requestGyroPermissionFromUserGesture() {
  // No iOS 13+, solicita permissão explícita no gesto de clique
  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    DeviceOrientationEvent.requestPermission()
      .then(status => {
        if (status === "granted") {
          attachGyroListener();
        }
      })
      .catch(() => {});
  }

  if (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  ) {
    DeviceMotionEvent.requestPermission()
      .then(status => {
        if (status === "granted") {
          attachGyroListener();
        }
      })
      .catch(() => {});
  }

  attachGyroListener();
}

function normalizeAngleDelta(delta) {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

function attachGyroListener() {
  if (state.gyro.listening) return;
  state.gyro.listening = true;

  let hasOrientationAngles = false;

  function handleOrientationEvent(e) {
    if (!state.gyro.active3D || state.gyro.pointerInteracting) return;
    if (e.gamma == null || e.beta == null) return;
    if (e.gamma === 0 && e.beta === 0 && e.alpha === 0) return;

    hasOrientationAngles = true;
    state.gyro.hasSensorData = true;

    if (state.gyro.baseBeta === null || state.gyro.baseGamma === null) {
      state.gyro.baseBeta = e.beta;
      state.gyro.baseGamma = e.gamma;
    }

    const deltaGamma = normalizeAngleDelta(e.gamma - state.gyro.baseGamma);
    const deltaBeta = normalizeAngleDelta(e.beta - state.gyro.baseBeta);

    // Recalibra suavemente a base se a pessoa mudar muito a postura do celular
    if (Math.abs(deltaGamma) > 45) {
      state.gyro.baseGamma = e.gamma - Math.sign(deltaGamma) * 30;
    }
    if (Math.abs(deltaBeta) > 45) {
      state.gyro.baseBeta = e.beta - Math.sign(deltaBeta) * 25;
    }

    // Limita entre -26° e +26° no eixo Y e -18° e +18° no eixo X para NUNCA mostrar o verso!
    state.gyro.targetRy = clamp(-10 + deltaGamma * 0.95, -26, 26);
    state.gyro.targetRx = clamp(4 - deltaBeta * 0.75, -18, 18);
  }

  // 1. Sensor de orientação padrão (iOS + Android com giroscópio)
  window.addEventListener("deviceorientation", handleOrientationEvent, true);

  // 2. Sensor de orientação absoluta do Chrome no Android
  if ("ondeviceorientationabsolute" in window) {
    window.addEventListener("deviceorientationabsolute", handleOrientationEvent, true);
  }

  // 3. Fallback universal para Android (DeviceMotion / Acelerômetro de gravidade)
  // Funciona mesmo em celulares Android que não possuem giroscópio físico dedicado!
  let baseGx = null;
  let baseGy = null;

  function applyGravityVector(gx, gy) {
    if (!state.gyro.active3D || state.gyro.pointerInteracting || hasOrientationAngles) return;
    if (gx == null || gy == null) return;

    state.gyro.hasSensorData = true;

    if (baseGx === null || baseGy === null) {
      baseGx = gx;
      baseGy = gy;
    }

    const dGx = gx - baseGx;
    const dGy = gy - baseGy;

    // No acelerômetro, inclinar o celular para os lados altera gx (-9.8 a +9.8 m/s²)
    state.gyro.targetRy = clamp(-10 - dGx * 4.2, -26, 26);
    state.gyro.targetRx = clamp(4 + dGy * 3.2, -18, 18);
  }

  window.addEventListener(
    "devicemotion",
    e => {
      const ag = e.accelerationIncludingGravity;
      if (!ag) return;
      applyGravityVector(ag.x, ag.y);
    },
    true
  );

  // 4. API nativa Generic Sensor do Chrome no Android (Accelerometer / GravitySensor)
  try {
    const SensorClass = window.GravitySensor || window.Accelerometer;
    if ( typeof SensorClass === "function" ) {
      const sensor = new SensorClass({ frequency: 30 });
      sensor.addEventListener("reading", () => {
        applyGravityVector(sensor.x, sensor.y);
      });
      sensor.start();
    }
  } catch (_) {}
}

function initDvd3dInteractions() {
  const stage = document.getElementById("dvd-stage");
  if (!stage) return;

  // No Android, não precisa esperar permissão de clique como no iOS: já ativa os sensores ao carregar!
  if (
    typeof DeviceOrientationEvent === "undefined" ||
    typeof DeviceOrientationEvent.requestPermission !== "function"
  ) {
    attachGyroListener();
  }

  function updateFromPointer(clientX, clientY, targetStage) {
    if (!state.gyro.active3D || !targetStage) return;
    const rect = targetStage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;  // -1..1
    const ny = ((clientY - rect.top) / rect.height) * 2 - 1;  // -1..1

    state.gyro.targetRy = clamp(nx * 25, -26, 26);
    state.gyro.targetRx = clamp(-ny * 17, -18, 18);
  }

  stage.addEventListener("pointerdown", e => {
    if (!state.gyro.active3D) return;
    state.gyro.pointerInteracting = true;
    updateFromPointer(e.clientX, e.clientY, stage);
  });

  window.addEventListener("pointermove", e => {
    if (!state.gyro.active3D) return;
    const shelfStage = document.getElementById("summary-shelf-stage");
    const activeStage = !document.getElementById("summary-view")?.classList.contains("hidden") && shelfStage
      ? shelfStage
      : stage;

    if (state.gyro.pointerInteracting || e.pointerType === "mouse") {
      const rect = activeStage.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left - 40 &&
        e.clientX <= rect.right + 40 &&
        e.clientY >= rect.top - 40 &&
        e.clientY <= rect.bottom + 40;
      if (state.gyro.pointerInteracting || inside) {
        updateFromPointer(e.clientX, e.clientY, activeStage);
      }
    }
  });

  window.addEventListener("pointerup", () => {
    state.gyro.pointerInteracting = false;
  });
}

function startDvd3dAnimationLoop() {
  if (state.gyro.rafId) cancelAnimationFrame(state.gyro.rafId);

  const boxEl = document.getElementById("dvd-box-3d");
  const shadowEl = document.getElementById("dvd-shadow");
  const shelfStageEl = document.getElementById("summary-shelf-stage");
  const startTime = performance.now();

  function tick(now) {
    if (!state.gyro.active3D) return;

    // Se o celular ainda não mexeu o giroscópio nem o dedo está tocando, faz um movimento suave de vitrine 3D
    if (!state.gyro.hasSensorData && !state.gyro.pointerInteracting) {
      const t = (now - startTime) * 0.0018;
      state.gyro.targetRy = -14 + Math.sin(t) * 10; // Oscila entre -24° e -4° mostrando a lombada do DVD
      state.gyro.targetRx = 4 + Math.cos(t * 0.8) * 5;
    }

    // Interpolação suave (lerp)
    state.gyro.currentRx += (state.gyro.targetRx - state.gyro.currentRx) * 0.14;
    state.gyro.currentRy += (state.gyro.targetRy - state.gyro.currentRy) * 0.14;

    const rx = clamp(state.gyro.currentRx, -18, 18);
    const ry = clamp(state.gyro.currentRy, -26, 26);
    const glareX = clamp(50 - ry * 1.6, 10, 90);
    const glareY = clamp(45 + rx * 1.8, 10, 90);

    if (boxEl) {
      boxEl.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      boxEl.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      boxEl.style.setProperty("--glare-x", `${glareX.toFixed(1)}%`);
      boxEl.style.setProperty("--glare-y", `${glareY.toFixed(1)}%`);
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

    state.gyro.rafId = requestAnimationFrame(tick);
  }

  state.gyro.rafId = requestAnimationFrame(tick);
}

function setDvd3dMode(enable3D) {
  const stage = document.getElementById("dvd-stage");
  if (!stage) return;

  state.gyro.active3D = enable3D;
  state.gyro.baseBeta = null;
  state.gyro.baseGamma = null;

  if (enable3D) {
    stage.classList.remove("flat-mode");
    state.gyro.currentRx = 4;
    state.gyro.currentRy = -16;
    state.gyro.targetRx = 4;
    state.gyro.targetRy = -16;
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
  const movieFirstDate = new Map();

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].c;
    if (!c) continue;

    const dateFormatted = c[0] ? (c[0].f || String(c[0].v || "")).trim() : "";
    const movie = c[1] && c[1].v != null ? String(c[1].v).trim() : "";
    const author = c[3] && c[3].v != null ? String(c[3].v).trim() : "Anônimo";

    if (!movie) continue;
    const rowIso = parseBrDateToIso(dateFormatted);
    if (!movieFirstDate.has(movie) || (rowIso && rowIso < movieFirstDate.get(movie))) {
      movieFirstDate.set(movie, rowIso);
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

  const movies = Array.from(movieFirstDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
    .map(([title, firstIso]) => ({ title, firstIso }));

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

function buildDailyChallenge(reviews, allMovies, dateIso) {
  const eligibleReviews = reviews.filter(r => {
    const rIso = parseBrDateToIso(r.date);
    return !rIso || rIso < dateIso;
  });

  const pool = eligibleReviews.length >= TOTAL_PHASES ? eligibleReviews : reviews;
  const seedKey = `cineminha-ovavat-${dateIso}`;
  const rng = mulberry32(cyrb32(seedKey));

  const shuffledReviews = seededShuffle(pool, rng);

  const selectedReviews = [];
  const usedMoviesToday = new Set();

  for (const rev of shuffledReviews) {
    if (!usedMoviesToday.has(rev.movie)) {
      usedMoviesToday.add(rev.movie);
      selectedReviews.push(rev);
      if (selectedReviews.length === TOTAL_PHASES) break;
    }
  }

  if (selectedReviews.length < TOTAL_PHASES) {
    for (const rev of shuffledReviews) {
      if (!selectedReviews.includes(rev)) {
        selectedReviews.push(rev);
        if (selectedReviews.length === TOTAL_PHASES) break;
      }
    }
  }

  const normalizedMovies = allMovies.map(m =>
    typeof m === "string" ? { title: m, firstIso: "" } : m
  );
  const eligibleMovieTitles = normalizedMovies
    .filter(m => !m.firstIso || m.firstIso < dateIso)
    .map(m => m.title);
  const moviePool = eligibleMovieTitles.length >= 4
    ? eligibleMovieTitles
    : normalizedMovies.map(m => m.title);

  return selectedReviews.map((reviewObj, phaseIdx) => {
    const phaseRng = mulberry32(cyrb32(`${seedKey}-phase-${phaseIdx}-${reviewObj.movie}`));
    const wrongPool = moviePool.filter(m => m !== reviewObj.movie);
    const distractors = seededShuffle(wrongPool, phaseRng).slice(0, 3);
    const options = seededShuffle([reviewObj.movie, ...distractors], phaseRng);
    const correctIndex = options.indexOf(reviewObj.movie);

    // Apenas 1 review extra do mesmo filme (sorteada de forma determinística para todos no dia)
    const extraRng = mulberry32(cyrb32(`${seedKey}-extra-reviews-${phaseIdx}-${reviewObj.movie}`));
    const sameMovieOthers = pool.filter(
      r => r.movie === reviewObj.movie && r.review.trim() !== reviewObj.review.trim()
    );
    const extraReviews = seededShuffle(sameMovieOthers, extraRng).slice(0, 1);

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
    return { ...(window.OVAVAT_POSTERS || {}), ...saved };
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
  const cand = normalizeTitleStrict(candidateTitle);
  const targ = normalizeTitleStrict(targetMovieTitle);
  const hintNorm = optionalHint ? normalizeTitleStrict(optionalHint) : "";

  if (!cand || !targ) return false;
  if (cand === targ) return true;
  if (hintNorm && cand === hintNorm) return true;

  const candNoOFilme = cand.replace(/\bo filme\b/g, "").replace(/\s+/g, " ").trim();
  const targNoOFilme = targ.replace(/\bo filme\b/g, "").replace(/\s+/g, " ").trim();
  if (candNoOFilme === targNoOFilme) return true;

  const targWords = targ.split(" ");
  if (targWords.length >= 2 && targ.length >= 8) {
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

async function fetchCinemetaCandidates(movieTitle, knownImdbId = null) {
  const urls = [];

  if (knownImdbId && String(knownImdbId).startsWith("tt")) {
    urls.push(`https://images.metahub.space/poster/medium/${knownImdbId}/img`);
    try {
      const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${knownImdbId}.json`);
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        if (metaData?.meta?.poster) urls.push(metaData.meta.poster);
      }
    } catch (_) {}
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
      const candidates = exact ? [exact, ...metas.filter(m => m !== exact)] : metas.slice(0, 2);

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

  try {
    const items = await fetchImdbV2Jsonp(clean);
    const titleItems = items.filter(
      it => it.id && String(it.id).startsWith("tt") && it.i && (it.i[0] || it.i.imageUrl)
    );
    if (titleItems.length > 0) {
      const exact = titleItems.find(it => isSameMovieTitle(it.l, clean)) || titleItems[0];
      const rawUrl = Array.isArray(exact.i) ? exact.i[0] : exact.i.imageUrl;
      if (rawUrl) {
        return rawUrl.replace(/\._V1_.*\.jpg$/i, "._V1_SX500.jpg");
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

      const exact = titleItems.find(it => isSameMovieTitle(it.l, clean)) || titleItems[0];
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
    if (!res.ok) return { images: [], imdbId: null };
    const data = await res.json();
    const html = data?.parse?.text?.["*"];
    if (!html) return { images: [], imdbId: null };

    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d{6,10})/i);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const infoboxText = (doc.querySelector(".infobox, .infobox_v2")?.textContent || "").toLowerCase();
    if (
      infoboxText.includes("nascimento") &&
      infoboxText.includes("ocupação") &&
      !infoboxText.includes("direção") &&
      !infoboxText.includes("lançamento")
    ) {
      return { images: [], imdbId: null };
    }

    const images = [];
    const imgs = doc.querySelectorAll(".infobox img, .infobox_v2 img, table.infobox img");
    for (const img of imgs) {
      const width = parseInt(img.getAttribute("width") || "0", 10);
      if (width > 0 && width < 90) continue;

      let src = img.getAttribute("src") || "";
      if (!src) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!isUsablePosterUrl(src)) continue;

      src = src.replace(/\/(\d+)px-/, "/500px-");
      images.push(src);
    }
    return { images, imdbId };
  } catch (_) {}
  return { images: [], imdbId: null };
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

  for (const q of queries) {
    const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&origin=*&format=json&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=pageimages&piprop=thumbnail|original&pithumbsize=600&pilicense=any`;

    const res = await fetch(endpoint);
    if (!res.ok) continue;
    const data = await res.json();
    if (!data?.query?.pages) continue;

    const pages = Object.values(data.query.pages).sort(
      (a, b) => (a.index || 99) - (b.index || 99)
    );

    for (const page of pages) {
      if (!isSameMovieTitle(page.title, cleanTitle, hint)) {
        continue;
      }

      const directImg =
        (page.thumbnail && page.thumbnail.source) ||
        (page.original && page.original.source);
      if (isUsablePosterUrl(directImg)) {
        imageUrls.push(directImg);
      }

      const info = await extractInfoboxDataFromPageId(page.pageid, lang);
      if (info.imdbId && !foundImdbId) {
        foundImdbId = info.imdbId;
      }
      for (const u of info.images) {
        if (!imageUrls.includes(u)) imageUrls.push(u);
      }

      if (imageUrls.length > 0 || foundImdbId) {
        return { imageUrls, imdbId: foundImdbId };
      }
    }
  }

  return { imageUrls, imdbId: foundImdbId };
}

async function fetchPosterFromItunes(movieTitle) {
  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&country=BR&media=movie&entity=movie&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;

  const exact = data.results.find(item => isSameMovieTitle(item.trackName, cleanTitle));
  if (exact && exact.artworkUrl100) {
    return exact.artworkUrl100.replace("100x100bb", "600x900bb");
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
    // Guarda a primeira imagem horizontal (cena/foto do filme) APENAS como último recurso
    // caso nenhum pôster vertical (isPortrait) exista em nenhuma fonte.
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

    // 1. iTunes Movie Store BR (sempre cartazes oficiais brasileiros verticais 2:3)
    try {
      const itunesUrl = await fetchPosterFromItunes(movieTitle);
      const portrait = await checkCandidate(itunesUrl);
      if (portrait) {
        savePosterToCache(movieTitle, portrait);
        return portrait;
      }
    } catch (_) {}

    // 2. Wikipedia PT (verifica primeiro se a imagem é um pôster vertical + extrai o ID tt do IMDb do filme)
    let wikiImdbId = null;
    try {
      const wikiPt = await fetchWikipediaCandidates(movieTitle, "pt");
      wikiImdbId = wikiPt.imdbId;
      for (const candidateUrl of wikiPt.imageUrls) {
        const portrait = await checkCandidate(candidateUrl);
        if (portrait) {
          savePosterToCache(movieTitle, portrait);
          return portrait;
        }
      }
    } catch (_) {}

    // 3. Cinemeta API + Metahub (usando tanto o ID exato do IMDb quanto o título do filme)
    try {
      const cinemetaUrls = await fetchCinemetaCandidates(movieTitle, wikiImdbId);
      for (const candidateUrl of cinemetaUrls) {
        const portrait = await checkCandidate(candidateUrl);
        if (portrait) {
          savePosterToCache(movieTitle, portrait);
          return portrait;
        }
      }
    } catch (_) {}

    // 4. IMDb Suggest API (busca direta por ID ou título)
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

    // 5. Se realmente não existir cartaz vertical em lugar nenhum, usa a outra imagem encontrada
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

function getStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STATS);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (_) {}
  return {
    played: 0,
    totalCorrect: 0,
    currentStreak: 0,
    maxStreak: 0,
    lastCompletedDate: null,
    distribution: [0, 0, 0, 0, 0, 0]
  };
}

function saveStats(stats) {
  try {
    localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(stats));
  } catch (_) {}
}

function recordDailyCompletion(score) {
  const stats = getStats();
  if (stats.lastCompletedDate === state.todayStr) {
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
        completed: state.completed
      })
    );
  } catch (_) {}
}

function resetDailyGameForTesting() {
  localStorage.removeItem(STORAGE_KEYS.DAILY_PROGRESS);
  state.currentPhase = 0;
  state.answers = [];
  state.phaseHints = {};
  state.completed = false;
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
  const yesterdayIso = getYesterdayIso(state.todayStr);
  let activeStreak = stats.currentStreak;
  if (
    stats.lastCompletedDate &&
    stats.lastCompletedDate !== state.todayStr &&
    stats.lastCompletedDate !== yesterdayIso
  ) {
    activeStreak = 0;
  }

  document.getElementById("header-streak").textContent = String(activeStreak);
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
  reviewTextEl.innerHTML = formatReviewHtml(
    activeReviewObj.review,
    activeReviewObj.movie,
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
  const revealCard = document.getElementById("reveal-card");
  const badge = document.getElementById("reveal-badge");
  const titleEl = document.getElementById("reveal-movie-title");
  const authorEl = document.getElementById("reveal-author-name");
  const nextBtnText = document.getElementById("btn-next-text");

  const skeleton = document.getElementById("poster-skeleton");
  const posterImg = document.getElementById("reveal-poster");
  const fallbackBox = document.getElementById("poster-fallback");
  const fallbackTitle = document.getElementById("poster-fallback-title");

  if (isCorrect) {
    badge.className = `status-pill ${usedHint ? "correct-hint" : "correct"}`;
    badge.textContent = usedHint ? "🟨 Acertou (Com outra review)" : "✓ Acertou";
  } else {
    badge.className = "status-pill wrong";
    badge.textContent = "✕ Errou";
  }

  titleEl.textContent = activeReviewObj.movie;
  authorEl.textContent = activeReviewObj.author;

  if (state.currentPhase + 1 < TOTAL_PHASES) {
    nextBtnText.textContent = `Próxima Fase (${state.currentPhase + 2}/${TOTAL_PHASES})`;
  } else {
    nextBtnText.textContent = "Ver Resultado";
  }

  skeleton.classList.remove("hidden");
  posterImg.classList.add("hidden");
  fallbackBox.classList.add("hidden");
  fallbackTitle.textContent = activeReviewObj.movie;

  // Sempre exibe o filme correto revelado no Box de DVD 3D com giroscópio (mesmo se a pessoa errar)
  setDvd3dMode(true);

  revealCard.classList.remove("hidden");

  const targetMovie = activeReviewObj.movie;
  const posterUrl = await resolveMoviePoster(targetMovie);

  const currentMovieNow = state.dailyPhases[state.currentPhase]?.reviewObj?.movie;
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

  // Solicita permissão do giroscópio no iOS aproveitando o clique do usuário
  requestGyroPermissionFromUserGesture();

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

  if (state.answers.length === TOTAL_PHASES) {
    const totalScore = state.answers.filter(a => a && a.correct).length;
    recordDailyCompletion(totalScore);
    updateHeaderStats();
  }

  saveDailyProgress();
  renderCurrentPhase();
}

function handleNextPhase() {
  setDvd3dMode(false);
  if (state.currentPhase + 1 < TOTAL_PHASES) {
    state.currentPhase += 1;
    saveDailyProgress();
    renderCurrentPhase();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    state.completed = true;
    const totalScore = state.answers.filter(a => a && a.correct).length;
    recordDailyCompletion(totalScore);
    saveDailyProgress();
    updateHeaderStats();
    showSummaryView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ============================================================================
// 11. TELA DE RESUMO FINAL E COMPARTILHAMENTO NO WHATSAPP (MANTIDA IGUAL)
// ============================================================================

function getScoreSubtitle(score) {
  switch (score) {
    case 5: return "Gabaritou! Você conhece cada pérola das quintas-feiras! 🏆";
    case 4: return "Quase perfeito! Memória afiada nas reviews da galera! 🍿";
    case 3: return "Bom desempenho! Passou de ano no Cineminha! 🎬";
    case 2: return "Deu pro gasto, mas faltou prestar atenção nos créditos! 👀";
    case 1: return "Pelo menos uma salvou a honra de hoje! 😅";
    default: return "Dormiu durante a sessão de quinta-feira? 💤";
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
      const ry = isSelected ? -10 : slotFromCenter * -5;
      const rz = isSelected ? 0 : slotFromCenter * 2;
      const scale = isSelected ? 1.1 : 0.92;

      item.classList.toggle("active", isSelected);
      item.style.zIndex = String(isSelected ? 30 : 20 - distFromSelected * 3);
      item.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, ${tz}px) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${scale})`;
      item.style.filter = isSelected ? "brightness(1.04)" : "brightness(0.84)";
    });

    const phase = state.dailyPhases[selectedIdx];
    const ans = state.answers[selectedIdx];
    if (phase && shelfCaption) {
      const emoji = getAnswerEmoji(ans);
      shelfCaption.textContent = `${emoji} Fase ${selectedIdx + 1}: ${phase.reviewObj.movie}`;
    }
  }

  state.dailyPhases.forEach((phase, idx) => {
    const rev = phase.reviewObj;
    const ans = state.answers[idx];
    const statusClass = ans && ans.correct ? (ans.usedHint ? "correct-hint" : "correct") : "wrong";
    const statusSymbol = ans && ans.correct ? "✓" : "✕";
    const imgId = `shelf-dvd-img-${idx}`;

    const item = document.createElement("div");
    item.className = "shelf-dvd-item";
    item.innerHTML = `
      <div class="shelf-dvd-box">
        <div class="shelf-dvd-spine"><span>DVD</span></div>
        <div class="shelf-dvd-edge-right"></div>
        <div class="shelf-dvd-front">
          <div class="shelf-dvd-lip"><span>CINEMINHA</span></div>
          <div class="shelf-dvd-art">
            <img id="${imgId}" class="shelf-dvd-img" src="assets/icon.jpg" alt="${escapeHtml(rev.movie)}" referrerpolicy="no-referrer" />
            <div class="shelf-dvd-glare"></div>
            <span class="shelf-status-dot ${statusClass}">${statusSymbol}</span>
          </div>
        </div>
      </div>
    `;

    item.addEventListener("click", () => {
      requestGyroPermissionFromUserGesture();
      selectShelfDvd(idx);
    });

    shelfStage.appendChild(item);

    resolveMoviePoster(rev.movie).then(url => {
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

  const avgPercent = stats.played > 0
    ? Math.round((stats.totalCorrect / (stats.played * TOTAL_PHASES)) * 100)
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
    const displayedAuthor = ans && ans.author ? ans.author : rev.author;
    const displayedQuote = ans && ans.review ? ans.review : rev.review;

    const item = document.createElement("div");
    item.className = "recap-item";

    const imgId = `recap-poster-${i}`;
    item.innerHTML = `
      <img id="${imgId}" class="recap-poster" src="assets/icon.jpg" alt="${escapeHtml(rev.movie)}" referrerpolicy="no-referrer" />
      <div class="recap-details">
        <div class="recap-movie-row">
          <span class="recap-movie">${statusEmoji} ${escapeHtml(rev.movie)}</span>
          <span class="recap-author">por ${escapeHtml(displayedAuthor)}</span>
        </div>
        <p class="recap-quote">“${escapeHtml(displayedQuote)}”</p>
      </div>
    `;
    recapList.appendChild(item);

    resolveMoviePoster(rev.movie).then(url => {
      if (url) {
        const imgEl = document.getElementById(imgId);
        if (imgEl) imgEl.src = url;
      }
    });
  }
}

function renderStatsModal() {
  const stats = getStats();
  const avgPercent = stats.played > 0
    ? Math.round((stats.totalCorrect / (stats.played * TOTAL_PHASES)) * 100)
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
