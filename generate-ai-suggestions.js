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

function buildPrompt(input, appliedFiltered) {
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

  const appliedBlock = appliedFiltered && appliedFiltered.kept.length > 0
    ? `

지난 ${APPLIED_WINDOW_WEEKS}주 (약 ${APPLIED_WINDOW_WEEKS * 7}일) 동안 적용된 액션 (각 줄: \`- [YYYY-MM-DD] [host] 내용\`):
\`\`\`
${appliedFiltered.kept.join("\n")}
\`\`\`
검증 규칙(반드시 지킬 것):
1. 위 목록에 있는 액션과 *동일/유사* 한 작업은 "개선 액션" 또는 "Top URL Actions" 의 새 액션으로 **제안하지 말 것**. 대신 현재 metric 으로 *효과 검증* 만 수행.
2. 효과 검증은 아래 둘 중 하나로 분류:
   - **효과 보임**: 해당 host/URL 의 현재 LCP/CLS/TBT 가 액션 기록 이전 측정 대비 개선됨 → 해당 host 의 "Per-site Diagnosis" → '원인 가설' 또는 '개선 액션' 마지막 줄에 \`✅ [YYYY-MM-DD 적용한 X] 가 Y metric 을 Z 만큼 개선시킨 것으로 보임\` 한 줄 추가.
   - **효과 불명/악화**: 액션 기록은 있지만 현재 metric 이 여전히 나쁘거나 더 악화 → 해당 host 의 '개선 액션' 또는 'Cross-cutting Recommendations' 에 \`⚠️ [YYYY-MM-DD 적용한 X] 기록 있으나 현재 Y metric 이 여전히 N — 적용 상태 검증 / 롤백 가능성 확인 권장\` 한 줄 추가.
3. ${APPLIED_WINDOW_WEEKS}주 이전 기록은 이 목록에서 제외됨 — 그 시점에 적용한 액션이라도 다시 제안 가능 (롤백/시간 경과에 따른 재제안 허용).
`
    : "";

  return `
너는 Lighthouse/Core Web Vitals 기반 웹 성능 개선 컨설턴트다.
아래 JSON 은 여러 사이트의 측정 결과로 mobile/desktop URL 별 점수·metric 과 host 별 집계를 포함한다.
${targetsBlock}${appliedBlock}
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

  const prompt = buildPrompt(slim, appliedFiltered);

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
