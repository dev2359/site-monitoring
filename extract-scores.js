const fs = require("fs");
const path = require("path");

const THRESHOLDS = {
  warn: 0.8, // 80점 미만이면 WARN
  crit: 0.6, // 60점 미만이면 CRIT
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
  const perf = entry.summary?.performance;
  const acc = entry.summary?.accessibility;
  const bp = entry.summary?.["best-practices"] ?? entry.summary?.bestPractices;
  const seo = entry.summary?.seo;

  let metrics = {};
  let runtimeError = null;
  const reportPath = safeJoinCwd(entry.jsonPath);
  const reportJson = reportPath ? readJsonSafe(reportPath) : null;

  if (reportJson?.categories || reportJson?.lhr?.categories) {
    const extracted = extractOneReport(reportJson);
    metrics = extracted.metrics || {};
    runtimeError = extracted.runtimeError || null;
  } else {
    metrics = {};
    runtimeError = reportJson?.runtimeError || null;
  }

  const hasPerf = typeof perf === "number" && Number.isFinite(perf);
  const inferredRuntimeError =
    runtimeError ||
    (hasPerf ? null : { message: "Missing performance score in LHCI manifest entry" });
  
  return {
    device,
    file: entry.jsonPath || "(manifest)",
    ok: hasPerf && !inferredRuntimeError,
    url: entry.url,
    performance: perf,
    accessibility: acc,
    bestPractices: bp,
    seo,
    metrics,
    runtimeError: inferredRuntimeError,
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
  const root = reportJson?.lhr?.categories ? reportJson.lhr : reportJson;

  const c = root.categories || {};
  const audits = root.audits || {};

  const performance = c.performance?.score;
  const accessibility = c.accessibility?.score;
  const bestPractices = c["best-practices"]?.score;
  const seo = c.seo?.score;

  const lcp = pickNumber(audits, [
    ["largest-contentful-paint", "numericValue"],
    ["metrics", "details", "items", 0, "largestContentfulPaint"],
  ]);

  const cls = pickNumber(audits, [
    ["cumulative-layout-shift", "numericValue"],
    ["metrics", "details", "items", 0, "cumulativeLayoutShift"],
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
    // requestedUrl = 측정 요청 URL (redirect 전). finalUrl 은 redirect 후라
    // m.* 같은 다른 host 로 바뀔 수 있어 device(측정 환경) 와 어긋남 → requestedUrl 우선.
    requestedUrl: root.requestedUrl || null,
    finalUrl: root.finalUrl || root.requestedUrl || "(unknown)",
    scores: { performance, accessibility, bestPractices, seo },
    metrics: { lcp, cls, tbt, si },
    runtimeError: root.runtimeError || null,
  };
}

function trimmedMean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return undefined;
  // 4개 이상일 때만 상하 1개씩 제외 (runner outlier 완화). 3개 이하는 그대로 평균.
  if (nums.length <= 3) {
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  return trimmed.reduce((sum, n) => sum + n, 0) / trimmed.length;
}

function aggregateByDeviceUrl(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.device}@@${item.url}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  return [...grouped.values()].map((rows) => {
    const base = rows[0];
    return {
      ...base,
      performance: trimmedMean(rows.map((r) => r.performance)),
      accessibility: trimmedMean(rows.map((r) => r.accessibility)),
      bestPractices: trimmedMean(rows.map((r) => r.bestPractices)),
      seo: trimmedMean(rows.map((r) => r.seo)),
      metrics: {
        lcp: trimmedMean(rows.map((r) => r.metrics?.lcp)),
        cls: trimmedMean(rows.map((r) => r.metrics?.cls)),
        tbt: trimmedMean(rows.map((r) => r.metrics?.tbt)),
        si: trimmedMean(rows.map((r) => r.metrics?.si)),
      },
    };
  });
}

function loadReports({ dir, device }) {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items = [];

  // 1) manifest.json 이 있으면 그것을 단일 소스로 사용. 개별 report 파일까지 같이 읽으면
  //    동일 run을 두 번 카운트해 trimmedMean이 왜곡된다.
  let manifestSeen = false;
  for (const file of files) {
    const data = readJsonSafe(path.join(dir, file));
    if (!data || !isManifestJson(data)) continue;
    manifestSeen = true;
    for (const entry of data) {
      const r = extractFromManifestEntry(entry, device);
      if (!r.url) continue;
      items.push(r);
    }
  }

  // 2) manifest 가 없는 경우만 개별 report 파일을 fallback 으로 처리.
  if (!manifestSeen) {
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const data = readJsonSafe(fullPath);
      if (!data) continue;

      if (!data.categories && !data.lhr?.categories) {
        const root = data.lhr || data;
        items.push({
          device,
          file,
          ok: false,
          // requestedUrl 우선 — redirect 로 finalUrl 이 m.* 등 다른 host 가 돼도 device 와 일치 유지.
          url: root.requestedUrl || data.finalUrl || data.requestedUrl || "(unknown)",
          runtimeError: data.runtimeError || { message: "Invalid report (no categories)" },
        });
        continue;
      }

      const extracted = extractOneReport(data);
      items.push({
        device,
        file,
        ok: true,
        // requestedUrl 우선 (manifest 경로의 entry.url 과 일관). finalUrl 은 redirect 후라 device 와 어긋날 수 있음.
        url: extracted.requestedUrl || extracted.finalUrl,
        performance: extracted.scores.performance,
        accessibility: extracted.scores.accessibility,
        bestPractices: extracted.scores.bestPractices,
        seo: extracted.scores.seo,
        metrics: extracted.metrics,
      });
    }
  }

  items.sort((a, b) => (a.url || "").localeCompare(b.url || ""));
  return items;
}

// 모든 URL이 같은 metric 값을 갖는 경우(과거 reportFilenamePattern placeholder 오류 같은
// 집계 버그)를 조기에 감지하기 위한 sanity check.
function warnIfMetricsCollapsed(items) {
  for (const dev of ["desktop", "mobile"]) {
    const arr = items.filter((x) => x.device === dev);
    if (arr.length < 3) continue;
    const lcps = arr.map((x) => x.metrics?.lcp).filter((v) => typeof v === "number");
    if (lcps.length < 3) continue;
    const unique = new Set(lcps.map((v) => v.toFixed(4))).size;
    if (unique === 1) {
      console.warn(
        `⚠️ [${dev}] ${arr.length}개 URL이 모두 동일한 LCP(${lcps[0].toFixed(2)}ms)를 가집니다. ` +
          `LHCI reportFilenamePattern placeholder 또는 manifest jsonPath 확인 필요.`
      );
    }
  }
}

function buildSummary(allItems) {
  const okItemsRaw = allItems.filter((x) => x.ok && typeof x.performance === "number");
  const okItems = aggregateByDeviceUrl(okItemsRaw);
  const invalidItems = allItems.filter((x) => !x.ok || typeof x.performance !== "number");

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
      invalidReports: invalidItems.length,
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
    invalid: invalidItems.map((x) => ({
      device: x.device,
      file: x.file,
      url: x.url,
      runtimeError: x.runtimeError,
    })),
  };
}

function buildSummaryMarkdown(summary) {
  const overall = summary?.overall || {};
  const items = Array.isArray(summary?.items) ? summary.items : [];
  const problems = Array.isArray(summary?.problems) ? summary.problems : [];
  const invalid = Array.isArray(summary?.invalid) ? summary.invalid : [];

  const header = `# 📊 Lighthouse Daily Summary

- **Status:** ${overall.status}
- **Total reports:** ${overall.totalReports} (valid: ${overall.validReports})
- **Invalid reports:** ${overall.invalidReports ?? 0}
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
  const items = Array.isArray(summary.items) ? summary.items : [];

  const hostMap = new Map();
  for (const item of items) {
    let host;
    try {
      host = new URL(item.url).host;
    } catch {
      continue;
    }
    if (!hostMap.has(host)) hostMap.set(host, { mobile: [], desktop: [] });
    const bucket = hostMap.get(host)[item.device];
    if (bucket) bucket.push(item);
  }

  const mean = (a) => a.reduce((s, n) => s + n, 0) / a.length;
  const byHost = [];
  for (const [host, byDev] of hostMap.entries()) {
    const stat = { host };
    let worst = 1;
    for (const dev of ["mobile", "desktop"]) {
      const arr = byDev[dev];
      if (!arr.length) continue;
      const perfs = arr.map((x) => x.performance).filter((v) => typeof v === "number");
      const lcps = arr.map((x) => x.metrics?.lcp).filter((v) => typeof v === "number");
      const clss = arr.map((x) => x.metrics?.cls).filter((v) => typeof v === "number");
      const tbts = arr.map((x) => x.metrics?.tbt).filter((v) => typeof v === "number");
      stat[dev] = {
        urls: arr.length,
        perfAvg: perfs.length ? Math.round(mean(perfs) * 100) : null,
        perfMin: perfs.length ? Math.round(Math.min(...perfs) * 100) : null,
        lcpAvgMs: lcps.length ? Math.round(mean(lcps)) : null,
        clsAvg: clss.length ? Number(mean(clss).toFixed(3)) : null,
        tbtAvgMs: tbts.length ? Math.round(mean(tbts)) : null,
        problemCount: arr.filter((x) => statusFromPerf(x.performance) !== "OK").length,
      };
      if (perfs.length) worst = Math.min(worst, Math.min(...perfs));
    }
    stat._sort = worst;
    byHost.push(stat);
  }
  byHost.sort((a, b) => a._sort - b._sort);
  for (const h of byHost) delete h._sort;

  // Slack 메시지가 실제로 노출할 URL 셋(Top 3 Mobile + Top 3 Desktop, perf 오름차순) 을
  // AI 에 전달해 Top URL Actions 가 정확히 이 URL 들을 같은 순서로 다루도록 한다.
  const TOP_N_PER_DEVICE_FOR_SLACK = 3;
  const sortByPerfAsc = (arr) =>
    arr.slice().sort((a, b) => (a.performance ?? 1) - (b.performance ?? 1));
  const problemsList = Array.isArray(summary.problems) ? summary.problems : [];
  const slackTargets = [
    ...sortByPerfAsc(problemsList.filter((p) => p.device === "mobile")).slice(
      0,
      TOP_N_PER_DEVICE_FOR_SLACK
    ),
    ...sortByPerfAsc(problemsList.filter((p) => p.device === "desktop")).slice(
      0,
      TOP_N_PER_DEVICE_FOR_SLACK
    ),
  ].map((p) => ({
    device: p.device,
    url: p.url,
    performance: p.performance,
    metrics: p.metrics,
  }));

  return {
    generatedAt: summary.generatedAt,
    thresholds: summary.thresholds,
    overall: summary.overall,
    problems: summary.problems,
    byHost,
    slackTargets,
  };
}

// 외부에서 buildAiInput 만 재호출하고 싶을 때 사용 (예: regenerate-ai-input.js).
module.exports = { buildAiInput, buildSummary };

function main() {
  ensureDir("results");

  const allItems = RESULT_DIRS.flatMap(loadReports);
  const summary = buildSummary(allItems);

  warnIfMetricsCollapsed(summary.items || []);

  fs.writeFileSync("results/summary.json", JSON.stringify(summary, null, 2), "utf-8");
  fs.writeFileSync("results/summary.md", buildSummaryMarkdown(summary), "utf-8");
  fs.writeFileSync("results/slack-payload.json", JSON.stringify(buildSlackPayload(summary), null, 2), "utf-8");
  fs.writeFileSync("results/ai-input.json", JSON.stringify(buildAiInput(summary), null, 2), "utf-8");

  console.log(`\n📌 Overall status: ${summary.overall.status}`);
  if (summary.overall.worst) {
    console.log(
      `   Worst: [${summary.overall.worst.device}] ${toPct(summary.overall.worst.performance)} - ${summary.overall.worst.url}`
    );
  }
  console.log(`   Problems: ${summary.problems.length}`);
}

// require() 로 import 되면 main() 자동 실행 막기 (regenerate-ai-input.js 등이 모듈로 로드).
if (require.main === module) {
  main();
}
