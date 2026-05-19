/**
 * build-regressions.js
 *
 * Week-over-Week 비교 CSV(results/compare-wow.csv 기본)에서 perf_delta 가
 * REGRESSION_THRESHOLD 이하인 회귀 행만 모아 Markdown 으로 출력한다.
 *
 * - input:  results/compare-wow.csv (env: IN_CSV)
 * - output: results/regressions-wow.md (env: OUT_MD)
 *
 * 절대 임계값(WARN<80, CRIT<60)이 아니라 *자기 기준* 변화량을 잡기 위한 보조 보고서.
 * Slack 으로는 발송하지 않고 Job Summary 에만 노출하는 것을 전제.
 *
 * Node 18+, no deps.
 */

const fs = require("fs");
const path = require("path");

const IN_CSV = process.env.IN_CSV || path.join("results", "compare-wow.csv");
const OUT_MD = process.env.OUT_MD || path.join("results", "regressions-wow.md");
const REGRESSION_THRESHOLD = parseInt(process.env.REGRESSION_THRESHOLD || "-10", 10);
const TITLE = process.env.TITLE || "⚠️ Week-over-Week Regressions";
const WINDOW_LABEL = process.env.WINDOW_LABEL || "지난 주 대비";

function ensureOutDir() {
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
}

function writeMd(md) {
  ensureOutDir();
  fs.writeFileSync(OUT_MD, md, "utf-8");
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cols[j] ?? "";
    rows.push(obj);
  }
  return rows;
}

function toNum(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function main() {
  if (!fs.existsSync(IN_CSV)) {
    writeMd(
      `## ${TITLE}\n\n_(비교 CSV (${IN_CSV})가 없어 회귀 분석을 생성하지 못했습니다.)_\n`
    );
    console.log(`No CSV at ${IN_CSV}. Wrote placeholder.`);
    return;
  }

  const rows = parseCsv(fs.readFileSync(IN_CSV, "utf-8"));
  const regressions = rows
    .map((r) => ({
      device: r.device || "",
      url: r.url || "",
      trend: r.trend || "",
      perf_past: toNum(r.perf_past),
      perf_now: toNum(r.perf_now),
      perf_delta: toNum(r.perf_delta),
      lcp_sec_past: toNum(r.lcp_sec_past),
      lcp_sec_now: toNum(r.lcp_sec_now),
      lcp_sec_delta: toNum(r.lcp_sec_delta),
      cls_delta: toNum(r.cls_delta),
    }))
    .filter((r) => r.perf_delta != null && r.perf_delta <= REGRESSION_THRESHOLD)
    .sort((a, b) => (a.perf_delta ?? 0) - (b.perf_delta ?? 0));

  if (regressions.length === 0) {
    writeMd(
      `## ${TITLE}\n\n${WINDOW_LABEL} Perf ${REGRESSION_THRESHOLD}점 이하 회귀 URL 없음 ✅\n`
    );
    console.log("No regressions.");
    return;
  }

  const head =
    `## ${TITLE}\n\n` +
    `${WINDOW_LABEL} Perf 가 ${Math.abs(REGRESSION_THRESHOLD)}점 이상 하락한 URL: **${regressions.length}개**\n\n` +
    `| Device | URL | Trend | Perf (Past→Now, Δ) | LCP(s) Δ | CLS Δ |\n` +
    `|---|---|:---:|---:|---:|---:|\n`;

  const body = regressions
    .map((r) => {
      const trendCell = r.trend ? `\`${r.trend}\`` : "";
      const perfCell = `${r.perf_past ?? ""}→${r.perf_now ?? ""} (**${r.perf_delta}**)`;
      const lcpCell =
        r.lcp_sec_delta == null ? "" : (r.lcp_sec_delta > 0 ? "+" : "") + r.lcp_sec_delta.toFixed(2);
      const clsCell =
        r.cls_delta == null ? "" : (r.cls_delta > 0 ? "+" : "") + r.cls_delta.toFixed(3);
      return `| ${r.device} | ${r.url} | ${trendCell} | ${perfCell} | ${lcpCell} | ${clsCell} |`;
    })
    .join("\n");

  writeMd(head + body + "\n");
  console.log(`✅ Wrote ${regressions.length} regressions to ${OUT_MD}`);
}

main();
