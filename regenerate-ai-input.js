/**
 * regenerate-ai-input.js
 *
 * 기존 results/summary.json 만 가지고 results/ai-input.json 을 새로 만든다.
 * Lighthouse 측정을 다시 돌리지 않고, AI 호출 단계만 재실행할 때 사용.
 *
 * - input:  results/summary.json (env SUMMARY_PATH 로 오버라이드 가능)
 * - output: results/ai-input.json (env AI_INPUT_PATH 로 오버라이드 가능)
 *
 * Node 18+
 */

const fs = require("fs");
const path = require("path");
const { buildAiInput } = require("./extract-scores.js");

const SUMMARY_PATH = process.env.SUMMARY_PATH || path.join("results", "summary.json");
const OUT_PATH = process.env.AI_INPUT_PATH || path.join("results", "ai-input.json");

if (!fs.existsSync(SUMMARY_PATH)) {
  console.error(`❌ ${SUMMARY_PATH} 없음`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8"));
const aiInput = buildAiInput(summary);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(aiInput, null, 2), "utf-8");

console.log(`✅ Wrote ${OUT_PATH} (${fs.statSync(OUT_PATH).size} bytes)`);
console.log(`   problems=${(aiInput.problems || []).length}, byHost=${(aiInput.byHost || []).length}, slackTargets=${(aiInput.slackTargets || []).length}`);
