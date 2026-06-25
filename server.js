/* =====================================================================
   COOL BEANS + RS SENJAKALA — Combined server (pure Node.js, no deps)
   One Node process serves BOTH attendance webs:
     /coolbeans/  → Cool Beans Restaurant
     /senjakala/  → RS Senjakala
     /            → landing page (links to both)
   Run:  node server.js        (default http://localhost:3000)
   Env:  PORT, HOST, DATA_DIR
   ===================================================================== */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createApp } = require("./lib/app-core");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const APPS_DIR = path.join(__dirname, "apps");
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- App instances ---------------- */
const coolbeans = createApp({
  name: "Cool Beans",
  publicDir: path.join(APPS_DIR, "coolbeans", "public"),
  dataFile: path.join(DATA_DIR, "coolbeans.json"),
  defaultPw: "coolbeans",
  hasTheme: true,
  jabatan: {
    "MANAJEMEN": ["CEO", "WAKIL CEO", "MANAGER"],
    "DAPUR": ["HEAD CHEFF", "CHEFF"],
    "LAYANAN": ["WAITERS", "TRAINER"],
  },
  seedStaff: [
    ["Mocha Delight", "CEO"], ["Caramel Swirl", "WAKIL CEO"], ["Hazel Brew", "MANAGER"],
    ["Chef Espresso", "HEAD CHEFF"], ["Latte Cream", "CHEFF"], ["Matcha Leaf", "CHEFF"],
    ["Vanilla Bean", "WAITERS"], ["Cocoa Drizzle", "WAITERS"], ["Sugar Cube", "TRAINER"],
  ],
  fallbackJab: "TRAINER",
  fallbackDivision: "LAYANAN",
  labels: { auth: "Tidak berwenang. Masuk sebagai Manajemen.", entityNotFound: "Karyawan tidak ditemukan." },
});

const senjakala = createApp({
  name: "RS Senjakala",
  publicDir: path.join(APPS_DIR, "senjakala", "public"),
  dataFile: path.join(DATA_DIR, "senjakala.json"),
  seedFile: path.join(APPS_DIR, "senjakala", "seed.json"),
  defaultPw: "senjakala",
  hasTheme: false,
  jabatan: {
    "DIREKSI & MANAJEMEN": ["CEO", "DIREKTUR", "WAKIL DIREKTUR", "SEKBEN", "KABID KOMDIS", "KOMDIS", "KABID HRD", "HRD", "KA.LABORAN", "MANAJEMEN LAB"],
    "STAFF MEDIS": ["DOKTER SPESIALIS", "DOKTER UMUM", "CO-ASS", "TRAINEE"],
  },
  seedStaff: [
    ["Alicia Clarissa De Sugar", "CEO"], ["Ael De Lucha", "DIREKTUR"],
    ["Leviathan Desugar Roseveil", "CO-ASS"], ["Catalina De Sugar", "CO-ASS"], ["Kiyan Nagasaki", "CO-ASS"],
    ["Jarvis Immanuel Wibowo", "TRAINEE"], ["Billie Triazdy MihuMihu Wibowo", "TRAINEE"], ["Vynara Noir Wibowo", "TRAINEE"],
    ["Arlan Turvass", "TRAINEE"], ["Divta De Sugar", "TRAINEE"], ["Cyra Himari", "TRAINEE"],
  ],
  fallbackJab: "TRAINEE",
  fallbackDivision: "STAFF MEDIS",
  labels: { auth: "Tidak berwenang. Masuk sebagai Direksi.", entityNotFound: "Petugas tidak ditemukan." },
});

const MOUNTS = [
  { prefix: "/coolbeans", app: coolbeans },
  { prefix: "/senjakala", app: senjakala },
];

/* ---------------- Landing page ---------------- */
const LANDING = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sistem Absensi</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:linear-gradient(135deg,#f5f0ff,#fff7f0);color:#2a2540;padding:24px}
  .wrap{width:100%;max-width:560px}
  h1{font-size:1.5rem;margin:0 0 4px}
  p.sub{margin:0 0 28px;color:#6b6486}
  .cards{display:grid;gap:16px}
  a.card{display:flex;align-items:center;gap:16px;padding:20px 22px;border-radius:18px;text-decoration:none;color:inherit;
         background:#fff;box-shadow:0 8px 30px rgba(80,60,140,.10);border:1px solid rgba(120,90,200,.12);transition:transform .12s,box-shadow .12s}
  a.card:hover{transform:translateY(-2px);box-shadow:0 14px 40px rgba(80,60,140,.18)}
  .dot{width:46px;height:46px;border-radius:13px;flex:0 0 auto;display:grid;place-items:center;font-size:1.4rem}
  .cb .dot{background:linear-gradient(135deg,#7A5DC7,#E89AAE);color:#fff}
  .sj .dot{background:linear-gradient(135deg,#caa14b,#8a6f2e);color:#fff}
  .card b{display:block;font-size:1.08rem}
  .card span{color:#7a7392;font-size:.9rem}
  footer{margin-top:26px;color:#9b95b3;font-size:.82rem;text-align:center}
</style></head>
<body><div class="wrap">
  <h1>Sistem Absensi</h1>
  <p class="sub">Pilih organisasi untuk membuka halaman absensi & dashboard.</p>
  <div class="cards">
    <a class="card cb" href="/coolbeans/"><span class="dot">☕</span><span><b>Cool Beans Restaurant</b><span>Absensi &amp; rekap shift — tema ungu/pink</span></span></a>
    <a class="card sj" href="/senjakala/"><span class="dot">✚</span><span><b>RS Senjakala</b><span>Absensi &amp; rekap shift — tema gold</span></span></a>
  </div>
  <footer>Satu server Node.js menyajikan kedua web.</footer>
</div></body></html>`;

/* ---------------- Router ---------------- */
const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  for (const { prefix, app } of MOUNTS) {
    if (urlPath === prefix) {
      // Normalize to trailing slash so relative asset URLs resolve under the mount.
      res.writeHead(302, { Location: prefix + "/" });
      return res.end();
    }
    if (urlPath.startsWith(prefix + "/")) {
      const sub = urlPath.slice(prefix.length) || "/";
      return app.handle(req, res, sub);
    }
  }

  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(LANDING);
  }
  if (urlPath === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found. Buka /coolbeans/ atau /senjakala/");
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Sistem Absensi (gabungan) — server aktif (bind ${HOST}:${PORT})`);
  console.log(`  ➜  Landing      : http://localhost:${PORT}/`);
  console.log(`  ➜  Cool Beans   : http://localhost:${PORT}/coolbeans/`);
  console.log(`  ➜  RS Senjakala : http://localhost:${PORT}/senjakala/`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) for (const ni of nets[name] || []) if (ni.family === "IPv4" && !ni.internal) console.log(`  ➜  Jaringan     : http://${ni.address}:${PORT}/`);
  console.log(`  Data : ${DATA_DIR}  (coolbeans.json, senjakala.json)`);
  console.log(`  Zona : WIB (UTC+7)\n`);
});
