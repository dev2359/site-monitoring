/**
 * sync-notion.js
 *
 * 매주 Lighthouse 실행 후 Notion *Master DB* 에 1 row 생성하고, 그 row 의 detail page 안에
 * ⚠️ Regressions 요약 + 📊 Full Table (inline database, 79 rows) 를 채운다.
 *
 * Master DB 권장 schema (정확한 컬럼명):
 *   Title (Title)        — push 시 "📊 YYYY-MM-DD Weekly" 자동 입력 (실제 컬럼명은 자동 감지)
 *   Date (Date)
 *   Regressions (Number)
 *   Improvements (Number)
 *   Total URLs (Number)
 *   Past Snapshot (Text / rich_text)
 * → 누락된 컬럼은 best-effort 로 skip (warning).
 *
 * 환경변수:
 *   NOTION_TOKEN              (필수) — ntn_... 또는 secret_...
 *   NOTION_WEEKLY_DB_ID       (권장) — Master DB ID (주차별 archive)
 *   NOTION_PARENT_PAGE_ID     (호환) — 기존 secret 이름. 위 변수 없으면 fallback 으로 사용
 *                              (값은 이제 page ID 가 아니라 *DB ID* 여야 함)
 *   NOTION_CURRENT_DB_ID      (옵션) — Current DB ID. 설정 시 (Device, URL) 키로 upsert 추가 실행.
 *                              사용자가 노션에서 한 번 정렬/필터/메모 셋업 → 영구 유지
 *   NOTION_ARCHIVE_STALE      (옵션) — "true" 면 Current DB 에 있지만 새 CSV 에 없는 row 를 archive
 *   NOTION_CSV_PATH           (옵션) — 기본 results/compare-wow.csv
 *   NOTION_ROW_TITLE          (옵션) — 기본 "📊 {YYYY-MM-DD} Weekly"
 *
 * Notion API rate limit ~3 req/s. ~83 reqs (schema + row + blocks + inline DB + 79 rows) → ~30초.
 * Node 18+
 */

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.NOTION_TOKEN || "";
// Master DB (주차별 archive) — secret 이름 NOTION_WEEKLY_DB_ID > NOTION_PARENT_PAGE_ID 순.
const DB_ID = process.env.NOTION_WEEKLY_DB_ID || process.env.NOTION_PARENT_PAGE_ID || "";
// Current DB (최신 79 rows upsert) — 설정 시에만 동기화.
const CURRENT_DB_ID = process.env.NOTION_CURRENT_DB_ID || "";
const ARCHIVE_STALE =
  String(process.env.NOTION_ARCHIVE_STALE || "false").toLowerCase() === "true";
const CSV_PATH = process.env.NOTION_CSV_PATH || path.join("results", "compare-wow.csv");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const REGRESSION_DELTA = -5; // build-slack-payload.js 와 일치
const IMPROVEMENT_DELTA = 5;

function exitErr(msg) {
  console.error("❌", msg);
  process.exit(1);
}

if (!TOKEN) exitErr("NOTION_TOKEN 미설정");
if (!DB_ID) exitErr("NOTION_WEEKLY_DB_ID 또는 NOTION_PARENT_PAGE_ID 미설정 (값은 Master DB ID 여야 함)");
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

// 노션 백엔드의 일시 장애 (5xx, 429, 네트워크 에러) 시 exponential backoff 로 최대 3 회 재시도.
// 4xx (429 제외) 는 즉시 fail — 재시도해도 의미 없음.
const MAX_RETRIES = 3;
async function notionFetch(method, url, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${NOTION_API}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      // 네트워크 에러 (DNS, 연결 실패 등) — retry 대상
      lastErr = netErr;
      if (attempt < MAX_RETRIES) {
        const backoff = 500 * Math.pow(3, attempt); // 500ms → 1500ms → 4500ms
        console.warn(`   ⏳ network error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms — ${netErr.message}`);
        await sleep(backoff);
        continue;
      }
      throw netErr;
    }

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (res.ok) return json;

    // retry 대상: 5xx 또는 429 (rate limit)
    const retriable = res.status >= 500 || res.status === 429;
    if (retriable && attempt < MAX_RETRIES) {
      const backoff = 500 * Math.pow(3, attempt);
      console.warn(
        `   ⏳ Notion ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms — ${url}`
      );
      await sleep(backoff);
      lastErr = new Error(`Notion ${method} ${url} ${res.status}: ${text.slice(0, 200)}`);
      continue;
    }

    // 4xx (429 제외) 또는 재시도 횟수 초과 — 즉시 fail
    throw new Error(`Notion ${method} ${url} ${res.status}: ${text.slice(0, 300)}`);
  }
  throw lastErr || new Error(`Notion ${method} ${url} 재시도 초과`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Master DB schema 조회 — title property 이름 동적 감지 + 옵션 컬럼 존재 여부 확인.
async function fetchDbSchema(dbId) {
  return await notionFetch("GET", `/databases/${dbId}`);
}

// schema 안에서 type === 'title' 인 property 이름 찾기 (Notion DB 는 정확히 1개).
function findTitlePropertyName(schema) {
  const props = schema.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "title") return name;
  }
  throw new Error("Master DB 에 title type property 가 없음");
}

// 1) Master DB 에 한 주차 row(page) 생성. metadata 컬럼들은 schema 에 있을 때만 채움 (없으면 skip).
async function createWeeklyDbRow(dbId, schema, titleProp, meta) {
  const properties = {
    [titleProp]: { title: [{ text: { content: meta.title } }] },
  };

  const schemaProps = schema.properties || {};
  const setIfExists = (name, type, value) => {
    if (!schemaProps[name] || schemaProps[name].type !== type) return false;
    if (type === "date") properties[name] = { date: { start: value } };
    else if (type === "number") properties[name] = { number: value };
    else if (type === "rich_text")
      properties[name] = { rich_text: [{ text: { content: value ?? "" } }] };
    return true;
  };

  const optional = [
    ["Date", "date", meta.dateIso],
    ["Regressions", "number", meta.regressions],
    ["Improvements", "number", meta.improvements],
    ["Total URLs", "number", meta.total],
    ["Past Snapshot", "rich_text", meta.pastLabel || ""],
  ];

  const missing = [];
  for (const [name, type, value] of optional) {
    const ok = setIfExists(name, type, value);
    if (!ok) missing.push(`${name}(${type})`);
  }
  if (missing.length > 0) {
    console.warn(`⚠️ Master DB 에 다음 컬럼 누락/타입 불일치 — skip: ${missing.join(", ")}`);
  }

  return await notionFetch("POST", "/pages", {
    parent: { database_id: dbId },
    properties,
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
// 컬럼 정의 순서가 새 DB 의 default 컬럼 순서가 됨 (Title 은 항상 가장 왼쪽).
// 자주 보는 정보 → 부가 정보 순으로: URL · Device · Host · Status · Perf · LCP · CLS · Trend · Path
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
    Status: {
      formula: {
        // Perf Δ 기준 자동 분류 — Notion 안에서 임계값 튜닝 가능 (수동 수정 시 다음 주 새 DB 에는 미적용)
        expression:
          'if(prop("Perf Δ") <= -5, "🚨 회귀", if(prop("Perf Δ") >= 5, "✅ 개선", "➖ 유지"))',
      },
    },
    "Perf Now": { number: { format: "number" } },
    "Perf Δ": { number: { format: "number" } },
    "LCP Now": { number: { format: "number" } },
    "LCP Δ": { number: { format: "number" } },
    "CLS Now": { number: { format: "number" } },
    "Trend (8w)": { rich_text: {} },
    Path: { rich_text: {} },
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
// 5) Current DB upsert — 매주 같은 (Device, URL) row 값만 갱신해 "현재 상태" 유지.
//    Master DB(주차별 archive) 와 schema 동일. Status 컬럼은 Notion Formula 라 코드에서 안 보냄.
async function queryAllPages(dbId) {
  const all = [];
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const json = await notionFetch("POST", `/databases/${dbId}/query`, body);
    for (const r of json.results || []) all.push(r);
    if (json.has_more && json.next_cursor) cursor = json.next_cursor;
    else break;
  }
  return all;
}

function extractKey(page) {
  const props = page.properties || {};
  const url = props["URL"]?.title?.[0]?.plain_text || "";
  const device = props["Device"]?.select?.name || "";
  return `${device}|${url}`;
}

async function upsertCurrentDb(dbId, rows) {
  console.log(`\n🔄 Current DB upsert 시작: ${dbId}`);
  const existing = await queryAllPages(dbId);
  console.log(`   기존 page: ${existing.length}`);

  const byKey = new Map();
  for (const p of existing) byKey.set(extractKey(p), p);

  let created = 0,
    updated = 0,
    failed = 0;
  const seenKeys = new Set();

  for (const row of rows) {
    const key = `${row.device}|${row.url}`;
    seenKeys.add(key);
    const props = buildRowProperties(row);
    const existingPage = byKey.get(key);

    try {
      if (existingPage) {
        await notionFetch("PATCH", `/pages/${existingPage.id}`, { properties: props });
        updated++;
      } else {
        await notionFetch("POST", `/pages`, {
          parent: { database_id: dbId },
          properties: props,
        });
        created++;
      }
    } catch (e) {
      console.error(`   ❌ ${key} — ${e.message}`);
      failed++;
    }
    await sleep(350);
  }

  // stale: 새 CSV 에 없는 기존 row. NOTION_ARCHIVE_STALE=true 일 때만 archive.
  const staleKeys = [...byKey.keys()].filter((k) => !seenKeys.has(k));
  let archived = 0;
  if (ARCHIVE_STALE && staleKeys.length > 0) {
    console.log(`   🗑 stale row ${staleKeys.length}개 archive...`);
    for (const key of staleKeys) {
      try {
        await notionFetch("PATCH", `/pages/${byKey.get(key).id}`, { archived: true });
        archived++;
      } catch (e) {
        console.error(`   ❌ archive ${key} — ${e.message}`);
        failed++;
      }
      await sleep(350);
    }
  }

  const staleNote = ARCHIVE_STALE
    ? `archived=${archived}`
    : `stale 유지=${staleKeys.length}`;
  console.log(
    `✅ Current DB upsert 완료: created=${created}, updated=${updated}, ${staleNote}, failed=${failed}`
  );

  return failed;
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
    process.env.NOTION_ROW_TITLE ||
    process.env.NOTION_SUBPAGE_TITLE ||  // 이전 이름도 호환
    `📊 ${today} Weekly`;

  console.log(`🔍 Master DB schema 조회: ${DB_ID}`);
  const schema = await fetchDbSchema(DB_ID);
  const titleProp = findTitlePropertyName(schema);
  console.log(`   title property: "${titleProp}"`);
  await sleep(350);

  const meta = {
    title,
    dateIso: today,
    regressions: regressions.length,
    improvements: improvements.length,
    total: rows.length,
    pastLabel,
  };

  console.log(`📝 Master DB row 생성: "${title}"`);
  const row = await createWeeklyDbRow(DB_ID, schema, titleProp, meta);
  const rowPageId = row.id;
  console.log(`   row page id: ${rowPageId}`);
  await sleep(350);

  console.log(`📌 row detail 본문 blocks 추가 (regressions=${regressions.length})...`);
  await appendBlocks(
    rowPageId,
    buildIntroBlocks(rows.length, regressions, improvements, pastLabel)
  );
  await sleep(350);

  console.log(`📊 inline database (Full Table) 생성...`);
  const detailDb = await createInlineDatabase(rowPageId);
  console.log(`   inline database id: ${detailDb.id}`);
  await sleep(350);

  console.log(`📥 ${rows.length} rows insert 시작 (~${Math.ceil(rows.length * 0.35)}초 소요)...`);
  let ok = 0,
    failed = 0;
  for (const r of rows) {
    try {
      await insertRow(detailDb.id, r);
      ok++;
    } catch (e) {
      console.error(`   ❌ ${r.device}|${r.url} — ${e.message}`);
      failed++;
    }
    await sleep(350);
  }

  console.log(
    `\n✅ Master DB sync 완료: row "${title}", rows inserted=${ok}, failed=${failed}, ` +
      `regressions=${regressions.length}, improvements=${improvements.length}`
  );

  // Current DB (최신 79 rows 유지) 가 설정돼 있으면 추가 upsert.
  let currentFailed = 0;
  if (CURRENT_DB_ID) {
    try {
      currentFailed = await upsertCurrentDb(CURRENT_DB_ID, rows);
    } catch (e) {
      console.error(`❌ Current DB upsert 실패: ${e.message}`);
      currentFailed = 1; // 실패 마킹
    }
  } else {
    console.log(`\nℹ️ NOTION_CURRENT_DB_ID 미설정 — Current DB upsert skip`);
  }

  if (failed > 0 || currentFailed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
