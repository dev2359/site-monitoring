#!/usr/bin/env bash
#
# 측정 워크플로를 VM 에서 직접 트리거하도록 설정.
#
# 왜 필요한가: GitHub 예약 워크플로(schedule)가 이 저장소에서 4~7시간씩 밀린다. 특정 워크플로의
# 문제가 아니라 전체가 같이 밀린다 — railway-healthcheck(예약 00:00)는 03:57~05:26 에,
# history-compact(예약 01:00)는 05:25~07:19 에 돌았다. GitHub 의 예약 실행은 보장된 스케줄이
# 아니라 best-effort 큐이기 때문이다.
#
# 그래서 생기는 문제:
#   1) VM 이 15:45 UTC 에 깨어 유예 구간(GRACE_MINUTES) 안에 job 이 안 오면 스스로 꺼진다.
#      → 10/28 · 11/04 · 11/11 · 11/15 회차가 통째로 누락됐다.
#   2) 누락되지 않아도 VM 이 4~7시간을 대기로 날린다. 실제 측정은 2시간 16분인데 가동은 7시간.
#
# 해결: OCI 스케줄러가 VM 을 깨운 직후 VM 이 직접 workflow_dispatch 를 호출한다. 러너가 이미
# 켜져 있으므로 지연이 사실상 0 이 되고, 가동 시간도 측정 시간 + 유휴 30분으로 수렴한다.
#
# 실행: root 또는 sudo. setup-runner.sh / setup-auto-shutdown.sh 이후에 한 번만.
#
# 사전 준비 — GitHub Fine-grained PAT (사용자가 발급):
#   Settings → Developer settings → Personal access tokens → Fine-grained tokens
#     Repository access : dev2359/site-monitoring 만 선택
#     Permissions       : Actions = Read and write  (Metadata = Read 는 자동)
#     Expiration        : 1년 권장 (만료되면 트리거가 조용히 멈추므로 갱신일 기록할 것)
#
# 사용법:
#   export GH_TOKEN=github_pat_xxxxx
#   sudo -E bash scripts/setup-dispatch.sh
#
# 환경변수:
#   GH_TOKEN   (필수) 위 PAT
#   REPO       (기본 dev2359/site-monitoring)
#   WORKFLOW   (기본 lighthouse.yml)
#   REF        (기본 main)
#   BOOT_DELAY (기본 3) 부팅 후 몇 분 뒤에 트리거할지
#
set -euo pipefail

REPO="${REPO:-dev2359/site-monitoring}"
WORKFLOW="${WORKFLOW:-lighthouse.yml}"
REF="${REF:-main}"
BOOT_DELAY="${BOOT_DELAY:-3}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "root 로 실행하세요: sudo -E bash $0"
[[ -n "${GH_TOKEN:-}" ]] || die "GH_TOKEN 이 필요합니다 (위 주석의 Fine-grained PAT 발급 방법 참고)"
command -v jq >/dev/null || die "jq 가 필요합니다 (setup-runner.sh 가 설치함)"

# ── 토큰 선검증 ──────────────────────────────────────────────────────────────
# 설치를 마친 뒤 다음 회차에 가서야 토큰이 틀린 걸 알게 되면 회차를 날린다. 지금 확인한다.
log "토큰 검증"
code=$(curl -s -o /tmp/lh-tok.json -w '%{http_code}' \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW")
[[ "$code" == "200" ]] || die "워크플로 조회 실패 (HTTP $code). 토큰 권한·저장소 범위를 확인하세요: $(head -c 200 /tmp/lh-tok.json)"
echo "  $(jq -r '.name' /tmp/lh-tok.json) — 조회 OK"
rm -f /tmp/lh-tok.json

# ── 설정 파일 ────────────────────────────────────────────────────────────────
log "설정 저장 → /etc/lh-dispatch.env (600)"
cat > /etc/lh-dispatch.env <<EOF
GH_TOKEN=$GH_TOKEN
REPO=$REPO
WORKFLOW=$WORKFLOW
REF=$REF
EOF
chmod 600 /etc/lh-dispatch.env
chown root:root /etc/lh-dispatch.env

# ── 디스패처 ─────────────────────────────────────────────────────────────────
log "디스패처 설치 → /usr/local/bin/lh-dispatch.sh"
cat > /usr/local/bin/lh-dispatch.sh <<'SCRIPT'
#!/usr/bin/env bash
set -uo pipefail
# shellcheck disable=SC1091
. /etc/lh-dispatch.env

note() { logger -t lh-dispatch "$*" 2>/dev/null || true; }
API="https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW"
H_AUTH="Authorization: Bearer $GH_TOKEN"
H_ACC="Accept: application/vnd.github+json"

# 이 VM 은 측정 외의 이유로도 부팅될 수 있다 (수동 시작, 재부팅). 그때 측정이 멋대로 돌지
# 않도록 세 겹으로 막는다.

# 가드 1 — 측정 요일인가 (UTC 일=0 · 수=3 → KST 월·목)
DOW=$(date -u +%w)
case "$DOW" in
  0|3) ;;
  *) note "건너뜀: UTC 요일 $DOW 는 측정일이 아님"; exit 0 ;;
esac

# 가드 2 — OCI 가 깨우는 시간대(15:45 UTC) 부근인가
HOUR=$((10#$(date -u +%H)))
if (( HOUR < 15 || HOUR > 17 )); then
  note "건너뜀: UTC ${HOUR}시는 시작 창(15~17) 밖"
  exit 0
fi

# 가드 3 — 최근 6시간 내 이미 실행됐는가 (재부팅으로 인한 중복 트리거 방지)
SINCE=$(date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ)
RUNS=$(curl -s --max-time 30 -H "$H_AUTH" -H "$H_ACC" "$API/runs?per_page=10")
if [ -n "$RUNS" ] && echo "$RUNS" | jq -e . >/dev/null 2>&1; then
  RECENT=$(echo "$RUNS" | jq -r --arg s "$SINCE" '[.workflow_runs[]? | select(.created_at > $s)] | length')
  if [ "${RECENT:-0}" -gt 0 ]; then
    note "건너뜀: 최근 6시간 내 실행 ${RECENT}건"
    exit 0
  fi
else
  # 조회가 실패해도 트리거는 진행한다 — 중복 실행보다 회차 누락이 더 비싸다.
  note "경고: 최근 실행 조회 실패 — 가드 3 생략하고 진행"
fi

# ── 디스패치 ──
CODE=$(curl -s --max-time 30 -o /tmp/lh-dispatch.out -w '%{http_code}' -X POST \
  -H "$H_AUTH" -H "$H_ACC" "$API/dispatches" \
  -d "{\"ref\":\"$REF\"}")

if [ "$CODE" = "204" ]; then
  note "디스패치 성공 ($WORKFLOW @ $REF)"
  exit 0
fi

note "디스패치 실패 HTTP $CODE: $(head -c 200 /tmp/lh-dispatch.out 2>/dev/null)"
exit 1
SCRIPT
chmod 755 /usr/local/bin/lh-dispatch.sh

# ── systemd ──────────────────────────────────────────────────────────────────
log "부팅 트리거 설치 (부팅 후 ${BOOT_DELAY}분)"
cat > /etc/systemd/system/lh-dispatch.service <<'EOF'
[Unit]
Description=Trigger Lighthouse measurement workflow from this runner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/lh-dispatch.sh
EOF

cat > /etc/systemd/system/lh-dispatch.timer <<EOF
[Unit]
Description=Trigger measurement ${BOOT_DELAY} minutes after boot

[Timer]
OnBootSec=${BOOT_DELAY}min
Unit=lh-dispatch.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable lh-dispatch.timer >/dev/null

# OnBootSec 기준 시각이 이미 지난 상태에서 --now 를 주면 타이머가 즉시 발화한다.
# 여기서는 즉시 측정이 돌아도 무방하지만, 의도치 않은 실행을 막기 위해 다음 부팅부터 적용한다.
UP_MIN=$(( $(cut -d. -f1 /proc/uptime) / 60 ))
if (( UP_MIN < BOOT_DELAY )); then
  systemctl start lh-dispatch.timer
  echo "  타이머 즉시 무장 (uptime ${UP_MIN}분)"
else
  echo "  타이머는 다음 부팅부터 적용 (uptime ${UP_MIN}분 ≥ ${BOOT_DELAY}분 — 지금 켜면 즉시 디스패치됨)"
fi

cat <<EOF

$(printf '\033[1;32m✔ 완료\033[0m')

  저장소   : $REPO
  워크플로 : $WORKFLOW ($REF)
  트리거   : 부팅 후 ${BOOT_DELAY}분
  가드     : UTC 일·수 / 15~17시 / 최근 6시간 내 실행 없을 때만

확인 명령
  systemctl list-timers 'lh-*'
  journalctl -t lh-dispatch -n 20      # 트리거 판정 로그
  sudo /usr/local/bin/lh-dispatch.sh   # 1회 수동 실행 (가드에 걸리면 건너뜀)

다음 단계
  이 트리거가 한 회차 정상 동작한 뒤에 lighthouse.yml 의 schedule(cron) 블록을 제거하세요.
  둘을 같이 두면 GitHub 의 지연된 예약 실행이 중복 회차를 만들거나, concurrency 설정
  (cancel-in-progress: true) 때문에 진행 중인 측정을 취소시킬 수 있습니다.

주의
  PAT 만료 시 트리거가 조용히 멈춥니다 (journalctl 에 HTTP 401 로 남음).
  만료일을 기록해 두고, 갱신 시 /etc/lh-dispatch.env 의 GH_TOKEN 만 교체 후
  systemctl daemon-reload 없이 바로 적용됩니다.
EOF
