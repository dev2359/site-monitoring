// 설정 검증용 임시 config — main(lighthouserc_mobile.js)의 settings 를 그대로 재사용하고
// URL 1개 + numberOfRuns 3 으로 빠르게 측정. 검증 끝나면 이 파일 + 워크플로 삭제 가능.
const base = require("./lighthouserc_mobile.js");

module.exports = {
  ci: {
    collect: {
      ...base.ci.collect,
      // desktop 검증 config 와 같은 URL 을 쓴다 — 러너 A/B 비교 시 device 간 결과도 나란히 볼 수 있다.
      // m.curicell.kr 은 본 도메인으로 넘기는 302 만 남아 측정 대상에서 제거됨 (urls.js 참고).
      url: ["https://curicell.kr/product/detail.html?product_no=129"],
      numberOfRuns: 3,
    },
    upload: base.ci.upload,
  },
};
