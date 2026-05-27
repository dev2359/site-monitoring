// 설정 검증용 임시 config — main(lighthouserc_mobile.js)의 settings 를 그대로 재사용하고
// URL 1개 + numberOfRuns 3 으로 빠르게 측정. 검증 끝나면 이 파일 + 워크플로 삭제 가능.
const base = require("./lighthouserc_mobile.js");

module.exports = {
  ci: {
    collect: {
      ...base.ci.collect,
      url: ["https://m.curicell.kr/product/detail.html?product_no=129"],
      numberOfRuns: 3,
    },
    upload: base.ci.upload,
  },
};
