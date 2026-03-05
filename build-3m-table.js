/**
 * build-3m-table.js
 * - Build a full URL comparison table (Now vs ~3 months ago) for GitHub Job Summary.
 * - input: results/summary.json, history/YYYY-MM-DD.json
 * - output: results/compare-3m-all.md, results/compare-3m-all.csv
 *
 * Node 18+, no deps.
 */

const fs = require("fs");
const path = require("path");

const HISTORY_DIR = "history";
const NOW_PATH = path.join("results", "summary.json");
const OUT_MD = path.join("results", "compare-3m-all.md");
const OUT_CSV = path.join("results", "compare-3m-all.csv");

function exists(p) {
  return fs.existsSync(p);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function listHistoryFiles() {
  if (!exists(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}
function toDate(yyyy_mm_dd) {
  return new Date(`${yyyy_mm_dd}T00:00:00Z`);
}
function pickNearestDate(targetDate, files) {
  let best = null;
  let bestDiff = Infinity;
  for (const f of files) {
    const dStr = f.replace(".json", "");
    const d = toDate(dStr);
    const diff = Math.abs(d.getTime() - targetDate.getTime());
    if (diff < bestDiff) {
      best = dStr;
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

/**
 * summary.json의 items 구조를 최대한 관대하게 normalize
 * key: `${device}||${url}` 로 now/past 매칭
 */
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
  const files = listHistoryFiles();

  // 운영 목적: 3개월 전을 90일로 근사 (스케줄이 주 2회여도 안정적으로 매칭됨)
  const nowDate = new Date();
  const target = new Date(nowDate.getTime() - 90 * 24 * 60 * 60 * 1000);
  const pastDate = pickNearestDate(target, files);

  const nowRows = normalizeItems(nowSummary);
  const nowIdx = indexByKey(nowRows);

  let pastIdx = new Map();
  let hasPast = false;

  if (pastDate && exists(path.join(HISTORY_DIR, `${pastDate}.json`))) {
    hasPast = true;
    const pastSummary = readJson(path.join(HISTORY_DIR, `${pastDate}.json`));
    const pastRows = normalizeItems(pastSummary);
    pastIdx = indexByKey(pastRows);
  }

  // 현재+과거 union (과거에만 있던 URL도 포함)
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

      lcp_past_ms: p.lcpMs,
      lcp_now_ms: n.lcpMs,
      lcp_delta_ms: delta(n.lcpMs, p.lcpMs),

      cls_past: p.cls,
      cls_now: n.cls,
      cls_delta: delta(n.cls, p.cls),

      a11y_past: p.a11y,
      a11y_now: n.a11y,
      a11y_delta: delta(n.a11y, p.a11y),

      bp_past: p.bp,
      bp_now: n.bp,
      bp_delta: delta(n.bp, p.bp),

      seo_past: p.seo,
      seo_now: n.seo,
      seo_delta: delta(n.seo, p.seo),
    });
  }

  // 정렬: 현재 Perf 낮은 순 → Perf delta(악화) 큰 순
  rows.sort((a, b) => {
    const aNow = a.perf_now ?? 999;
    const bNow = b.perf_now ?? 999;
    if (aNow !== bNow) return aNow - bNow;

    const aD = a.perf_delta ?? 0;
    const bD = b.perf_delta ?? 0;
    return aD - bD; // -값(악화) 먼저
  });

  // Markdown (Job Summary에서는 너무 길어질 수 있어 <details>로 접기)
  const header =
    `# 3-Month Comparison (All URLs)\n\n` +
    `- Now: ${nowDate.toISOString().slice(0, 10)}\n` +
    `- Past: ${hasPast ? pastDate : "(not enough history yet)"}\n` +
    `- Rows: ${rows.length}\n\n`;

  const tableHead =
    `| Device | URL | Perf (Past→Now, Δ) | LCP (Past→Now, Δ) | CLS (Past→Now, Δ) |\n` +
    `|---|---|---:|---:|---:|\n`;

  const mdLines = rows.map((r) => {
    const perfCell = `${r.perf_past ?? ""}→${r.perf_now ?? ""} (${r.perf_delta ?? ""})`;
    const lcpCell = `${msToSec(r.lcp_past_ms)}→${msToSec(r.lcp_now_ms)} (${r.lcp_delta_ms == null ? "" : (r.lcp_delta_ms / 1000).toFixed(2)})`;
    const clsCell = `${fmtNum(r.cls_past, 3)}→${fmtNum(r.cls_now, 3)} (${r.cls_delta == null ? "" : r.cls_delta.toFixed(3)})`;
    return `| ${r.device} | ${r.url} | ${perfCell} | ${lcpCell} | ${clsCell} |`;
  });

  const md =
    header +
    `<details>\n<summary>Show full table</summary>\n\n` +
    tableHead +
    mdLines.join("\n") +
    `\n\n</details>\n`;

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md, "utf-8");

  // CSV (엑셀/스프레드시트에서 필터/정렬용)
  const csvHeader = [
    "device",
    "url",
    "perf_past",
    "perf_now",
    "perf_delta",
    "lcp_sec_past",
    "lcp_sec_now",
    "lcp_sec_delta",
    "cls_past",
    "cls_now",
    "cls_delta",
    "a11y_past",
    "a11y_now",
    "a11y_delta",
    "bp_past",
    "bp_now",
    "bp_delta",
    "seo_past",
    "seo_now",
    "seo_delta",
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
      lcpPastS,
      lcpNowS,
      lcpDeltaS,
      r.cls_past ?? "",
      r.cls_now ?? "",
      r.cls_delta == null ? "" : r.cls_delta.toFixed(3),
      r.a11y_past ?? "",
      r.a11y_now ?? "",
      r.a11y_delta ?? "",
      r.bp_past ?? "",
      r.bp_now ?? "",
      r.bp_delta ?? "",
      r.seo_past ?? "",
      r.seo_now ?? "",
      r.seo_delta ?? "",
    ].join(",");
  });

  fs.writeFileSync(OUT_CSV, [csvHeader, ...csvLines].join("\n"), "utf-8");

  console.log(`✅ Wrote: ${OUT_MD}`);
  console.log(`✅ Wrote: ${OUT_CSV}`);
}

main();
