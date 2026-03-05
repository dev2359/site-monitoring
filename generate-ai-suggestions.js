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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 650);

function mustReadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf-8");
}

function buildPrompt(input) {
  const warn = Math.round((input.thresholds?.warn ?? 0.8) * 100);
  const crit = Math.round((input.thresholds?.crit ?? 0.7) * 100);

  return `
너는 Lighthouse 성능 개선 전문가다.
아래 JSON은 여러 URL의 Lighthouse 요약이다. (mobile/desktop 포함)

목표:
- Slack에 바로 붙일 수 있는 "짧고 실행 가능한" 개선 제안을 만든다.
- 우선순위: CRIT(Perf<${crit}) → WARN(Perf<${warn}) → 그 외.
- 불확실하면 "가설"로 명시하고, 측정/검증 방법을 함께 제시한다.

출력 규칙(반드시 지켜):
- Markdown만 출력
- 섹션 헤더는 아래와 정확히 일치해야 함 (파싱 안정)
- TL;DR 3줄, Actions 5개, 각 Action은 1~2줄로 짧게
- 긴 서론/배경 설명 금지

반드시 이 형식:
## TL;DR
- ...
- ...
- ...

## Root cause hypotheses (Top 3)
1) ...
2) ...
3) ...

## Recommended actions (Top 5)
1) ...
2) ...
3) ...
4) ...
5) ...

## Verification checklist
- ...

입력(JSON):
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
- OpenAI 호출 실패로 자동 제안을 생성하지 못했습니다.
- 원인: \`${String(err.message || err)}\`
- Job Summary / Lighthouse 리포트 기반으로 수동 확인이 필요합니다.

## Root cause hypotheses (Top 3)
1) JS/서드파티 과다로 INP/TBT 악화 가능
2) 이미지/폰트 최적화 부족으로 LCP 악화 가능
3) CLS 유발 요소(이미지 크기 미지정/레이아웃 점프) 가능

## Recommended actions (Top 5)
1) 문제 URL 상위부터 waterfall/coverage로 병목 리소스 식별
2) hero 이미지 최적화(사이즈/포맷/priority) + 캐시 정책 점검
3) 3rd-party 스크립트 지연 로드/제거 + 번들 분할/트리쉐이킹
4) 폰트 preload/서브셋 + CLS 유발 요소(width/height, skeleton) 보강
5) 변경 후 Lighthouse 재측정 및 회귀 가드(임계치/변화량) 추가

## Verification checklist
- Perf 점수 상승 및 LCP/INP/CLS 개선 확인
- 문제 URL 개수 감소 확인
`;
}

async function main() {
  const input = mustReadJson(IN_PATH);

  const slim = {
    generatedAt: input.generatedAt,
    thresholds: input.thresholds,
    worst: input.worst,
    summary: input.summary,
    problems: Array.isArray(input.problems) ? input.problems.slice(0, 10) : undefined,
  };

  const prompt = buildPrompt(slim);

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
