/* =====================================================================
   RS SENJAKALA — Sistem Absensi  (vanilla JS, REST API ke server.js)
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------- Reference data ---------------- */
  const JABATAN = {
    "DIREKSI & MANAJEMEN": ["CEO", "DIREKTUR", "WAKIL DIREKTUR", "SEKBEN", "KABID KOMDIS", "KOMDIS", "KABID HRD", "HRD", "KA.LABORAN", "MANAJEMEN LAB"],
    "STAFF MEDIS": ["DOKTER SPESIALIS", "DOKTER UMUM", "CO-ASS", "TRAINEE"],
  };
  const DIVISIONS = Object.keys(JABATAN);
  const ALL_JABATAN = DIVISIONS.reduce((a, d) => a.concat(JABATAN[d]), []);
  function divisionOf(jab) {
    for (const d of DIVISIONS) if (JABATAN[d].includes(jab)) return d;
    return "STAFF MEDIS";
  }

  const MAX_HISTORY = 7;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const DAYS_FULL = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
  const DAYS_SHORT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

  /* ---------------- Tiny helpers ---------------- */
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const rupiah = (n) => "Rp " + Math.round(n || 0).toLocaleString("id-ID");

  /* ---------------- Date / week utilities ---------------- */
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const off = (x.getDay() + 6) % 7; // 0=Mon
    x.setDate(x.getDate() - off);
    return x;
  }
  function weekRange(d) {
    const start = mondayOf(d);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { start, end, key: ymd(start) };
  }
  function fmtRange(startStr, endStr) {
    const s = parseYmd(startStr), e = parseYmd(endStr);
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    if (sameMonth) return `${s.getDate()} – ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
    const sameYear = s.getFullYear() === e.getFullYear();
    return `${s.getDate()} ${MONTHS[s.getMonth()]}${sameYear ? "" : " " + s.getFullYear()} – ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
  }

  /* ---------------- Duration ---------------- */
  function toSec(t) { if (!t) return null; const p = t.split(":").map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
  function durationSec(on, off) {
    const a = toSec(on), b = toSec(off);
    if (a === null || b === null) return 0;
    let d = b - a; if (d <= 0) d += 86400; // crosses midnight
    return d;
  }
  function secToHM(sec) { sec = Math.round(sec); return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor((sec % 3600) / 60)); }
  function secToHuman(sec) {
    if (!sec) return "0 menit";
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h && m) return `${h}j ${m}m`;
    if (h) return `${h} jam`;
    return `${m} menit`;
  }
  const hours1 = (sec) => (sec / 3600).toFixed(1);

  /* ---------------- State + API layer ---------------- */
  let state = { staff: [], week: { key: "", start: "", end: "", records: [] }, history: [], payroll: { jab: {} }, passwordIsDefault: true };
  let authed = false;
  let TOKEN = null;
  let staffSig = "";
  let recapRange = "week"; // "week" | "7" | "14" | "30" — rentang Peringkat & Rekap

  // Mount prefix this app is served under (e.g. "/senjakala"), so API calls
  // hit /senjakala/api/... when the combined server hosts both webs.
  const API_BASE = location.pathname.replace(/\/+$/, "").replace(/\/index\.html$/, "");

  async function api(path, opts) {
    opts = opts || {};
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const res = await fetch(API_BASE + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null; try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { authed = false; TOKEN = null; }
    if (!res.ok) throw new Error((data && data.error) || ("Kesalahan server (" + res.status + ")"));
    return data;
  }

  function applyState(s) {
    state.week = s.week; state.history = s.history; state.passwordIsDefault = s.passwordIsDefault;
    state.payroll = s.payroll && s.payroll.jab ? s.payroll : { jab: {} };
    if (Array.isArray(s.staff)) state.staff = s.staff;
  }
  async function refresh() { applyState(await api("/api/state")); afterStateUpdate(); }
  function afterStateUpdate() {
    const sig = state.staff.map((s) => s.id + s.jabatan + s.active).join("|");
    if (sig !== staffSig) { staffSig = sig; if (qs("#fName")) fillNameSelect(); }
    renderWeekChips(); renderHeroMeta(); renderRecent(); updateShiftNote();
    if (!qs("#view-dashboard").classList.contains("hidden")) renderDashboard();
  }

  /* ---------------- Aggregations ---------------- */
  function aggregateByStaff(records) {
    const map = new Map();
    records.forEach((r) => {
      const k = r.name + "||" + r.jabatan;
      if (!map.has(k)) map.set(k, { name: r.name, jabatan: r.jabatan, division: r.division || divisionOf(r.jabatan), sec: 0, shifts: 0, days: new Set(), records: [] });
      const o = map.get(k); o.sec += r.seconds; o.shifts += 1; o.days.add(r.date); o.records.push(r);
    });
    return Array.from(map.values()).map((o) => ({ ...o, days: o.days.size })).sort((a, b) => b.sec - a.sec);
  }
  function totalSec(records) { return records.reduce((s, r) => s + r.seconds, 0); }
  function byDivision(records) {
    const m = {}; DIVISIONS.forEach((d) => (m[d] = 0));
    records.forEach((r) => { m[r.division || divisionOf(r.jabatan)] += r.seconds; });
    return m;
  }
  function byDay(records) {
    const arr = new Array(7).fill(0);
    records.forEach((r) => { const idx = (parseYmd(r.date).getDay() + 6) % 7; arr[idx] += r.seconds; });
    return arr;
  }

  /* ---------------- Range pooling (minggu ini / 7 / 14 / 30 hari) ---------------- */
  function allRecords() {
    let all = state.week.records.slice();
    state.history.forEach((h) => { if (Array.isArray(h.records)) all = all.concat(h.records); });
    return all;
  }
  function recordsInRange(range) {
    if (range === "week") return state.week.records;
    const days = Number(range) || 7;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    start.setDate(start.getDate() - (days - 1));
    const lo = ymd(start), hi = ymd(today);
    return allRecords().filter((r) => r.date >= lo && r.date <= hi);
  }
  function rangeLabel(range) {
    if (range === "week") return "minggu ini";
    if (range === "7") return "7 hari terakhir";
    if (range === "14") return "14 hari terakhir";
    return "30 hari terakhir";
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function setRange(r) {
    recapRange = r;
    qsa("#rangeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.range === r));
    renderKPI();
    renderChartDays();
    renderChartDivision();
    renderChartRank();
    renderRecapTable();
    updateDashPeriod();
  }
  function updateDashPeriod() {
    const dp = qs("#dashPeriod"); if (!dp) return;
    dp.textContent = recapRange === "week"
      ? "Periode rekap · " + (state.week && state.week.start ? fmtRange(state.week.start, state.week.end) : "—")
      : "Periode · " + cap(rangeLabel(recapRange));
  }

  /* ===================================================================
     ABSEN PAGE
     =================================================================== */
  function activeStaff() { return state.staff.filter((s) => s.active); }

  function fillNameSelect() {
    const sel = qs("#fName");
    const cur = sel.value;
    let html = '<option value="" disabled selected>Pilih nama…</option>';
    DIVISIONS.forEach((div) => {
      const list = activeStaff().filter((s) => divisionOf(s.jabatan) === div);
      if (!list.length) return;
      html += `<optgroup label="${esc(div)}">`;
      list.sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => {
        html += `<option value="${esc(s.id)}">${esc(s.name)}</option>`;
      });
      html += "</optgroup>";
    });
    sel.innerHTML = html;
    if (cur && state.staff.some((s) => s.id === cur && s.active)) sel.value = cur;
    else { sel.value = ""; setJabatanDisplay(""); }
    if (qs("#heroStaff")) renderHeroMeta();
  }
  function fillJabatanSelect(target, selected) {
    const sel = qs(target);
    let html = selected ? "" : '<option value="" disabled selected>Pilih jabatan…</option>';
    DIVISIONS.forEach((div) => {
      html += `<optgroup label="${esc(div)}">`;
      JABATAN[div].forEach((j) => { html += `<option value="${esc(j)}"${j === selected ? " selected" : ""}>${esc(j)}</option>`; });
      html += "</optgroup>";
    });
    sel.innerHTML = html;
  }

  function setJabatanDisplay(jab) { const el = qs("#fJabatan"); el.textContent = jab || "—"; el.classList.toggle("filled", !!jab); }
  function onNameChange() {
    const s = state.staff.find((x) => x.id === qs("#fName").value);
    setJabatanDisplay(s ? s.jabatan : "");
    updateShiftNote();
  }
  function updateTotalPreview() {
    const sec = durationSec(qs("#fOn").value, qs("#fOff").value);
    qs("#tpValue").textContent = secToHM(sec);
    qs("#tpHuman").textContent = sec ? "Setara " + secToHuman(sec) + " jam duty" : "Isi jam On Duty & Off Duty untuk menghitung";
  }
  function recordsForDate(name, date) {
    const wk = weekRange(parseYmd(date)).key;
    const hist = state.history.find((w) => w.key === wk);
    const bucket = wk === state.week.key ? state.week.records : (hist ? hist.records : []);
    return bucket.filter((r) => r.name === name && r.date === date);
  }
  function updateShiftNote() {
    const s = state.staff.find((x) => x.id === qs("#fName").value);
    const date = qs("#fDate").value;
    const note = qs("#shiftNote");
    if (!note) return;
    if (!s || !date) { note.textContent = "Pilih nama & tanggal untuk melihat sesi shift hari itu."; return; }
    const n = recordsForDate(s.name, date).length + 1;
    const tgl = parseYmd(date);
    note.innerHTML = `Akan tercatat sebagai <b>Shift ${n}</b> untuk ${esc(s.name.split(" ")[0])} pada ${tgl.getDate()} ${MONTHS[tgl.getMonth()]}.`;
  }

  async function submitAbsen(e) {
    e.preventDefault();
    const staff = state.staff.find((x) => x.id === qs("#fName").value);
    const date = qs("#fDate").value;
    const on = qs("#fOn").value, off = qs("#fOff").value;

    if (!staff) return toast("Pilih nama petugas dulu", "err");
    if (!date) return toast("Pilih tanggal", "err");
    if (!on || !off) return toast("Isi jam On Duty & Off Duty", "err");

    const btn = qs("#submitBtn"); btn.disabled = true;
    try {
      const r = await api("/api/absen", { method: "POST", body: { staffId: staff.id, date, on, off } });
      state.week = r.week; state.history = r.history;
      toast(`Absen ${esc(staff.name)} — ${esc(r.record.shift)} (${secToHuman(r.record.seconds)}) tercatat`, "ok");
      qs("#fOn").value = ""; qs("#fOff").value = "";
      updateTotalPreview(); updateShiftNote(); renderRecent(); renderWeekChips(); renderHeroMeta();
      if (!qs("#view-dashboard").classList.contains("hidden")) renderDashboard();
    } catch (err) {
      toast("Gagal menyimpan: " + err.message, "err");
    } finally { btn.disabled = false; }
  }

  function renderRecent() {
    const today = ymd(new Date());
    qs("#recentDate").textContent = DAYS_FULL[(new Date().getDay() + 6) % 7] + ", " + fmtRange(today, today);
    const recs = state.week.records.filter((r) => r.date === today).sort((a, b) => b.ts - a.ts);
    const people = new Set(recs.map((r) => r.name));
    qs("#recCount").textContent = recs.length;
    qs("#recPeople").textContent = people.size;
    qs("#recHours").textContent = secToHuman(totalSec(recs)).replace(" menit", "m").replace(" jam", "j");

    const list = qs("#recentList");
    if (!recs.length) { list.innerHTML = ""; qs("#recentEmpty").style.display = "block"; return; }
    qs("#recentEmpty").style.display = "none";
    list.innerHTML = recs.map((r) => `
      <li class="recent-item">
        <span class="ri-dot"></span>
        <span class="ri-main">
          <span class="ri-name">${esc(r.name)}</span>
          <span class="ri-meta">${esc(r.jabatan)} · ${esc(r.shift)} · ${r.on.slice(0, 5)}–${r.off.slice(0, 5)}</span>
        </span>
        <span class="ri-dur">${secToHuman(r.seconds)}</span>
      </li>`).join("");
  }

  /* ===================================================================
     CLOCK
     =================================================================== */
  function renderHeroMeta() {
    const now = new Date();
    qs("#heroDate").textContent = "Hari ini · " + DAYS_FULL[(now.getDay() + 6) % 7] + ", " + now.getDate() + " " + MONTHS[now.getMonth()] + " " + now.getFullYear();
    qs("#heroWeek").textContent = (state.week && state.week.start) ? "Minggu " + fmtRange(state.week.start, state.week.end) : "Memuat minggu…";
    qs("#heroStaff").textContent = activeStaff().length + " petugas aktif";
  }

  /* ===================================================================
     DASHBOARD
     =================================================================== */
  function renderWeekChips() {
    if (!state.week || !state.week.start) { qs("#weekChip").textContent = "Memuat…"; return; }
    const label = fmtRange(state.week.start, state.week.end);
    qs("#weekChip").textContent = "Minggu " + label;
    const dp = qs("#dashPeriod"); if (dp) dp.textContent = "Periode rekap · " + label;
  }

  function renderDashboard() {
    renderWeekChips();
    updateDashPeriod();
    renderKPI();
    renderChartDays();
    renderChartDivision();
    renderChartRank();
    renderRecapTable();
    renderArchive();
    renderPayroll();
    renderPayrollSettings();
    renderStaffTable();
    applyRole();
  }

  function renderKPI() {
    const recs = recordsInRange(recapRange);
    const tSec = totalSec(recs);
    const active = new Set(recs.map((r) => r.name)).size;
    const avg = active ? tSec / active : 0;
    const ic = (p) => `<div class="kpi-ic"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${p}</svg></div>`;
    const cards = [
      { ic: '<path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/>', label: "Total Jam Duty", value: hours1(tSec), unit: "jam", foot: secToHuman(tSec) + " · " + rangeLabel(recapRange) },
      { ic: '<circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 8.5a3 3 0 0 1 0 5M17 19a5 5 0 0 0-2-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>', label: "Petugas Aktif", value: active, unit: "", foot: "dari " + activeStaff().length + " terdaftar" },
      { ic: '<rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 12l2.5 2.5L16 9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', label: "Total Shift", value: recs.length, unit: "", foot: "catatan kehadiran" },
      { ic: '<path d="M4 19V5M4 19h16M8 16l3-4 3 2 4-6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', label: "Rata-rata / Petugas", value: hours1(avg), unit: "jam", foot: "per petugas aktif" },
    ];
    qs("#kpiGrid").innerHTML = cards.map((c) => `
      <article class="foil card kpi">
        ${ic(c.ic)}
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}${c.unit ? `<span class="unit">${c.unit}</span>` : ""}</div>
        <div class="kpi-foot">${esc(c.foot)}</div>
      </article>`).join("");
  }

  function renderChartDays() {
    const dd = qs("#daysDesc"); if (dd) dd.textContent = recapRange === "week" ? "Minggu berjalan · Senin–Minggu" : cap(rangeLabel(recapRange)) + " · total per hari";
    const data = byDay(recordsInRange(recapRange));
    const max = Math.max(...data, 1);
    const todayIdx = (new Date().getDay() + 6) % 7;
    const isThisWeek = recapRange === "week" && weekRange(new Date()).key === state.week.key;
    qs("#chartDays").innerHTML = `<div class="bars">${data.map((sec, i) => {
      const h = sec > 0 ? Math.max(4, (sec / max) * 170) : 3;
      return `<div class="bar-col-wrap ${isThisWeek && i === todayIdx ? "today" : ""}">
          <div class="bar ${sec ? "" : "empty"}" style="height:${h}px">${sec ? `<span class="bar-val">${hours1(sec)}j</span>` : ""}</div>
          <span class="bar-lbl">${DAYS_SHORT[i]}</span>
        </div>`;
    }).join("")}</div>`;
  }

  function renderChartDivision() {
    const div = byDivision(recordsInRange(recapRange));
    const total = DIVISIONS.reduce((s, d) => s + div[d], 0);
    const colors = { "DIREKSI & MANAJEMEN": "#E8A830", "STAFF MEDIS": "#8FB97A" };
    const R = 54, C = 2 * Math.PI * R;
    let offset = 0;
    const segs = DIVISIONS.map((d) => {
      const frac = total ? div[d] / total : 0;
      const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${colors[d]}" stroke-width="20"
        stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 70 70)" stroke-linecap="butt"/>`;
      offset += frac * C;
      return seg;
    }).join("");
    const ring = total ? segs : `<circle cx="70" cy="70" r="${R}" fill="none" stroke="rgba(231,176,96,.12)" stroke-width="20"/>`;
    qs("#chartDivision").innerHTML = `
      <svg class="donut" width="150" height="150" viewBox="0 0 140 140" aria-hidden="true">
        ${ring}
        <text x="70" y="64" text-anchor="middle" class="donut-center" fill="#F4EADB" font-size="22" font-weight="600">${hours1(total)}</text>
        <text x="70" y="84" text-anchor="middle" fill="#9C8A72" font-size="10" letter-spacing="2">JAM</text>
      </svg>
      <div class="legend">
        ${DIVISIONS.map((d) => `
          <div class="legend-item">
            <span class="legend-dot" style="background:${colors[d]}"></span>
            <span class="legend-name">${esc(d === "DIREKSI & MANAJEMEN" ? "Direksi & Manajemen" : "Staff Medis")}</span>
            <span class="legend-val">${total ? Math.round((div[d] / total) * 100) : 0}%</span>
          </div>`).join("")}
      </div>`;
  }

  function renderChartRank() {
    const desc = qs("#rankDesc"); if (desc) desc.textContent = "Total jam duty tertinggi · " + rangeLabel(recapRange);
    const agg = aggregateByStaff(recordsInRange(recapRange)).slice(0, 8);
    if (!agg.length) { qs("#chartRank").innerHTML = `<p class="recent-empty" style="display:block">Belum ada data untuk diperingkat pada ${esc(rangeLabel(recapRange))}.</p>`; return; }
    const max = agg[0].sec || 1;
    qs("#chartRank").innerHTML = agg.map((o, i) => `
      <div class="rank-row">
        <span class="rank-no">${pad(i + 1)}</span>
        <div class="rank-mid">
          <div class="rank-name">${esc(o.name)} <span class="rank-job">· ${esc(o.jabatan)}</span></div>
          <div class="rank-track"><div class="rank-fill" style="width:${(o.sec / max) * 100}%"></div></div>
        </div>
        <span class="rank-val">${secToHuman(o.sec)}</span>
      </div>`).join("");
  }

  function divisionPill(division) {
    const isDir = division === "DIREKSI & MANAJEMEN";
    return `<span class="pill ${isDir ? "direksi" : "medis"}">${isDir ? "Direksi" : "Medis"}</span>`;
  }

  function renderRecapTable() {
    const recs = recordsInRange(recapRange);
    const agg = aggregateByStaff(recs);
    const periodLabel = recapRange === "week" ? fmtRange(state.week.start, state.week.end) : cap(rangeLabel(recapRange));
    const rd = qs("#recapDesc"); if (rd) rd.textContent = "Klik baris untuk rincian · " + rangeLabel(recapRange);
    const body = qs("#recapBody");
    if (!agg.length) {
      body.innerHTML = ""; qs("#recapTable").style.display = "none";
      const empty = qs("#recapEmpty"); empty.style.display = "block"; empty.textContent = "Belum ada kehadiran pada " + rangeLabel(recapRange) + ".";
      return;
    }
    qs("#recapEmpty").style.display = "none"; qs("#recapTable").style.display = "";
    const max = agg[0].sec || 1;
    body.innerHTML = agg.map((o) => `
      <tr class="clickable" data-name="${esc(o.name)}" data-jab="${esc(o.jabatan)}">
        <td class="td-name">${esc(o.name)}</td>
        <td>${divisionPill(o.division)} <span style="color:var(--ivory-2)">${esc(o.jabatan)}</span></td>
        <td class="num">${o.days}</td>
        <td class="num">${o.shifts}</td>
        <td class="num td-mono">${secToHuman(o.sec)}</td>
        <td class="bar-col"><div class="mini-track"><div class="mini-fill" style="width:${(o.sec / max) * 100}%"></div></div></td>
      </tr>`).join("");
    qsa("#recapBody tr").forEach((tr) => tr.addEventListener("click", () => openStaffDetail(tr.dataset.name, tr.dataset.jab, recs, periodLabel)));
  }

  function openStaffDetail(name, jab, records, periodLabel) {
    const recs = records.filter((r) => r.name === name && r.jabatan === jab).sort((a, b) => a.date.localeCompare(b.date) || (toSec(a.on) - toSec(b.on)));
    const tSec = totalSec(recs);
    const days = new Set(recs.map((r) => r.date)).size;
    const rows = recs.map((r) => `
      <tr>
        <td class="td-mono">${r.date.slice(8)}/${r.date.slice(5, 7)}</td>
        <td>${esc(r.shift)}</td>
        <td class="td-mono">${r.on.slice(0, 5)} – ${r.off.slice(0, 5)}</td>
        <td class="num td-mono">${secToHuman(r.seconds)}</td>
      </tr>`).join("");
    showModal(`
      <button class="modal-x" data-close aria-label="Tutup">&times;</button>
      <div class="detail-head">
        <div>
          <div class="detail-name">${esc(name)}</div>
          <div class="detail-sub">${divisionPill(divisionOf(jab))} ${esc(jab)} · ${esc(periodLabel)}</div>
        </div>
      </div>
      <div class="detail-kpis">
        <div class="detail-kpi"><b>${secToHuman(tSec)}</b><span>Total Jam</span></div>
        <div class="detail-kpi"><b>${recs.length}</b><span>Shift</span></div>
        <div class="detail-kpi"><b>${days}</b><span>Hari Aktif</span></div>
      </div>
      <div class="table-scroll">
        <table class="ledger compact">
          <thead><tr><th>Tgl</th><th>Shift</th><th>On – Off</th><th class="num">Durasi</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  function renderArchive() {
    const rail = qs("#archiveRail");
    qs("#archiveCount").textContent = state.history.length + " / " + MAX_HISTORY;
    if (!state.history.length) { rail.innerHTML = ""; qs("#archiveEmpty").style.display = "block"; return; }
    qs("#archiveEmpty").style.display = "none";
    const items = state.history.slice().reverse();
    rail.innerHTML = items.map((w, i) => {
      const tSec = totalSec(w.records);
      const people = new Set(w.records.map((r) => r.name)).size;
      const showGaji = payrollHasRate(w.payroll);
      const gajiRow = showGaji ? `<div class="coin-stat gaji"><span>Total gaji</span><b>${rupiah(totalPayroll(w.records, w.payroll))}</b></div>` : "";
      return `<button class="coin ${i === 0 ? "newest" : ""}" data-key="${esc(w.key)}">
          <div class="coin-no">ARSIP · ${pad(state.history.length - i)}</div>
          <div class="coin-range">${esc(fmtRange(w.start, w.end))}</div>
          <div class="coin-stat"><span>Total jam</span><b>${secToHuman(tSec)}</b></div>
          <div class="coin-stat"><span>Petugas</span><b>${people}</b></div>
          <div class="coin-stat"><span>Shift</span><b>${w.records.length}</b></div>
          ${gajiRow}
        </button>`;
    }).join("");
    qsa(".coin", rail).forEach((c) => c.addEventListener("click", () => openArchiveWeek(c.dataset.key)));
  }

  function openArchiveWeek(key) {
    const w = state.history.find((x) => x.key === key); if (!w) return;
    const agg = aggregateByStaff(w.records);
    const tSec = totalSec(w.records);
    const rows = agg.length ? agg.map((o) => `
      <tr><td class="td-name">${esc(o.name)}</td><td>${divisionPill(o.division)} ${esc(o.jabatan)}</td>
      <td class="num">${o.days}</td><td class="num">${o.shifts}</td><td class="num td-mono">${secToHuman(o.sec)}</td></tr>`).join("")
      : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1rem">Tidak ada catatan.</td></tr>`;

    // Gaji arsip: pakai snapshot tarif saat minggu diarsipkan; arsip lama tanpa snapshot pakai tarif terkini.
    const pr = w.payroll || state.payroll || { jab: {} };
    const hasSnapshot = !!w.payroll;
    const anyRate = payrollHasRate(pr);
    let payTotal = 0;
    const payRows = agg.map((o) => {
      const c = computePay(o.sec, o.jabatan, pr); payTotal += c.pay;
      const otLabel = c.otH > 0 ? `${fmtHours(c.otH)} <span class="ot-tag">+${c.otBonus}%</span>` : "—";
      return `<tr>
        <td class="td-name">${esc(o.name)}</td>
        <td>${divisionPill(o.division)} <span style="color:var(--ivory-2)">${esc(o.jabatan)}</span></td>
        <td class="num td-mono">${secToHuman(o.sec)}</td>
        <td class="num td-mono">${otLabel}</td>
        <td class="num td-mono">${c.rate ? rupiah(c.rate) : "—"}</td>
        <td class="num td-mono pay">${c.rate ? rupiah(c.pay) : "—"}</td>
      </tr>`;
    }).join("");
    const payNote = anyRate
      ? (hasSnapshot ? "Dihitung dari tarif gaji saat minggu ini diarsipkan." : "Arsip lama tanpa snapshot — dihitung dengan tarif gaji saat ini.")
      : "Tarif gaji belum diatur untuk minggu ini.";
    const payrollBlock = agg.length ? `
        <div class="arch-sub">
          <h3 class="arch-sub-title">Penggajian</h3>
          <span class="payroll-total sm">${rupiah(payTotal)}</span>
        </div>
        <table class="ledger compact">
          <thead><tr><th>Petugas</th><th>Jabatan</th><th class="num">Jam</th><th class="num">Lembur</th><th class="num">Gaji/Jam</th><th class="num">Gaji</th></tr></thead>
          <tbody>${payRows}</tbody>
        </table>
        <p class="payroll-note">${payNote}</p>` : "";

    showModal(`
      <button class="modal-x" data-close aria-label="Tutup">&times;</button>
      <div class="detail-head">
        <div>
          <div class="detail-name">Rekap ${esc(fmtRange(w.start, w.end))}</div>
          <div class="detail-sub">Arsip mingguan · diarsipkan ${new Date(w.archivedAt).toLocaleDateString("id-ID")}</div>
        </div>
      </div>
      <div class="detail-kpis">
        <div class="detail-kpi"><b>${secToHuman(tSec)}</b><span>Total Jam</span></div>
        <div class="detail-kpi"><b>${w.records.length}</b><span>Shift</span></div>
        <div class="detail-kpi"><b>${new Set(w.records.map((r) => r.name)).size}</b><span>Petugas</span></div>
        ${anyRate ? `<div class="detail-kpi"><b>${rupiah(payTotal)}</b><span>Total Gaji</span></div>` : ""}
      </div>
      <div class="table-scroll">
        <div class="arch-sub first"><h3 class="arch-sub-title">Kehadiran</h3></div>
        <table class="ledger compact">
          <thead><tr><th>Petugas</th><th>Jabatan</th><th class="num">Hari</th><th class="num">Shift</th><th class="num">Jam</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${payrollBlock}
      </div>
      <div style="margin-top:1rem;text-align:right"><button class="chip-btn solid" data-export-week="${esc(w.key)}">Ekspor CSV minggu ini</button></div>`);
    const exBtn = qs("[data-export-week]"); if (exBtn) exBtn.addEventListener("click", () => exportCSV(w.records, "Rekap_" + w.start + "_sd_" + w.end));
  }

  /* ---------------- Staff manager ---------------- */
  function renderStaffTable() {
    const body = qs("#staffBody");
    const sorted = state.staff.slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    body.innerHTML = sorted.map((s) => {
      const opts = DIVISIONS.map((d) => `<optgroup label="${esc(d)}">${JABATAN[d].map((j) => `<option value="${esc(j)}"${j === s.jabatan ? " selected" : ""}>${esc(j)}</option>`).join("")}</optgroup>`).join("");
      return `<tr>
        <td class="td-name">${esc(s.name)}</td>
        <td><div class="select-wrap sm"><select data-jab-for="${esc(s.id)}">${opts}</select><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div></td>
        <td class="num"><button class="status-tag ${s.active ? "aktif" : "off"}" data-toggle="${esc(s.id)}" title="Klik untuk ubah status">${s.active ? "Aktif" : "Nonaktif"}</button></td>
        <td><div class="row-tools">
          <button class="icon-btn" data-del="${esc(s.id)}" title="Hapus petugas" aria-label="Hapus ${esc(s.name)}"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div></td>
      </tr>`;
    }).join("");

    qsa("[data-jab-for]", body).forEach((sel) => sel.addEventListener("change", async () => {
      const s = state.staff.find((x) => x.id === sel.dataset.jabFor); if (!s) return;
      try { await api("/api/staff/" + s.id, { method: "PATCH", body: { jabatan: sel.value } }); toast(`Jabatan ${esc(s.name)} → ${esc(sel.value)}`, "info"); await refresh(); }
      catch (err) { toast(err.message, "err"); }
    }));
    qsa("[data-toggle]", body).forEach((b) => b.addEventListener("click", async () => {
      const s = state.staff.find((x) => x.id === b.dataset.toggle); if (!s) return;
      try { await api("/api/staff/" + s.id, { method: "PATCH", body: { active: !s.active } }); await refresh(); }
      catch (err) { toast(err.message, "err"); }
    }));
    qsa("[data-del]", body).forEach((b) => b.addEventListener("click", async () => {
      const s = state.staff.find((x) => x.id === b.dataset.del); if (!s) return;
      if (await confirmDialog(`Hapus <b>${esc(s.name)}</b> dari daftar petugas?`, "Catatan kehadiran yang sudah masuk tetap tersimpan.")) {
        try { await api("/api/staff/" + s.id, { method: "DELETE" }); await refresh(); toast("Petugas dihapus", "info"); }
        catch (err) { toast(err.message, "err"); }
      }
    }));
  }

  async function addStaff(e) {
    e.preventDefault();
    const name = qs("#saName").value.trim();
    const jab = qs("#saJabatan").value;
    if (!name) return toast("Isi nama petugas", "err");
    try {
      await api("/api/staff", { method: "POST", body: { name, jabatan: jab } });
      qs("#saName").value = ""; await refresh();
      toast(`${esc(name)} ditambahkan sebagai ${esc(jab)}`, "ok");
    } catch (err) { toast(err.message, "err"); }
  }

  /* ===================================================================
     PAYROLL / PENGGAJIAN
     =================================================================== */
  function computePay(sec, jabatan, p) {
    const hours = sec / 3600;
    const j = (p.jab && p.jab[jabatan]) || {};
    const rate = Number(j.rate) || 0;
    const thr = Number(j.otThreshold) || 0;
    const otH = thr > 0 ? Math.max(0, hours - thr) : 0;
    const normH = hours - otH;
    const pay = normH * rate + otH * rate * (1 + (Number(j.otBonusPct) || 0) / 100);
    return { hours, rate, otH, otThr: thr, otBonus: Number(j.otBonusPct) || 0, pay };
  }
  function fmtHours(h) { return (Math.round(h * 10) / 10).toString().replace(/\.0$/, "") + "j"; }
  function totalPayroll(records, p) { return aggregateByStaff(records).reduce((s, o) => s + computePay(o.sec, o.jabatan, p).pay, 0); }
  function payrollHasRate(p) { return !!p && ALL_JABATAN.some((j) => p.jab && p.jab[j] && p.jab[j].rate > 0); }

  function renderPayroll() {
    const body = qs("#payrollBody"); if (!body) return;
    const p = state.payroll || { jab: {} };
    const agg = aggregateByStaff(state.week.records);
    const anyRate = ALL_JABATAN.some((j) => p.jab && p.jab[j] && p.jab[j].rate > 0);
    if (!agg.length) {
      body.innerHTML = ""; qs("#payrollTable").style.display = "none"; qs("#payrollEmpty").style.display = "block";
      qs("#payrollTotal").textContent = "Rp 0"; qs("#payrollHint").textContent = ""; return;
    }
    qs("#payrollEmpty").style.display = "none"; qs("#payrollTable").style.display = "";
    let total = 0;
    body.innerHTML = agg.map((o) => {
      const c = computePay(o.sec, o.jabatan, p); total += c.pay;
      const otLabel = c.otH > 0 ? `${fmtHours(c.otH)} <span class="ot-tag">+${c.otBonus}%</span>` : "—";
      return `<tr>
        <td class="td-name">${esc(o.name)}</td>
        <td>${divisionPill(o.division)} <span style="color:var(--ivory-2)">${esc(o.jabatan)}</span></td>
        <td class="num td-mono">${secToHuman(o.sec)}</td>
        <td class="num td-mono">${otLabel}</td>
        <td class="num td-mono">${c.rate ? rupiah(c.rate) : "—"}</td>
        <td class="num td-mono pay">${c.rate ? rupiah(c.pay) : "—"}</td>
      </tr>`;
    }).join("");
    qs("#payrollTotal").textContent = rupiah(total);
    qs("#payrollHint").textContent = !anyRate
      ? "Gaji belum diatur. Management dapat mengaturnya di Pengaturan Gaji."
      : "Lembur & bonus dihitung per jabatan (kolom Lembur = jam di atas ambang jabatan masing-masing).";
  }

  function renderPayrollSettings() {
    const host = qs("#rateGrid"); if (!host) return;
    if (host.contains(document.activeElement)) return; // jangan ganggu input management
    const p = state.payroll || { jab: {} };
    const rows = DIVISIONS.map((d) => {
      const head = `<tr class="rate-div"><td colspan="4">${esc(d === "DIREKSI & MANAJEMEN" ? "Direksi & Manajemen" : "Staff Medis")}</td></tr>`;
      const cells = JABATAN[d].map((j) => {
        const o = (p.jab && p.jab[j]) || {};
        return `<tr>
          <td class="rate-name">${esc(j)}</td>
          <td><span class="rp-in">Rp<input type="number" min="0" step="1000" data-pay="${esc(j)}" data-k="rate" value="${o.rate || ""}" placeholder="0" /></span></td>
          <td><span class="rp-in"><input type="number" min="0" step="0.5" data-pay="${esc(j)}" data-k="otThreshold" value="${o.otThreshold || ""}" placeholder="0" /><i>jam</i></span></td>
          <td><span class="rp-in"><input type="number" min="0" step="5" data-pay="${esc(j)}" data-k="otBonusPct" value="${o.otBonusPct || ""}" placeholder="0" /><i>%</i></span></td>
        </tr>`;
      }).join("");
      return head + cells;
    }).join("");
    host.innerHTML = `<table class="rate-table"><thead><tr><th>Jabatan</th><th>Gaji / Jam</th><th>Lembur di atas</th><th>Bonus</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function savePayroll() {
    const jab = {};
    ALL_JABATAN.forEach((j) => { jab[j] = { rate: 0, otThreshold: 0, otBonusPct: 0 }; });
    qsa("[data-pay]").forEach((i) => { const j = i.dataset.pay, k = i.dataset.k; if (!jab[j]) jab[j] = { rate: 0, otThreshold: 0, otBonusPct: 0 }; jab[j][k] = Number(i.value) || 0; });
    try {
      await api("/api/payroll", { method: "POST", body: { jab } });
      await refresh(); toast("Pengaturan gaji disimpan & diterapkan", "ok");
    } catch (err) { toast(err.message, "err"); }
  }

  /* ===================================================================
     ACCESS ROLE (pengamat vs admin)
     =================================================================== */
  function applyRole() {
    qsa(".admin-only").forEach((el) => { el.style.display = authed ? "" : "none"; });
    qsa(".viewer-only").forEach((el) => { el.style.display = authed ? "none" : ""; });
    const b = qs("#modeBadge");
    if (b) { b.textContent = authed ? "Mode Management" : "Mode Pengamat"; b.classList.toggle("admin", authed); }
  }
  function viewOnly() {
    authed = false; TOKEN = null; closeLogin();
    renderDashboard(); showView("dash");
    toast("Mode pengamat — hanya melihat", "info");
  }

  /* ===================================================================
     EXPORT / IMPORT
     =================================================================== */
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }
  function exportCSV(records, fname) {
    const head = ["Tanggal", "Hari", "Nama", "Jabatan", "Divisi", "Shift", "On Duty", "Off Duty", "Durasi (jam)", "Durasi"];
    const lines = [head.join(";")];
    records.slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts).forEach((r) => {
      const day = DAYS_FULL[(parseYmd(r.date).getDay() + 6) % 7];
      lines.push([r.date, day, r.name, r.jabatan, r.division, r.shift, r.on, r.off, hours1(r.seconds), secToHuman(r.seconds)].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"));
    });
    download((fname || "Rekap_RS_Senjakala") + ".csv", "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
    toast("CSV diunduh", "ok");
  }
  function exportJSON() {
    const data = { staff: state.staff, week: state.week, history: state.history };
    download("Backup_RS_Senjakala_" + ymd(new Date()) + ".json", JSON.stringify(data, null, 2), "application/json");
    toast("Cadangan JSON diunduh", "ok");
  }
  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !data.week || !Array.isArray(data.staff)) throw new Error("File cadangan tidak valid");
        if (await confirmDialog("Pulihkan data dari cadangan ini?", "Seluruh data saat ini akan ditimpa (kata sandi tetap).")) {
          await api("/api/import", { method: "POST", body: { staff: data.staff, week: data.week, history: data.history || [] } });
          await refresh(); toast("Data dipulihkan", "ok");
        }
      } catch (e) { toast(e.message || "File cadangan tidak valid", "err"); }
    };
    reader.readAsText(file);
  }

  /* ===================================================================
     AUTH / NAV
     =================================================================== */
  function showView(name) {
    const absen = qs("#view-absen"), dash = qs("#view-dashboard");
    if (name === "dash") {
      absen.classList.add("hidden"); dash.classList.remove("hidden"); dash.setAttribute("aria-hidden", "false");
      qs("#navDash").setAttribute("aria-current", "true"); qs("#navAbsen").removeAttribute("aria-current");
    } else {
      dash.classList.add("hidden"); dash.setAttribute("aria-hidden", "true"); absen.classList.remove("hidden");
      qs("#navAbsen").setAttribute("aria-current", "true"); qs("#navDash").removeAttribute("aria-current");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function gotoDash() {
    if (authed) { try { await refresh(); } catch (e) {} renderDashboard(); showView("dash"); return; }
    openLogin();
  }
  function openLogin() {
    const m = qs("#loginModal"); m.classList.remove("hidden");
    qs("#loginError").hidden = true; qs("#loginPw").value = ""; setTimeout(() => qs("#loginPw").focus(), 50);
    qs("#loginHint").style.display = state.passwordIsDefault ? "" : "none";
  }
  function closeLogin() { qs("#loginModal").classList.add("hidden"); }
  async function tryLogin(e) {
    e.preventDefault();
    try {
      const r = await api("/api/login", { method: "POST", body: { password: qs("#loginPw").value } });
      TOKEN = r.token; authed = true; closeLogin();
      await refresh(); renderDashboard(); showView("dash"); toast("Selamat datang, Direksi", "ok");
    } catch (err) { qs("#loginError").hidden = false; qs("#loginPw").select(); }
  }
  function logout() { authed = false; TOKEN = null; showView("absen"); toast("Anda telah keluar", "info"); }

  async function changePassword(e) {
    e.preventDefault();
    const oldv = qs("#pwOld").value, nv = qs("#pwNew").value.trim();
    if (nv.length < 4) return toast("Sandi baru minimal 4 karakter", "err");
    try {
      await api("/api/password", { method: "POST", body: { oldPassword: oldv, newPassword: nv } });
      qs("#pwOld").value = ""; qs("#pwNew").value = ""; await refresh();
      toast("Kata sandi diperbarui", "ok");
    } catch (err) { toast(err.message, "err"); }
  }

  /* ===================================================================
     MODAL / TOAST / CONFIRM
     =================================================================== */
  function showModal(html) { const m = qs("#modal"); qs("#modalInner").innerHTML = html; m.classList.remove("hidden"); qsa("[data-close]", m).forEach((b) => b.addEventListener("click", closeModal)); }
  function closeModal() { qs("#modal").classList.add("hidden"); qs("#modalInner").innerHTML = ""; }

  function confirmDialog(title, sub) {
    return new Promise((resolve) => {
      showModal(`
        <div class="detail-head"><div><div class="detail-name" style="font-size:1.25rem">${title}</div>${sub ? `<div class="detail-sub">${sub}</div>` : ""}</div></div>
        <div class="dz-row" style="justify-content:flex-end;margin-top:.5rem">
          <button class="chip-btn" data-no>Batal</button>
          <button class="chip-btn solid" data-yes>Ya, lanjutkan</button>
        </div>`);
      qs("[data-yes]").addEventListener("click", () => { closeModal(); resolve(true); });
      qs("[data-no]").addEventListener("click", () => { closeModal(); resolve(false); });
    });
  }

  let toastTimer;
  function toast(msg, kind) {
    kind = kind || "info";
    const icons = { ok: "✓", err: "!", info: "✦" };
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = `<span class="toast-ic">${icons[kind]}</span><span>${msg}</span>`;
    qs("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 3200);
  }

  /* ===================================================================
     INIT
     =================================================================== */
  function startPolling() {
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
  }

  async function init() {
    // static form setup (independent of server data)
    setJabatanDisplay("");
    fillJabatanSelect("#saJabatan", "TRAINEE");
    qs("#fDate").value = ymd(new Date());
    qs("#fDate").max = ymd(new Date());
    updateTotalPreview();
    updateShiftNote();

    // absen events
    qs("#fName").addEventListener("change", onNameChange);
    qs("#fDate").addEventListener("change", updateShiftNote);
    qs("#fOn").addEventListener("input", updateTotalPreview);
    qs("#fOff").addEventListener("input", updateTotalPreview);
    qs("#absenForm").addEventListener("submit", submitAbsen);

    // nav
    qs("#navAbsen").addEventListener("click", () => showView("absen"));
    qs("#navDash").addEventListener("click", gotoDash);
    const brand = qs("#brandHome");
    brand.addEventListener("click", () => showView("absen"));
    brand.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showView("absen"); } });

    // login modal
    qs("#loginForm").addEventListener("submit", tryLogin);
    qs("#loginClose").addEventListener("click", closeLogin);
    qs("#loginModal").addEventListener("click", (e) => { if (e.target === qs("#loginModal")) closeLogin(); });
    qs("#pwEye").addEventListener("click", () => { const i = qs("#loginPw"); i.type = i.type === "password" ? "text" : "password"; i.focus(); });
    qs("#btnViewOnly").addEventListener("click", viewOnly);

    // dashboard actions
    qs("#btnLogout").addEventListener("click", logout);
    qs("#btnAdminLogin").addEventListener("click", openLogin);
    qs("#btnSavePayroll").addEventListener("click", savePayroll);
    qsa("#rangeSeg .seg-btn").forEach((b) => b.addEventListener("click", () => setRange(b.dataset.range)));
    qs("#btnArchive").addEventListener("click", async () => {
      if (!state.week.records.length) return toast("Belum ada catatan untuk diarsipkan", "info");
      if (await confirmDialog("Tutup & arsipkan minggu ini?", "Rekap berjalan dipindah ke arsip, lalu lembar minggu dikosongkan.")) {
        try { await api("/api/archive", { method: "POST" }); await refresh(); toast("Minggu diarsipkan", "ok"); }
        catch (err) { toast(err.message, "err"); }
      }
    });
    qs("#staffAddForm").addEventListener("submit", addStaff);
    qs("#pwForm").addEventListener("submit", changePassword);
    qs("#btnExportCsv").addEventListener("click", () => {
      if (!state.week.records.length) return toast("Belum ada data minggu ini", "info");
      exportCSV(state.week.records, "Rekap_RS_Senjakala_" + state.week.start + "_sd_" + state.week.end);
    });
    qs("#btnExportJson").addEventListener("click", exportJSON);
    qs("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    qs("#btnResetWeek").addEventListener("click", async () => {
      if (await confirmDialog("Kosongkan rekap minggu ini?", "Catatan minggu berjalan akan dihapus permanen (arsip tetap aman).")) {
        try { await api("/api/reset-week", { method: "POST" }); await refresh(); toast("Rekap minggu dikosongkan", "info"); }
        catch (err) { toast(err.message, "err"); }
      }
    });
    qs("#btnResetAll").addEventListener("click", async () => {
      if (await confirmDialog("Reset SEMUA data?", "Petugas, rekap, dan arsip dikembalikan ke awal (kata sandi tetap). Tidak bisa dibatalkan.")) {
        try { await api("/api/reset-all", { method: "POST" }); await refresh(); showView("absen"); toast("Semua data direset", "info"); }
        catch (err) { toast(err.message, "err"); }
      }
    });

    // generic modal close
    qs("#modal").addEventListener("click", (e) => { if (e.target === qs("#modal")) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeLogin(); } });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh().catch(() => {}); });

    // load shared data from server, then keep it fresh
    try { await refresh(); }
    catch (err) { toast("Tidak terhubung ke server. Jalankan: node server.js", "err"); renderWeekChips(); }
    startPolling();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
