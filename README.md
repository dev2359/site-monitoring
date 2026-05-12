# Site Monitoring (Lighthouse CI + GitHub Actions + OpenAI + Slack)

이 저장소는 여러 사이트 URL을 주기적으로 Lighthouse로 측정하고, 결과를 요약/비교/알림까지 자동화하는 모니터링 파이프라인입니다.

## 개요

- Desktop / Mobile을 분리 측정
- URL별 다회 측정(run) 후 집계
- 결과를 `results/summary.json`으로 통합
- 히스토리 스냅샷(`history/*.json`) 누적
- 3개월 비교 테이블 생성
- OpenAI 기반 요약/인사이트 생성
- Slack Webhook 알림 전송

## 저장소 구조

- `.github/workflows/lighthouse.yml`: 전체 실행 워크플로
- `lighthouserc.js`: Desktop LHCI 설정
- `lighthouserc_mobile.js`: Mobile LHCI 설정
- `extract-scores.js`: Desktop/Mobile 결과 파싱 + 요약 생성
- `build-3m-table.js`: 현재 vs 3개월 전 비교 표/CSV 생성
- `generate-3m-ai-analysis.js`: 3개월 추이 AI 분석
- `generate-ai-suggestions.js`: 이번 실행 결과 기반 AI 제안
- `build-slack-payload.js`: Slack 메시지 payload 생성
- `history/*.json`: 실행별 스냅샷 아카이브

## 실행 방식

### GitHub Actions

워크플로: `.github/workflows/lighthouse.yml`

- 스케줄 실행: `cron: "0 16 * * 0,3"` (UTC 기준)
- 수동 실행: `workflow_dispatch`

Job 구성:

1. `lighthouse_desktop`
2. `lighthouse_mobile`
3. `summarize_and_notify` (위 2개 완료 후 실행)

## 필요한 GitHub Secrets

- `OPENAI_API_KEY`: OpenAI API 호출용
- `SLACK_WEBHOOK_URL`: Slack Webhook URL
- (선택) `GITHUB_TOKEN`: 기본 제공 토큰 사용 가능, 별도 설정 불필요

## 주요 산출물

실행 중/후 생성되는 파일:

- `results/summary.json`: 통합 요약 원본
- `results/summary.md`: 요약 Markdown
- `results/compare-3m-all.md`: 3개월 비교 테이블
- `results/compare-3m-all.csv`: 3개월 비교 CSV
- `results/compare-3m-ai.md`: 3개월 AI 인사이트
- `results/ai-input.json`: AI 입력 데이터
- `results/ai-suggestions.md`: AI 제안 결과
- `results/slack-payload.json`: Slack 전송 payload

그리고 워크플로에서 `history/<timestamp>.json`으로 스냅샷을 커밋/푸시합니다.

## 측정 설정 포인트

### Desktop (`lighthouserc.js`)

- `numberOfRuns: 5`
- `formFactor: "desktop"`
- `throttlingMethod: "devtools"`
- `maxWaitForLoad: 90000`

### Mobile (`lighthouserc_mobile.js`)

- `numberOfRuns: 5`
- `formFactor: "mobile"`
- `screenEmulation` 활성화
- `throttlingMethod: "simulate"`
- `maxWaitForLoad: 90000`

## 집계/판정 로직

`extract-scores.js`에서:

- Lighthouse 결과(JSON/manifest)를 파싱
- URL+디바이스 단위로 평균 집계
- `warn`, `crit` 임계값으로 상태 판정
- 문제 URL 목록 및 invalid 보고서 생성

## 로컬 실행(선택)

Node.js 18+ 기준:

```bash
npm install -g @lhci/cli
lhci autorun --config=lighthouserc.js
lhci autorun --config=lighthouserc_mobile.js
node extract-scores.js
node build-3m-table.js
node generate-3m-ai-analysis.js
node generate-ai-suggestions.js
node build-slack-payload.js
```

`generate-*` 스크립트는 `OPENAI_API_KEY` 환경변수가 필요합니다.

## 트러블슈팅

### 1) `NO_FCP` 오류 (페이지가 paint되지 않음)

특정 URL에서 간헐적으로 발생할 수 있습니다.

- 원인 예시: 봇 차단, 지역/네트워크 이슈, 렌더링 타임아웃, 일시적 서버 응답 문제
- 대응:
  - 문제 URL 단독 재실행으로 재현 확인
  - `numberOfRuns` 조정(예: 5 -> 3)
  - `maxWaitForLoad` 상향
  - 문제 URL을 별도 잡으로 분리해 전체 실패 전파 방지

### 2) 3개월 비교 표에서 현재값(`Now`) 빈값

- `results/summary.json`의 `items`가 비어 있거나 누락되면 발생
- `extract-scores.js` 실행 결과의 `items` 필드 존재 여부 확인

### 3) URL 오타/리다이렉트

- URL 오타는 측정 실패/왜곡의 주요 원인입니다.
- 최종 URL로 리다이렉트되는 경우 집계에서 예상과 다른 URL 키로 보일 수 있습니다.

## 운영 팁

- URL 수가 많아 실행 시간이 길다면:
  - 사이트군별로 워크플로 분리
  - run 수를 URL 중요도별로 차등
- Slack 알림 노이즈가 많으면:
  - `warn`/`crit` 임계값 재조정
  - invalid 보고서와 분리 알림

