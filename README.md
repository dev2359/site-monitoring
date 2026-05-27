# Site Monitoring (Lighthouse CI + GitHub Actions + OpenAI + Slack)

이 저장소는 여러 사이트 URL을 주기적으로 Lighthouse로 측정하고, 결과를 요약/비교/알림까지 자동화하는 모니터링 파이프라인입니다.

## 개요

- Desktop / Mobile을 분리 측정
- URL별 다회 측정(run) 후 집계 (trimmed mean)
- 결과를 `results/summary.json`으로 통합
- 히스토리 스냅샷(`history/*.json`) 누적
- 3개월 비교 테이블 + WoW(주간) 비교 + 회귀 보고서 생성
- OpenAI 기반 사이트별/URL별 개선 액션 자동 제안 (이미 적용한 액션은 효과 검증으로 전환)
- Slack 채널에 메인 + 스레드 분리 발송, 호스트별 담당자 자동 멘션
- Slack 리포트의 URL 블록 "✅ 액션 기록" 버튼 또는 Message Shortcut 으로 "적용한 액션"을 GitHub 에 자동 커밋 → 다음 실행부터 재제안 방지

## 저장소 구조

### 워크플로

- `.github/workflows/lighthouse.yml`: 전체 실행 워크플로 (스케줄 + 수동)
- `.github/workflows/slack-test-send.yml`: Lighthouse 측정을 **스킵**하고 마지막 history 스냅샷으로 Slack 메시지만 재발송 — 리포트 포맷 검증용
- `.github/workflows/slack-delete.yml`: ts 입력받아 봇이 보낸 Slack 메시지 삭제 (메인/스레드 여러 ts 콤마 구분 가능)
- `.github/workflows/railway-healthcheck.yml`: Railway 의 `slack-applied-action` 서비스 `/health` 를 매일 1회 ping. 실패 시 Slack webhook 으로 알림 — 액션 기록이 조용히 누락되는 상황 방지
- `.github/workflows/history-compact.yml`: `history/` 의 오래된 스냅샷을 *주별 1개* 로 정리. **기본 dry-run** (목록만 Job Summary 출력), 수동 실행에서 `dry_run=false` 선택 시 실제 삭제 + 커밋

### 측정 / 집계

- `urls.js`: 측정 대상 URL 중앙 관리. `desktop`/`mobile` × `domestic`/`global` 4 그룹. domestic = 국내 hosting(.kr/.co.kr + themedion.com, bifigen.com), global = 해외 hosting(lactomedi/celladix 의 .com/.sg/.jp/.us)
- `lighthouserc.js`: Desktop LHCI 설정. `LH_SCOPE`(domestic/global) 환경변수로 `urls.desktop[scope]` 선택. throttling 은 로컬 DevTools 와 동일한 `simulate`
- `lighthouserc_mobile.js`: Mobile LHCI 설정. 동일하게 `LH_SCOPE` 로 `urls.mobile[scope]` 선택
- `extract-scores.js`: Desktop/Mobile 결과 파싱 + 요약 생성. `module.exports = { buildAiInput, buildSummary }` 로 재사용 가능
- `regenerate-ai-input.js`: `results/summary.json` 에서 `results/ai-input.json` 만 다시 생성하는 헬퍼 (`slack-test-send.yml` 이 사용)
- `compact-history.js`: `history/` 의 오래된 스냅샷을 ISO 주별 1개씩만 남기고 정리. `DRY_RUN` 환경변수로 dry-run/real-delete 토글. `history-compact.yml` 워크플로가 호출
- `build-3m-table.js`: 현재 vs 과거 비교 표/CSV 생성. `PAST_DAYS`/`OUT_MD`/`OUT_CSV`/`COMPARE_TITLE`/`COMPARE_LABEL` 환경변수로 윈도 변경 가능 (3개월 + WoW 두 번 호출). 표에 per-URL 8주 sparkline trend 컬럼 포함. baseline floor: `2026-04-22`
- `build-regressions.js`: WoW 비교 CSV 에서 perf Δ ≤ -10 인 URL 만 추출해 회귀 보고서 생성 (Job Summary 전용)

### AI 분석

- `generate-3m-ai-analysis.js`: 3개월 추이 AI 분석
- `generate-ai-suggestions.js`: 이번 실행 결과 기반 AI 제안 (TL;DR + Per-site Diagnosis + Top URL Actions + Cross-cutting 4섹션 구조). 레포 루트 `applied-actions.md` 가 있으면 *최근 `APPLIED_WINDOW_WEEKS` 주(기본 12주)* 분량만 프롬프트에 주입 → 그 윈도 안의 액션은 재제안 대신 현재 metric 으로 *효과 검증* 코멘트로 전환 (✅ 효과 보임 / ⚠️ 적용 기록은 있으나 metric 미개선 → 롤백 가능성 확인). Slack 에는 Top 6 URL(모바일 3 + 데스크탑 3) 액션, GitHub Job Summary 에는 전 섹션 노출

### Slack 발송 / 삭제

- `build-slack-payload.js`: Slack 메시지 payload 생성. 결과는 `{ main, thread }` 구조 — 메인은 헤더 / WoW 요약 / 대시보드 링크만, 스레드 댓글엔 Top Mobile/Desktop Problems · AI TL;DR · URL별 Best Action · 담당자 멘션을 각각 별도 section block 으로 분할 (Slack "자세히 보기" 토글 회피)
- `send-slack.js`: payload 를 실제 Slack 에 전송. `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` 가 있으면 `chat.postMessage` 로 메인 + 스레드 분리 발송 후 ts 출력(삭제용), 없으면 `SLACK_WEBHOOK_URL` 로 메인만 fallback. `unfurl_links: false, unfurl_media: false` 로 링크 미리보기 비활성화
- `delete-slack-message.js`: `chat.delete` API 로 봇 메시지 삭제. `DELETE_TS` 환경변수에 콤마/공백 구분 다중 ts 지원

### 담당자 매핑 / 적용 액션

- `owners.json`: host → Slack 사용자/그룹 ID 매핑 (`U...` 개인 / `S...` 사용자 그룹). 스레드 댓글의 담당자 멘션에 사용. 매핑 누락 시 `_default` 키로 대체. 멘션 대상은 Slack 에 노출되는 Top 6 URL 의 호스트로 한정
- `applied-actions.md`: 매주 적용한 개선 액션을 한 줄씩 기록. **두 가지 경로**로 갱신됨 — (a) 사용자가 직접 PR/커밋, (b) Slack `/applied-action` 슬래시 커맨드 또는 Message Shortcut → `slack-applied-action/` 서비스 → GitHub Contents API 로 자동 커밋. AI 제안의 신선도 유지 + 효과 검증 유도
- `slack-applied-action/`: Slack `/applied-action` 슬래시 커맨드 + Message Shortcut("Applied Action 기록") 핸들러. **Railway 별도 서비스로 배포**. 상세는 [slack-applied-action/README.md](slack-applied-action/README.md)

### 노션 동기화

- `sync-notion.js`: 매주 Lighthouse 실행 후 `results/compare-wow.csv` 를 노션에 push. **두 DB 분담** — (a) **Master DB** 에 한 row 추가하고 그 row 의 detail page 안에 ⚠️ Regressions 요약 + 📊 Full Table (inline DB, 11 컬럼) 생성 (주차별 archive), (b) `NOTION_CURRENT_DB_ID` 등록 시 **Current DB** 에 (URL, Device) 키로 upsert (항상 최신 79 rows, 사용자 view 영구 유지). Status 는 노션 Formula 로 Perf Δ 기준 🚨 / ✅ / ➖ 자동 분류

### 데이터

- `history/*.json`: 실행별 스냅샷 아카이브 (워크플로가 자동 커밋)

## 실행 방식

### GitHub Actions — 주간 측정

워크플로: `.github/workflows/lighthouse.yml`

- 스케줄 실행: `cron: "0 16 * * 0,3"` (UTC 기준)
- 수동 실행: `workflow_dispatch`

Job 구성:

1. `lighthouse` (matrix: `device`(desktop/mobile) × `scope`(domestic/global) = **4 jobs 병렬**) — 각 job 이 `LH_SCOPE` 로 해당 URL 그룹만 측정. scope 별 결과는 manifest 제거 후 device 별 artifact 로 업로드. `matrix.runner` 로 runner 지정 — 나중에 domestic 만 `self-hosted`(Seoul) 로 바꾸면 국내 사이트만 한국 환경 측정
2. `summarize_and_notify` (위 완료 후) — 4 artifact 를 device 별 merge → 요약 / 3개월 비교 / WoW 비교 / 회귀 보고서 / AI 분석 + 제안 / Slack 발송 / 노션 sync (secret 등록 시) / history 커밋

### GitHub Actions — 운영 유틸

- `slack-test-send.yml` (`workflow_dispatch`): 마지막 history 스냅샷 → `results/summary.json` 시드 → `regenerate-ai-input.js` → 비교/회귀/AI/페이로드 → Slack 발송. **Lighthouse 측정을 안 거치므로 1~2분 안에 끝남**. 리포트 포맷 검증/리허설용. 노션 sync 는 기본 skip — `sync_notion=true` input 으로 명시적으로 켤 수 있음 (테스트 데이터로 노션 archive 더럽힘 방지)
- `slack-delete.yml` (`workflow_dispatch`): 입력받은 ts 의 봇 메시지를 삭제. 콤마/공백으로 메인 ts + thread ts 등 다중 입력 가능. ts 는 `slack-test-send.yml` 실행 로그의 `main posted (ts=...)` / `thread reply posted (ts=...)` 라인에서 확인
- `railway-healthcheck.yml` (스케줄 + 수동): 매일 1회 Railway `/health` 호출. 실패 시 Slack 으로 "🚨 액션 기록 누락 위험" 알림. Secret `RAILWAY_HEALTH_URL` 필요
- `history-compact.yml` (스케줄 + 수동, **기본 dry-run**): 매주 월요일 `compact-history.js` 실행. dry-run 모드는 어떤 파일이 삭제될지 Job Summary 에만 표시 — 결과 확인 후 수동으로 `dry_run=false` 선택해 실제 삭제 수행

### Railway — `slack-applied-action/` 서비스

`/applied-action` 슬래시 커맨드 + Message Shortcut("Applied Action 기록") 을 처리. 사용자가 Slack 에서 적용한 액션을 입력하면 GitHub Contents API 로 `applied-actions.md` 에 자동 커밋. 다음 주간 실행부터 AI 가 그 액션을 재제안하지 않고 효과 검증으로 전환.

상세 설정 (환경변수, 배포 방법) 은 [slack-applied-action/README.md](slack-applied-action/README.md) 참고.

## 필요한 GitHub Secrets

- `OPENAI_API_KEY`: OpenAI API 호출용
- `SLACK_BOT_TOKEN`: Slack Bot User OAuth Token (`xoxb-...`). 스레드 분리 발송 및 봇 메시지 삭제에 필수. Bot Token Scope 에 `chat:write` 권한 필요
- `SLACK_CHANNEL_ID`: 메시지를 발송할 Slack 채널 ID (`C0XXXXXXXX`). 채널에 봇이 초대돼 있어야 함 (`/invite @앱이름`)
- (선택) `SLACK_WEBHOOK_URL`: `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` 미설정 시의 fallback. 이 모드는 스레드 분리 불가. **`railway-healthcheck.yml` 알림에도 재사용됨**
- (선택) `RAILWAY_HEALTH_URL`: `railway-healthcheck.yml` 이 ping 하는 URL. 예: `https://<service>.up.railway.app/health`. 미설정 시 헬스체크 워크플로가 실패하므로, slack-applied-action 서비스를 운영한다면 등록 권장
- (선택) `NOTION_TOKEN`: Notion Internal Integration Token. `ntn_...` 또는 `secret_...` 둘 다 가능. `sync-notion.js` 가 호출. 미설정이면 노션 sync step 자동 skip
- (선택) `NOTION_WEEKLY_DB_ID` (권장) / `NOTION_PARENT_PAGE_ID` (호환): Master DB ID. 사용자가 만든 DB 를 integration 에 share 한 뒤 DB ID 등록. 매주 워크플로가 이 DB 에 한 row 추가, 그 row 의 detail page 안에 `📊 YYYY-MM-DD Weekly` sub-DB 자동 생성. 두 secret 이름 모두 인식 (`NOTION_WEEKLY_DB_ID` 우선)
- (선택) `NOTION_CURRENT_DB_ID`: Current DB ID. 설정 시 매주 같은 (URL, Device) row 를 upsert — 항상 최신 79 rows 유지. 사용자가 노션에서 정렬/필터/메모 한 번 셋업하면 영구 보존
- `GITHUB_TOKEN`: 기본 제공 토큰 사용, 별도 설정 불필요 (history 자동 커밋용)

### Railway (`slack-applied-action`) 서비스 환경변수

`slack-applied-action/` 디렉터리 Root 로 배포한 서비스에 등록.

- `SLACK_SIGNING_SECRET`: Slack App **Basic Information → Signing Secret** (요청 서명 검증)
- `SLACK_BOT_TOKEN`: 위와 동일 (스레드에 결과 게시 + Modal 열기)
- `GITHUB_TOKEN`: Fine-grained PAT (Contents: Read & Write 만, 본 레포 한정 권장)
- (선택) `GITHUB_REPO` / `GITHUB_FILE_PATH` / `GITHUB_BRANCH` / `COMMIT_AUTHOR_NAME` / `COMMIT_AUTHOR_EMAIL`: 기본값 사용 시 생략

### Notion 셋업 (선택)

매주 노션 Master DB 에 한 주차 row 가 자동 추가되도록:

1. **Integration 생성**: https://www.notion.so/profile/integrations → "+ New integration" (Internal) → Save → **Internal Integration Secret** 복사 (`ntn_...` 또는 `secret_...`)
2. **Master DB 생성**: 노션에 새 데이터베이스 (full page 또는 inline) — 이름 예: `Weekly Snapshots`. 다음 컬럼 셋업:

   | 컬럼 | Type | 비고 |
   |---|---|---|
   | (Title — 임의 이름) | Title | 코드가 자동 감지 |
   | Date | Date | |
   | Regressions | Number | |
   | Improvements | Number | |
   | Total URLs | Number | |
   | Past Snapshot | Text (rich_text) | |

   (Title 외 컬럼은 누락돼 있어도 skip + warning 으로 처리됨)

3. **Integration 권한**: DB 우상단 `···` → **Connections** → 위 integration 추가
4. **DB ID 복사**: DB URL 의 32자 hex (dash 포함 형식도 OK)
5. **GitHub Secrets 등록**:
   - `NOTION_TOKEN` = 1단계의 token
   - `NOTION_WEEKLY_DB_ID` = 4단계의 DB ID (또는 기존 `NOTION_PARENT_PAGE_ID` 의 값으로 등록해도 OK — fallback 지원)

이후 매주 lighthouse 실행 시 Master DB 에 한 row 추가:

```
Master DB: Weekly Snapshots
┌───────────────────────────────────────────────────────────┐
│ Title           │ Date  │ Reg │ Imp │ Total │ Past Snap  │
├───────────────────────────────────────────────────────────┤
│ 📊 2026-05-26 W │ 5/26  │  1  │ 11  │  79   │ 2026-05-19 │ ← click
│ 📊 2026-05-19 W │ 5/19  │  3  │  2  │  79   │ 2026-05-12 │
└───────────────────────────────────────────────────────────┘
                            ↓
              row detail page:
              ├ ⚠️ Regressions (perf Δ ≤ -10) bulleted list
              ├ ℹ️ 회귀/개선/총 URL 카운트 callout
              └ 📊 Full Table (inline DB, 11 컬럼)
                  URL · Device · Host · Path · Trend(8w)
                  Perf Now/Δ · LCP Now/Δ · CLS Now
                  Status (Formula 자동: 🚨 회귀 / ✅ 개선 / ➖ 유지)
```

> ⚠️ 매주 새 inline DB 가 생성되므로, 노션에서 컬럼 type 을 수동 수정해도 다음 주 새 DB 에는 적용 안 됨. schema 변경이 필요하면 [sync-notion.js](sync-notion.js) 의 `createInlineDatabase()` 를 수정.

#### (선택) Current DB — 최신 상태만 upsert

Master DB 의 inline DB 는 매주 새로 만들어지므로 사용자 정렬/필터/메모가 보존되지 않습니다.
별도로 *항상 최신 79 rows 만* 유지하는 Current DB 를 두면 한 번 셋업한 view 가 영구 유지됩니다.

1. **새 DB 생성** — 이름 예: `Latest URLs Snapshot`
2. **컬럼 셋업** — Master 의 inline DB 와 같은 schema:

   | 컬럼 | Type | 비고 |
   |---|---|---|
   | URL | Title | (자동 감지) |
   | Device | Select | mobile / desktop |
   | Host | Select | |
   | Status | Formula | `if(prop("Perf Δ") <= -5, "🚨 회귀", if(prop("Perf Δ") >= 5, "✅ 개선", "➖ 유지"))` |
   | Perf Now / Perf Δ / LCP Now / LCP Δ / CLS Now | Number | |
   | Trend (8w) / Path | Text (rich_text) | |

3. **Integration 권한** 추가
4. **GitHub Secret** `NOTION_CURRENT_DB_ID` = 새 DB ID 등록

이후 매주 워크플로가:
- Master DB 에 row 추가 (archive)
- Current DB 의 (URL, Device) row 를 query → 있으면 update, 없으면 create

→ 한 번 노션에서 정렬/필터/Group by Host 같은 view 셋업하면 매주 그대로 유지됨. 사용자가 row 옆에 단 메모/커스텀 컬럼도 보존됨.

(옵션) `NOTION_ARCHIVE_STALE=true` env 면 새 CSV 에 없는 기존 Current DB row 를 자동 archive. 기본은 안전하게 유지.

### Slack App 설정 요약

- **Bot Token Scopes**: `chat:write`, `commands`
- **Slash Commands**: `/applied-action` → Request URL: Railway 서비스의 `POST /applied-action`
- **Interactivity & Shortcuts**:
  - Interactivity Request URL: Railway 서비스의 `POST /slack/interactivity`
  - Message Shortcut: Name "Applied Action 기록", Callback ID `record_applied_action` — 메시지 ⋯ 메뉴에서 실행. 스레드 안에서도 가능 (슬래시 커맨드는 Slack 정책상 스레드 불가 → Shortcut 필수)

## 주요 산출물

실행 중/후 생성되는 파일:

- `results/summary.json`: 통합 요약 원본
- `results/summary.md`: 요약 Markdown
- `results/compare-3m-all.md` / `.csv`: 3개월 비교 (sparkline trend 포함)
- `results/compare-wow.md` / `.csv`: 주간(WoW) 비교
- `results/regressions-wow.md`: WoW 회귀 보고서 (perf Δ ≤ -10 만 — Job Summary 전용)
- `results/compare-3m-ai.md`: 3개월 AI 인사이트
- `results/ai-input.json`: AI 입력 데이터
- `results/ai-suggestions.md`: AI 제안 결과 (TL;DR / Per-site / Top URL Actions / Cross-cutting)
- `results/slack-payload.json`: Slack 전송 payload (`{ main, thread }` 구조)

그리고 워크플로에서 `history/<timestamp>.json`으로 스냅샷을 커밋/푸시합니다.

## 측정 설정 포인트

### Desktop (`lighthouserc.js`)

- `numberOfRuns: 5`
- `formFactor: "desktop"`
- `screenEmulation` 1350×940, DPR 1 (로컬 DevTools desktop preset 과 동일)
- `throttlingMethod: "simulate"` (로컬 Chrome DevTools 기본값과 일치 — `devtools` 와 달리 runner 의 네트워크 throttle 을 모델값 `rttMs:40` 으로 대체)
- `throttling`: rttMs 40 / throughputKbps 10240 / cpuSlowdownMultiplier 1
- `maxWaitForLoad: 90000`

### Mobile (`lighthouserc_mobile.js`)

- `numberOfRuns: 5`
- `formFactor: "mobile"`
- `screenEmulation` 활성화 (390×844, DPR 2 — iPhone 계열에 가깝게)
- `throttlingMethod: "simulate"`
- `throttling`: rttMs 150 / throughputKbps 5000 (국내 LTE/5G 체감에 근접 — simulate 용 key 로 정정)
- `cpuSlowdownMultiplier: 1` (CPU throttle 없음 — 상위 단말 기준)
- `maxWaitForLoad: 90000`

> 주의 1: Lighthouse 공식 Mobile 프리셋(CPU 4x, Slow 4G)보다 느슨하므로, 본 측정 점수는 PageSpeed Insights/Chrome DevTools 기본 Mobile 결과보다 높게 나옵니다. 실제 자사 이용자(국내 LTE/5G·상위 iPhone) 환경에 맞춘 의도적인 설정입니다.
>
> 주의 2: `simulate` 로 네트워크 throttle 은 로컬과 맞췄지만, **GitHub runner(US/EU)의 한국 서버까지 실제 RTT(server-side latency)는 못 줄입니다** — 국내 사이트의 LCP 가 로컬 대비 높게 나오는 주원인. 근본 해결은 국내(Seoul) self-hosted runner 로 domestic 측정을 옮기는 것 (workflow matrix 의 `runner` 만 변경하면 됨).

## 집계/판정 로직

`extract-scores.js`에서:

- Lighthouse 결과(JSON/manifest)를 파싱
- URL+디바이스 단위로 **trimmed mean**(상하 1개 제외 평균, 4 run 이상일 때) 집계 → runner 노이즈/outlier 완화
- 임계값(아래)으로 상태 판정
- 문제 URL 목록 및 invalid 보고서 생성

### 임계값 (Performance score, 100점 만점)

- `WARN`: 80 미만 (`warn: 0.8`)
- `CRIT`: 60 미만 (`crit: 0.6`)
- `OK`: 80 이상

Slack 알림은 전체 `overall.status !== "OK"`일 때만 전송됩니다.

## 로컬 실행(선택)

Node.js 18+ 기준:

```bash
npm install -g @lhci/cli
lhci autorun --config=lighthouserc.js
lhci autorun --config=lighthouserc_mobile.js
node extract-scores.js
node build-3m-table.js
# WoW 비교 (별도 환경변수)
PAST_DAYS=7 OUT_MD=results/compare-wow.md OUT_CSV=results/compare-wow.csv \
  COMPARE_TITLE="Week-over-Week Comparison" COMPARE_LABEL="Past (~7d ago)" \
  node build-3m-table.js
node build-regressions.js
node generate-3m-ai-analysis.js
node generate-ai-suggestions.js
node build-slack-payload.js
node send-slack.js     # 실제 발송 (SLACK_BOT_TOKEN/CHANNEL_ID 필요)
```

`generate-*` 스크립트는 `OPENAI_API_KEY` 환경변수가 필요합니다.

### Slack 메시지 포맷만 검증 (Lighthouse 스킵)

리포트 포맷 변경을 검증하고 싶을 때는 GitHub UI 에서 **Actions → Slack Test Send (skip measurements) → Run workflow** 실행 (1~2분 소요). 발송 결과의 ts 가 로그에 출력되므로, 잘못 보낸 경우 **Slack Delete Message** 워크플로에 그 ts 를 입력해 삭제할 수 있습니다.

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
- **적용한 액션을 빠짐없이 기록**해야 AI 제안 품질이 유지됩니다.
  - 권장: 주간 리포트 스레드의 각 URL 블록 옆 **"✅ 액션 기록" 버튼** (host 자동 입력)
  - 대안: 메시지 ⋯ 메뉴 → **"Applied Action 기록"** Shortcut (스레드 안에서도 가능)
  - 메인 채널에서는 `/applied-action <host> <내용>` 슬래시 커맨드도 사용 가능
  - modal 의 "적용 내용" 은 **여러 줄 입력 가능** — 줄당 1 entry 로 자동 분할, 들여쓰기로 시작한 줄은 이전 entry 의 부연으로 합쳐짐
  - 모든 경로가 `applied-actions.md` 에 자동 커밋 → 다음 주간 실행부터 같은 액션 재제안 차단 + 효과 검증으로 전환
- 담당자가 바뀌면 `owners.json` 의 host → Slack ID 매핑을 업데이트하세요. `_default` 가 fallback 입니다.

