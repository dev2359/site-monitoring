# Applied Actions

매주 적용한 개선 액션을 이 파일에 한 줄씩 기록하세요. CI 의 `generate-ai-suggestions.js`
가 이 파일을 읽어 AI 프롬프트에 주입하므로, 이미 적용한 액션이 매주 같은 조언으로
반복되는 것을 막고, 다음 측정에서 효과 검증 코멘트가 나오도록 유도합니다.

## 작성 형식

```
- [YYYY-MM-DD] [host] 적용 내용 한 줄 (어떤 metric 을 노린 변경인지 포함)
```

예시:
```
- [2026-05-18] wellit.co.kr hero 배너 WebP 변환 + fetchpriority="high" 적용 (LCP 단축 목적)
- [2026-05-18] celladix.co.kr GA/Meta Pixel 스크립트 defer 적용 (TBT 단축 목적)
- [2026-05-25] themedion.com 폰트 5종 → 2종 축소 + woff2 preload 추가 (FCP/LCP 동시 개선 목적)
```

## 액션 기록 (여기 아래에 누적)

<!-- 여기 아래부터 매주 한 줄씩 추가 -->
- [2026-05-19] wellit.co.kr 테스트 - 채널 모드 동작
- [2026-05-21] wellit.co.kr 테스트 적용
