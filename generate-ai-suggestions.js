/**
 * generate-ai-suggestions.js
 * - input:  results/ai-input.json
 * - output: results/ai-suggestions.md
 *
 * OpenAI Responses API (recommended)
 * Node 18+ (global fetch)
 */

const fs = require("fs");
const path = require("path");

const IN_PATH = path.join("results", "ai-input.json");
const OUT_PATH = path.join("results", "ai-suggestions.md");
const APPLIED_PATH = process.env.APPLIED_ACTIONS_PATH || "applied-actions.md";
// evaluate-applied-actions.js 가 만든 코드 기반 효과 검증 결과 (있으면 fact 로 주입).
const APPLIED_EVAL_PATH = path.join("results", "applied-eval.json");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 6000);

// applied-actions.md 에서 최근 N 주 분량만 AI 에 전달. 이 윈도 이전 기록은 자동 제외되어
// 시간이 지나면 자연스럽게 재제안 가능 (롤백/리팩토링으로 원상복귀된 경우 대비).
const APPLIED_WINDOW_WEEKS = parseInt(process.env.APPLIED_WINDOW_WEEKS || "12", 10);

function mustReadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// applied-actions.md 에서 `- [YYYY-MM-DD] ...` 형식 항목만 추출하고
// 최근 windowDays 일 이내 것만 남긴다. 헤더/설명/코드블록(```) 안 예시는 모두 제외.
function filterRecentAppliedActions(md, windowDays) {
  if (!md) return { kept: [], totalEntries: 0, droppedOld: 0 };
  const lines = md.split(/\r?\n/);
  const datePattern = /^\s*-\s*\[(\d{4})-(\d{2})-(\d{2})\]\s*(.*)$/;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const kept = [];
  let totalEntries = 0;
  let droppedOld = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    // ``` 만나면 코드블록 진입/탈출 — 코드블록 안의 라인은 예시로 간주.
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const m = line.match(datePattern);
    if (!m) continue;
    totalEntries++;
    const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d >= cutoff) {
      kept.push(line.trim());
    } else {
      droppedOld++;
    }
  }
  return { kept, totalEntries, droppedOld };
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf-8");
}

function buildPrompt(input, appliedFiltered, appliedEval) {
  const warn = Math.round((input.thresholds?.warn ?? 0.8) * 100);
  const crit = Math.round((input.thresholds?.crit ?? 0.6) * 100);

  const targets = Array.isArray(input.slackTargets) ? input.slackTargets : [];
  const targetsBlock = targets.length > 0
    ? `

[Slack 노출 대상] — "Top URL Actions" 섹션은 아래 ${targets.length}개 URL 을 *정확히 이 순서로* 다룰 것. 빠뜨리거나 다른 URL 로 대체 금지.
${targets
  .map((t, i) => {
    const perf = typeof t.performance === "number" ? Math.round(t.performance * 100) : "?";
    const lcp = t.metrics?.lcp ? `${Math.round(t.metrics.lcp)}ms` : "?";
    const cls = typeof t.metrics?.cls === "number" ? t.metrics.cls.toFixed(3) : "?";
    const tbt = t.metrics?.tbt ? `${Math.round(t.metrics.tbt)}ms` : "?";
    const dev = t.device === "mobile" ? "Mobile" : "Desktop";
    return `${i + 1}. [${dev}] ${t.url} (Perf ${perf}, LCP ${lcp}, CLS ${cls}, TBT ${tbt})`;
  })
  .join("\n")}
`
    : "";

  // (A) 재제안 차단 — 최근 적용 목록과 동일/유사 작업은 새 액션으로 제안 금지.
  const appliedBlock = appliedFiltered && appliedFiltered.kept.length > 0
    ? `

지난 ${APPLIED_WINDOW_WEEKS}주 (약 ${APPLIED_WINDOW_WEEKS * 7}일) 동안 적용된 액션 (각 줄: \`- [YYYY-MM-DD] [host] 내용\`):
\`\`\`
${appliedFiltered.kept.join("\n")}
\`\`\`
규칙:
1. 위 목록에 있는 액션과 *동일/유사* 한 작업은 "개선 액션" 또는 "Top URL Actions" 의 새 액션으로 **제안하지 말 것** (이미 적용됨).
2. ${APPLIED_WINDOW_WEEKS}주 이전 기록은 이 목록에서 제외됨 — 그 시점 액션이라도 다시 제안 가능 (롤백/시간 경과에 따른 재제안 허용).
`
    : "";

  // (B) 코드가 계산한 효과 검증 결과 — AI 는 다시 판정하지 말고 그대로 사실로 인용.
  const evalResults = appliedEval && Array.isArray(appliedEval.results) ? appliedEval.results : [];
  const evalBlock = evalResults.length > 0
    ? `

[적용 액션 효과 검증 — 코드가 before/after metric 비교로 산출한 *확정 사실*]
${evalResults.map((r) => `- ${r.summaryLine}`).join("\n")}
규칙(반드시 지킬 것):
1. 위 검증 결과는 코드가 계산한 사실이다. **다시 판정하거나 ✅/⚠️/➖ 를 새로 만들지 말 것.**
2. 해당 host 의 "Per-site Diagnosis" 에서 위 사실을 *컨텍스트로만* 활용 (예: 효과 보인 액션은 "최근 X 가 효과 보이는 가운데..." 식으로 언급, 악화/미반영은 원인 재진단).
3. ✅(효과 보임) 으로 검증된 액션과 동일 metric 을 노린 *유사* 작업은 새로 제안하지 말 것.
4. ⚠️(악화/미반영) host 는 다른 원인 가설을 세워 *다른* 액션을 제안할 것.
`
    : "";

  return `
너는 Lighthouse/Core Web Vitals 기반 웹 성능 개선 컨설턴트다.
아래 JSON 은 여러 사이트의 측정 결과로 mobile/desktop URL 별 점수·metric 과 host 별 집계를 포함한다.
${targetsBlock}${appliedBlock}${evalBlock}
목표:
- 일반론이 아니라 host/URL 단위로 구체적인 진단을 한다.
- 각 액션은 어떤 요소/리소스를 어떻게 바꾸면 어떤 metric(LCP/CLS/TBT/INP 등)이 어떻게 개선되는지 명시.
- 우선순위: CRIT(Perf<${crit}) > WARN(Perf<${warn}) > 그 외.
- 추정은 "가설" 로 명시하고 검증 방법 한 줄 덧붙이기.

출력 규칙(반드시 지킬 것):
- 아래의 정확한 Markdown 형식만 출력. 다른 텍스트(서론, 메타 설명) 금지.
- 섹션 제목과 헤더 레벨 변경 금지. (파서가 정확한 형식을 기대함)
- h3 의 형식도 반드시 지킬 것.

형식:

## TL;DR
- 가장 시급한 위험/패턴 3 줄 (각 1 줄, host 또는 metric 을 명시)

## Per-site Diagnosis
problemCount > 0 인 host 만 worst perf 순서로 최대 6 개. 각 host 는 정확히 아래 구조:

### {host}
- **현황:** Mobile {N} URLs avg Perf {n} / Desktop {N} URLs avg Perf {n} / avg LCP {n}s / 문제 URL {n}개
- **원인 가설:** host 공통 패턴 기반 1~3 줄
- **개선 액션:**
  - 액션 1 (어떤 metric 을 어떻게)
  - 액션 2
  - 액션 3 (선택)

## Top URL Actions
위 "Slack 노출 대상" 섹션에 명시된 URL 들을 *같은 순서로 빠짐없이* 다룬다. 만약 입력에 그 섹션이 없으면 fallback 으로 perf 가장 낮은 6 개. 각 URL 은 정확히 아래 구조:

### [{Device}] {url} (Perf {n})
- **메트릭:** LCP {n}ms, CLS {n}, TBT {n}ms
- **액션:**
  - 액션 1 (어떤 요소/리소스 → 어떤 작업 → 기대 효과 metric)
  - 액션 2
  - 액션 3
  - 액션 4 (선택)

여기서 Device 는 "Mobile" 또는 "Desktop", url 은 절대 URL 전체.

## Cross-cutting Recommendations
여러 사이트에 공통 적용 가능한 권장사항 2~3 개 (1~2 줄씩)

데이터(JSON):
${JSON.stringify(input, null, 2)}
`.trim();
}

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Responses API: 최신 권장 엔드포인트
        // output_text를 활용하면 결과 추출이 쉬움
        input: prompt,
        instructions:
          "Return concise, actionable recommendations. Follow the required Markdown section format exactly.",
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(async () => {
      const t = await res.text();
      throw new Error(`Non-JSON response: ${t}`);
    });

    if (!res.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      throw new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${msg}`);
    }

    if (typeof data.output_text === "string" && data.output_text.trim()) {
      return data.output_text.trim();
    }

    const chunks = [];
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
      }
    }
    return chunks.join("\n").trim();
  } finally {
    clearTimeout(timeout);
  }
}

// 1차 응답 markdown 의 "## Top URL Actions" 섹션에서 ### [Mobile|Desktop] URL 헤더만 추출.
// (device, url) 정규화된 키 집합을 반환 — slackTargets 와 비교용.
function extractRespondedKeys(md) {
  const keys = new Set();
  if (!md) return keys;
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*Top URL Actions/i.test(l.trim()));
  if (start === -1) return keys;
  const normUrl = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^##\s+/.test(t)) break;
    const m = t.match(/^###\s*\[?(Mobile|Desktop|M|D)\]?\s+(\S.+?)\s*\(/i);
    if (m) {
      const dev = /^m/i.test(m[1]) ? "mobile" : "desktop";
      keys.add(`${dev}|${normUrl(m[2].trim())}`);
    }
  }
  return keys;
}

// 누락 URL 만 다루도록 짧은 retry 프롬프트 — TL;DR/Per-site/Cross-cutting 은 출력하지 않음.
function buildRetryPrompt(missing) {
  const listed = missing
    .map((t, i) => {
      const perf = typeof t.performance === "number" ? Math.round(t.performance * 100) : "?";
      const lcp = t.metrics?.lcp ? `${Math.round(t.metrics.lcp)}ms` : "?";
      const cls = typeof t.metrics?.cls === "number" ? t.metrics.cls.toFixed(3) : "?";
      const tbt = t.metrics?.tbt ? `${Math.round(t.metrics.tbt)}ms` : "?";
      const dev = t.device === "mobile" ? "Mobile" : "Desktop";
      return `${i + 1}. [${dev}] ${t.url} (Perf ${perf}, LCP ${lcp}, CLS ${cls}, TBT ${tbt})`;
    })
    .join("\n");

  return `
이전 응답에서 다음 ${missing.length}개 URL 을 빠뜨렸다. 아래 URL 들만 다뤄라.
TL;DR / Per-site Diagnosis / Cross-cutting Recommendations 섹션은 출력하지 말 것.
"## Top URL Actions" 헤더 한 줄 다음에 URL 별 블록만 출력.

대상 URL:
${listed}

형식 (정확히 지킬 것):

## Top URL Actions

### [{Device}] {url} (Perf {n})
- **메트릭:** LCP {n}ms, CLS {n}, TBT {n}ms
- **액션:**
  - 액션 1 (어떤 요소/리소스 → 어떤 작업 → 기대 효과 metric)
  - 액션 2
  - 액션 3
`.trim();
}

// 2차 응답의 URL 블록들만 추출해 1차 markdown 의 Top URL Actions 섹션 끝에 append.
function mergeTopUrlActions(md1, md2) {
  if (!md2) return md1;

  // md2 에서 ### 로 시작하는 URL 블록만 모음.
  const m2lines = md2.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let inSection = false;
  for (const line of m2lines) {
    if (/^###\s*\[/.test(line)) {
      if (cur.length) blocks.push(cur.join("\n").trimEnd());
      cur = [line];
      inSection = true;
    } else if (/^##\s+/.test(line)) {
      if (cur.length) blocks.push(cur.join("\n").trimEnd());
      cur = [];
      inSection = false;
    } else if (inSection) {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join("\n").trimEnd());
  if (blocks.length === 0) return md1;

  // md1 의 Top URL Actions 섹션 끝 위치 찾기.
  const m1lines = md1.split(/\r?\n/);
  const topIdx = m1lines.findIndex((l) => /^##\s*Top URL Actions/i.test(l.trim()));
  if (topIdx === -1) {
    return `${md1}\n\n## Top URL Actions\n\n${blocks.join("\n\n")}\n`;
  }
  let endIdx = m1lines.length;
  for (let i = topIdx + 1; i < m1lines.length; i++) {
    if (/^##\s+/.test(m1lines[i].trim())) {
      endIdx = i;
      break;
    }
  }
  const before = m1lines.slice(0, endIdx);
  // 끝쪽 빈 줄 정리.
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  const after = m1lines.slice(endIdx);
  return [...before, "", blocks.join("\n\n"), "", ...after].join("\n");
}

function fallbackMarkdown(err) {
  return `# AI Suggestions (fallback)

## TL;DR
- OpenAI 호출 실패로 자동 진단을 생성하지 못했습니다.
- 원인: \`${String(err.message || err)}\`
- Job Summary / Lighthouse 리포트 기반으로 수동 확인이 필요합니다.

## Per-site Diagnosis
_(AI 호출 실패로 host 별 진단을 생성하지 못함)_

## Top URL Actions
_(AI 호출 실패로 URL 별 액션을 생성하지 못함)_

## Cross-cutting Recommendations
- 문제 URL 상위부터 waterfall/coverage 로 병목 리소스 식별
- hero 이미지 최적화(사이즈/포맷/priority) + 캐시 정책 점검
- 3rd-party 스크립트 지연 로드/제거 + 번들 분할/트리쉐이킹
`;
}

async function main() {
  const input = mustReadJson(IN_PATH);

  const slim = {
    generatedAt: input.generatedAt,
    thresholds: input.thresholds,
    overall: input.overall,
    problems: Array.isArray(input.problems) ? input.problems : undefined,
    byHost: input.byHost,
    // slackTargets 는 buildPrompt 의 [Slack 노출 대상] 강제 지시에 필수 — 빠지면 AI 가
    // 자유롭게 URL 을 고르게 되어 slackTargets 와 어긋난 응답이 나온다.
    slackTargets: Array.isArray(input.slackTargets) ? input.slackTargets : undefined,
  };

  let appliedFiltered = null;
  if (fs.existsSync(APPLIED_PATH)) {
    try {
      const md = fs.readFileSync(APPLIED_PATH, "utf-8");
      const windowDays = APPLIED_WINDOW_WEEKS * 7;
      appliedFiltered = filterRecentAppliedActions(md, windowDays);
      console.log(
        `ℹ️ applied-actions: total=${appliedFiltered.totalEntries}, kept(last ${APPLIED_WINDOW_WEEKS}w)=${appliedFiltered.kept.length}, droppedOld=${appliedFiltered.droppedOld}`
      );
    } catch (e) {
      console.warn(`⚠️ Failed to read ${APPLIED_PATH}:`, e?.message || e);
    }
  }

  // 코드 기반 효과 검증 결과 (evaluate-applied-actions.js 산출). 있으면 fact 로 주입.
  let appliedEval = null;
  if (fs.existsSync(APPLIED_EVAL_PATH)) {
    try {
      appliedEval = JSON.parse(fs.readFileSync(APPLIED_EVAL_PATH, "utf-8"));
      const n = Array.isArray(appliedEval.results) ? appliedEval.results.length : 0;
      console.log(`ℹ️ applied-eval: ${n}건 (counts=${JSON.stringify(appliedEval.counts || {})})`);
    } catch (e) {
      console.warn(`⚠️ Failed to read ${APPLIED_EVAL_PATH}:`, e?.message || e);
    }
  } else {
    console.log(`ℹ️ ${APPLIED_EVAL_PATH} 없음 — 효과 검증 블록 생략 (evaluate-applied-actions.js 미실행)`);
  }

  const prompt = buildPrompt(slim, appliedFiltered, appliedEval);

  try {
    let md = await callOpenAI(prompt);

    // AI 가 프롬프트의 "slackTargets N개 모두 다뤄라" 지시를 무시하고 일부 URL 을 빠뜨리는 경우가 있어,
    // 응답에서 누락된 항목을 식별해 *누락된 URL 만* 한 번 더 요청 → 1차 결과에 병합.
    // 재호출도 누락되면 placeholder 처리는 build-slack-payload.js 가 담당.
    const slackTargets = Array.isArray(input.slackTargets) ? input.slackTargets : [];
    if (slackTargets.length > 0) {
      const normUrl = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
      const responded = extractRespondedKeys(md);
      const missing = slackTargets.filter(
        (t) => !responded.has(`${t.device}|${normUrl(t.url)}`)
      );

      if (missing.length > 0) {
        console.warn(
          `⚠️ AI 가 slackTargets 중 ${missing.length}/${slackTargets.length} 개 빠뜨림 → retry`
        );
        missing.forEach((t) => console.warn(`   - [${t.device}] ${t.url}`));

        try {
          const retryPrompt = buildRetryPrompt(missing);
          const md2 = await callOpenAI(retryPrompt);
          const merged = mergeTopUrlActions(md, md2);
          const responded2 = extractRespondedKeys(merged);
          const stillMissing = slackTargets.filter(
            (t) => !responded2.has(`${t.device}|${normUrl(t.url)}`)
          );
          console.log(
            `   retry 결과: ${missing.length - stillMissing.length}/${missing.length} 회복, 잔여 누락 ${stillMissing.length}`
          );
          md = merged;
        } catch (retryErr) {
          console.warn(
            `⚠️ retry 호출 실패 — 1차 결과 그대로 사용: ${retryErr?.message || retryErr}`
          );
        }
      } else {
        console.log(`✅ slackTargets ${slackTargets.length}개 모두 응답에 포함`);
      }
    }

    const out = md.includes("## TL;DR") ? md : `# AI Suggestions\n\n${md}`;
    writeText(OUT_PATH, out);
    console.log(`✅ AI suggestions written: ${OUT_PATH}`);
  } catch (err) {
    console.error("❌ OpenAI failed:", err);
    writeText(OUT_PATH, fallbackMarkdown(err));
    process.exit(0);
  }
}

main();
