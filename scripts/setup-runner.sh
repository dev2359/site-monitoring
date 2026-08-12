#!/usr/bin/env bash
#
# 국내(춘천) 측정용 self-hosted GitHub Actions runner 프로비저닝.
#
# 왜 필요한가: 기존에는 GitHub 호스티드 러너(US/EU)에서 국내 사이트를 측정해 태평양 왕복
# 지연이 LCP 에 누적됐다. 측정 위치만 국내로 옮기면 해소된다 (README "측정 환경" 참고).
#
# 대상: OCI ap-chuncheon-1 / VM.Standard.E5.Flex / Ubuntu 24.04 x86_64
# 실행: root 또는 sudo. 인스턴스당 한 번만.
#
# 사용법:
#   export RUNNER_TOKEN=<Settings→Actions→Runners→New self-hosted runner 의 토큰>
#   sudo -E bash scripts/setup-runner.sh
#
# 환경변수:
#   RUNNER_TOKEN   (필수) 등록 토큰. 발급 후 1시간 만료.
#   REPO_URL       (기본 https://github.com/dev2359/site-monitoring)
#   RUNNER_NAME    (기본 lh-runner-chuncheon-01)
#   RUNNER_LABELS  (기본 chuncheon) — 워크플로가 이 라벨 하나로 매칭한다.
#   RUNNER_USER    (기본 ghrunner)
#   SMOKE_TEST     (기본 1) — 등록 후 Chrome+Lighthouse 실동작 확인
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dev2359/site-monitoring}"
RUNNER_NAME="${RUNNER_NAME:-lh-runner-chuncheon-01}"
RUNNER_LABELS="${RUNNER_LABELS:-chuncheon}"
RUNNER_USER="${RUNNER_USER:-ghrunner}"
RUNNER_HOME="/opt/actions-runner"
SMOKE_TEST="${SMOKE_TEST:-1}"
SMOKE_URL="https://curicell.kr/product/detail.html?product_no=129"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "root 로 실행하세요: sudo -E bash $0"
[[ -n "${RUNNER_TOKEN:-}" ]] || die "RUNNER_TOKEN 이 필요합니다 (Settings→Actions→Runners→New self-hosted runner)"

ARCH="$(uname -m)"
[[ "$ARCH" == "x86_64" ]] || die "x86_64 전용입니다 (현재: $ARCH). arm64 에는 google-chrome-stable 정식 빌드가 없어 Chromium 으로 대체해야 하고, 그러면 측정 도구가 실사용자 브라우저와 달라집니다."

# ── 1. 기본 패키지 ────────────────────────────────────────────────────────────
log "기본 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# libicu-dev: actions-runner 는 .NET 런타임이라 이게 없으면 config.sh 가 즉시 죽는다.
#             원인 메시지가 불친절해서 처음 겪으면 찾기 어려운 지점.
apt-get install -y -qq curl tar gzip unzip jq git ca-certificates gnupg libicu-dev

# 로그 가독성용. history 스냅샷 타임스탬프는 요약 job(ubuntu-latest)의 `date -u` 라 무관.
timedatectl set-timezone Asia/Seoul || true

# locale 은 건드리지 않는다 — Chrome 의 Accept-Language 가 바뀌면 계속 GitHub 러너(en-US)에서
# 측정하는 해외 사이트와 조건이 달라져 비교 축이 하나 더 생긴다.

# ── 2. swap ──────────────────────────────────────────────────────────────────
# 8GB 면 순차 측정에는 충분하지만, 무거운 상품 상세에서 OOM 으로 회차를 통째로 날리는 것보다
# 안전망을 두는 편이 낫다. swappiness 를 낮춰 실제로 타지 않게 한다 — swap 을 타면 CPU 계열
# 지표가 왜곡되지만, 그 경우 summary.json 의 benchmarkIndex min/max 편차로 감지된다.
if ! swapon --show | grep -q '/swapfile'; then
  log "swap 2GB 생성 (안전망)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# ── 3. Google Chrome ─────────────────────────────────────────────────────────
# GitHub 호스티드 러너에는 프리인스톨돼 있지만 새 VM 에는 없다.
# 이게 빠지면 lhci autorun 이 Chrome 을 못 찾고 즉시 실패한다.
if ! command -v google-chrome >/dev/null 2>&1; then
  log "Google Chrome 설치"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable
fi
CHROME_BIN="$(command -v google-chrome)"
CHROME_VER="$("$CHROME_BIN" --version)"

# ── 4. Node.js ───────────────────────────────────────────────────────────────
# 워크플로는 actions/setup-node 가 tool cache 에 받아 쓰므로 시스템 Node 가 필수는 아니지만,
# 스모크 테스트와 수동 디버깅에 필요하다.
if ! command -v node >/dev/null 2>&1; then
  log "Node.js 20 설치"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

# ── 5. 러너 전용 유저 ─────────────────────────────────────────────────────────
# root 로 Chrome 을 띄우면 sandbox 가 꺼져(--no-sandbox 필요) GitHub 호스티드 러너와
# 실행 조건이 달라진다. 측정 환경을 맞추기 위해 전용 non-root 유저를 쓴다.
if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
  log "러너 유저 생성: $RUNNER_USER"
  useradd -m -s /bin/bash "$RUNNER_USER"
fi

# ── 6. actions-runner 설치 ───────────────────────────────────────────────────
log "actions-runner 다운로드"
mkdir -p "$RUNNER_HOME"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME"

RUNNER_VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/^v//')"
[[ -n "$RUNNER_VERSION" && "$RUNNER_VERSION" != "null" ]] || die "runner 최신 버전 조회 실패"
echo "runner version: $RUNNER_VERSION"

TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
if [[ ! -f "$RUNNER_HOME/config.sh" ]]; then
  curl -fsSL -o "/tmp/$TARBALL" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
  tar -xzf "/tmp/$TARBALL" -C "$RUNNER_HOME"
  rm -f "/tmp/$TARBALL"
  chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME"
fi

# 러너는 자기 디렉터리의 .env 를 서비스 환경변수로 읽는다.
# CHROME_PATH 는 chrome-launcher 가 가장 먼저 보는 힌트라 명시해 둔다.
log "CHROME_PATH 설정"
printf 'CHROME_PATH=%s\n' "$CHROME_BIN" > "$RUNNER_HOME/.env"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME/.env"

# ── 7. 등록 + systemd 서비스 ─────────────────────────────────────────────────
log "러너 등록: $RUNNER_NAME (labels: self-hosted, Linux, X64, $RUNNER_LABELS)"
sudo -u "$RUNNER_USER" \
  "$RUNNER_HOME/config.sh" \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --work _work \
    --unattended --replace

log "systemd 서비스 등록 + 시작"
"$RUNNER_HOME/svc.sh" install "$RUNNER_USER"
"$RUNNER_HOME/svc.sh" start
"$RUNNER_HOME/svc.sh" status || true

# ── 8. 스모크 테스트 ─────────────────────────────────────────────────────────
# 워크플로를 돌리기 전에 이 VM 에서 Chrome+Lighthouse 가 실제로 동작하는지 확인한다.
# 여기서 실패하면 워크플로도 반드시 실패한다.
if [[ "$SMOKE_TEST" == "1" ]]; then
  log "스모크 테스트 (1 URL)"
  sudo -u "$RUNNER_USER" bash -lc "
    set -e
    cd \$(mktemp -d)
    CHROME_PATH='$CHROME_BIN' npx -y lighthouse '$SMOKE_URL' \
      --only-categories=performance --preset=desktop \
      --chrome-flags='--headless=new' --output=json --output-path=./lh.json --quiet
    node -e \"
      const r = require('./lh.json'), a = r.audits;
      console.log('perf        :', Math.round(r.categories.performance.score * 100));
      console.log('LCP         :', Math.round(a['largest-contentful-paint'].numericValue), 'ms');
      console.log('TBT         :', Math.round(a['total-blocking-time'].numericValue), 'ms');
      console.log('benchmarkIdx:', r.environment.benchmarkIndex);
    \"
  "
fi

cat <<EOF

$(printf '\033[1;32m✔ 완료\033[0m')

  runner     : $RUNNER_NAME  (labels: self-hosted, Linux, X64, $RUNNER_LABELS)
  chrome     : $CHROME_VER
  runner ver : $RUNNER_VERSION
  CHROME_PATH: $CHROME_BIN

다음 단계
  1. GitHub Settings → Actions → Runners 에서 "$RUNNER_NAME" 이 Idle 인지 확인
  2. sudo bash scripts/setup-auto-shutdown.sh   ← 자동 종료 설치 (비용 절감의 핵심)
  3. lighthouse-config-test.yml 을 runner=chuncheon 으로 수동 실행 → 로컬/CI 값과 비교
  4. 비교 결과가 기대대로면 lighthouse.yml 의 domestic 2줄을 chuncheon 으로 전환

기록해 두세요 (측정 이력 해석용)
  위 benchmarkIdx 값 — 앞으로 이 러너의 CPU 성능 기준선입니다. summary.json 의
  environment.<device>.benchmarkIndex 가 이 값에서 크게 벗어나면 CPU 경합 신호입니다.
  Chrome 은 apt 로 자동 업데이트되므로 버전이 오르면 지표가 미세하게 이동합니다
  (고정하려면 apt-mark hold google-chrome-stable — 실사용자 브라우저와 멀어지는 트레이드오프).
EOF
