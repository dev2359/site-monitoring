# scripts

국내(춘천) 측정 러너 구축 스크립트. 측정 대상 사이트가 국내 호스팅인데 GitHub 호스티드
러너(US/EU)에서 측정해 태평양 왕복 지연이 LCP 에 누적되던 문제를 해소하기 위한 것.
배경은 루트 [README.md](../README.md) 의 "측정 환경" 절 참고.

## 실행 순서

새 인스턴스에서 딱 두 번 실행한다.

```bash
# 1) 러너 설치 — Chrome, Node, actions-runner 등록, systemd 서비스, 스모크 테스트
export RUNNER_TOKEN=<Settings→Actions→Runners→New self-hosted runner 의 토큰>
sudo -E bash scripts/setup-runner.sh

# 2) 자동 종료 설치 — 비용 절감의 핵심
sudo bash scripts/setup-auto-shutdown.sh
```

`RUNNER_TOKEN` 은 **발급 후 1시간 만료**라 실행 직전에 받는다.

## 대상 환경

| | |
|---|---|
| 리전 | OCI `ap-chuncheon-1` (또는 `ap-seoul-1`) |
| Shape | `VM.Standard.E5.Flex` 2 OCPU (4 vCPU) / 8GB |
| OS | Ubuntu 24.04 **x86_64** |
| 러너 라벨 | `chuncheon` |

**x86_64 전용**이다. arm64 에는 `google-chrome-stable` 정식 빌드가 없어 Chromium 으로
대체해야 하고, 그러면 측정 도구가 실사용자 브라우저와 달라진다. 스크립트가 아키텍처를
검사하고 arm64 면 중단한다.

## setup-runner.sh

- **`libicu-dev`** — actions-runner 가 .NET 런타임이라 없으면 `config.sh` 가 즉시 죽는다.
  에러 메시지가 불친절해서 처음 겪으면 원인 찾기 어려운 지점.
- **Google Chrome** — GitHub 호스티드 러너에는 프리인스톨돼 있지만 새 VM 에는 없다.
  빠지면 `lhci autorun` 이 Chrome 을 못 찾고 실패한다. 경로를 러너 `.env` 의 `CHROME_PATH` 에 기록.
- **non-root 유저(`ghrunner`)** — root 로 Chrome 을 띄우면 sandbox 가 꺼져 GitHub 호스티드
  러너와 실행 조건이 달라진다. 측정 환경을 맞추기 위한 것.
- **locale 미변경** — Chrome 의 `Accept-Language` 가 바뀌면 계속 GitHub 러너(en-US)에서
  측정하는 해외 사이트와 조건이 달라져 비교 축이 하나 더 생긴다.
- 마지막에 스모크 테스트로 `benchmarkIndex` 를 출력한다. **이 값을 기록해 둘 것** —
  이후 `summary.json` 의 `environment.<device>.benchmarkIndex` 가 여기서 크게 벗어나면
  CPU 경합 신호다.

## setup-auto-shutdown.sh

측정은 주 2회 × 2~3시간(월 약 24시간)뿐이라 상시 가동은 낭비다. 종료를 **VM 스스로**
수행하게 해서, GitHub 쪽 실패로 인한 요금 누수 가능성을 없앤다.

| 장치 | 동작 |
|---|---|
| 유휴 종료 | `Runner.Worker` 프로세스가 연속 30분 없으면 종료 (5분마다 점검) |
| 유예 구간 | 부팅 후 90분은 판정 보류 |
| 절대 상한 | 부팅 후 360분이면 무조건 종료 |

**유예 구간이 왜 필요한가**: GitHub 의 예약 워크플로는 정시에 뜨지 않고 수 분~수십 분 밀린다.
00:45 에 켰는데 워크플로가 01:20 에 뜨면 유예 없이는 01:15 에 스스로 꺼져 그 회차를 날린다.

### 시작 트리거는 별도

이 스크립트는 **종료만** 담당한다. 스케줄(월·목 01:00 KST) 15분 전에 인스턴스를 켜주는
장치가 따로 필요하다.

1. **OCI Resource Scheduler** — 콘솔에서 크론만 지정. 추가 개발 없음. 가장 단순.
2. **상시 가동 서버의 cron + OCI CLI** — 측정에 관여하지 않으므로 공유 서버 문제와 무관.
3. GitHub Actions 선행 job — OCI 자격증명을 secrets 에 넣어야 해서 비권장.

GitHub 은 조건에 맞는 러너가 나타날 때까지 job 을 큐에 보관하므로, 켜두기만 하면 워크플로
쪽에 대기 로직은 필요하지 않다.

## 러너 등록 후

1. Settings → Actions → Runners 에서 러너가 `Idle` 인지 확인
2. [lighthouse-config-test.yml](../.github/workflows/lighthouse-config-test.yml) 을
   `runner=chuncheon` 으로 수동 실행 → `ubuntu-latest` 결과와 비교
3. 기대대로면 [lighthouse.yml](../.github/workflows/lighthouse.yml) matrix 의 domestic 2줄을
   `chuncheon` 으로 전환
4. **기준선 단절 처리** — 전환 시점 이전 데이터가 비교에 섞이지 않도록
   `EARLIEST_BASELINE_DATE` 를 전환일로 올린다.
   [evaluate-applied-actions.js](../evaluate-applied-actions.js) 와
   [build-3m-table.js](../build-3m-table.js) **두 파일 모두** 수정해야 한다.

## 점검 명령

```bash
systemctl list-timers 'lh-*'        # 타이머 상태
journalctl -t lh-idle -n 30         # 유휴 판정 로그
sudo /opt/actions-runner/svc.sh status
```
