/**
 * build-slack-payload.js
 * - input: results/summary.json, results/ai-input.json (slackTargets 정답지), results/ai-suggestions.md (optional)
 * - output: results/slack-payload.json
 *
 * Node 18 compatible, no extra deps.
 */

const fs = require("fs");
const path = require("path");

const SUMMARY_PATH = path.join("results", "summary.json");
const AI_INPUT_PATH = path.join("results", "ai-input.json");
const AI_MD_PATH = path.join("results", "ai-suggestions.md");
const WOW_CSV_PATH = path.join("results", "compare-wow.csv");
const OWNERS_PATH = "owners.json";
const OUT_PATH = path.join("results", "slack-payload.json");

const TOP_N_PER_DEVICE = 3; // 출력 개수
const DEFAULT_THRESHOLDS = { warn: 0.8, crit: 0.6 }; // Perf 기준
const REGRESSION_DELTA = -10; // WoW 회귀 기준
const IMPROVEMENT_DELTA = 10; // WoW 개선 기준

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

// WoW CSV 의 perf_delta 컬럼을 스캔해 회귀(<=-10) / 개선(>=+10) 개수를 센다.
function readWowCounts(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf-8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { regressions: 0, improvements: 0 };

  const header = lines[0].split(",");
  const idx = header.indexOf("perf_delta");
  if (idx === -1) return { regressions: 0, improvements: 0 };

  let regressions = 0;
  let improvements = 0;
  for (let i = 1; i < lines.length; i++) {
    // 단순 split: trend 컬럼에 콤마가 없는 unicode bar 라 안전.
    const cols = lines[i].split(",");
    const raw = (cols[idx] || "").trim();
    if (!raw) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (v <= REGRESSION_DELTA) regressions++;
    else if (v >= IMPROVEMENT_DELTA) improvements++;
  }
  return { regressions, improvements };
}

// Slack 멘션 토큰 (U... 개인 / S... 사용자 그룹).
function formatMention(id) {
  if (typeof id !== "string") return "";
  if (id.startsWith("S")) return `<!subteam^${id}>`;
  if (id.startsWith("U") || id.startsWith("W")) return `<@${id}>`;
  return id;
}

function readOwners(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(`⚠️ owners.json 파싱 실패:`, e?.message || e);
    return null;
  }
}

// 이번 회차 problems 의 host 집합 → owners.json 매핑으로 멘션 라인 생성.
// 매핑 없는 host 는 _default 백업으로 묶음.
function buildOwnerLines(problems, owners) {
  if (!owners) return [];

  const hosts = new Set();
  for (const p of problems || []) {
    try {
      hosts.add(new URL(p.url).host);
    } catch {}
  }
  if (hosts.size === 0) return [];

  // 멘션 집합이 같은 host 들은 한 줄로 묶어 시각적 노이즈를 줄임.
  const byMention = new Map();
  const fallbackKey = "__default__";
  for (const host of [...hosts].sort()) {
    let ids = owners[host];
    let usedFallback = false;
    if (!ids || ids.length === 0) {
      ids = owners._default;
      usedFallback = true;
    }
    if (!ids || ids.length === 0) continue;

    const key = usedFallback ? fallbackKey : ids.slice().sort().join("|");
    if (!byMention.has(key)) byMention.set(key, { ids, hosts: [], fallback: usedFallback });
    byMention.get(key).hosts.push(host);
  }

  return [...byMention.values()].map(({ ids, hosts, fallback }) => {
    const mentions = ids.map(formatMention).filter(Boolean).join(" ");
    const tag = fallback ? " _(default)_" : "";
    return `• ${hosts.join(", ")}${tag} — ${mentions}`;
  });
}

// AI 가 프롬프트의 "이 6개 URL 만 다뤄라" 지시를 무시하고 다른 URL 을 끼워넣는 경우가 있어,
// ai-input.json 의 slackTargets 를 *정답지* 로 두고 AI 응답을 정합화한다.
// - slackTargets URL 과 매칭되는 AI entry 만 통과 (AI 의 actions 그대로 사용)
// - slackTargets 에 있지만 AI 가 빠뜨린 URL 은 metric-only placeholder 로 채움
// - slackTargets 자체가 없는 경우(레거시 ai-input) → AI 출력 그대로 fallback
function reconcileTopUrls(slackTargets, aiTopUrls) {
  if (!Array.isArray(slackTargets) || slackTargets.length === 0) {
    return (aiTopUrls || []).map((u) => ({ ...u, _matched: true }));
  }

  const normUrl = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
  // 동일 URL 이 mobile/desktop 양쪽에 있을 수 있어 (device, url) 복합키로 인덱싱.
  const key = (device, url) => `${device}|${normUrl(url)}`;
  const byKey = new Map();
  for (const t of aiTopUrls || []) byKey.set(key(t.device, t.url), t);

  return slackTargets.map((st) => {
    const matched = byKey.get(key(st.device, st.url));
    if (matched) {
      return { ...matched, _matched: true };
    }
    const m = st.metrics || {};
    const lcp = m.lcp ? `${Math.round(m.lcp)}ms` : "?";
    const cls = typeof m.cls === "number" ? m.cls.toFixed(3) : "?";
    const tbt = m.tbt ? `${Math.round(m.tbt)}ms` : "?";
    return {
      device: st.device,
      url: st.url,
      perf: typeof st.performance === "number" ? Math.round(st.performance * 100) : null,
      metric: `LCP ${lcp}, CLS ${cls}, TBT ${tbt}`,
      actions: [],
      _matched: false,
    };
  });
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

  // (topUrlEntriesForSlack 는 위 owner 멘션 블록 직전에 이미 계산됨 — 그대로 사용)

  // WoW 카운트 (compare-wow.csv 가 있을 때만)
  const wow = readWowCounts(WOW_CSV_PATH);
  const wowLine = wow
    ? `회귀 ${wow.regressions}건 / 개선 ${wow.improvements}건 _(perf Δ ±${IMPROVEMENT_DELTA} 기준)_`
    : null;

  // Top URL Actions 노출 URL — Slack 표시 한도 6 개 (Mobile 3 + Desktop 3 매칭).
  // 단일 큰 블록은 Slack 의 message-level "자세히 보기" 토글을 유발할 수 있어 URL 1 개당 별도 섹션으로 분할.
  const TOP_URL_LIMIT = 6;
  const ACTIONS_PER_URL = 3; // 6 개 URL 모두 상세 노출 — 각 URL 당 액션 3 개까지

  // ai-input.json 의 slackTargets 를 정답지로 두고 AI 응답을 정합화 (AI hallucination 방어).
  let slackTargets = [];
  if (fs.existsSync(AI_INPUT_PATH)) {
    try {
      const aiInput = readJson(AI_INPUT_PATH);
      slackTargets = Array.isArray(aiInput.slackTargets) ? aiInput.slackTargets : [];
    } catch (e) {
      console.warn(`⚠️ ai-input.json 파싱 실패:`, e?.message || e);
    }
  }
  const topUrlEntriesForSlack = reconcileTopUrls(slackTargets, ai.topUrls).slice(0, TOP_URL_LIMIT);
  const missingFromAi = topUrlEntriesForSlack.filter((u) => !u._matched).length;

  // Owner 멘션 라인 — Top URL Actions 에 노출되는 6 개 URL 의 host 만 대상으로.
  // (AI 응답이 비어있으면 fallback 으로 Slack 표시되는 Top Mobile/Desktop Problems 의 host 사용)
  const owners = readOwners(OWNERS_PATH);
  const ownerSource =
    topUrlEntriesForSlack.length > 0
      ? topUrlEntriesForSlack.map((u) => ({ url: u.url }))
      : [...problemsMobile.slice(0, TOP_N_PER_DEVICE), ...problemsDesktop.slice(0, TOP_N_PER_DEVICE)];
  const ownerLines = buildOwnerLines(ownerSource, owners);

  const runUrl = process.env.GITHUB_RUN_URL;
  const dashboardCtx = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: runUrl
          ? `<${runUrl}|📊 전체 URL 점수(표) 보러가기>`
          : "📊 전체 URL 점수(표) 보러가기",
      },
    ],
  };

  // ===== MAIN (채널 노출, 컴팩트) =====
  const mainBlocks = [
    { type: "header", text: { type: "plain_text", text: headerText } },
  ];
  if (wowLine) {
    mainBlocks.push({ type: "section", text: { type: "mrkdwn", text: wowLine } });
  }
  mainBlocks.push(dashboardCtx);

  const mainText = wow
    ? `${headerText} | WoW 회귀 ${wow.regressions} / 개선 ${wow.improvements}`
    : `${headerText}`;

  // ===== THREAD (펼침, 상세 전부) =====
  // 각 섹션을 헤더 + 항목별 별도 블록으로 분할 → message-level "자세히 보기" 토글 회피.
  const threadBlocks = [];

  threadBlocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*📱 Top Mobile Problems*" },
  });
  for (const line of topMobileLines) {
    threadBlocks.push({ type: "section", text: { type: "mrkdwn", text: line } });
  }

  threadBlocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*🖥️ Top Desktop Problems*" },
  });
  for (const line of topDesktopLines) {
    threadBlocks.push({ type: "section", text: { type: "mrkdwn", text: line } });
  }
  if (aiTldrBlock) {
    threadBlocks.push({ type: "section", text: { type: "mrkdwn", text: aiTldrBlock } });
  }

  // Top URL Actions — 헤더 한 줄 + URL 1 개당 별도 section 블록.
  // Slack 의 message-level "자세히 보기" 토글 회피 + 시각적으로 분리되어 가독성 향상.
  if (topUrlEntriesForSlack.length > 0) {
    threadBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🎯 Top URL Actions*" },
    });
    for (const u of topUrlEntriesForSlack) {
      const tag = deviceTag(u.device);
      const short = shortenUrl(u.url);
      const head = `*[${tag}] <${u.url}|${short}>* \`P:${u.perf}\``;
      let blockText;
      if (u._matched && Array.isArray(u.actions) && u.actions.length > 0) {
        const acts = u.actions
          .slice(0, ACTIONS_PER_URL)
          .map((a) => `   • ${a}`)
          .join("\n");
        blockText = `${head}\n${acts}`;
      } else {
        // AI 가 이 URL 을 빠뜨림 — metric 만 표시 + 다음 실행 재시도 안내.
        const metricLine = u.metric ? `   _${u.metric}_\n` : "";
        blockText = `${head}\n${metricLine}   _⚠️ AI 응답에서 누락 — 다음 실행에서 자동 재시도_`;
      }
      threadBlocks.push({
        type: "section",
        text: { type: "mrkdwn", text: blockText },
      });
    }
  }

  if (ownerLines.length > 0) {
    threadBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*👥 담당자*\n${ownerLines.join("\n")}` },
    });
  }

  const threadText = `Lighthouse 상세 (${date}) - Problems(P<${warnCut}): ${problems.length}`;

  const payload = {
    main: {
      text: mainText,
      blocks: mainBlocks,
    },
    thread: {
      text: threadText,
      blocks: threadBlocks,
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✅ Slack payload written: ${OUT_PATH}`);
  console.log(`   main blocks: ${mainBlocks.length}, thread blocks: ${threadBlocks.length}`);
  if (wow) console.log(`   WoW: regressions=${wow.regressions}, improvements=${wow.improvements}`);
  if (ownerLines.length) console.log(`   Owner mention lines: ${ownerLines.length}`);
  console.log(
    `   Top URL Actions: ${topUrlEntriesForSlack.length} (slackTargets=${slackTargets.length}, AI 누락=${missingFromAi})`
  );
  if (missingFromAi > 0) {
    console.warn(`⚠️ AI 가 slackTargets URL ${missingFromAi}개를 빠뜨림 → metric-only placeholder 로 채움`);
  }
}

main();
