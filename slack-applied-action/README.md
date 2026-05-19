# slack-applied-action

Slack `/applied-action` 슬래시 커맨드 핸들러. Railway 에 별도 서비스로 배포.

## 동작

`/applied-action <host> <내용>` 입력 → 이 서비스가 받아서 GitHub Contents API 로
레포 루트의 `applied-actions.md` 에 한 줄 append → 커밋 → Slack 에 결과 응답.

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
- `POST /slack/interactivity` — Message Shortcut(메시지 ⋯ 메뉴) + Modal 제출 수신. 스레드 내 메시지에서도 실행 가능, 결과는 같은 스레드에 게시

## 로컬 실행

```sh
SLACK_SIGNING_SECRET=... GITHUB_TOKEN=... npm start
```

## Railway 배포

1. Railway 신규 프로젝트 → GitHub `dev2359/site-monitoring` 연결
2. Service settings → Root Directory: `slack-applied-action`
3. Variables 에 위 환경변수 등록
4. Deploy → 발급된 public URL 의 `/applied-action` 을 Slack App 슬래시 커맨드 Request URL 에 등록
