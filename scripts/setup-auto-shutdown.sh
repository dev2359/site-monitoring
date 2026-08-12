#!/usr/bin/env bash
#
# 측정 러너 자동 종료 설치.
#
# 왜 필요한가: 측정은 주 2회 × 2~3시간(월 약 24시간)뿐인데 상시 가동하면 730시간을 과금한다.
# 인스턴스를 필요할 때만 켜면 월 비용이 약 1/10 로 떨어진다.
#
# 왜 종료를 VM 안에서 하는가: 종료를 GitHub Actions job 에 맡기면 CI 실패·네트워크 장애 시
# 인스턴스가 계속 켜져 요금이 새어나간다. VM 이 스스로 끄면 그 실패 모드가 원리적으로 없다.
# (시작은 외부 트리거가 필요하다 — OCI Resource Scheduler 또는 상시 가동 서버의 cron.)
#
# 실행: root 또는 sudo. setup-runner.sh 이후에 한 번만.
#
# 환경변수:
#   IDLE_MINUTES   (기본 30)  연속 유휴 시간이 이만큼이면 종료
#   GRACE_MINUTES  (기본 90)  부팅 후 이 시간 동안은 유휴 판정을 하지 않음
#   MAX_UPTIME_MIN (기본 360) 부팅 후 이 시간이 지나면 무조건 종료 (백스톱)
#   CHECK_MINUTES  (기본 5)   유휴 점검 주기
#
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-30}"
GRACE_MINUTES="${GRACE_MINUTES:-90}"
MAX_UPTIME_MIN="${MAX_UPTIME_MIN:-360}"
CHECK_MINUTES="${CHECK_MINUTES:-5}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "root 로 실행하세요: sudo bash $0" >&2; exit 1; }

# ── 유휴 감지 스크립트 ────────────────────────────────────────────────────────
# 러너는 job 을 실행할 때 Runner.Worker 프로세스를 띄운다. 그 존재 여부로 작업 중인지 판정한다.
#
# GRACE 가 왜 필요한가: GitHub 의 예약 워크플로는 정시에 뜨지 않는다. cron 이 수 분에서
# 수십 분까지 밀리는 게 흔하다. 00:45 에 VM 을 켰는데 워크플로가 01:20 에 뜨면, 유예가 없으면
# 01:15 에 스스로 꺼져 그 회차를 통째로 날린다. 부팅 직후 일정 시간은 판정을 보류한다.
log "유휴 감지 스크립트 설치 → /usr/local/bin/lh-idle-shutdown.sh"
cat > /usr/local/bin/lh-idle-shutdown.sh <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-30}"
GRACE_MINUTES="${GRACE_MINUTES:-90}"
CHECK_MINUTES="${CHECK_MINUTES:-5}"
COUNT_FILE="${COUNT_FILE:-/run/lh-idle-count}"   # tmpfs — 재부팅 시 자동 초기화

# 로깅 실패가 종료 판정 자체를 중단시키면 자동 종료가 조용히 멈춰 요금이 새므로,
# set -e 하에서도 절대 실패하지 않게 감싼다.
note() { logger -t lh-idle "$*" 2>/dev/null || true; }

# 카운터를 남기지 못하면 유휴가 누적되지 않아 영구히 종료되지 않는다 — 조용히 실패하게 두면
# 안 되는 지점이라, 쓰기 가능 여부를 먼저 확인하고 대체 경로로 넘긴다.
# touch 는 기존 파일을 지우지 않으므로 카운터가 보존된다.
if ! touch "$COUNT_FILE" 2>/dev/null; then
  note "경고: $COUNT_FILE 쓰기 불가 → /var/tmp 로 대체"
  COUNT_FILE=/var/tmp/lh-idle-count
  touch "$COUNT_FILE" 2>/dev/null || { note "치명: 카운터 파일 생성 불가 — 유휴 종료 동작 불가"; exit 1; }
fi
save() { echo "$1" > "$COUNT_FILE" 2>/dev/null || note "경고: 카운터 저장 실패"; }

uptime_min=$(( $(cut -d. -f1 /proc/uptime) / 60 ))

if (( uptime_min < GRACE_MINUTES )); then
  note "grace 구간 (부팅 후 ${uptime_min}분 < ${GRACE_MINUTES}분) — 판정 보류"
  save 0
  exit 0
fi

# Runner.Worker 가 있으면 job 실행 중.
if pgrep -f 'Runner\.Worker' >/dev/null 2>&1; then
  note "작업 중 — 카운터 초기화"
  save 0
  exit 0
fi

count=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
[[ "$count" =~ ^[0-9]+$ ]] || count=0
count=$(( count + 1 ))
save "$count"

idle_min=$(( count * CHECK_MINUTES ))
note "유휴 ${idle_min}분 / 기준 ${IDLE_MINUTES}분"

if (( idle_min >= IDLE_MINUTES )); then
  note "유휴 기준 도달 — 종료"
  /usr/bin/systemctl poweroff
fi
SCRIPT
chmod 755 /usr/local/bin/lh-idle-shutdown.sh

# ── 유휴 점검 타이머 ─────────────────────────────────────────────────────────
log "유휴 점검 타이머 설치 (${CHECK_MINUTES}분 주기)"
cat > /etc/systemd/system/lh-idle-shutdown.service <<EOF
[Unit]
Description=Lighthouse runner idle shutdown check

[Service]
Type=oneshot
Environment=IDLE_MINUTES=${IDLE_MINUTES}
Environment=GRACE_MINUTES=${GRACE_MINUTES}
Environment=CHECK_MINUTES=${CHECK_MINUTES}
ExecStart=/usr/local/bin/lh-idle-shutdown.sh
EOF

cat > /etc/systemd/system/lh-idle-shutdown.timer <<EOF
[Unit]
Description=Run Lighthouse runner idle check every ${CHECK_MINUTES} minutes

[Timer]
OnBootSec=${CHECK_MINUTES}min
OnUnitActiveSec=${CHECK_MINUTES}min
Unit=lh-idle-shutdown.service

[Install]
WantedBy=timers.target
EOF

# ── 절대 상한 백스톱 ─────────────────────────────────────────────────────────
# 유휴 감지가 어떤 이유로든 동작하지 않아도 요금이 무한정 새지 않도록 하는 마지막 방어선.
# 측정은 3시간 안에 끝나므로 6시간이면 정상 동작을 방해하지 않는다.
log "절대 상한 백스톱 설치 (부팅 후 ${MAX_UPTIME_MIN}분)"
cat > /etc/systemd/system/lh-max-uptime.service <<'EOF'
[Unit]
Description=Lighthouse runner absolute uptime cap (cost backstop)

[Service]
Type=oneshot
ExecStart=/usr/bin/logger -t lh-idle "절대 상한 도달 — 강제 종료"
ExecStart=/usr/bin/systemctl poweroff
EOF

cat > /etc/systemd/system/lh-max-uptime.timer <<EOF
[Unit]
Description=Power off ${MAX_UPTIME_MIN} minutes after boot regardless of state

[Timer]
OnBootSec=${MAX_UPTIME_MIN}min
Unit=lh-max-uptime.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now lh-idle-shutdown.timer
systemctl enable --now lh-max-uptime.timer

cat <<EOF

$(printf '\033[1;32m✔ 완료\033[0m')

  유휴 종료 : 연속 ${IDLE_MINUTES}분 유휴 시 (${CHECK_MINUTES}분마다 점검)
  유예 구간 : 부팅 후 ${GRACE_MINUTES}분 — 스케줄 지연 흡수용, 이 동안은 종료하지 않음
  절대 상한 : 부팅 후 ${MAX_UPTIME_MIN}분

예상 가동 시간 (회차당)
  지연 없음    00:45 부팅 → 03:00 측정 완료 → 03:30 종료 = 약 2.75시간
  30분 지연    01:30 시작  → 03:30 완료      → 04:00 종료 = 약 3.25시간
  job 미도착   유예 90분 + 유휴 30분                        = 약 2시간
  → 월 8회 기준 약 24시간

확인 명령
  systemctl list-timers 'lh-*'
  journalctl -t lh-idle -n 30        # 판정 로그
  systemctl start lh-idle-shutdown   # 1회 수동 점검 (유휴면 즉시 종료되니 주의)

남은 작업 — 시작 트리거는 외부에서 걸어야 합니다
  이 스크립트는 종료만 담당합니다. 측정 스케줄(월·목 01:00 KST) 15분 전에 인스턴스를
  켜주는 장치가 별도로 필요합니다. 아래 중 하나:
    a) OCI Resource Scheduler — 콘솔에서 크론만 지정. 추가 개발 없음. 가장 단순.
    b) 상시 가동 중인 서버의 cron + OCI CLI — 측정에 관여하지 않으므로 공유 서버 문제와 무관.
    c) GitHub Actions 선행 job — OCI 자격증명을 secrets 에 넣어야 해서 비권장.
  GitHub 은 조건에 맞는 러너가 나타날 때까지 job 을 큐에 보관하므로, 켜두기만 하면
  별도의 대기 로직은 필요하지 않습니다.
EOF
