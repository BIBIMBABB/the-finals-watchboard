const AUTH_KEY = "tf_watchboard_auth_v1";
const STATS_META_KEY = "tf_watchboard_stats_meta_v1";
const APP_API_BASE = "/api";

const API_BASE = "https://www.davg25.com/app/the-finals-leaderboard-tracker/api/vaiiya";
const DEFAULT_SEASON = "s9";
// History timestamp is already delayed in most cases, so keep compensation minimal.
const RISK_TIME_OFFSET_MINUTES = 10;
const AVG_MATCHMAKING_MINUTES = 7;
const GAME_MIN_MINUTES = 25;
const GAME_MAX_MINUTES = 32;

const state = {
  entries: [],
  auth: loadAuth(),
  apiSource: "local-fallback",
  userStatsById: {},
  userStatsAt: null,
  statsMeta: loadStatsMeta(),
  lastLeaderboardUpdate: isoMinutesAgo(8),
  nextLeaderboardEstimate: isoMinutesFromNow(14),
  filters: {
    verdict: "all",
    riskMin: "all",
    recentDays: "all",
    quickSearch: "",
  },
};

function isoMinutesAgo(mins) {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function isoMinutesFromNow(mins) {
  return new Date(Date.now() + mins * 60_000).toISOString();
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeVerdict(v) {
  const x = norm(v);
  if (x === "confirmed" || x === "suspected" || x === "teaming") return x;
  return "suspected";
}


function authHeaders(token = state.auth.token) {
  if (!token) return {};
  return { "X-Admin-Token": token };
}

async function apiRequest(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const response = await fetch(`${APP_API_BASE}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function normalizeEntry(e) {
  return {
    playerId: String(e?.playerId || "").trim(),
    displayName: String(e?.displayName || "").trim(),
    cheatVerdict: normalizeVerdict(e?.cheatVerdict || e?.status),
    tags: Array.isArray(e?.tags) ? e.tags.map((x) => String(x).trim()).filter(Boolean) : [],
    lastSeenAt: e?.lastSeenAt || new Date().toISOString(),
    createdAt: e?.createdAt || new Date().toISOString(),
    updatedAt: e?.updatedAt || new Date().toISOString(),
  };
}

async function fetchWatchEntries() {
  const data = await apiRequest("/entries");
  const rows = Array.isArray(data?.entries) ? data.entries : [];
  return rows.map(normalizeEntry).filter((e) => e.playerId && e.displayName);
}

async function upsertWatchEntry(entry) {
  const data = await apiRequest("/entries", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(entry),
  });
  return normalizeEntry(data?.entry || entry);
}

async function removeWatchEntry(playerId) {
  await apiRequest(`/entries/${encodeURIComponent(playerId)}`, {
    method: "DELETE",
    headers: {
      ...authHeaders(),
    },
  });
}

async function verifyAdminToken(token) {
  await apiRequest("/auth/check", {
    method: "GET",
    headers: {
      ...authHeaders(token),
    },
  });
}
function loadStatsMeta() {
  const raw = localStorage.getItem(STATS_META_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveStatsMeta() {
  localStorage.setItem(STATS_META_KEY, JSON.stringify(state.statsMeta));
}
function loadAuth() {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return { role: "viewer", token: "" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.role === "admin" && typeof parsed.token === "string" && parsed.token) {
      return { role: "admin", token: parsed.token };
    }
  } catch {}
  return { role: "viewer", token: "" };
}

function saveAuth() {
  localStorage.setItem(AUTH_KEY, JSON.stringify(state.auth));
}

function isAdmin() {
  return state.auth.role === "admin" && !!state.auth.token;
}

function getEntryObservedAt(entry) {
  const meta = state.statsMeta[norm(entry.playerId)];
  if (meta?.lastPlayedAt) return meta.lastPlayedAt;
  return null;
}

function parseApiTime(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;

  const s = String(v).trim();
  if (!s) return null;

  // Do not force UTC when timezone is missing. Respect runtime local parsing.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}




function riskScore(entry) {
  const seenDate = parseApiTime(getEntryObservedAt(entry));
  if (!seenDate) {
    // Unknown play time should not stay high; keep conservative defaults.
    if (entry.cheatVerdict === "confirmed") return 22;
    if (entry.cheatVerdict === "teaming") return 18;
    return 14;
  }

  const seenMs = seenDate.getTime();
  const elapsedMin = Math.max(0, (Date.now() - seenMs) / 60_000);
  const sinceActualMin = Math.max(0, elapsedMin - RISK_TIME_OFFSET_MINUTES);
  const requeuePeakEnd = GAME_MAX_MINUTES + AVG_MATCHMAKING_MINUTES; // 32 + 7 = 39

  let timingScore = 12;
  if (sinceActualMin <= 10) {
    // 0m -> 10m: keep lower until likely requeue window opens.
    const t = Math.max(0, Math.min(1, sinceActualMin / 10));
    timingScore = 22 + t * 10; // 22 -> 32
  } else if (sinceActualMin <= requeuePeakEnd) {
    // 10m -> 39m: linear rise 32 -> 88
    const t = (sinceActualMin - 10) / (requeuePeakEnd - 10);
    timingScore = 32 + t * 56;
  } else if (sinceActualMin <= 120) {
    // 39m -> 120m: linear decay 88 -> 56
    const t = (sinceActualMin - requeuePeakEnd) / (120 - requeuePeakEnd);
    timingScore = 88 - t * 32;
  } else if (sinceActualMin <= 360) {
    // 120m -> 360m: linear decay 56 -> 28
    const t = (sinceActualMin - 120) / (360 - 120);
    timingScore = 56 - t * 28;
  } else if (sinceActualMin <= 1440) {
    // 6h -> 24h: linear decay 28 -> 12
    const t = (sinceActualMin - 360) / (1440 - 360);
    timingScore = 28 - t * 16;
  }

  const verdictBonus = entry.cheatVerdict === "confirmed" ? 10 : entry.cheatVerdict === "teaming" ? 6 : 0;
  const score = timingScore + verdictBonus;

  const floor = entry.cheatVerdict === "confirmed" ? 12 : entry.cheatVerdict === "teaming" ? 10 : 8;
  return Math.max(floor, Math.min(99, Math.round(score)));
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  return `${day}일 전`;
}

function relativeTimeFuture(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "곧";
  if (min < 60) return `${min}분 후`;
  return `${Math.floor(min / 60)}시간 후`;
}

function formatObservedAt(iso) {
  const d = parseApiTime(iso);
  if (!d) return "-";

  const fmt = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });

  return fmt.format(d).replace(",", "");
}


function freshnessStatus(lastUpdateIso) {
  const lagMin = Math.floor((Date.now() - new Date(lastUpdateIso).getTime()) / 60_000);
  if (lagMin <= 10) return { label: "FRESH", className: "fresh" };
  if (lagMin <= 30) return { label: "AGING", className: "aging" };
  return { label: "STALE", className: "stale" };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function getFilteredEntries() {
  const { verdict, riskMin, recentDays, quickSearch } = state.filters;
  const q = quickSearch.trim().toLowerCase();

  return state.entries
    .filter((entry) => {
      if (verdict !== "all" && entry.cheatVerdict !== verdict) return false;
      if (riskMin !== "all" && riskScore(entry) < Number(riskMin)) return false;
      if (recentDays !== "all") {
        const threshold = Date.now() - Number(recentDays) * 86_400_000;
        const observed = parseApiTime(getEntryObservedAt(entry));
        if (!observed || observed.getTime() < threshold) return false;
      }
      if (q) {
        const hay = `${entry.displayName} ${entry.playerId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const byRisk = riskScore(b) - riskScore(a);
      if (byRisk !== 0) return byRisk;
      const bTime = parseApiTime(getEntryObservedAt(b))?.getTime() ?? 0;
      const aTime = parseApiTime(getEntryObservedAt(a))?.getTime() ?? 0;
      return bTime - aTime;
    });
}

function lookupUserStat(entry) {
  const keyId = norm(entry.playerId);
  const keyName = norm(entry.displayName);
  return state.userStatsById[keyId] || state.userStatsById[keyName] || null;
}

function buildStatsIndex(leaderboard = []) {
  const idx = {};
  for (const p of leaderboard) {
    const stat = {
      id: p.id || null,
      rank: Number.isFinite(p.rank) ? p.rank : null,
      oldRank: Number.isFinite(p.oldRank) ? p.oldRank : null,
      points: Number.isFinite(p.points) ? p.points : null,
      rankChange: Number.isFinite(p.rankChange) ? p.rankChange : null,
      leagueName: p.leagueName || null,
      steamId: p.steamId || null,
      xboxId: p.xboxId || null,
      psnId: p.psnId || null,
    };

    const candidates = [p.id, p.steamId, p.xboxId, p.psnId];
    for (const c of candidates) {
      const k = norm(c);
      if (k) idx[k] = stat;
    }
  }
  return idx;
}

function formatSigned(n) {
  if (typeof n !== "number") return "-";
  if (n > 0) return `+${n}`;
  return String(n);
}

function findLastMeaningfulPlayAt(history) {
  if (!Array.isArray(history) || history.length < 2) return null;

  const normalized = history
    .map((h) => ({
      timestamp: h?.timestamp || null,
      points: typeof h?.points === "number" ? h.points : null,
      rank: typeof h?.rank === "number" ? h.rank : null,
      league: typeof h?.league === "number" ? h.league : null,
      ms: parseApiTime(h?.timestamp)?.getTime() ?? 0,
    }))
    .filter((h) => h.ms > 0)
    .sort((a, b) => b.ms - a.ms);

  for (let i = 0; i < normalized.length - 1; i += 1) {
    const cur = normalized[i];
    const prev = normalized[i + 1];
    const changed = cur.points !== prev.points;
    if (changed && cur.timestamp) return cur.timestamp;
  }

  return null;
}

function findOldestHistoryAt(history) {
  if (!Array.isArray(history) || history.length < 1) return null;
  const normalized = history
    .map((h) => ({ timestamp: h?.timestamp || null, ms: parseApiTime(h?.timestamp)?.getTime() ?? 0 }))
    .filter((h) => h.ms > 0)
    .sort((a, b) => a.ms - b.ms);
  return normalized[0]?.timestamp || null;
}

function compute24hPointsDelta(history) {
  if (!Array.isArray(history) || history.length < 2) return null;

  const normalized = history
    .map((h) => ({
      points: typeof h?.points === "number" ? h.points : null,
      ms: parseApiTime(h?.timestamp)?.getTime() ?? 0,
    }))
    .filter((h) => h.ms > 0 && typeof h.points === "number")
    .sort((a, b) => b.ms - a.ms);

  if (normalized.length < 2) return null;

  const latest = normalized[0];
  const targetMs = latest.ms - 86_400_000;

  let base = null;
  for (const item of normalized) {
    if (item.ms <= targetMs) {
      base = item;
      break;
    }
  }

  if (!base) return null;
  return latest.points - base.points;
}


async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}




function renderStats() {
  const grid = document.getElementById("statsGrid");
  const now = Date.now();
  const total = state.entries.length;
  const confirmed = state.entries.filter((e) => e.cheatVerdict === "confirmed").length;
  const teaming = state.entries.filter((e) => e.cheatVerdict === "teaming").length;
  const suspected = state.entries.filter((e) => e.cheatVerdict === "suspected").length;
  const new24 = state.entries.filter((e) => now - new Date(e.createdAt).getTime() <= 86_400_000).length;
  const changed24 = state.entries.filter((e) => now - new Date(e.updatedAt).getTime() <= 86_400_000).length;

  const cards = [
    ["총 등록", total],
    ["핵확정", confirmed],
    ["티밍", teaming],
    ["핵의심", suspected],
    ["24h 신규", new24],
    ["24h 상태변경", changed24],
    ["전적동기화", state.userStatsAt ? relativeTime(state.userStatsAt) : "-"],
  ];

  grid.innerHTML = cards.map(([label, value]) => `<article><h3>${label}</h3><p>${value}</p></article>`).join("");
}

function renderStatusStrip() {
  const lastText = document.getElementById("lastUpdateText");
  const nextText = document.getElementById("nextUpdateText");
  const sourceText = document.getElementById("apiSourceText");
  const badge = document.getElementById("freshBadge");

  lastText.textContent = relativeTime(state.lastLeaderboardUpdate);
  nextText.textContent = relativeTimeFuture(state.nextLeaderboardEstimate);
  sourceText.textContent = state.apiSource;

  const fresh = freshnessStatus(state.lastLeaderboardUpdate);
  badge.textContent = fresh.label;
  badge.className = `badge ${fresh.className}`;
}

function renderAuthUI() {
  const adminPill = document.getElementById("adminPill");
  const authBtn = document.getElementById("authBtn");
  const adminPanel = document.getElementById("adminPanel");

  if (isAdmin()) {
    adminPill.textContent = "Admin: ON";
    adminPill.classList.add("on");
    authBtn.textContent = "로그아웃";
    adminPanel.classList.remove("hidden");
  } else {
    adminPill.textContent = "Admin: OFF";
    adminPill.classList.remove("on");
    authBtn.textContent = "관리자 로그인";
    adminPanel.classList.add("hidden");
  }
}

function renderTable() {
  const rows = document.getElementById("rows");
  const empty = document.getElementById("emptyState");
  const entries = getFilteredEntries();

  if (entries.length === 0) {
    rows.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  const canWrite = isAdmin();

  rows.innerHTML = entries
    .map((e) => {
      const stat = lookupUserStat(e);
      const risk = riskScore(e);
      const riskClass = risk >= 70 ? "high" : risk >= 40 ? "mid" : "low";
      const verdictLabel = e.cheatVerdict === "confirmed" ? "핵확정" : e.cheatVerdict === "teaming" ? "티밍" : "핵의심";
      return `
        <tr>
          <td class="status ${e.cheatVerdict}">${verdictLabel}</td>
          <td class="risk ${riskClass}">${risk}</td>
          <td>${escapeHtml(e.displayName)}<br><small>${escapeHtml(e.playerId)}</small></td>
          <td>${escapeHtml(stat?.leagueName || "-")}</td>
          <td>${stat?.rank ?? "-"}</td>
          <td>${stat?.points != null ? stat.points.toLocaleString() : "-"}</td>
          <td>${formatSigned(state.statsMeta[norm(e.playerId)]?.delta24hPoints)}</td>
          <td>${escapeHtml((e.tags || []).join(", "))}</td>
          <td>${formatObservedAt(getEntryObservedAt(e))}</td>
          <td><button class="ghost danger" data-act="delete" data-id="${escapeHtml(e.playerId)}" ${canWrite ? "" : "disabled"}>삭제</button></td>
        </tr>
      `;
    })
    .join("");
}

async function fetchLeaderboardUpdateInfo() {
  const url = `${API_BASE}/leaderboard-update-info/`;
  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchLeaderboardData() {
  const url = `${API_BASE}/leaderboard/?leagues=true`;
  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchPlayerStatsById(playerId, season = DEFAULT_SEASON) {
  const url = `${API_BASE}/player-stats/?id=${encodeURIComponent(playerId)}&season=${encodeURIComponent(season)}`;
  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchPlayerHistoryById(playerId, season = DEFAULT_SEASON) {
  const url = `${API_BASE}/player-history/?id=${encodeURIComponent(playerId)}&season=${encodeURIComponent(season)}`;
  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryFetchPlayerData(fetcher, candidates, season = DEFAULT_SEASON) {
  for (const id of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetcher(id, season);
      } catch {
        if (attempt === 0) await sleep(120);
      }
    }
  }
  return null;
}



async function syncApiStatus() {
  try {
    const data = await fetchLeaderboardUpdateInfo();
    if (data?.latestUpdateTimestamp) state.lastLeaderboardUpdate = data.latestUpdateTimestamp;
    if (data?.estimatedNextUpdateTimestamp) state.nextLeaderboardEstimate = data.estimatedNextUpdateTimestamp;
    state.apiSource = "davg25-api";
  } catch {
    state.apiSource = "local-fallback";
  }
  renderStatusStrip();
}

async function syncUserStats() {
  try {
    const data = await fetchLeaderboardData();
    const lb = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
    state.userStatsById = buildStatsIndex(lb);

    const syncAt = new Date().toISOString();
    state.userStatsAt = syncAt;

    const detailResults = await mapWithConcurrency(state.entries, 3, async (entry) => {
      const statHint = lookupUserStat(entry);
      const rawCandidates = [
        entry.playerId,
        entry.displayName,
        statHint?.id,
        statHint?.steamId,
        statHint?.psnId,
        statHint?.xboxId,
      ].filter(Boolean);

      const seen = new Set();
      const candidates = rawCandidates.filter((id) => {
        const k = norm(id);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      const detail = await tryFetchPlayerData(fetchPlayerStatsById, candidates, DEFAULT_SEASON);
      const history = await tryFetchPlayerData(fetchPlayerHistoryById, candidates, DEFAULT_SEASON);
      return { playerId: entry.playerId, detail, history };
    });

    const detailById = {};
    const historyById = {};
    for (const item of detailResults) {
      const key = norm(item.playerId);
      detailById[key] = item.detail;
      historyById[key] = item.history;
    }

    for (const entry of state.entries) {
      const stat = lookupUserStat(entry);
      const key = norm(entry.playerId);
      const prev = state.statsMeta[key] || {};
      const next = { ...prev };
      const detail = detailById[key];
      const history = historyById[key];

      if (Array.isArray(history) && history.length > 0) {
        const historyPlayedAt = findLastMeaningfulPlayAt(history);
        const historyOldestAt = findOldestHistoryAt(history);
        next.lastPlayedAt = historyPlayedAt || historyOldestAt || null;
        next.delta24hPoints = compute24hPointsDelta(history);
      } else {
        // No reliable history => mark as unknown instead of keeping stale cached time.
        next.lastPlayedAt = null;
        next.delta24hPoints = null;
      }

      const currentPoints = typeof detail?.points === "number" ? detail.points : stat?.points;
      if (typeof currentPoints === "number") next.lastPoints = currentPoints;

      const currentRank = typeof detail?.rank === "number" ? detail.rank : stat?.rank;
      if (typeof currentRank === "number") next.lastRank = currentRank;

      if (next.scoreChangedAt) delete next.scoreChangedAt;
      state.statsMeta[key] = next;
    }

    saveStatsMeta();
  } catch {
    // keep old stats cache in memory
  }
  renderStats();
  renderTable();
}

function bindControls() {
  document.getElementById("statusFilter").addEventListener("change", (e) => {
    state.filters.verdict = e.target.value;
    rerender();
  });

  document.getElementById("riskFilter").addEventListener("change", (e) => {
    state.filters.riskMin = e.target.value;
    rerender();
  });

  document.getElementById("recentFilter").addEventListener("change", (e) => {
    state.filters.recentDays = e.target.value;
    rerender();
  });

  document.getElementById("quickSearch").addEventListener("input", (e) => {
    state.filters.quickSearch = e.target.value;
    rerender();
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state.filters = { verdict: "all", riskMin: "all", recentDays: "all", quickSearch: "" };
    document.getElementById("statusFilter").value = "all";
    document.getElementById("riskFilter").value = "all";
    document.getElementById("recentFilter").value = "all";
    document.getElementById("quickSearch").value = "";
    rerender();
  });


  document.getElementById("rows").addEventListener("click", async (e) => {
    if (!isAdmin()) return;

    const btn = e.target.closest("button[data-id]");
    if (!btn || btn.disabled) return;
    if (btn.dataset.act !== "delete") return;

    const id = btn.dataset.id;
    const entry = state.entries.find((x) => x.playerId === id);
    if (!entry) return;

    const ok = window.confirm(`${entry.displayName} (${entry.playerId}) 등록을 삭제할까요?`);
    if (!ok) return;

        const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "삭제중...";

    try {
      await removeWatchEntry(id);
      state.entries = state.entries.filter((x) => x.playerId !== id);
      rerender();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      window.alert(`삭제 실패: ${err.message || err}`);
    }
  });
}

function bindAuth() {
  const authBtn = document.getElementById("authBtn");
  const syncBtn = document.getElementById("syncNowBtn");

  authBtn.addEventListener("click", async () => {
    if (isAdmin()) {
      state.auth = { role: "viewer", token: "" };
      saveAuth();
      rerender();
      return;
    }

    const input = window.prompt("관리자 토큰 입력");
    if (input === null) return;

    const token = input.trim();
    if (!token) return;

    authBtn.disabled = true;
    const prev = authBtn.textContent;
    authBtn.textContent = "검증중...";

    try {
      await verifyAdminToken(token);
      state.auth = { role: "admin", token };
      saveAuth();
      rerender();
    } catch {
      window.alert("관리자 토큰이 올바르지 않음");
    } finally {
      authBtn.disabled = false;
      authBtn.textContent = prev;
    }
  });

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    const prev = syncBtn.textContent;
    syncBtn.textContent = "동기화 중...";
    await loadEntriesFromServer();
    await Promise.all([syncApiStatus(), syncUserStats()]);
    syncBtn.textContent = prev;
    syncBtn.disabled = false;
  });
}

function bindAdminForm() {
  document.getElementById("entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) return;

    const playerId = document.getElementById("playerId").value.trim();
    const displayName = document.getElementById("displayName").value.trim();
    const tags = splitCsv(document.getElementById("tags").value);
    const cheatVerdict = normalizeVerdict(document.getElementById("entryVerdict").value);

    if (!playerId || !displayName) return;

    const form = e.target;
    const submit = form.querySelector('button[type="submit"]');
    const prev = submit ? submit.textContent : "저장";
    if (submit) {
      submit.disabled = true;
      submit.textContent = "저장중...";
    }

    try {
      const saved = await upsertWatchEntry({
        playerId,
        displayName,
        tags,
        cheatVerdict,
      });
      const existing = state.entries.find((x) => norm(x.playerId) === norm(saved.playerId));
      if (existing) {
        Object.assign(existing, saved);
      } else {
        state.entries.push(saved);
      }
      form.reset();
      rerender();
      await syncUserStats();
    } catch (err) {
      window.alert(`저장 실패: ${err.message || err}`);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = prev;
      }
    }
  });
}

async function loadEntriesFromServer() {
  try {
    state.entries = await fetchWatchEntries();
  } catch {
    state.entries = [];
  }
}
function rerender() {
  renderAuthUI();
  renderStatusStrip();
  renderStats();
  renderTable();
}

async function init() {
  bindControls();
  bindAuth();
  bindAdminForm();

  if (state.auth.token) {
    try {
      await verifyAdminToken(state.auth.token);
      state.auth.role = "admin";
    } catch {
      state.auth = { role: "viewer", token: "" };
      saveAuth();
    }
  }

  await loadEntriesFromServer();
  rerender();
  await Promise.all([syncApiStatus(), syncUserStats()]);

  setInterval(syncApiStatus, 60_000);
  setInterval(syncUserStats, 300_000);
}

init();














































