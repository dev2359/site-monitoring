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

/**
 * Parse AI markdown to extract:
 * - TL;DR: lines under "## TL;DR"
 * - actions: top 3 items under "## Recommended actions" or "## Recommended actions (Top 5)"
 *
 * This is a tolerant parser: if sections are missing, it falls back gracefully.
 */
function parseAiMarkdown(md) {
  if (!md) {
    return {
      tldr: [],
      actions: [],
      rawSnippet: null,
    };
  }

  const lines = md.split(/\r?\n/);

  function extractSection(headerRegex) {
    // Find a line that matches headerRegex (e.g., /^##\s*TL;DR/i)
    const startIdx = lines.findIndex((l) => headerRegex.test(l.trim()));
    if (startIdx === -1) return [];

    // Collect until next header "## " or "# "
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
    .filter(Boolean);

  // Actions: accept multiple header variants
  let actionLines = extractSection(/^##\s*Recommended actions/i);
  if (actionLines.length === 0) {
    actionLines = extractSection(/^##\s*Recommendations/i);
  }

  // Normalize actions from numbered lists / bullets
  const actions = actionLines
    .map((l) => l.replace(/^\d+\)\s*/, "").replace(/^\d+\.\s*/, "").replace(/^[-•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  // In case tldr/actions both empty, take a small snippet
  const rawSnippet =
    tldrLines.length === 0 && actions.length === 0
      ? lines.filter((l) => l.trim()).slice(0, 10).join("\n")
      : null;

  return { tldr: tldrLines.slice(0, 3), actions, rawSnippet };
}

function statusEmoji(status) {
  if (status === "CRIT") return "🚨";
  if (status === "WARN") return "⚠️";
  if (status === "OK") return "✅";
  return "ℹ️";
}

function buildProblemLines(problems) {
  // top 5 problem urls
  return problems.slice(0, 5).map((p) => {
    const perf = toPct(p.performance);
    const lcp = p.metrics?.lcp ? `${Math.round(p.metrics.lcp)}ms` : "N/A";
    const cls = typeof p.metrics?.cls === "number" ? p.metrics.cls.toFixed(3) : "N/A";
    return `• *[${p.device}]* *${perf}* - ${p.url} (LCP ${lcp}, CLS ${cls})`;
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

  const date = new Date().toISOString().slice(0, 10);
  const status = summary?.overall?.status || "UNKNOWN";
  const emoji = statusEmoji(status);

  const problems = Array.isArray(summary.problems) ? summary.problems : [];
  const worst = summary?.overall?.worst;

  const problemLines = problems.length ? buildProblemLines(problems) : ["• (No problem URLs)"];

  // Compose AI blocks
  const aiTldrBlock =
    ai.tldr.length > 0
      ? `*AI TL;DR*\n${ai.tldr.map((l) => `• ${l}`).join("\n")}`
      : ai.rawSnippet
      ? `*AI Note*\n\`\`\`\n${ai.rawSnippet}\n\`\`\``
      : null;

  const aiActionsBlock =
    ai.actions.length > 0 ? `*Recommended actions (Top 3)*\n${ai.actions.map((a) => `• ${a}`).join("\n")}` : null;

  const worstLine = worst
    ? `*Worst:* *[${worst.device}]* *${toPct(worst.performance)}* - ${worst.url}`
    : "*Worst:* N/A";

  const headerText = `${emoji} Daily Lighthouse (${date}) - ${status}`;
  const totalProblems = `*Problem URLs (<${Math.round((summary.thresholds?.warn ?? 0.8) * 100)}):* ${problems.length}`;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: headerText } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${worstLine}\n${totalProblems}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Top problem URLs*\n${problemLines.join("\n")}`,
      },
    },
  ];

  if (aiTldrBlock) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: aiTldrBlock } });
  }
  if (aiActionsBlock) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: aiActionsBlock } });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Details: GitHub Actions Job Summary + uploaded artifacts" }],
  });

  const payload = {
    text: `${headerText}\n${worstLine}\n${totalProblems}`,
    blocks,
  };

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✅ Slack payload written: ${OUT_PATH}`);
}

main();
