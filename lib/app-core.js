/* =====================================================================
   Shared app core (pure Node.js, no dependencies)
   One factory `createApp(config)` builds a self-contained attendance app
   (static files + REST API + JSON storage). The combined server mounts
   two instances (Lotus Palace + RS Senjakala) on different path prefixes.
   ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_HISTORY = 7;
const WIB_OFFSET = 7 * 3600 * 1000; // Asia/Jakarta (UTC+7), no DST

/* ---------------- Utils (shared, stateless) ---------------- */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const pad = (n) => String(n).padStart(2, "0");
function wibParts(ms) { const d = new Date(ms + WIB_OFFSET); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() }; }
function ymdNow() { const p = wibParts(Date.now()); return p.y + "-" + pad(p.m + 1) + "-" + pad(p.d); }
function mondayKey(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const dow = new Date(base).getUTCDay();
  const off = (dow + 6) % 7;
  const mon = new Date(base - off * 86400000);
  return mon.toISOString().slice(0, 10);
}
function weekRange(ymd) {
  const start = mondayKey(ymd);
  const [y, m, d] = start.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d) + 6 * 86400000).toISOString().slice(0, 10);
  return { start, end, key: start };
}
function toSec(t) { if (!t) return null; const p = String(t).split(":").map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
function durationSec(on, off) { const a = toSec(on), b = toSec(off); if (a === null || b === null) return 0; let x = b - a; if (x <= 0) x += 86400; return x; }
const isHM = (t) => /^\d{1,2}:\d{2}$/.test(String(t || ""));
const isYmd = (t) => /^\d{4}-\d{2}-\d{2}$/.test(String(t || ""));

function hashPassword(pw) { const salt = crypto.randomBytes(16).toString("hex"); return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex"); }
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const h = crypto.scryptSync(pw, salt, 64);
  const a = Buffer.from(hash, "hex");
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}
function bearer(req) { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }

/* ---------------- HTTP helpers (shared) ---------------- */
function sendJSON(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s), "Cache-Control": "no-store" }); res.end(s); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ""; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 5e6) { reject(new Error("payload too large")); req.destroy(); } data += c; });
    req.on("end", () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

/* =====================================================================
   Factory
   config = {
     name, publicDir, dataFile, seedFile?, defaultPw,
     jabatan: { DIVISION: [jab,...] }, seedStaff: [[name,jabatan],...],
     fallbackJab, fallbackDivision, hasTheme,
     labels: { auth, entityNotFound }
   }
   ===================================================================== */
async function createApp(config) {
  const BASE_DIR = config.publicDir;
  const DATA_FILE = config.dataFile;
  const DEFAULT_PW = config.defaultPw;
  const JABATAN = config.jabatan;
  const ALL_JABATAN = [].concat(...Object.values(JABATAN));
  const FALLBACK_JAB = config.fallbackJab;
  const FALLBACK_DIV = config.fallbackDivision;
  const HAS_THEME = !!config.hasTheme;
  const L = config.labels || {};
  const AUTH_ERR = L.auth || "Tidak berwenang.";
  const NOT_FOUND = L.entityNotFound || "Data tidak ditemukan.";

  function divisionOf(j) { for (const d in JABATAN) if (JABATAN[d].includes(j)) return d; return FALLBACK_DIV; }

  /* ---- theme (Lotus Palace only) ---- */
  function defaultTheme() { return { accent: "#7A5DC7", pink: "#E89AAE", bg: "vanilla" }; }

  /* ---- state ---- */
  let state = null;
  const tokens = new Map();
  let writeTimer = null;

  function issueToken() { const t = crypto.randomBytes(24).toString("hex"); tokens.set(t, Date.now() + 8 * 3600 * 1000); return t; }
  function validToken(t) { const e = tokens.get(t); if (!e) return false; if (Date.now() > e) { tokens.delete(t); return false; } return true; }

  function freshWeek(ymd) { return Object.assign({ records: [] }, weekRange(ymd || ymdNow())); }
  function defaultPayroll() { return { jab: {} }; }
  function defaultState() {
    const s = {
      version: 1,
      passwordHash: hashPassword(DEFAULT_PW),
      staff: config.seedStaff.map(([name, jabatan]) => ({ id: uid(), name, jabatan, active: true })),
      week: freshWeek(),
      history: [],
      payroll: defaultPayroll(),
    };
    if (HAS_THEME) s.theme = defaultTheme();
    return s;
  }
  /* ---- storage backend ----
     Upstash Redis (REST) when UPSTASH_REDIS_REST_URL + _TOKEN are set (prod,
     survives restarts/redeploys); otherwise a local JSON file (dev). The whole
     state is stored as one JSON string per app — no extra npm dependency. */
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
  const REDIS_KEY = "absensi:" + config.key;

  async function storeRead() {
    if (USE_REDIS) {
      const r = await fetch(REDIS_URL.replace(/\/+$/, "") + "/get/" + encodeURIComponent(REDIS_KEY), {
        headers: { Authorization: "Bearer " + REDIS_TOKEN },
      });
      if (!r.ok) throw new Error("Upstash GET " + r.status);
      const j = await r.json();
      return j && j.result ? JSON.parse(j.result) : null;
    }
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return null;
  }
  async function storeWrite(obj) {
    const s = JSON.stringify(obj);
    if (USE_REDIS) {
      const r = await fetch(REDIS_URL.replace(/\/+$/, "") + "/set/" + encodeURIComponent(REDIS_KEY), {
        method: "POST", headers: { Authorization: "Bearer " + REDIS_TOKEN }, body: s,
      });
      if (!r.ok) throw new Error("Upstash SET " + r.status);
      return;
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp"; fs.writeFileSync(tmp, s); fs.renameSync(tmp, DATA_FILE);
  }

  function normalize() {
    if (!state.passwordHash) state.passwordHash = hashPassword(DEFAULT_PW);
    if (!state.week) state.week = freshWeek();
    if (!Array.isArray(state.history)) state.history = [];
    if (!Array.isArray(state.staff)) state.staff = defaultState().staff;
    if (!state.payroll || typeof state.payroll !== "object") state.payroll = defaultPayroll();
    if (!state.payroll.jab || typeof state.payroll.jab !== "object") state.payroll.jab = {};
    if (HAS_THEME && (!state.theme || typeof state.theme !== "object")) state.theme = defaultTheme();
  }

  async function load() {
    try {
      const existing = await storeRead();
      if (existing) {
        state = existing; normalize();
      } else if (config.seedFile && fs.existsSync(config.seedFile)) {
        state = JSON.parse(fs.readFileSync(config.seedFile, "utf8")); normalize();
        await storeWrite(state);
        console.log(`[${config.name}] Seeded from ${path.basename(config.seedFile)}.`);
      } else {
        state = defaultState(); normalize();
        await storeWrite(state);
        console.log(`[${config.name}] Created fresh data with seeded staff.`);
      }
    } catch (e) {
      console.error(`[${config.name}] Failed to load data, starting fresh:`, e.message);
      state = defaultState(); normalize();
    }
    console.log(`[${config.name}] storage = ${USE_REDIS ? "Upstash Redis" : "local file (" + DATA_FILE + ")"}`);
  }

  function persist() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      storeWrite(state).catch((e) => console.error(`[${config.name}] Persist failed:`, e.message));
    }, 120);
  }

  /* ---- domain logic ---- */
  function capHistory() { while (state.history.length > MAX_HISTORY) state.history.shift(); }
  function clonePayroll(p) { try { return JSON.parse(JSON.stringify(p || defaultPayroll())); } catch (_) { return defaultPayroll(); } }
  function archiveSnapshot() { return Object.assign({}, state.week, { archivedAt: Date.now(), payroll: clonePayroll(state.payroll) }); }
  function rolloverIfNeeded() {
    const nowKey = weekRange(ymdNow()).key;
    if (state.week.key !== nowKey) {
      if (state.week.records.length) { state.history.push(archiveSnapshot()); capHistory(); }
      state.week = freshWeek();
      persist();
      return true;
    }
    return false;
  }
  function bucketFor(dateYmd) {
    const wk = weekRange(dateYmd).key;
    if (wk === state.week.key) return state.week;
    return state.history.find((w) => w.key === wk) || state.week;
  }
  function publicState() {
    const o = { staff: state.staff, week: state.week, history: state.history, payroll: state.payroll, passwordIsDefault: verifyPassword(DEFAULT_PW, state.passwordHash) };
    if (HAS_THEME) o.theme = state.theme;
    return o;
  }

  /* ---- static ---- */
  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath.split("?")[0]);
    if (rel === "/" || rel === "") rel = "/index.html";
    const ext = path.extname(rel).toLowerCase();
    const base = path.basename(rel).toLowerCase();
    if (base === "data.json" || base === "seed.json" || base.endsWith(".tmp") || !MIME[ext]) { res.writeHead(404); return res.end("Not found"); }
    const filePath = path.join(BASE_DIR, rel);
    if (!filePath.startsWith(BASE_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[ext], "Content-Length": buf.length, "Cache-Control": "no-cache" });
      res.end(buf);
    });
  }

  /* ---- API ---- */
  async function handleApi(req, res, urlPath) {
    const method = req.method;
    const requireAuth = () => { if (!validToken(bearer(req))) { sendJSON(res, 401, { error: AUTH_ERR }); return false; } return true; };

    if (urlPath === "/api/state" && method === "GET") { rolloverIfNeeded(); return sendJSON(res, 200, publicState()); }

    if (urlPath === "/api/login" && method === "POST") {
      const b = await readBody(req);
      if (verifyPassword(String(b.password || "").trim(), state.passwordHash)) return sendJSON(res, 200, { token: issueToken() });
      return sendJSON(res, 401, { error: "Kata sandi salah." });
    }

    if (urlPath === "/api/absen" && method === "POST") {
      const b = await readBody(req);
      const staff = state.staff.find((s) => s.id === b.staffId);
      if (!staff) return sendJSON(res, 400, { error: NOT_FOUND });
      if (!isYmd(b.date)) return sendJSON(res, 400, { error: "Tanggal tidak valid." });
      if (!isHM(b.on) || !isHM(b.off)) return sendJSON(res, 400, { error: "Jam tidak valid." });
      rolloverIfNeeded();
      const bucket = bucketFor(b.date);
      const shiftNo = bucket.records.filter((r) => r.name === staff.name && r.date === b.date).length + 1;
      const rec = {
        id: uid(), staffId: staff.id, name: staff.name, jabatan: staff.jabatan, division: divisionOf(staff.jabatan),
        date: b.date, shift: "Shift " + shiftNo, on: b.on, off: b.off, seconds: durationSec(b.on, b.off), ts: Date.now(),
      };
      bucket.records.push(rec);
      persist();
      return sendJSON(res, 200, { record: rec, week: state.week, history: state.history });
    }

    // ---- protected ----
    if (urlPath === "/api/staff" && method === "POST") {
      if (!requireAuth()) return;
      const b = await readBody(req);
      const name = String(b.name || "").trim();
      const jabatan = ALL_JABATAN.includes(b.jabatan) ? b.jabatan : FALLBACK_JAB;
      if (!name) return sendJSON(res, 400, { error: "Nama wajib diisi." });
      if (state.staff.some((s) => s.name.toLowerCase() === name.toLowerCase())) return sendJSON(res, 409, { error: "Nama sudah terdaftar." });
      state.staff.push({ id: uid(), name, jabatan, active: true });
      persist(); return sendJSON(res, 200, publicState());
    }
    const mStaff = urlPath.match(/^\/api\/staff\/([^/]+)$/);
    if (mStaff && (method === "PATCH" || method === "DELETE")) {
      if (!requireAuth()) return;
      const s = state.staff.find((x) => x.id === mStaff[1]);
      if (!s) return sendJSON(res, 404, { error: NOT_FOUND });
      if (method === "DELETE") { state.staff = state.staff.filter((x) => x.id !== s.id); }
      else { const b = await readBody(req); if (ALL_JABATAN.includes(b.jabatan)) s.jabatan = b.jabatan; if (typeof b.active === "boolean") s.active = b.active; }
      persist(); return sendJSON(res, 200, publicState());
    }
    if (urlPath === "/api/password" && method === "POST") {
      if (!requireAuth()) return;
      const b = await readBody(req);
      if (!verifyPassword(String(b.oldPassword || "").trim(), state.passwordHash)) return sendJSON(res, 403, { error: "Sandi saat ini salah." });
      const nv = String(b.newPassword || "").trim();
      if (nv.length < 4) return sendJSON(res, 400, { error: "Sandi baru minimal 4 karakter." });
      state.passwordHash = hashPassword(nv); persist(); return sendJSON(res, 200, { ok: true });
    }
    if (urlPath === "/api/payroll" && method === "POST") {
      if (!requireAuth()) return;
      const b = await readBody(req);
      const src = (b && b.jab) || {};
      const jab = {};
      for (const j of ALL_JABATAN) {
        const o = src[j] || {};
        jab[j] = {
          rate: Math.max(0, Math.round(Number(o.rate) || 0)),
          otThreshold: Math.max(0, Number(o.otThreshold) || 0),
          otBonusPct: Math.max(0, Number(o.otBonusPct) || 0),
        };
      }
      state.payroll = { jab };
      persist(); return sendJSON(res, 200, publicState());
    }
    if (HAS_THEME && urlPath === "/api/theme" && method === "POST") {
      if (!requireAuth()) return;
      const b = await readBody(req);
      const HEX = /^#[0-9a-fA-F]{6}$/;
      const BG_OK = ["vanilla", "strawberry", "matcha", "taro", "choco"];
      const t = state.theme || defaultTheme();
      state.theme = {
        accent: HEX.test(b.accent) ? b.accent : t.accent,
        pink: HEX.test(b.pink) ? b.pink : t.pink,
        bg: BG_OK.includes(b.bg) ? b.bg : t.bg,
      };
      persist(); return sendJSON(res, 200, publicState());
    }
    if (urlPath === "/api/archive" && method === "POST") {
      if (!requireAuth()) return;
      if (!state.week.records.length) return sendJSON(res, 400, { error: "Belum ada catatan untuk diarsipkan." });
      state.history.push(archiveSnapshot()); capHistory();
      state.week = freshWeek(); persist(); return sendJSON(res, 200, publicState());
    }
    if (urlPath === "/api/reset-week" && method === "POST") {
      if (!requireAuth()) return; state.week.records = []; persist(); return sendJSON(res, 200, publicState());
    }
    if (urlPath === "/api/reset-all" && method === "POST") {
      if (!requireAuth()) return; const keep = state.passwordHash; state = defaultState(); state.passwordHash = keep; persist(); return sendJSON(res, 200, publicState());
    }
    if (urlPath === "/api/import" && method === "POST") {
      if (!requireAuth()) return;
      const b = await readBody(req);
      if (!b || !Array.isArray(b.staff) || !b.week) return sendJSON(res, 400, { error: "Data cadangan tidak valid." });
      state.staff = b.staff; state.week = b.week; state.history = Array.isArray(b.history) ? b.history : [];
      capHistory(); persist(); return sendJSON(res, 200, publicState());
    }

    sendJSON(res, 404, { error: "Endpoint tidak ditemukan." });
  }

  /* ---- public handler: subPath is the URL with the mount prefix stripped ---- */
  function handle(req, res, subPath) {
    if (subPath.startsWith("/api/")) {
      handleApi(req, res, subPath).catch((e) => { try { sendJSON(res, 400, { error: e.message || "Bad request" }); } catch (_) {} });
    } else {
      serveStatic(req, res, subPath);
    }
  }

  await load();
  return { handle, name: config.name };
}

module.exports = { createApp };
