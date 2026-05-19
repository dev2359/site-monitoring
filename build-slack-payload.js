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

const TOP_N_PER_DEVICE = 3; // 출력 개수
const DEFAULT_THRESHOLDS = { warn: 0.8, crit: 0.6 }; // Perf 기준

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
 * Parse AI markdown produced by generate-ai-suggestions.js (new structured format).
 * Extracts:
 * - tldr: lines under "## TL;DR" (up to 3)
 * - topUrls: per-URL entries under "## Top URL Actions"
 *   each: { device, url, perf, metric, actions: [...] }
 *
 * Falls back gracefully when sections are missing (e.g., fallback markdown).
 */
function parseAiMarkdown(md) {
  if (!md) {
    return { tldr: [], topUrls: [], rawSnippet: null };
  }

  const lines = md.split(/\r?\n/);

  const tldrStart = lines.findIndex((l) => /^##\s*TL;DR/i.test(l.trim()));
  const tldr = [];
  if (tldrStart !== -1) {
    for (let i = tldrStart + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^##\s+/.test(t)) break;
      const bullet = t.match(/^[-*•]\s+(.+)$/);
      if (bullet) tldr.push(bullet[1].trim());
      if (tldr.length >= 3) break;
    }
  }

  const topUrls = [];
  const topUrlStart = lines.findIndex((l) => /^##\s*Top URL Actions/i.test(l.trim()));
  if (topUrlStart !== -1) {
    let current = null;
    let inActions = false;

    const pushCurrent = () => {
      if (current) topUrls.push(current);
    };

    for (let i = topUrlStart + 1; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      if (/^##\s+/.test(t)) {
        pushCurrent();
        current = null;
        break;
      }

      const h3 = t.match(/^###\s*\[?(\w+)\]?\s+(\S.+?)\s*\(\s*Perf\s*(\d+)\s*\)/i);
      if (h3) {
        pushCurrent();
        const devRaw = h3[1].toLowerCase();
        current = {
          device: devRaw.startsWith("m") ? "mobile" : "desktop",
          url: h3[2].trim().replace(/^[<\[]|[>\]]$/g, ""),
          perf: parseInt(h3[3], 10),
          metric: "",
          actions: [],
        };
        inActions = false;
        continue;
      }
      if (!current) continue;

      const stripped = t.replace(/\*\*/g, "");

      if (/^[-*•]?\s*메트릭\s*:/i.test(stripped) || /^[-*•]?\s*Metric\s*:/i.test(stripped)) {
        const m = stripped.match(/(?:메트릭|Metric)\s*:\s*(.+)$/i);
        if (m) current.metric = m[1].trim();
        inActions = false;
        continue;
      }
      if (/^[-*•]?\s*액션\s*:?\s*$/i.test(stripped) || /^[-*•]?\s*Actions?\s*:?\s*$/i.test(stripped)) {
        inActions = true;
        continue;
      }

      if (inActions) {
        const bullet = raw.match(/^\s*[-*•]\s+(.+)$/);
        if (bullet) current.actions.push(bullet[1].trim().replace(/\*\*/g, ""));
      }
    }
    pushCurrent();
  }

  const rawSnippet =
    tldr.length === 0 && topUrls.length === 0
      ? lines.filter((l) => l.trim()).slice(0, 10).join("\n")
      : null;

  return { tldr, topUrls, rawSnippet };
}

function shortenUrl(u) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.length > 1 ? x.pathname : ""}${x.search ? "?…" : ""}`;
  } catch {
    return u;
  }
}

function buildProblemLines(problems, warn01, crit01, limit) {
  const sorted = problems
    .slice()
    .sort((a, b) => (a.performance ?? 1) - (b.performance ?? 1))
    .slice(0, limit);

  return sorted.map((p) => {
    const perf = toPct(p.performance);
    const a11y = toPct(p.accessibility);
    const bp = toPct(p.bestPractices);
    const seo = toPct(p.seo);
    
    const m = p.metrics || {};    
    const lcp = m.lcp ? `${Math.round(m.lcp)}ms` : "N/A";
    const cls = typeof m.cls === "number" ? safeFixed(m.cls, 3) : "N/A";
    const icon = lineEmojiFromPerf(p.performance, warn01, crit01);
    
    const u = new URL(p.url);
    const short = `${u.host}${u.pathname}${u.search ? "…" : ""}`;
    
    return `• [${deviceTag(p.device)}] <${p.url}|${short}>
    \`P ${perf} | A ${a11y} | BP ${bp} | SEO ${seo}\``; // | LCP ${lcp} | CLS ${cls} 너무 길어져서 뺌
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

  const derivedStatus =
    summary?.overall?.status && summary.overall.status !== "UNKNOWN"
      ? summary.overall.status
      : statusFromPerf(worst?.performance, warn01, crit01);

  const headerEmoji = statusEmoji(derivedStatus);
  const headerText = `${headerEmoji} ${derivedStatus} (${date}) `;

  const itemsMobile = items.filter((p) => p.device === "mobile");
  const itemsDesktop = items.filter((p) => p.device === "desktop");
  const problemsMobile = problems.filter((p) => p.device === "mobile");
  const problemsDesktop = problems.filter((p) => p.device === "desktop");

  const cAll = countByStatus(items, warn01, crit01);
  const cM = countByStatus(itemsMobile, warn01, crit01);
  const cD = countByStatus(itemsDesktop, warn01, crit01);

  const validReports = summary?.overall?.validReports ?? items.length;
  const invalidReports = summary?.invalid?.length ?? 0;

  const worstLine = worst
    ? `*Worst:* *[${deviceTag(worst.device)}]* P:${toPct(worst.performance)} | ${worst.url}`
    : `*Worst:* N/A _(valid: ${validReports}, invalid: ${invalidReports})_`;

  const kpiText =
    `*All:* 🚨 ${cAll.crit}  ⚠️ ${cAll.warn}  ✅ ${cAll.ok}  ℹ️ ${cAll.unknown}\n`;

  const topMobileLines =
    problemsMobile.length > 0
      ? buildProblemLines(problemsMobile, warn01, crit01, TOP_N_PER_DEVICE)
      : ["✅ (No mobile problems)"];

  const topDesktopLines =
    problemsDesktop.length > 0
      ? buildProblemLines(problemsDesktop, warn01, crit01, TOP_N_PER_DEVICE)
      : ["✅ (No desktop problems)"];

  const aiTldrBlock =
    ai.tldr.length > 0
      ? `*🧠 AI TL;DR*\n${ai.tldr.map((l) => `• ${l.replace(/^[-•]\s*/, "")}`).join("\n")}`
      : ai.rawSnippet
      ? `*AI Note*\n\`\`\`\n${ai.rawSnippet}\n\`\`\``
      : null;

  // Top URL Actions: AI 가 생성한 URL 별 진단 중 상위 3 개. 각 URL 의 액션 2 개씩 표시.
  const TOP_URL_LIMIT = 3;
  const ACTIONS_PER_URL = 2;
  const topUrlsBlock =
    ai.topUrls.length > 0
      ? `*🎯 Top URL Actions*\n${ai.topUrls
          .slice(0, TOP_URL_LIMIT)
          .map((u) => {
            const tag = deviceTag(u.device);
            const short = shortenUrl(u.url);
            const acts = u.actions
              .slice(0, ACTIONS_PER_URL)
              .map((a) => `   • ${a}`)
              .join("\n");
            const head = `*[${tag}] <${u.url}|${short}>* \`P:${u.perf}\``;
            return acts ? `${head}\n${acts}` : head;
          })
          .join("\n\n")}`
      : null;

  // Slack blocks
  const blocks = [
    { type: "header", text: { type: "plain_text", text: headerText } },

    { type: "section", text: { type: "mrkdwn", text: `*📱 Top Mobile Problems*\n${topMobileLines.join("\n")}` } },
    { type: "section", text: { type: "mrkdwn", text: `*🖥️ Top Desktop Problems*\n${topDesktopLines.join("\n")}` } },
  ];

  if (aiTldrBlock) blocks.push({ type: "section", text: { type: "mrkdwn", text: aiTldrBlock } });
  if (topUrlsBlock) blocks.push({ type: "section", text: { type: "mrkdwn", text: topUrlsBlock } });

  const runUrl = process.env.GITHUB_RUN_URL;
  
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: runUrl
          ? `<${runUrl}|📊 전체 URL 점수(표) 보러가기>`
          : "📊 전체 URL 점수(표) 보러가기",
      },
    ],
  });
  
  const payload = {
    text: `${headerText}\n${worstLine}\nProblems(P<${warnCut}): ${problems.length}`,
    blocks,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✅ Slack payload written: ${OUT_PATH}`);
}

main();
