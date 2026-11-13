/**
 * Cineminha do Ovavat — Jogo Diário de 5 Fases
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
  POSTER_CACHE: "ovavat_poster_cache_v4_strict",
  THEME: "ovavat_theme_v2_light"
};

// Estado em memória
const state = {
  todayStr: "",        // YYYY-MM-DD (America/Sao_Paulo)
  displayDateStr: "",  // DD/MM/YYYY
  shortDateStr: "",    // DD/MM
  editionNumber: 1,
  allReviews: [],
  allMovies: [],
  dailyPhases: [],     // Array de 5 objetos: { reviewObj, options: [4 strings], correctIndex }
  currentPhase: 0,     // 0..4
  answers: [],         // Array de { selectedIndex, correct, movie, author, review }
  completed: false,
  posterMemoryCache: {}
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
// 2. UTILITÁRIOS DE DATA E SEED DETERMINÍSTICO (SEMPRE IGUAL PARA TODOS NO DIA)
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
// 3. LEITURA E PARSE DA PLANILHA GOOGLE SHEETS (2024, 2025, 2026+)
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
// 4. CENSURA INTELIGENTE DO NOME DO FILME NA REVIEW
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
// 5. SORTEIO DAS 5 FASES DIÁRIAS (100% IGUAL PARA TODO MUNDO NO DIA)
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

    return {
      reviewObj,
      options,
      correctIndex
    };
  });
}

// ============================================================================
// 6. BUSCA PRECISA DE CARTAZES ONLINE (WIKIPEDIA ESTRITA + IMDB TITLES + ITUNES)
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

async function extractInfoboxImageFromPageId(pageId, lang = "pt") {
  try {
    const parseUrl = `https://${lang}.wikipedia.org/w/api.php?action=parse&origin=*&format=json&pageid=${pageId}&prop=text&section=0`;
    const res = await fetch(parseUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const html = data?.parse?.text?.["*"];
    if (!html) return null;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const infoboxText = (doc.querySelector(".infobox, .infobox_v2")?.textContent || "").toLowerCase();
    if (
      infoboxText.includes("nascimento") &&
      infoboxText.includes("ocupação") &&
      !infoboxText.includes("direção") &&
      !infoboxText.includes("lançamento")
    ) {
      return null;
    }

    const imgs = doc.querySelectorAll(".infobox img, .infobox_v2 img, table.infobox img");
    for (const img of imgs) {
      const width = parseInt(img.getAttribute("width") || "0", 10);
      if (width > 0 && width < 90) continue;

      let src = img.getAttribute("src") || "";
      if (!src) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!isUsablePosterUrl(src)) continue;

      src = src.replace(/\/(\d+)px-/, "/500px-");
      return src;
    }
  } catch (_) {}
  return null;
}

async function fetchPosterFromWikipedia(movieTitle, lang = "pt") {
  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const hint =
    (window.OVAVAT_MOVIE_SEARCH_HINTS && window.OVAVAT_MOVIE_SEARCH_HINTS[movieTitle]) || "";

  const queries = [
    hint,
    `${cleanTitle} (filme)`,
    `${cleanTitle} (telefilme)`,
    cleanTitle
  ].filter(Boolean);

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
        return directImg;
      }

      const infoboxImg = await extractInfoboxImageFromPageId(page.pageid, lang);
      if (isUsablePosterUrl(infoboxImg)) {
        return infoboxImg;
      }
    }
  }

  return null;
}

async function fetchPosterFromImdbSuggestion(movieTitle) {
  const cleanTitle = movieTitle.replace(/#/g, "").trim();
  const targetUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(cleanTitle)}.json`;
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

      const exactMatch = titleItems.find(it => isSameMovieTitle(it.l, cleanTitle));
      if (exactMatch) {
        return exactMatch.i.imageUrl.replace(/\._V1_.*\.jpg$/i, "._V1_SX500.jpg");
      }

      const firstTitle = titleItems[0];
      if (firstTitle) {
        const normCand = normalizeTitleStrict(firstTitle.l);
        const normTarg = normalizeTitleStrict(cleanTitle);
        const targNumbers = normTarg.match(/\b\d+\b/g) || [];
        const candNumbers = normCand.match(/\b\d+\b/g) || [];
        if (targNumbers.join(",") === candNumbers.join(",")) {
          return firstTitle.i.imageUrl.replace(/\._V1_.*\.jpg$/i, "._V1_SX500.jpg");
        }
      }
    } catch (_) {}
  }
  return null;
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

  // 1. Wikipedia PT-BR
  try {
    const wikiPtUrl = await fetchPosterFromWikipedia(movieTitle, "pt");
    if (wikiPtUrl) {
      savePosterToCache(movieTitle, wikiPtUrl);
      return wikiPtUrl;
    }
  } catch (_) {}

  // 2. IMDb Title Search (apenas títulos 'tt...')
  try {
    const imdbUrl = await fetchPosterFromImdbSuggestion(movieTitle);
    if (imdbUrl) {
      savePosterToCache(movieTitle, imdbUrl);
      return imdbUrl;
    }
  } catch (_) {}

  // 3. iTunes Movies BR (match estrito)
  try {
    const itunesUrl = await fetchPosterFromItunes(movieTitle);
    if (itunesUrl) {
      savePosterToCache(movieTitle, itunesUrl);
      return itunesUrl;
    }
  } catch (_) {}

  // 4. Wikipedia EN
  try {
    const wikiEnUrl = await fetchPosterFromWikipedia(movieTitle, "en");
    if (wikiEnUrl) {
      savePosterToCache(movieTitle, wikiEnUrl);
      return wikiEnUrl;
    }
  } catch (_) {}

  return null;
}

function preloadDailyPosters() {
  for (const phase of state.dailyPhases) {
    resolveMoviePoster(phase.reviewObj.movie);
  }
}

// ============================================================================
// 7. PERSISTÊNCIA DE STREAKS, PROGRESSO DO DIA E RESET DE TESTE
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
        completed: state.completed
      })
    );
  } catch (_) {}
}

function resetDailyGameForTesting() {
  localStorage.removeItem(STORAGE_KEYS.DAILY_PROGRESS);
  state.currentPhase = 0;
  state.answers = [];
  state.completed = false;

  document.getElementById("summary-view").classList.add("hidden");
  document.getElementById("game-view").classList.remove("hidden");
  document.getElementById("modal-reset").classList.add("hidden");

  renderCurrentPhase();
  showToast("Partida reiniciada! 🔄");
}

// ============================================================================
// 8. INTERFACE E RENDERIZAÇÃO
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

function renderProgressPills() {
  const bars = document.querySelectorAll(".seg-bar");
  bars.forEach((bar, idx) => {
    bar.className = "seg-bar";
    const ans = state.answers[idx];
    if (ans) {
      bar.classList.add(ans.correct ? "correct" : "wrong");
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

  const phaseData = state.dailyPhases[state.currentPhase];
  if (!phaseData) return;

  const { reviewObj, options, correctIndex } = phaseData;
  const existingAnswer = state.answers[state.currentPhase];

  const reviewTextEl = document.getElementById("review-text");
  reviewTextEl.innerHTML = formatReviewHtml(reviewObj.review, reviewObj.movie, Boolean(existingAnswer));

  const revealCard = document.getElementById("reveal-card");
  if (!existingAnswer) {
    revealCard.classList.add("hidden");
  }

  const optionsGrid = document.getElementById("options-grid");
  optionsGrid.innerHTML = "";
  const letters = ["A", "B", "C", "D"];

  options.forEach((movieOption, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.type = "button";
    btn.innerHTML = `
      <span class="option-letter">${letters[idx]}</span>
      <span class="option-title">${escapeHtml(movieOption)}</span>
    `;

    if (existingAnswer) {
      btn.disabled = true;
      if (idx === correctIndex) {
        btn.classList.add("correct");
      } else if (idx === existingAnswer.selectedIndex && !existingAnswer.correct) {
        btn.classList.add("wrong");
      } else {
        btn.classList.add("dimmed");
      }
    } else {
      btn.addEventListener("click", () => handleSelectOption(idx));
    }

    optionsGrid.appendChild(btn);
  });

  if (existingAnswer) {
    showRevealCard(phaseData, existingAnswer.correct);
  }
}

async function showRevealCard(phaseData, isCorrect) {
  const { reviewObj } = phaseData;
  const revealCard = document.getElementById("reveal-card");
  const badge = document.getElementById("reveal-badge");
  const titleEl = document.getElementById("reveal-movie-title");
  const authorEl = document.getElementById("reveal-author-name");
  const nextBtnText = document.getElementById("btn-next-text");

  const skeleton = document.getElementById("poster-skeleton");
  const posterImg = document.getElementById("reveal-poster");
  const fallbackBox = document.getElementById("poster-fallback");
  const fallbackTitle = document.getElementById("poster-fallback-title");

  badge.className = `status-pill ${isCorrect ? "correct" : "wrong"}`;
  badge.textContent = isCorrect ? "✓ Acertou" : "✕ Errou";

  titleEl.textContent = reviewObj.movie;
  authorEl.textContent = reviewObj.author;

  if (state.currentPhase + 1 < TOTAL_PHASES) {
    nextBtnText.textContent = `Próxima Fase (${state.currentPhase + 2}/${TOTAL_PHASES})`;
  } else {
    nextBtnText.textContent = "Ver Resultado";
  }

  skeleton.classList.remove("hidden");
  posterImg.classList.add("hidden");
  fallbackBox.classList.add("hidden");
  fallbackTitle.textContent = reviewObj.movie;

  revealCard.classList.remove("hidden");

  const targetMovie = reviewObj.movie;
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

  const phaseData = state.dailyPhases[state.currentPhase];
  const isCorrect = selectedIndex === phaseData.correctIndex;

  state.answers[state.currentPhase] = {
    selectedIndex,
    correct: isCorrect,
    movie: phaseData.reviewObj.movie,
    author: phaseData.reviewObj.author,
    review: phaseData.reviewObj.review
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
// 9. TELA DE RESUMO FINAL E COMPARTILHAMENTO NO WHATSAPP
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
  const emojis = state.answers.map(a => (a && a.correct ? "🟩" : "🟥")).join(" ");

  return [
    `🍿 *Cineminha do Ovavat* #${state.editionNumber} (${state.shortDateStr})`,
    `🎯 Acertos: ${score}/${TOTAL_PHASES} | 🔥 Streak: ${stats.currentStreak}`,
    ``,
    emojis
  ].join("\n");
}

async function showSummaryView() {
  document.getElementById("loading-view").classList.add("hidden");
  document.getElementById("game-view").classList.add("hidden");
  document.getElementById("summary-view").classList.remove("hidden");

  renderProgressPills();

  const score = state.answers.filter(a => a && a.correct).length;
  const stats = getStats();

  document.getElementById("summary-date-label").textContent = `Desafio #${state.editionNumber} • ${state.displayDateStr}`;
  document.getElementById("summary-score-title").textContent = `${score} de ${TOTAL_PHASES}`;
  document.getElementById("summary-score-subtitle").textContent = getScoreSubtitle(score);

  const emojiStrip = document.getElementById("summary-emoji-strip");
  emojiStrip.textContent = state.answers.map(a => (a && a.correct ? "🟩" : "🟥")).join("  ");

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
    const statusEmoji = ans && ans.correct ? "🟩" : "🟥";

    const item = document.createElement("div");
    item.className = "recap-item";

    const imgId = `recap-poster-${i}`;
    item.innerHTML = `
      <img id="${imgId}" class="recap-poster" src="assets/icon.jpg" alt="${escapeHtml(rev.movie)}" referrerpolicy="no-referrer" />
      <div class="recap-details">
        <div class="recap-movie-row">
          <span class="recap-movie">${statusEmoji} ${escapeHtml(rev.movie)}</span>
          <span class="recap-author">por ${escapeHtml(rev.author)}</span>
        </div>
        <p class="recap-quote">“${escapeHtml(rev.review)}”</p>
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
// 10. COUNTDOWN PARA MEIA-NOITE
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
// 11. INICIALIZAÇÃO E EVENTOS
// ============================================================================

function bindEvents() {
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-next").addEventListener("click", handleNextPhase);

  // Botão secreto de Reset ao clicar no ícone do topo (com 2 etapas de confirmação)
  document.getElementById("brand-icon-trigger").addEventListener("click", () => {
    document.getElementById("reset-step-1").classList.remove("hidden");
    document.getElementById("reset-step-2").classList.add("hidden");
    document.getElementById("modal-reset").classList.remove("hidden");
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
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(waUrl, "_blank", "noopener,noreferrer");
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

  const dateParts = getBrazilDateParts();
  state.todayStr = dateParts.iso;
  state.displayDateStr = dateParts.brFull;
  state.shortDateStr = dateParts.brShort;
  state.editionNumber = computeEditionNumber(state.todayStr);
  state.posterMemoryCache = loadPosterCache();

  bindEvents();
  startCountdownTimer();

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
