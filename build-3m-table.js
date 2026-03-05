/**
 * build-3m-table.js
 * - Build a full URL comparison table (Now vs ~3 months ago) for GitHub Job Summary.
 * - input: results/summary.json, history/*.json
 * - output: results/compare-3m-all.md, results/compare-3m-all.csv
 *
 * Supports history filenames:
 *  - YYYY-MM-DD.json
 *  - YYYY-MM-DD-HHMMSS.json (UTC recommended)
 *
 * Enhancement:
 *  - If multiple snapshots exist on the same date (YYYY-MM-DD), only the latest one is used.
 *
 * Node 18+, no deps.
 */

const fs = require("fs");
const path = require("path");

const HISTORY_DIR = "history";
const NOW_PATH = path.join("results", "summary.json");
const OUT_MD = path.join("results", "compare-3m-all.md");
const OUT_CSV = path.join("results", "compare-3m-all.csv");

const PAST_DAYS = 90;

function exists(p) {
  return fs.existsSync(p);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function parseHistoryFilename(fileName) {
  const m = fileName.match(/^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?\.json$/);
  if (!m) return null;

  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);

  const HH = m[4] ? Number(m[4]) : 0;
  const MM = m[5] ? Number(m[5]) : 0;
  const SS = m[6] ? Number(m[6]) : 0;

  const date = new Date(Date.UTC(yyyy, mm - 1, dd, HH, MM, SS));
  const dayKey = `${m[1]}-${m[2]}-${m[3]}`; 
  const timeKey = `${String(HH).padStart(2, "0")}${String(MM).padStart(2, "0")}${String(SS).padStart(2, "0")}`; // HHMMSS

  return {
    fileName,
    isoKey: fileName.replace(/\.json$/, ""),
    date,
    dayKey,
    timeKey,
  };
}

function listHistoryLatestPerDay() {
  if (!exists(HISTORY_DIR)) return [];

  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));

  const bestByDay = new Map();

  for (const f of files) {
    const e = parseHistoryFilename(f);
    if (!e) continue;

    const prev = bestByDay.get(e.dayKey);
    if (!prev) {
      bestByDay.set(e.dayKey, e);
      continue;
    }

    if (e.date.getTime() > prev.date.getTime()) {
      bestByDay.set(e.dayKey, e);
    } else if (e.date.getTime() === prev.date.getTime() && e.fileName > prev.fileName) {
      bestByDay.set(e.dayKey, e);
    }
  }

  const entries = [...bestByDay.values()];
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

function pickNearestEntry(targetDate, entries) {
  let best = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(e.date.getTime() - targetDate.getTime());
    if (diff < bestDiff) {
      best = e;
      bestDiff = diff;
    }
  }
  return best;
}

function pct(score01) {
  return typeof score01 === "number" ? Math.round(score01 * 100) : null;
}
function fmtNum(n, digits = 0) {
  if (typeof n !== "number") return "";
  return n.toFixed(digits);
}
function msToSec(ms) {
  if (typeof ms !== "number") return "";
  return (ms / 1000).toFixed(2);
}
function delta(now, past) {
  if (typeof now !== "number" || typeof past !== "number") return null;
  return now - past;
}
function csvEscape(v) {
  const t = String(v ?? "");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function normalizeItems(summary) {
  const items = Array.isArray(summary.items) ? summary.items : [];
  return items
    .map((x) => {
      const device = x.device || x.formFactor || "";
      const url = x.url || x.finalUrl || x.requestedUrl || "";

      return {
        key: `${device}||${url}`,
        device,
        url,

        perf: pct(x.performance),
        a11y: pct(x.accessibility),
        bp: pct(x.bestPractices ?? x["best-practices"]),
        seo: pct(x.seo),

        lcpMs: typeof x.metrics?.lcp === "number" ? x.metrics.lcp : null,
        cls: typeof x.metrics?.cls === "number" ? x.metrics.cls : null,
      };
    })
    .filter((r) => r.url);
}

function indexByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.key, r);
  return m;
}

function main() {
  if (!exists(NOW_PATH)) {
    console.error("❌ Missing results/summary.json");
    process.exit(1);
  }

  const nowSummary = readJson(NOW_PATH);
  const nowRows = normalizeItems(nowSummary);
  const nowIdx = indexByKey(nowRows);

  const entries = listHistoryLatestPerDay();

  const nowDate = new Date();
  const target = new Date(nowDate.getTime() - PAST_DAYS * 24 * 60 * 60 * 1000);

  const pastEntry = pickNearestEntry(target, entries);

  let pastIdx = new Map();
  let hasPast = false;
  let pastLabel = "(not enough history yet)";

  if (pastEntry) {
    const pastPath = path.join(HISTORY_DIR, pastEntry.fileName);
    if (exists(pastPath)) {
      try {
        const pastSummary = readJson(pastPath);
        const pastRows = normalizeItems(pastSummary);
        pastIdx = indexByKey(pastRows);
        hasPast = pastRows.length > 0;
        pastLabel = pastEntry.isoKey;
      } catch (e) {
        console.error("⚠️ Failed to read past snapshot:", pastEntry.fileName, e?.message || e);
      }
    }
  }

  const allKeys = new Set([...nowIdx.keys(), ...pastIdx.keys()]);

  const rows = [];
  for (const key of allKeys) {
    const n = nowIdx.get(key) || {};
    const p = pastIdx.get(key) || {};

    rows.push({
      device: n.device || p.device || "",
      url: n.url || p.url || "",

      perf_past: p.perf,
      perf_now: n.perf,
      perf_delta: delta(n.perf, p.perf),

      a11y_past: p.a11y,
      a11y_now: n.a11y,
      a11y_delta: delta(n.a11y, p.a11y),

      bp_past: p.bp,
      bp_now: n.bp,
      bp_delta: delta(n.bp, p.bp),

      seo_past: p.seo,
      seo_now: n.seo,
      seo_delta: delta(n.seo, p.seo),

      lcp_past_ms: p.lcpMs,
      lcp_now_ms: n.lcpMs,
      lcp_delta_ms: delta(n.lcpMs, p.lcpMs),

      cls_past: p.cls,
      cls_now: n.cls,
      cls_delta: delta(n.cls, p.cls),
    });
  }

  rows.sort((a, b) => {
    const aNow = a.perf_now ?? 999;
    const bNow = b.perf_now ?? 999;
    if (aNow !== bNow) return aNow - bNow;

    const aD = a.perf_delta ?? 0;
    const bD = b.perf_delta ?? 0;
    return aD - bD;
  });

  const header =
    `# 3 Month Comparison (All URLs)\n\n` +
    `- Now: ${nowDate.toISOString().slice(0, 10)}\n` +
    `- Past (nearest to ~${PAST_DAYS}d ago, latest-per-day): ${hasPast ? pastLabel : "(not enough history yet)"}\n` +
    `- Rows: ${rows.length}\n` +
    `- Columns: Perf/A11y/BP/SEO/LCP/CLS (Past→Now, Δ)\n\n`;

  const tableHead =
    `| Device | URL | Perf (Past→Now, Δ) | A11y (Past→Now, Δ) | BP (Past→Now, Δ) | SEO (Past→Now, Δ) | LCP (Past→Now, Δ) | CLS (Past→Now, Δ) |\n` +
    `|---|---|---:|---:|---:|---:|---:|---:|\n`;

  const mdLines = rows.map((r) => {
    const perfCell = `${r.perf_past ?? ""}→${r.perf_now ?? ""} (${r.perf_delta ?? ""})`;
    const a11yCell = `${r.a11y_past ?? ""}→${r.a11y_now ?? ""} (${r.a11y_delta ?? ""})`;
    const bpCell = `${r.bp_past ?? ""}→${r.bp_now ?? ""} (${r.bp_delta ?? ""})`;
    const seoCell = `${r.seo_past ?? ""}→${r.seo_now ?? ""} (${r.seo_delta ?? ""})`;

    const lcpCell =
      `${msToSec(r.lcp_past_ms)}→${msToSec(r.lcp_now_ms)} ` +
      `(${r.lcp_delta_ms == null ? "" : (r.lcp_delta_ms / 1000).toFixed(2)})`;

    const clsCell =
      `${fmtNum(r.cls_past, 3)}→${fmtNum(r.cls_now, 3)} ` +
      `(${r.cls_delta == null ? "" : r.cls_delta.toFixed(3)})`;

    return `| ${r.device} | ${r.url} | ${perfCell} | ${a11yCell} | ${bpCell} | ${seoCell} | ${lcpCell} | ${clsCell} |`;
  });

  const md =
    header +
    `<details>\n<summary>Show full table</summary>\n\n` +
    tableHead +
    mdLines.join("\n") +
    `\n\n</details>\n`;

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md, "utf-8");

  // CSV
  const csvHeader = [
    "device",
    "url",
    "perf_past",
    "perf_now",
    "perf_delta",
    "a11y_past",
    "a11y_now",
    "a11y_delta",
    "bp_past",
    "bp_now",
    "bp_delta",
    "seo_past",
    "seo_now",
    "seo_delta",
    "lcp_sec_past",
    "lcp_sec_now",
    "lcp_sec_delta",
    "cls_past",
    "cls_now",
    "cls_delta",
  ].join(",");

  const csvLines = rows.map((r) => {
    const lcpPastS = r.lcp_past_ms == null ? "" : (r.lcp_past_ms / 1000).toFixed(2);
    const lcpNowS = r.lcp_now_ms == null ? "" : (r.lcp_now_ms / 1000).toFixed(2);
    const lcpDeltaS = r.lcp_delta_ms == null ? "" : (r.lcp_delta_ms / 1000).toFixed(2);

    return [
      csvEscape(r.device),
      csvEscape(r.url),

      r.perf_past ?? "",
      r.perf_now ?? "",
      r.perf_delta ?? "",

      r.a11y_past ?? "",
      r.a11y_now ?? "",
      r.a11y_delta ?? "",

      r.bp_past ?? "",
      r.bp_now ?? "",
      r.bp_delta ?? "",

      r.seo_past ?? "",
      r.seo_now ?? "",
      r.seo_delta ?? "",

      lcpPastS,
      lcpNowS,
      lcpDeltaS,

      r.cls_past ?? "",
      r.cls_now ?? "",
      r.cls_delta == null ? "" : r.cls_delta.toFixed(3),
    ].join(",");
  });

  fs.writeFileSync(OUT_CSV, [csvHeader, ...csvLines].join("\n"), "utf-8");

  console.log(`✅ Wrote: ${OUT_MD}`);
  console.log(`✅ Wrote: ${OUT_CSV}`);
  console.log(`ℹ️ Past snapshot used: ${hasPast ? pastLabel : "none"}`);
  console.log(`ℹ️ History candidates (latest per day): ${entries.length}`);
}

main();
