# Applied Actions

매주 적용한 개선 액션을 이 파일에 한 줄씩 기록하세요. CI 의 `generate-ai-suggestions.js`
가 이 파일을 읽어 AI 프롬프트에 주입하므로, 이미 적용한 액션이 매주 같은 조언으로
반복되는 것을 막고, 다음 측정에서 효과 검증 코멘트가 나오도록 유도합니다.

## 작성 형식

```
- [YYYY-MM-DD] host 적용 내용 한 줄 (어떤 metric 을 노린 변경인지 포함)
```

예시:
```
- [2026-05-18] wellit.co.kr hero 배너 WebP 변환 + fetchpriority="high" 적용 (LCP 단축 목적)
- [2026-05-18] celladix.co.kr GA/Meta Pixel 스크립트 defer 적용 (TBT 단축 목적)
- [2026-05-25] themedion.com 폰트 5종 → 2종 축소 + woff2 preload 추가 (FCP/LCP 동시 개선 목적)
```

## Slack 에서 자동 기록 (권장)

직접 편집하는 대신 Slack 리포트 스레드의 각 URL 블록 옆 **"✅ 액션 기록" 버튼**을 누르면
host 가 자동 입력된 modal 이 열립니다. 내용만 적어 제출하면 이 파일에 한 줄씩 자동 커밋됩니다.

modal 의 "적용 내용" textarea 는 **여러 줄 입력 가능** — 한 번에 여러 액션을 기록하면 줄 단위로
분할되어 각각 별도 entry 로 저장됩니다. 한 액션의 부연 설명은 줄 앞에 공백/탭으로 들여쓰기하면
이전 entry 에 이어 붙어 한 줄로 유지됩니다.

예시 입력:
```
hero 배너 WebP 변환 (LCP)
  → 2.4MB → 380KB, eager loading 추가
vendor.js 코드 스플리팅 + defer (TBT)
```
→ 2 개 entry 로 저장:
```
- [YYYY-MM-DD] wellit.co.kr hero 배너 WebP 변환 (LCP) → 2.4MB → 380KB, eager loading 추가
- [YYYY-MM-DD] wellit.co.kr vendor.js 코드 스플리팅 + defer (TBT)
```

## 액션 기록 (여기 아래에 누적)

<!-- 여기 아래부터 매주 한 줄씩 추가 -->
- [2026-05-19] wellit.co.kr 테스트 - 채널 모드 동작
- [2026-05-21] wellit.co.kr 테스트 적용
- [2026-05-26] wellit.co.kr 메인 페이지, 상품 분류 페이지, 브랜드 소개 등 png나 jpg파일 등 일부 페이지 wepbp 파일 변환
- [2026-05-26] curicell.kr promotion.js 파일 내부 불필요한 코드 제거 or 주석 처리(추후 사용할 수 있거나 히스토리가 명확하지 않은 코드는 주석)
- [2026-05-26] curicell.kr 썸네일 제외 보이는 이미지들 webp로 변경
- [2026-05-26] curicell.kr 중복으로 불러오는 font 수정 (2359.css의 @import로 구글 폰트 불러오는 부분 주석처리 -> layout에서 cdn 형식으로 불러오고 있어 중복으로 호출하고 있었음)
- [2026-05-31] housweet.kr 상품 상세 페이지 썸네일 lazy load 제거 (LCP 개선 위함)
- [2026-06-12] curicell.kr promotion.js 파일 사용하지 않는(않을) 주석 제거
- [2026-06-12] housweet.kr 71번 상품 옵션 선택 관련 js 수정
- [2026-06-17] celladix.co.kr 대표이미지 lazy 제거 + fetchpriority 적용 (LCP)
- [2026-06-17] celladix.co.kr 본문용 lazy 셀렉터 #prdDetail .cont img로 정정 (LCP 회귀 방지)
- [2026-06-17] celladix.co.kr setInterval을 observer/이벤트로 전환 (TBT)
