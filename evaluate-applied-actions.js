/**
 * evaluate-applied-actions.js
 *
 * applied-actions.md 에 기록된 개선 액션의 효과를 *코드로* deterministic 하게 검증한다.
 * AI 추론(✅/⚠️) 대신, history/*.json 의 before/after metric 을 직접 비교해 판정.
 *
 * 흐름:
 *   1. applied-actions.md 파싱 → [{date, host, content}] (최근 APPLIED_WINDOW_WEEKS 주만)
 *   2. 각 액션마다 before [적용일-7d, 적용일) / after [today-7d, today] 윈도의
 *      host metric (mobile/desktop 별 perf/lcp/cls/tbt 평균) 집계
 *   3. content 키워드로 primary metric 추론 → before/after delta → verdict 판정
 *   4. results/applied-eval.json + applied-eval.md 출력 (Job Summary 노출용)
 *
 * 출력은 generate-ai-suggestions.js 가 fact 로 주입 (AI 가 다시 판정하지 않음).
 *
 * 환경변수 (모두 override 가능):
 *   APPLIED_ACTIONS_PATH (기본 applied-actions.md)
 *   APPLIED_WINDOW_WEEKS (기본 12) — 이보다 오래된 entry 무시
 *   EVAL_BEFORE_DAYS / EVAL_AFTER_DAYS (기본 7)
 *   EVAL_MIN_SAMPLE (기본 2) — 윈도 스냅샷 부족 기준
 *   EVAL_LCP_REL / EVAL_TBT_REL (기본 0.10) — |Δ|/before 유의 임계
 *   EVAL_CLS_ABS (기본 0.02) / EVAL_PERF_PT (기본 5)
 *   EARLIEST_BASELINE_DATE (기본 2026-04-22) — collapsed era 차단
 *
 * Node 18+, no deps.
 */

const fs = require("fs");
const path = require("path");

const HISTORY_DIR = "history";
const APPLIED_PATH = process.env.APPLIED_ACTIONS_PATH || "applied-actions.md";
const OUT_JSON = path.join("results", "applied-eval.json");
const OUT_MD = path.join("results", "applied-eval.md");

const APPLIED_WINDOW_WEEKS = parseInt(process.env.APPLIED_WINDOW_WEEKS || "12", 10);
const EVAL_BEFORE_DAYS = parseInt(process.env.EVAL_BEFORE_DAYS || "7", 10);
const EVAL_AFTER_DAYS = parseInt(process.env.EVAL_AFTER_DAYS || "7", 10);
const EVAL_MIN_SAMPLE = parseInt(process.env.EVAL_MIN_SAMPLE || "2", 10);
const EVAL_LCP_REL = Number(process.env.EVAL_LCP_REL || "0.10");
const EVAL_TBT_REL = Number(process.env.EVAL_TBT_REL || "0.10");
const EVAL_CLS_ABS = Number(process.env.EVAL_CLS_ABS || "0.02");
const EVAL_PERF_PT = Number(process.env.EVAL_PERF_PT || "5");
const EARLIEST_BASELINE_DATE = process.env.EARLIEST_BASELINE_DATE || "2026-04-22";

const DAY_MS = 24 * 60 * 60 * 1000;

function exists(p) {
  return fs.existsSync(p);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function mean(arr) {
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}
function normHost(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
function truncate(s, n) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ───────────────────────────────────────────────────────────────────────────
// history 유틸 — build-3m-table.js (L46, L71) 복사. 그 파일은 require.main 가드가 없어
// require 하면 main() 이 자동 실행되므로 복사로 부작용 회피. (향후 history-utils.js 로 통합 가능)
function parseHistoryFilename(fileName) {
  const m = fileName.match(/^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?\.json$/);
  if (!m) return null;
  const HH = m[4] ? Number(m[4]) : 0;
  const MM = m[5] ? Number(m[5]) : 0;
  const SS = m[6] ? Number(m[6]) : 0;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), HH, MM, SS));
  return { fileName, isoKey: fileName.replace(/\.json$/, ""), date, dayKey: `${m[1]}-${m[2]}-${m[3]}` };
}

function listHistoryLatestPerDay() {
  if (!exists(HISTORY_DIR)) return [];
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  const bestByDay = new Map();
  for (const f of files) {
    const e = parseHistoryFilename(f);
    if (!e) continue;
    const prev = bestByDay.get(e.dayKey);
    if (!prev || e.date.getTime() > prev.date.getTime() || (e.date.getTime() === prev.date.getTime() && e.fileName > prev.fileName)) {
      bestByDay.set(e.dayKey, e);
    }
  }
  const entries = [...bestByDay.values()];
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

// 한 snapshot 의 items 에서 device 별 lcp/cls 가 전부 동일값이면 collapsed era 로 간주 → 마스킹.
// (build-3m-table.js detectCollapsedMetrics L206 의 raw items 버전)
function detectCollapsedMetrics(items) {
  const invalid = { mobile: { lcp: false, cls: false }, desktop: { lcp: false, cls: false } };
  for (const dev of ["mobile", "desktop"]) {
    const arr = items.filter((it) => it.device === dev);
    if (arr.length < 3) continue;
    for (const field of ["lcp", "cls"]) {
      const vals = arr.map((it) => it.metrics?.[field]).filter((v) => typeof v === "number");
      if (vals.length < 3) continue;
      if (new Set(vals.map((v) => v.toFixed(6))).size === 1) invalid[dev][field] = true;
    }
  }
  return invalid;
}

// ───────────────────────────────────────────────────────────────────────────
// applied-actions.md 파싱 — generate-ai-suggestions.js filterRecentAppliedActions(L32) 로직 차용.
function parseAppliedActions(md, nowMs) {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const datePattern = /^\s*-\s*\[(\d{4})-(\d{2})-(\d{2})\]\s*(.*)$/;
  const cutoff = nowMs - APPLIED_WINDOW_WEEKS * 7 * DAY_MS;
  const out = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = line.match(datePattern);
    if (!m) continue;
    const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (dateMs < cutoff) continue;
    const rest = (m[4] || "").trim();
    const tokens = rest.split(/\s+/);
    let host = null;
    let content = rest;
    if (tokens.length && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tokens[0])) {
      host = tokens[0].toLowerCase().replace(/^www\./, "");
      content = tokens.slice(1).join(" ").trim();
    }
    out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, dateMs, host, content, raw: line.trim() });
  }
  return out;
}

// content 키워드로 primary metric 추론. 명시적 lcp/cls/tbt 우선 → hit 최다 → 동점이면 null.
function inferPrimaryMetric(content) {
  const c = (content || "").toLowerCase();
  if (/\blcp\b/.test(c)) return "lcp";
  if (/\bcls\b/.test(c)) return "cls";
  if (/\btbt\b/.test(c)) return "tbt";
  const groups = {
    lcp: ["이미지", "image", "webp", "avif", "hero", "히어로", "lazy", "fetchpriority", "preload", "썸네일", "배너", "png", "jpg", "jpeg"],
    cls: ["폰트", "font", "레이아웃", "layout", "aspect-ratio", "width", "height", "치수", "고정"],
    tbt: ["js", "script", "스크립트", "defer", "async", "bundle", "번들", "ga", "pixel", "gtm", "splitting", "스플리팅", "주석", "불필요한 코드", "코드 제거", "promotion"],
  };
  const score = { lcp: 0, cls: 0, tbt: 0 };
  for (const [metric, kws] of Object.entries(groups)) {
    for (const kw of kws) if (c.includes(kw)) score[metric]++;
  }
  const max = Math.max(score.lcp, score.cls, score.tbt);
  if (max === 0) return null;
  const top = Object.keys(score).filter((k) => score[k] === max);
  return top.length === 1 ? top[0] : null;
}

// ───────────────────────────────────────────────────────────────────────────
function loadWindowSnapshots(entries, startMs, endMs) {
  const floorMs = new Date(`${EARLIEST_BASELINE_DATE}T00:00:00Z`).getTime();
  return entries.filter((e) => {
    const t = e.date.getTime();
    return t >= startMs && t < endMs && t >= floorMs;
  });
}

const METRIC_FIELD = { lcp: "lcpAvgMs", cls: "clsAvg", tbt: "tbtAvgMs", perf: "perfAvg" };

// 윈도 내 스냅샷들에서 host 의 device 별 metric 평균 집계.
function aggregateHostMetrics(snapshotEntries, host) {
  const acc = {
    mobile: { perf: [], lcp: [], cls: [], tbt: [], snapshotCount: 0, urlCount: 0 },
    desktop: { perf: [], lcp: [], cls: [], tbt: [], snapshotCount: 0, urlCount: 0 },
  };
  for (const e of snapshotEntries) {
    let data;
    try {
      data = readJson(path.join(HISTORY_DIR, e.fileName));
    } catch {
      continue;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const collapsed = detectCollapsedMetrics(items);
    for (const dev of ["mobile", "desktop"]) {
      const hostItems = items.filter((it) => it.device === dev && normHost(it.url) === host);
      if (!hostItems.length) continue;
      acc[dev].snapshotCount++;
      acc[dev].urlCount = Math.max(acc[dev].urlCount, hostItems.length);

      const perfs = hostItems.map((it) => it.performance).filter((n) => typeof n === "number");
      if (perfs.length) acc[dev].perf.push(mean(perfs) * 100);

      if (!collapsed[dev].lcp) {
        const v = hostItems.map((it) => it.metrics?.lcp).filter((n) => typeof n === "number");
        if (v.length) acc[dev].lcp.push(mean(v));
      }
      if (!collapsed[dev].cls) {
        const v = hostItems.map((it) => it.metrics?.cls).filter((n) => typeof n === "number");
        if (v.length) acc[dev].cls.push(mean(v));
      }
      const t = hostItems.map((it) => it.metrics?.tbt).filter((n) => typeof n === "number");
      if (t.length) acc[dev].tbt.push(mean(t));
    }
  }
  const out = {};
  for (const dev of ["mobile", "desktop"]) {
    const a = acc[dev];
    out[dev] = {
      perfAvg: a.perf.length ? Math.round(mean(a.perf)) : null,
      lcpAvgMs: a.lcp.length ? Math.round(mean(a.lcp)) : null,
      clsAvg: a.cls.length ? Number(mean(a.cls).toFixed(3)) : null,
      tbtAvgMs: a.tbt.length ? Math.round(mean(a.tbt)) : null,
      snapshotCount: a.snapshotCount,
      urlCount: a.urlCount,
    };
  }
  return out;
}

// metric 별 before/after delta + 유의성 판정.
function computeDelta(beforeVal, afterVal, metric) {
  const r = { metric, beforeVal: beforeVal ?? null, afterVal: afterVal ?? null, deltaAbs: null, deltaRel: null, improved: null, significant: false };
  if (typeof beforeVal !== "number" || typeof afterVal !== "number") return r;
  r.deltaAbs = afterVal - beforeVal;
  if (metric === "perf") {
    r.improved = afterVal > beforeVal; // 높을수록 좋음
    r.significant = Math.abs(r.deltaAbs) >= EVAL_PERF_PT;
  } else if (metric === "cls") {
    r.improved = afterVal < beforeVal; // 낮을수록 좋음
    r.significant = Math.abs(r.deltaAbs) >= EVAL_CLS_ABS;
  } else {
    // lcp, tbt — 낮을수록 좋음, relative 임계
    r.improved = afterVal < beforeVal;
    if (beforeVal > 0) {
      r.deltaRel = r.deltaAbs / beforeVal;
      const rel = metric === "lcp" ? EVAL_LCP_REL : EVAL_TBT_REL;
      r.significant = Math.abs(r.deltaRel) >= rel;
    }
  }
  return r;
}

// 정규화된 변화 크기 (primary metric 미상일 때 최대 변화 metric 선택용).
function normalizedChange(delta, metric) {
  if (metric === "cls") return delta.deltaAbs == null ? 0 : Math.abs(delta.deltaAbs) / EVAL_CLS_ABS;
  return delta.deltaRel == null ? 0 : Math.abs(delta.deltaRel) / (metric === "lcp" ? EVAL_LCP_REL : EVAL_TBT_REL);
}

const METRICS = ["lcp", "cls", "tbt"];

function evaluateAction(action, beforeAgg, afterAgg) {
  const base = { date: action.date, host: action.host, content: action.content, raw: action.raw };

  if (!action.host) return finalize({ ...base, verdict: "HOST_UNKNOWN" });

  const anyData = ["mobile", "desktop"].some(
    (d) => (beforeAgg[d]?.snapshotCount || 0) > 0 || (afterAgg[d]?.snapshotCount || 0) > 0
  );
  if (!anyData) return finalize({ ...base, verdict: "NO_MEASUREMENT" });

  const enough = ["mobile", "desktop"].filter(
    (d) => (beforeAgg[d]?.snapshotCount || 0) >= EVAL_MIN_SAMPLE && (afterAgg[d]?.snapshotCount || 0) >= EVAL_MIN_SAMPLE
  );
  if (!enough.length) return finalize({ ...base, verdict: "INSUFFICIENT_DATA" });

  let primary = inferPrimaryMetric(action.content);
  const inferred = primary !== null;
  let chosen = null; // { device, metric, delta }

  if (inferred) {
    // verdict device = enough 중 primary metric before 가 더 나쁜(값 큰) device
    const field = METRIC_FIELD[primary];
    let dev = null;
    let worst = -Infinity;
    for (const d of enough) {
      const bv = beforeAgg[d]?.[field];
      if (typeof bv === "number" && bv > worst) {
        worst = bv;
        dev = d;
      }
    }
    if (!dev) dev = enough[0];
    chosen = { device: dev, metric: primary, delta: computeDelta(beforeAgg[dev]?.[field], afterAgg[dev]?.[field], primary) };
  } else {
    // primary 미상 → 4 metric × enough device 중 정규화 변화 최대
    let best = null;
    for (const d of enough) {
      for (const mt of METRICS) {
        const delta = computeDelta(beforeAgg[d]?.[METRIC_FIELD[mt]], afterAgg[d]?.[METRIC_FIELD[mt]], mt);
        const nc = normalizedChange(delta, mt);
        if (!best || nc > best.nc) best = { device: d, metric: mt, delta, nc };
      }
    }
    if (best) {
      chosen = { device: best.device, metric: best.metric, delta: best.delta };
      primary = best.metric;
    }
  }

  let verdict = "NEUTRAL";
  if (chosen?.delta?.significant) verdict = chosen.delta.improved ? "IMPROVED" : "DEGRADED";

  return finalize({
    ...base,
    verdict,
    primaryMetric: primary,
    primaryMetricInferred: inferred,
    verdictDevice: chosen?.device || null,
    delta: chosen?.delta || null,
    metrics: { mobile: beforeAgg.mobile, desktop: beforeAgg.desktop },
    after: { mobile: afterAgg.mobile, desktop: afterAgg.desktop },
  });
}

function fmtMetricVal(v, metric) {
  if (typeof v !== "number") return "?";
  if (metric === "cls") return v.toFixed(3);
  return `${Math.round(v)}ms`; // lcp, tbt
}

function fmtChange(delta, metric) {
  if (!delta) return "";
  if (metric === "cls") {
    const sign = delta.deltaAbs > 0 ? "+" : "";
    return `Δ${sign}${delta.deltaAbs.toFixed(3)}`;
  }
  if (delta.deltaRel == null) return "";
  const pct = (delta.deltaRel * 100).toFixed(1);
  return `${delta.deltaRel > 0 ? "+" : ""}${pct}%`;
}

const VERDICT_ICON = {
  IMPROVED: "✅",
  DEGRADED: "⚠️",
  NEUTRAL: "➖",
  INSUFFICIENT_DATA: "❓",
  NO_MEASUREMENT: "❓",
  HOST_UNKNOWN: "❓",
};

function formatSummaryLine(e) {
  const icon = VERDICT_ICON[e.verdict] || "❓";
  const head = `${icon} [${e.date}] ${e.host || "(host 미상)"} ${truncate(e.content, 40)}`;
  if (e.verdict === "HOST_UNKNOWN") return `${head} → host 추출 실패 (기록 형식 확인)`;
  if (e.verdict === "NO_MEASUREMENT") return `${head} → 측정 데이터 없음`;
  if (e.verdict === "INSUFFICIENT_DATA") return `${head} → 윈도 스냅샷 부족 (판정 보류)`;
  const mt = e.primaryMetric;
  const d = e.delta;
  const val = (v) => fmtMetricVal(v, mt);
  const suffix =
    e.verdict === "DEGRADED" ? " — 악화/미반영, 적용 상태 확인 권장" : e.verdict === "NEUTRAL" ? " — 임계값 미만 변화" : "";
  return `${head} → [${e.verdictDevice}] ${mt.toUpperCase()} ${val(d?.beforeVal)}→${val(d?.afterVal)} (${fmtChange(d, mt)})${suffix}`;
}

function finalize(e) {
  e.summaryLine = formatSummaryLine(e);
  return e;
}

// ───────────────────────────────────────────────────────────────────────────
function buildJson(results, nowIso) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  return {
    generatedAt: nowIso,
    beforeWindowDays: EVAL_BEFORE_DAYS,
    afterWindowDays: EVAL_AFTER_DAYS,
    thresholds: { lcpRel: EVAL_LCP_REL, tbtRel: EVAL_TBT_REL, clsAbs: EVAL_CLS_ABS, perfPt: EVAL_PERF_PT, minSample: EVAL_MIN_SAMPLE },
    counts,
    results,
  };
}

function buildMarkdown(results, nowIso) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  const lines = [];
  lines.push(`## 📋 Applied Action Evaluation`);
  lines.push("");
  lines.push(
    `- 평가일: ${nowIso.slice(0, 10)} | before ${EVAL_BEFORE_DAYS}d / after ${EVAL_AFTER_DAYS}d 윈도`
  );
  lines.push(
    `- 임계값: LCP/TBT ${Math.round(EVAL_LCP_REL * 100)}% / CLS ${EVAL_CLS_ABS} / Perf ${EVAL_PERF_PT}pt`
  );
  const countStr = ["IMPROVED", "DEGRADED", "NEUTRAL", "INSUFFICIENT_DATA", "NO_MEASUREMENT", "HOST_UNKNOWN"]
    .filter((v) => counts[v])
    .map((v) => `${VERDICT_ICON[v]} ${v} ${counts[v]}`)
    .join(" / ");
  lines.push(`- 결과: ${countStr || "(평가 대상 없음)"}`);
  lines.push("");

  if (results.length === 0) {
    lines.push("_최근 적용 액션 기록이 없거나 평가 대상이 없습니다._");
    return lines.join("\n") + "\n";
  }

  // verdict 우선순위 정렬 (IMPROVED/DEGRADED 먼저, 그 다음 NEUTRAL, 그 외)
  const order = { IMPROVED: 0, DEGRADED: 1, NEUTRAL: 2, INSUFFICIENT_DATA: 3, NO_MEASUREMENT: 4, HOST_UNKNOWN: 5 };
  const sorted = results.slice().sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9));

  for (const r of sorted) lines.push(`- ${r.summaryLine}`);
  lines.push("");

  // 상세 metric 표 (IMPROVED/DEGRADED/NEUTRAL 만 — 데이터 있는 것)
  const detailed = sorted.filter((r) => ["IMPROVED", "DEGRADED", "NEUTRAL"].includes(r.verdict) && r.delta);
  if (detailed.length > 0) {
    lines.push("<details><summary>상세 metric (before → after)</summary>");
    lines.push("");
    lines.push("| 날짜 | host | metric | device | before | after | 판정 |");
    lines.push("|---|---|---|---|---:|---:|---|");
    for (const r of detailed) {
      const mt = r.primaryMetric;
      const val = (v) => fmtMetricVal(v, mt);
      lines.push(
        `| ${r.date} | ${r.host} | ${mt.toUpperCase()} | ${r.verdictDevice} | ${val(r.delta.beforeVal)} | ${val(r.delta.afterVal)} | ${r.verdict} |`
      );
    }
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

function main() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const md = exists(APPLIED_PATH) ? fs.readFileSync(APPLIED_PATH, "utf-8") : "";
  const actions = parseAppliedActions(md, nowMs);
  const entries = listHistoryLatestPerDay();

  console.log(`📥 applied actions (최근 ${APPLIED_WINDOW_WEEKS}주): ${actions.length}개, history 스냅샷: ${entries.length}일`);

  const afterStart = nowMs - EVAL_AFTER_DAYS * DAY_MS;
  const results = [];
  for (const a of actions) {
    // 적용일이 after 윈도와 겹칠 만큼 최근이면 before/after 분리 불가.
    if (a.dateMs > afterStart) {
      results.push(finalize({ date: a.date, host: a.host, content: a.content, raw: a.raw, verdict: "INSUFFICIENT_DATA", reason: "too_recent" }));
      continue;
    }
    const beforeSnaps = loadWindowSnapshots(entries, a.dateMs - EVAL_BEFORE_DAYS * DAY_MS, a.dateMs);
    const afterSnaps = loadWindowSnapshots(entries, afterStart, nowMs + 1);
    const beforeAgg = a.host ? aggregateHostMetrics(beforeSnaps, a.host) : { mobile: {}, desktop: {} };
    const afterAgg = a.host ? aggregateHostMetrics(afterSnaps, a.host) : { mobile: {}, desktop: {} };
    results.push(evaluateAction(a, beforeAgg, afterAgg));
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(buildJson(results, nowIso), null, 2), "utf-8");
  fs.writeFileSync(OUT_MD, buildMarkdown(results, nowIso), "utf-8");

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`✅ applied-eval 생성: ${OUT_JSON}, ${OUT_MD}`);
  console.log(`   verdicts:`, counts);
  for (const r of results) console.log(`   ${r.summaryLine}`);
}

module.exports = {
  parseAppliedActions,
  inferPrimaryMetric,
  aggregateHostMetrics,
  computeDelta,
  evaluateAction,
};

if (require.main === module) main();
