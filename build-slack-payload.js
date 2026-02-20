/**
 * build-slack-payload.js
 * - input: results/summary.json, results/ai-suggestions.md (optional)
 * - output: results/slack-payload.json
 *
 * Node 18 compatible, no extra deps.
 */

const fs = require("fs");
const path = require("path");

const SUMMARY_PATH = path.join("results", "summary.json");
const AI_MD_PATH = path.join("results", "ai-suggestions.md");
const OUT_PATH = path.join("results", "slack-payload.json");

// ===== Customize =====
const TOP_N_PER_DEVICE = 5; // mobile/desktop 각각 Top N만 노출
const DEFAULT_THRESHOLDS = { warn: 0.8, crit: 0.7 }; // Perf 기준
// =====================

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function toPct(score01) {
  if (typeof score01 !== "number") return "N/A";
  return String(Math.round(score01 * 100));
}

function safeFixed(n, digits = 3) {
  if (typeof n !== "number") return "N/A";
  return n.toFixed(digits);
}

function deviceTag(device) {
  return device === "mobile" ? "M" : device === "desktop" ? "D" : device;
}

function statusFromPerf(score01, warn01, crit01) {
  if (typeof score01 !== "number") return "UNKNOWN";
  if (score01 < crit01) return "CRIT";
  if (score01 < warn01) return "WARN";
  return "OK";
}

function statusEmoji(status) {
  if (status === "CRIT") return "🚨";
  if (status === "WARN") return "⚠️";
  if (status === "OK") return "✅";
  return "ℹ️";
}

function lineEmojiFromPerf(score01, warn01, crit01) {
  return statusEmoji(statusFromPerf(score01, warn01, crit01));
}

function score4(p) {
  // 2자리로 압축 표시: P:07 같은 형태 (N/A는 그대로)
  const P = toPct(p.performance);
  const A = toPct(p.accessibility);
  const BP = toPct(p.bestPractices);
  const SEO = toPct(p.seo);

  const pad2 = (s) => (s === "N/A" ? s : String(s).padStart(2, "0"));
  return `P:${pad2(P)} A:${pad2(A)} BP:${pad2(BP)} SEO:${pad2(SEO)}`;
}

function countByStatus(items, warn01, crit01) {
  let ok = 0,
    warn = 0,
    crit = 0,
    unknown = 0;

  for (const it of items) {
    const s = statusFromPerf(it.performance, warn01, crit01);
    if (s === "OK") ok++;
    else if (s === "WARN") warn++;
    else if (s === "CRIT") crit++;
    else unknown++;
  }
  return { ok, warn, crit, unknown };
}

/**
 * Parse AI markdown to extract:
 * - TL;DR: lines under "## TL;DR"
 * - actions: top 3 items under "## Recommended actions" or "## Recommendations"
 *
 * This is a tolerant parser: if sections are missing, it falls back gracefully.
 */
function parseAiMarkdown(md) {
  if (!md) {
    return { tldr: [], actions: [], rawSnippet: null };
  }

  const lines = md.split(/\r?\n/);

  function extractSection(headerRegex) {
    const startIdx = lines.findIndex((l) => headerRegex.test(l.trim()));
    if (startIdx === -1) return [];

    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^#{1,6}\s+/.test(t)) break; // next header
      if (!t) continue;
      out.push(t);
    }
    return out;
  }

  const tldrLines = extractSection(/^##\s*TL;DR/i)
    .map((l) => l.replace(/^-+\s*/, "").replace(/^•\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  let actionLines = extractSection(/^##\s*Recommended actions/i);
  if (actionLines.length === 0) actionLines = extractSection(/^##\s*Recommendations/i);

  const actions = actionLines
    .map((l) =>
      l
        .replace(/^\d+\)\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .replace(/^[-•]\s*/, "")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 3);

  const rawSnippet =
    tldrLines.length === 0 && actions.length === 0
      ? lines.filter((l) => l.trim()).slice(0, 10).join("\n")
      : null;

  return { tldr: tldrLines, actions, rawSnippet };
}

function buildProblemLines(problems, warn01, crit01, limit) {
  // perf 낮은 순으로 정렬해서 Top N만
  const sorted = problems
    .slice()
    .sort((a, b) => (a.performance ?? 1) - (b.performance ?? 1))
    .slice(0, limit);

  return sorted.map((p) => {
    const m = p.metrics || {};
    const lcp = m.lcp ? `${Math.round(m.lcp)}ms` : "N/A";
    const cls = typeof m.cls === "number" ? safeFixed(m.cls, 3) : "N/A";
    const icon = lineEmojiFromPerf(p.performance, warn01, crit01);

    // ✅ Slack 한 줄 가독성: 아이콘 + [M/D] + 4종 점수 + URL
    return `${icon} *[${deviceTag(p.device)}]* ${score4(p)} | ${p.url} _(LCP ${lcp}, CLS ${cls})_`;
  });
}

function main() {
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.error(`❌ Missing ${SUMMARY_PATH}. Run extract-scores.js first.`);
    process.exit(1);
  }

  const summary = readJson(SUMMARY_PATH);
  const aiMd = readTextIfExists(AI_MD_PATH);
  const ai = parseAiMarkdown(aiMd);

  const thresholds = summary.thresholds || DEFAULT_THRESHOLDS;
  const warn01 = typeof thresholds.warn === "number" ? thresholds.warn : DEFAULT_THRESHOLDS.warn;
  const crit01 = typeof thresholds.crit === "number" ? thresholds.crit : DEFAULT_THRESHOLDS.crit;
  const warnCut = Math.round(warn01 * 100);
  const critCut = Math.round(crit01 * 100);

  const date = new Date().toISOString().slice(0, 10);

  const items = Array.isArray(summary.items) ? summary.items : [];
  const problems = Array.isArray(summary.problems) ? summary.problems : [];
  const worst = summary?.overall?.worst || null;

  // 전체 상태는 summary.overall.status를 우선 사용, 없으면 worst/perf로 계산
  const derivedStatus =
    summary?.overall?.status && summary.overall.status !== "UNKNOWN"
      ? summary.overall.status
      : statusFromPerf(worst?.performance, warn01, crit01);

  const headerEmoji = statusEmoji(derivedStatus);
  const headerText = `${headerEmoji} Daily Lighthouse (${date}) - ${derivedStatus}`;

  // 디바이스별 분리
  const itemsMobile = items.filter((p) => p.device === "mobile");
  const itemsDesktop = items.filter((p) => p.device === "desktop");
  const problemsMobile = problems.filter((p) => p.device === "mobile");
  const problemsDesktop = problems.filter((p) => p.device === "desktop");

  // 카운트 요약
  const cAll = countByStatus(items, warn01, crit01);
  const cM = countByStatus(itemsMobile, warn01, crit01);
  const cD = countByStatus(itemsDesktop, warn01, crit01);

  const validReports = summary?.overall?.validReports ?? items.length;
  const invalidReports = summary?.invalid?.length ?? 0;

  const worstLine = worst
    ? `*Worst:* *[${deviceTag(worst.device)}]* P:${toPct(worst.performance)} | ${worst.url}`
    : `*Worst:* N/A _(valid: ${validReports}, invalid: ${invalidReports})_`;

  // KPI 텍스트: URL이 20개+여도 여기만 보면 전체 상황이 보이게
  const kpiText =
    `*Checked:* ${items.length} URLs  |  *Problems:* ${problems.length} _(P<${warnCut})_  |  *Critical:* _(P<${critCut})_\n` +
    `*All:* 🚨 ${cAll.crit}  ⚠️ ${cAll.warn}  ✅ ${cAll.ok}  ℹ️ ${cAll.unknown}\n` +
    `*Mobile:* 🚨 ${cM.crit}  ⚠️ ${cM.warn}  ✅ ${cM.ok}  ℹ️ ${cM.unknown}   |   ` +
    `*Desktop:* 🚨 ${cD.crit}  ⚠️ ${cD.warn}  ✅ ${cD.ok}  ℹ️ ${cD.unknown}`;

  // Top N 문제 URL만 노출
  const topMobileLines =
    problemsMobile.length > 0
      ? buildProblemLines(problemsMobile, warn01, crit01, TOP_N_PER_DEVICE)
      : ["✅ (No mobile problems)"];

  const topDesktopLines =
    problemsDesktop.length > 0
      ? buildProblemLines(problemsDesktop, warn01, crit01, TOP_N_PER_DEVICE)
      : ["✅ (No desktop problems)"];

  // Compose AI blocks
  const aiTldrBlock =
    ai.tldr.length > 0
      ? `*AI TL;DR*\n${ai.tldr.map((l) => `• ${l.replace(/^[-•]\s*/, "")}`).join("\n")}`
      : ai.rawSnippet
      ? `*AI Note*\n\`\`\`\n${ai.rawSnippet}\n\`\`\``
      : null;

  const aiActionsBlock =
    ai.actions.length > 0
      ? `*Recommended actions (Top 3)*\n${ai.actions.map((a) => `• ${a.replace(/^[-•]\s*/, "")}`).join("\n")}`
      : null;

  // Slack blocks
  const blocks = [
    { type: "header", text: { type: "plain_text", text: headerText } },
    { type: "section", text: { type: "mrkdwn", text: `${worstLine}\n${kpiText}` } },

    { type: "section", text: { type: "mrkdwn", text: `*Top Mobile Problems*\n${topMobileLines.join("\n")}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Top Desktop Problems*\n${topDesktopLines.join("\n")}` } },
  ];

  if (aiTldrBlock) blocks.push({ type: "section", text: { type: "mrkdwn", text: aiTldrBlock } });
  if (aiActionsBlock) blocks.push({ type: "section", text: { type: "mrkdwn", text: aiActionsBlock } });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "전체 URL 점수/표는 GitHub Actions Job Summary에서 확인 (Slack에는 문제 Top만 표시).",
      },
    ],
  });

  const payload = {
    text: `${headerText}\n${worstLine}\nProblems(P<${warnCut}): ${problems.length}`,
    blocks,
  };

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✅ Slack payload written: ${OUT_PATH}`);
}

main();
