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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 6000);

function mustReadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf-8");
}

function buildPrompt(input, appliedActions) {
  const warn = Math.round((input.thresholds?.warn ?? 0.8) * 100);
  const crit = Math.round((input.thresholds?.crit ?? 0.6) * 100);

  const appliedBlock = appliedActions && appliedActions.trim()
    ? `

이미 적용된 액션 목록 (다시 같은 액션을 제안하지 말 것):
\`\`\`
${appliedActions.trim()}
\`\`\`
규칙:
- 위에 적힌 액션과 동일/유사한 작업은 새 "개선 액션" 으로 제안하지 말 것.
- 해당 액션이 적용된 host/URL 의 metric 변화가 보이면 "Per-site Diagnosis" 의 '원인 가설' 또는 'Cross-cutting Recommendations' 에서 한 줄로 "이전 적용한 X 가 Y metric 에 어떤 영향을 줬는지" 검증 코멘트를 남길 것.
`
    : "";

  return `
너는 Lighthouse/Core Web Vitals 기반 웹 성능 개선 컨설턴트다.
아래 JSON 은 여러 사이트의 측정 결과로 mobile/desktop URL 별 점수·metric 과 host 별 집계를 포함한다.
${appliedBlock}
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
전체 URL 중 perf 가 가장 낮은 5 개. 각 URL 은 정확히 아래 구조:

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
  };

  let appliedActions = null;
  if (fs.existsSync(APPLIED_PATH)) {
    try {
      appliedActions = fs.readFileSync(APPLIED_PATH, "utf-8");
      console.log(`ℹ️ Loaded applied-actions from ${APPLIED_PATH} (${appliedActions.length} chars)`);
    } catch (e) {
      console.warn(`⚠️ Failed to read ${APPLIED_PATH}:`, e?.message || e);
    }
  }

  const prompt = buildPrompt(slim, appliedActions);

  try {
    const md = await callOpenAI(prompt);
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
