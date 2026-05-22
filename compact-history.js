/**
 * compact-history.js
 *
 * 오래된 history/*.json 스냅샷을 *주별 1개* 만 남기고 정리.
 * - 최근 RETENTION_MONTHS (기본 6) 이내는 그대로 유지
 * - 그 이전 데이터는 ISO week 별로 가장 최신 파일만 유지, 나머지 삭제
 *
 * 환경변수:
 *   DRY_RUN              — "false" 외 모든 값은 dry-run (기본 true) — 어떤 파일이 삭제될지 출력만 함
 *   RETENTION_MONTHS     — 이 개월 수 이내는 손대지 않음 (기본 6)
 *   HISTORY_DIR          — 기본 "history"
 *
 * 출력:
 *   - stdout 에 요약 + 삭제 대상 / 유지 목록
 *   - GITHUB_STEP_SUMMARY 에 동일 내용 markdown 으로 append
 *   - GITHUB_OUTPUT: changed=true|false (실제 삭제 발생 여부)
 *
 * Node 18+
 */

const fs = require("fs");
const path = require("path");

const HISTORY_DIR = process.env.HISTORY_DIR || "history";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const RETENTION_MONTHS = parseInt(process.env.RETENTION_MONTHS || "6", 10);

// 파일명 prefix `YYYY-MM-DD` 에서 Date(UTC) 추출.
function parseDateFromFilename(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// ISO 8601 week-numbering year + week → "YYYY-Www" 키.
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3); // 해당 주의 목요일로 이동
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstThursdayDow = (firstThursday.getUTCDay() + 6) % 7;
  const week =
    1 +
    Math.round(
      ((date - firstThursday) / 86400000 - 3 + firstThursdayDow) / 7
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function appendStepSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function main() {
  if (!fs.existsSync(HISTORY_DIR)) {
    console.log(`${HISTORY_DIR}/ 가 없음 — 정리 대상 없음.`);
    setOutput("changed", "false");
    return;
  }

  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);

  const all = fs
    .readdirSync(HISTORY_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((name) => ({ name, date: parseDateFromFilename(name) }))
    .filter((f) => f.date instanceof Date && !isNaN(f.date));

  if (all.length === 0) {
    console.log("정리 가능한 *.json 파일 없음.");
    setOutput("changed", "false");
    return;
  }

  all.sort((a, b) => a.date - b.date);

  const recent = all.filter((f) => f.date >= cutoff);
  const old = all.filter((f) => f.date < cutoff);

  // 오래된 파일을 ISO week 단위로 그룹화 → 각 week 의 가장 최신 파일만 유지.
  const byWeek = new Map();
  for (const f of old) {
    const k = isoWeekKey(f.date);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(f);
  }
  const keep = [];
  const del = [];
  for (const group of byWeek.values()) {
    group.sort((a, b) => b.date - a.date);
    keep.push(group[0]);
    del.push(...group.slice(1));
  }
  keep.sort((a, b) => a.date - b.date);
  del.sort((a, b) => a.date - b.date);

  const mode = DRY_RUN ? "DRY-RUN" : "REAL DELETE";
  console.log(`[${mode}] history/ 정리 — cutoff=${cutoff.toISOString().slice(0, 10)} (${RETENTION_MONTHS}개월)`);
  console.log(`  총 파일: ${all.length}`);
  console.log(`  최근 ${RETENTION_MONTHS}개월 (유지): ${recent.length}`);
  console.log(`  ${RETENTION_MONTHS}개월 이전: ${old.length} → 주별 유지 ${keep.length}, 삭제 대상 ${del.length}`);

  if (del.length === 0) {
    console.log("→ 삭제 대상 없음.");
  } else {
    console.log("\n=== 삭제 대상 ===");
    for (const f of del) console.log(`  - ${f.name}`);
    console.log("\n=== 유지 (주별 1개) ===");
    for (const f of keep) console.log(`  - ${f.name}`);
  }

  // GitHub Step Summary 에 markdown 으로 동일 정보.
  const md = [];
  md.push(`## History Compact (${mode})`);
  md.push("");
  md.push(`- cutoff: \`${cutoff.toISOString().slice(0, 10)}\` (RETENTION_MONTHS=${RETENTION_MONTHS})`);
  md.push(`- 총 파일: **${all.length}**`);
  md.push(`- 최근 ${RETENTION_MONTHS}개월 (그대로 유지): **${recent.length}**`);
  md.push(`- ${RETENTION_MONTHS}개월 이전: ${old.length} → 주별 유지 **${keep.length}**, 삭제 대상 **${del.length}**`);
  if (DRY_RUN) {
    md.push("");
    md.push("> ⚠️ **DRY-RUN 모드** — 실제 삭제 없음. 결과 확인 후 `DRY_RUN=false` 로 워크플로 재실행하면 삭제됩니다.");
  }
  if (del.length > 0) {
    md.push("");
    md.push(`### 🗑 삭제 대상 (${del.length})`);
    for (const f of del.slice(0, 200)) md.push(`- \`${f.name}\``);
    if (del.length > 200) md.push(`- ... 외 ${del.length - 200}건`);
    md.push("");
    md.push(`### 📌 주별 유지 (${keep.length})`);
    for (const f of keep.slice(0, 100)) md.push(`- \`${f.name}\``);
    if (keep.length > 100) md.push(`- ... 외 ${keep.length - 100}건`);
  }
  appendStepSummary(md.join("\n"));

  if (DRY_RUN || del.length === 0) {
    setOutput("changed", "false");
    return;
  }

  for (const f of del) {
    fs.unlinkSync(path.join(HISTORY_DIR, f.name));
  }
  console.log(`\n✅ ${del.length}개 파일 삭제 완료.`);
  setOutput("changed", "true");
  setOutput("deleted", String(del.length));
}

main();
