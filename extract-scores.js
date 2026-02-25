const fs = require("fs");
const path = require("path");

// ====== 설정(원하면 env로 뺄 수 있음) ======
const THRESHOLDS = {
  warn: 0.7, // 80점 미만이면 WARN
  crit: 0.6, // 70점 미만이면 CRIT
};

const RESULT_DIRS = [
  { dir: "results/desktop", device: "desktop" },
  { dir: "results/mobile", device: "mobile" },
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isManifestJson(data) {
  return Array.isArray(data) && data.length > 0 && data[0]?.url && data[0]?.summary;
}

function safeJoinCwd(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function extractFromManifestEntry(entry, device) {
  // 1) 점수는 manifest summary에서 우선 채우고
  const perf = entry.summary?.performance;
  const acc = entry.summary?.accessibility;
  const bp = entry.summary?.["best-practices"] ?? entry.summary?.bestPractices;
  const seo = entry.summary?.seo;

  // 2) metrics(LCP/CLS 등)는 report jsonPath를 열어서 audits에서 채움
  let metrics = {};
  const reportPath = safeJoinCwd(entry.jsonPath);
  const reportJson = reportPath ? readJsonSafe(reportPath) : null;

  if (reportJson?.categories || reportJson?.lhr?.categories) {
    const extracted = extractOneReport(reportJson);
    metrics = extracted.metrics || {};
  } else {
    metrics = {};
  }

  return {
    device,
    file: entry.jsonPath || "(manifest)",
    ok: true,
    url: entry.url,
    performance: perf,
    accessibility: acc,
    bestPractices: bp,
    seo,
    metrics,
  };
}

function extractFromManifest(manifestArray, device, file) {
  const reps = manifestArray.filter((x) => x.isRepresentativeRun);
  const rows = (reps.length ? reps : manifestArray).map((x) => ({
    device,
    file,
    ok: true,
    url: x.url,
    performance: x.summary?.performance,
    accessibility: x.summary?.accessibility,
    bestPractices: x.summary?.["best-practices"] ?? x.summary?.bestPractices,
    seo: x.summary?.seo,
    metrics: {},
  }));

  const seen = new Set();
  return rows.filter((r) => {
    if (!r.url) return false;
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function toPct(score) {
  if (typeof score !== "number") return null;
  return Math.round(score * 100);
}

function statusFromPerf(perfScore01) {
  if (typeof perfScore01 !== "number") return "UNKNOWN";
  if (perfScore01 < THRESHOLDS.crit) return "CRIT";
  if (perfScore01 < THRESHOLDS.warn) return "WARN";
  return "OK";
}

function get(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function pickNumber(obj, candidates) {
  for (const pathArr of candidates) {
    const v = get(obj, pathArr);
    if (typeof v === "number") return v;
  }
  return undefined;
}

function extractOneReport(reportJson) {
  // ✅ report가 { lhr: {...} }로 감싸진 케이스 대응
  const root = reportJson?.lhr?.categories ? reportJson.lhr : reportJson;

  const c = root.categories || {};
  const audits = root.audits || {};

  const performance = c.performance?.score;
  const accessibility = c.accessibility?.score;
  const bestPractices = c["best-practices"]?.score;
  const seo = c.seo?.score;

  // ✅ LCP/CLS는 케이스별 위치가 달라서 fallback 포함
  const lcp = pickNumber(audits, [
    ["largest-contentful-paint", "numericValue"],                 // 일반 audit
    ["metrics", "details", "items", 0, "largestContentfulPaint"], // metrics item
  ]);

  const cls = pickNumber(audits, [
    ["cumulative-layout-shift", "numericValue"],                  // 일반 audit
    ["metrics", "details", "items", 0, "cumulativeLayoutShift"],  // metrics item
  ]);

  const tbt = pickNumber(audits, [
    ["total-blocking-time", "numericValue"],
    ["metrics", "details", "items", 0, "totalBlockingTime"],
  ]);

  const si = pickNumber(audits, [
    ["speed-index", "numericValue"],
    ["metrics", "details", "items", 0, "speedIndex"],
  ]);

  return {
    finalUrl: root.finalUrl || root.requestedUrl || "(unknown)",
    scores: { performance, accessibility, bestPractices, seo },
    metrics: { lcp, cls, tbt, si },
    runtimeError: root.runtimeError || null,
  };
}

function loadReports({ dir, device }) {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const data = readJsonSafe(fullPath);
    if (!data) continue;

    if (isManifestJson(data)) {
      const reps = data.filter((x) => x.isRepresentativeRun);
      const rows = (reps.length ? reps : data).map((entry) => extractFromManifestEntry(entry, device));

      // URL 중복 제거(대표 run 기준이면 보통 없지만 안전하게)
      const seen = new Set();
      for (const r of rows) {
        if (!r.url) continue;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        items.push(r);
      }
      continue;
    }

    if (!data.categories) {
      items.push({
        device,
        file,
        ok: false,
        url: data.finalUrl || data.requestedUrl || "(unknown)",
        runtimeError: data.runtimeError || { message: "Invalid report (no categories)" },
      });
      continue;
    }

    const extracted = extractOneReport(data);
    items.push({
      device,
      file,
      ok: true,
      url: extracted.finalUrl,
      performance: extracted.scores.performance,
      accessibility: extracted.scores.accessibility,
      bestPractices: extracted.scores.bestPractices,
      seo: extracted.scores.seo,
      metrics: extracted.metrics,
    });
  }

  items.sort((a, b) => (a.url || "").localeCompare(b.url || ""));
  return items;
}

function buildSummary(allItems) {
  const okItems = allItems.filter((x) => x.ok && typeof x.performance === "number");

  const worst = okItems.reduce(
    (acc, cur) => (cur.performance < acc.performance ? cur : acc),
    okItems[0] || null
  );

  const overallStatus = worst ? statusFromPerf(worst.performance) : "UNKNOWN";

  const problems = okItems
    .filter((x) => statusFromPerf(x.performance) !== "OK")
    .sort((a, b) => a.performance - b.performance);

  return {
    generatedAt: new Date().toISOString(),
    thresholds: THRESHOLDS,
    overall: {
      status: overallStatus,
      worst: worst
        ? {
            device: worst.device,
            url: worst.url,
            performance: worst.performance,
          }
        : null,
      totalReports: allItems.length,
      validReports: okItems.length,
    },
    problems: problems.map((p) => ({
      device: p.device,
      url: p.url,
      performance: p.performance,
      accessibility: p.accessibility,
      bestPractices: p.bestPractices,
      seo: p.seo,
      metrics: p.metrics,
    })),
    
    items: okItems.map((x) => ({
      device: x.device,
      url: x.url,
      performance: x.performance,
      accessibility: x.accessibility,
      bestPractices: x.bestPractices,
      seo: x.seo,
      metrics: x.metrics,
    })),
    invalid: allItems.filter((x) => !x.ok).map((x) => ({
      device: x.device,
      file: x.file,
      url: x.url,
      runtimeError: x.runtimeError,
    })),
  };
}

function buildSummaryMarkdown(summary) {
  const { overall, items, problems, invalid } = summary;

  const header = `# 📊 Lighthouse Daily Summary

- **Status:** ${overall.status}
- **Total reports:** ${overall.totalReports} (valid: ${overall.validReports})
- **Thresholds:** WARN < ${Math.round(THRESHOLDS.warn * 100)}, CRIT < ${Math.round(
    THRESHOLDS.crit * 100
  )}

`;

  const worstLine = overall.worst
    ? `## 🔻 Worst
- **${overall.worst.device}** ${overall.worst.url}
- Performance: **${toPct(overall.worst.performance)}**
`
    : `## 🔻 Worst
- No valid reports
`;

  const problemSection = problems.length
    ? `## 🚨 Problem URLs (Performance < ${Math.round(THRESHOLDS.warn * 100)})
| Device | URL | Perf | A11y | BP | SEO | LCP(ms) | CLS | TBT(ms) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${problems
  .slice(0, 15)
  .map((p) => {
    const m = p.metrics || {};
    return `| ${p.device} | ${p.url} | ${toPct(p.performance)} | ${toPct(
      p.accessibility
    ) ?? "N/A"} | ${toPct(p.bestPractices) ?? "N/A"} | ${toPct(p.seo) ?? "N/A"} | ${
      m.lcp ? Math.round(m.lcp) : "N/A"
    } | ${typeof m.cls === "number" ? m.cls.toFixed(3) : "N/A"} | ${
      m.tbt ? Math.round(m.tbt) : "N/A"
    } |`;
  })
  .join("\n")}
`
    : `## ✅ Problem URLs
- None 🎉
`;

  const tableAll = `## 📋 All URLs (top 30 by URL)
| Device | URL | Perf |
|---|---|---:|
${items
  .slice(0, 30)
  .map((x) => `| ${x.device} | ${x.url} | ${toPct(x.performance)} |`)
  .join("\n")}
`;

  const invalidSection = invalid.length
    ? `## ⚠️ Invalid reports
${invalid
  .slice(0, 10)
  .map((x) => `- ${x.device} ${x.url} (${x.runtimeError?.message || "unknown error"})`)
  .join("\n")}
`
    : "";

  return header + worstLine + "\n" + problemSection + "\n" + tableAll + "\n" + invalidSection;
}

function buildSlackPayload(summary) {
  const { overall, problems } = summary;

  const title = `Daily Lighthouse (${new Date().toISOString().slice(0, 10)}) - ${overall.status}`;
  const emoji = overall.status === "CRIT" ? "🚨" : overall.status === "WARN" ? "⚠️" : "✅";

  const topProblems = problems.slice(0, 5);

  const problemLines = topProblems.length
    ? topProblems
        .map((p) => {
          const perf = toPct(p.performance);
          const m = p.metrics || {};
          const lcp = m.lcp ? `${Math.round(m.lcp)}ms` : "N/A";
          const cls = typeof m.cls === "number" ? m.cls.toFixed(3) : "N/A";
          return `• [${p.device}] ${perf} - ${p.url} (LCP ${lcp}, CLS ${cls})`;
        })
        .join("\n")
    : "• (no problem urls)";

  return {
    text: `${emoji} ${title}\n${problemLines}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${emoji} ${title}` } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Worst:* ${overall.worst ? `${overall.worst.device} ${toPct(overall.worst.performance)} - ${overall.worst.url}` : "N/A"}\n` +
            `*Problem URLs (<${Math.round(THRESHOLDS.warn * 100)}):* ${problems.length}`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: `*Top issues*\n${problemLines}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Actions Job Summary에서 상세 표를 확인하세요." }] },
    ],
  };
}

function buildAiInput(summary) {
  // AI에는 “문제 URL만” 주는 게 효율 좋음
  return {
    thresholds: summary.thresholds,
    overall: summary.overall,
    problems: summary.problems.slice(0, 10),
  };
}

function main() {
  ensureDir("results");

  const allItems = RESULT_DIRS.flatMap(loadReports);
  const summary = buildSummary(allItems);

  // 파일 생성
  fs.writeFileSync("results/summary.json", JSON.stringify(summary, null, 2), "utf-8");
  fs.writeFileSync("results/summary.md", buildSummaryMarkdown(summary), "utf-8");
  fs.writeFileSync("results/slack-payload.json", JSON.stringify(buildSlackPayload(summary), null, 2), "utf-8");
  fs.writeFileSync("results/ai-input.json", JSON.stringify(buildAiInput(summary), null, 2), "utf-8");

  // 콘솔에도 간단히
  console.log(`\n📌 Overall status: ${summary.overall.status}`);
  if (summary.overall.worst) {
    console.log(
      `   Worst: [${summary.overall.worst.device}] ${toPct(summary.overall.worst.performance)} - ${summary.overall.worst.url}`
    );
  }
  console.log(`   Problems: ${summary.problems.length}`);
}

main();
