# slack-applied-action

Slack 에서 적용한 성능 개선 액션을 GitHub `applied-actions.md` 에 자동 커밋하는 핸들러.
Railway 에 별도 서비스로 배포.

## 진입점 (모두 같은 modal 로 수렴)

1. **"✅ 액션 기록" 버튼** (권장) — 주간 Lighthouse 리포트 스레드의 각 URL 블록 옆 버튼.
   클릭하면 그 URL 의 host 가 자동 입력된 modal 이 열림. 결과는 같은 스레드에 게시.
2. **Message Shortcut "Applied Action 기록"** — 메시지 ⋯ 메뉴. 스레드 안에서도 동작.
3. **`/applied-action <host> <내용>`** 슬래시 커맨드 — 메인 채널 전용 (Slack 정책상 스레드 미지원).

## 동작

modal 또는 슬래시 커맨드 입력 → 서비스가 GitHub Contents API 로 `applied-actions.md` 를
읽고 entry 를 append → 커밋 → Slack 에 결과 응답.

### 멀티라인 입력 분할

modal "적용 내용" textarea 는 여러 줄 입력 가능. 서버가 줄 단위로 분할해 각각 별도 entry 로
저장한다. 규칙:

- 빈 줄 무시
- 공백/탭으로 시작하는 줄은 *이전 entry 의 부연 설명* 으로 간주해 이전 줄에 합침
- 그 외 줄은 새 entry

예시 입력 → 2 개 entry 로 저장:
```
hero 배너 WebP 변환 (LCP)
  → 2.4MB → 380KB
vendor.js 코드 스플리팅 (TBT)
```

## 환경변수

| Key | 필수 | 설명 |
|---|---|---|
| `SLACK_SIGNING_SECRET` | ✓ | Slack App Basic Information → Signing Secret |
| `SLACK_BOT_TOKEN` | 권장 | `xoxb-...`. 있으면 chat.postMessage 로 스레드 안에 응답 게시. 없으면 인라인 JSON fallback (스레드 안에 있어도 채널 노출 가능) |
| `GITHUB_TOKEN` | ✓ | Fine-grained PAT, Contents Read & Write 만 |
| `GITHUB_REPO` | | 기본 `dev2359/site-monitoring` |
| `GITHUB_FILE_PATH` | | 기본 `applied-actions.md` |
| `GITHUB_BRANCH` | | 기본 `main` |
| `COMMIT_AUTHOR_NAME` | | 기본 `applied-action-bot` |
| `COMMIT_AUTHOR_EMAIL` | | 기본 `applied-action-bot@users.noreply.github.com` |
| `PORT` | | Railway 가 자동 주입 |

## 엔드포인트

- `GET /health` 또는 `GET /` — 헬스 체크 (`ok`)
- `POST /applied-action` — Slack 슬래시 커맨드 수신 (메인 채널 전용 — Slack 정책상 스레드 미지원)
- `POST /slack/interactivity` — Slack 인터랙티브 이벤트 수신 (셋 다 같은 endpoint):
  - `message_action` — Message Shortcut 클릭 → modal open
  - `block_actions`  — "✅ 액션 기록" 버튼 클릭 → host prefill 된 modal open
  - `view_submission` — modal 제출 → GitHub 기록 + 스레드 응답

## 로컬 실행

```sh
SLACK_SIGNING_SECRET=... GITHUB_TOKEN=... npm start
```

## Railway 배포

1. Railway 신규 프로젝트 → GitHub `dev2359/site-monitoring` 연결
2. Service settings → Root Directory: `slack-applied-action`
3. Variables 에 위 환경변수 등록
4. Deploy → 발급된 public URL 의 `/applied-action` 을 Slack App 슬래시 커맨드 Request URL 에 등록
