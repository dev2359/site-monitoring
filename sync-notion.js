/**
 * sync-notion.js
 *
 * 매주 Lighthouse 실행 후 Notion 의 parent page 안에 *주간 sub-page* 를 생성하고,
 * 그 안에 ⚠️ Regressions 요약 + 📊 Full Table (inline database, 79 rows) 을 채운다.
 *
 * 환경변수:
 *   NOTION_TOKEN              (필수) — ntn_... 또는 secret_...
 *   NOTION_PARENT_PAGE_ID     (필수) — 사용자가 만든 빈 페이지의 ID (32자 hex, dash 포함 OK).
 *                              이 페이지를 integration 에 share 해 두어야 함.
 *   NOTION_CSV_PATH           (옵션) — 기본 results/compare-wow.csv
 *   NOTION_SUBPAGE_TITLE      (옵션) — 기본 "📊 {YYYY-MM-DD} Weekly Snapshot"
 *
 * Notion API rate limit ~3 req/s. 82 reqs (sub-page + blocks + DB + 79 rows) → ~30초.
 * Node 18+
 */

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.NOTION_TOKEN || "";
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID || "";
const CSV_PATH = process.env.NOTION_CSV_PATH || path.join("results", "compare-wow.csv");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const REGRESSION_DELTA = -10; // build-slack-payload.js 와 일치
const IMPROVEMENT_DELTA = 10;

function exitErr(msg) {
  console.error("❌", msg);
  process.exit(1);
}

if (!TOKEN) exitErr("NOTION_TOKEN 미설정");
if (!PARENT_PAGE_ID) exitErr("NOTION_PARENT_PAGE_ID 미설정");
if (!fs.existsSync(CSV_PATH))
  exitErr(`${CSV_PATH} 가 없음 — build-3m-table.js 먼저 실행 필요`);

// compare-wow.csv 는 셀 안에 쉼표/줄바꿈/따옴표 없음을 가정 (trend 는 unicode bar).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` || "/" };
  } catch {
    return { host: "(unknown)", path: url };
  }
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function notionFetch(method, url, body) {
  const res = await fetch(`${NOTION_API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    throw new Error(`Notion ${method} ${url} ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 주간 sub-page 생성
async function createWeeklySubPage(title) {
  return await notionFetch("POST", "/pages", {
    parent: { page_id: PARENT_PAGE_ID },
    properties: {
      title: { title: [{ text: { content: title } }] },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) sub-page 본문에 Regressions 섹션 + Full Table heading 추가
function buildIntroBlocks(totalRows, regressions, improvements, pastLabel) {
  const blocks = [];

  // Regressions heading
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [
        {
          type: "text",
          text: { content: `⚠️ Regressions (perf Δ ≤ ${REGRESSION_DELTA})` },
        },
      ],
    },
  });

  if (regressions.length === 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "✅ 회귀 없음" } }],
      },
    });
  } else {
    for (const r of regressions) {
      const dev = r.device === "mobile" ? "M" : r.device === "desktop" ? "D" : r.device;
      const text =
        `[${dev}] ${r.url} — Perf ${r.perf_past || "?"} → ${r.perf_now || "?"} (${r.perf_delta})`;
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: text } }],
        },
      });
    }
  }

  // Summary callout
  blocks.push({
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "ℹ️" },
      rich_text: [
        {
          type: "text",
          text: {
            content:
              `총 ${totalRows} URLs / 회귀 ${regressions.length}건 / 개선 ${improvements.length}건 ` +
              `(Past: ${pastLabel || "—"})`,
          },
        },
      ],
    },
  });

  // Divider + Full Table heading
  blocks.push({ object: "block", type: "divider", divider: {} });
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: "📊 Full Table" } }],
    },
  });

  return blocks;
}

async function appendBlocks(pageId, children) {
  return await notionFetch("PATCH", `/blocks/${pageId}/children`, { children });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) sub-page 안에 inline database 생성 (schema 정의)
async function createInlineDatabase(parentPageId) {
  const properties = {
    URL: { title: {} },
    Device: {
      select: {
        options: [
          { name: "mobile", color: "blue" },
          { name: "desktop", color: "green" },
        ],
      },
    },
    Host: { select: {} },
    Path: { rich_text: {} },
    "Trend (8w)": { rich_text: {} },
    "Perf Now": { number: { format: "number" } },
    "Perf Δ": { number: { format: "number" } },
    "LCP Now": { number: { format: "number" } },
    "LCP Δ": { number: { format: "number" } },
    "CLS Now": { number: { format: "number" } },
    Status: {
      formula: {
        // Perf Δ 기준 자동 분류 — Notion 안에서 임계값 튜닝 가능 (수동 수정 시 다음 주 새 DB 에는 미적용)
        expression:
          'if(prop("Perf Δ") <= -10, "🚨 회귀", if(prop("Perf Δ") >= 10, "✅ 개선", "➖ 유지"))',
      },
    },
  };

  return await notionFetch("POST", "/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    is_inline: true,
    title: [{ type: "text", text: { content: "Full Table" } }],
    properties,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) row insert
function buildRowProperties(row) {
  const { host, path: pathStr } = splitUrl(row.url);
  const setText = (s) => [{ type: "text", text: { content: s ?? "" } }];

  return {
    URL: { title: setText(row.url) },
    Device: { select: { name: row.device || "(unknown)" } },
    Host: { select: { name: host } },
    Path: { rich_text: setText(pathStr) },
    "Trend (8w)": { rich_text: setText(row.trend) },
    "Perf Now": { number: numOrNull(row.perf_now) },
    "Perf Δ": { number: numOrNull(row.perf_delta) },
    "LCP Now": { number: numOrNull(row.lcp_sec_now) },
    "LCP Δ": { number: numOrNull(row.lcp_sec_delta) },
    "CLS Now": { number: numOrNull(row.cls_now) },
  };
}

async function insertRow(databaseId, row) {
  return await notionFetch("POST", "/pages", {
    parent: { database_id: databaseId },
    properties: buildRowProperties(row),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// compare-wow.md 헤더의 "Past (~7d ago, latest-per-day): 2026-05-19-110504" 에서 past 라벨 추출
function readPastLabelFromMd() {
  const mdPath = CSV_PATH.replace(/\.csv$/, ".md");
  if (!fs.existsSync(mdPath)) return "";
  const md = fs.readFileSync(mdPath, "utf-8").split(/\r?\n/).slice(0, 10).join("\n");
  const m = md.match(/^- Past[^:]*:\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

async function main() {
  const csvText = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parseCsv(csvText);
  console.log(`📥 CSV rows: ${rows.length} (from ${CSV_PATH})`);

  // Perf Now 오름차순 정렬 — Notion DB 의 default order 가 row 입력 순서가 되므로,
  // 미리 정렬해 두면 노션에서도 "심각한 URL 부터" 자연스럽게 보임.
  rows.sort((a, b) => {
    const an = Number(a.perf_now);
    const bn = Number(b.perf_now);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return 0;
  });

  const regressions = rows.filter(
    (r) => Number.isFinite(Number(r.perf_delta)) && Number(r.perf_delta) <= REGRESSION_DELTA
  );
  const improvements = rows.filter(
    (r) => Number.isFinite(Number(r.perf_delta)) && Number(r.perf_delta) >= IMPROVEMENT_DELTA
  );
  const pastLabel = readPastLabelFromMd();

  const today = new Date().toISOString().slice(0, 10);
  const title =
    process.env.NOTION_SUBPAGE_TITLE || `📊 ${today} Weekly Snapshot`;

  console.log(`📝 sub-page 생성: "${title}"`);
  const subPage = await createWeeklySubPage(title);
  const subPageId = subPage.id;
  console.log(`   sub-page id: ${subPageId}`);
  await sleep(350);

  console.log(`📌 본문 blocks 추가 (regressions=${regressions.length})...`);
  await appendBlocks(
    subPageId,
    buildIntroBlocks(rows.length, regressions, improvements, pastLabel)
  );
  await sleep(350);

  console.log(`📊 inline database 생성...`);
  const db = await createInlineDatabase(subPageId);
  console.log(`   database id: ${db.id}`);
  await sleep(350);

  console.log(`📥 ${rows.length} rows insert 시작 (~${Math.ceil(rows.length * 0.35)}초 소요)...`);
  let ok = 0,
    failed = 0;
  for (const row of rows) {
    try {
      await insertRow(db.id, row);
      ok++;
    } catch (e) {
      console.error(`   ❌ ${row.device}|${row.url} — ${e.message}`);
      failed++;
    }
    await sleep(350);
  }

  console.log(
    `\n✅ Notion sync 완료: sub-page "${title}", rows inserted=${ok}, failed=${failed}, ` +
      `regressions=${regressions.length}, improvements=${improvements.length}`
  );

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
