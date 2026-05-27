// 측정 대상 URL 중앙 관리.
// device(desktop/mobile) × scope(domestic/global) 4 그룹.
// lighthouserc.js / lighthouserc_mobile.js 가 LH_SCOPE 환경변수로 그룹을 선택.
//
// scope 기준:
//   domestic — 국내 hosting (.kr/.co.kr + themedion.com, bifigen.com). 나중에 Seoul runner 로.
//   global   — 해외 hosting (lactomedi.{com,sg,jp}, celladix.{us,sg,jp}). GitHub runner(US) 유지.
//
// mobile 은 일부 도메인이 m. 서브도메인을 씀 (m.curicell.kr, m.cleanery.co.kr).

const domesticCommon = [
  "https://wellit.co.kr",
  "https://wellit.co.kr/product/detail.html?product_no=14",
  "https://wellit.co.kr/product/detail.html?product_no=202",
  "https://pronutrition.co.kr",
  "https://pronutrition.co.kr/product/detail.html?product_no=38",
  "https://pronutrition.co.kr/product/detail.html?product_no=86",
  "https://themedion.com",
  "https://themedion.com/product/detail.html?product_no=12",
  "https://themedion.com/product/detail.html?product_no=46",
  "https://themedion.com/product/detail.html?product_no=99",
  "https://celladix.co.kr",
  "https://celladix.co.kr/product/detail.html?product_no=10",
  "https://celladix.co.kr/product/detail.html?product_no=169",
  "https://bifigen.com",
  "https://bifigen.com/product/detail.html?product_no=12",
  "https://bifigen.com/product/detail.html?product_no=68",
  "https://housweet.co.kr",
  "https://housweet.kr/product/detail.html?product_no=71",
  "https://housweet.co.kr/product/detail.html?product_no=74",
  "https://hedn.kr",
  "https://hedn.kr/product/detail.html?product_no=64",
];

const globalCommon = [
  "https://lactomedi.com",
  "https://lactomedi.com/collections/best-sellers",
  "https://lactomedi.com/products/intimate-care-gel-for-women",
  "https://celladix.us",
  "https://celladix.us/collections/best-sellers",
  "https://celladix.us/products/131-pore-clearing-serum",
  "https://lactomedi.sg",
  "https://lactomedi.sg/products/intimate-care-gel-for-women",
  "https://celladix.sg",
  "https://celladix.sg/products/https-celladix-sg-products-celladix-131-pore-clearing-serum",
  "https://celladix.jp",
  "https://celladix.jp/products/sebum-rebalancing-rx-131-ampoule",
];

module.exports = {
  desktop: {
    domestic: [
      ...domesticCommon,
      "https://curicell.kr",
      "https://curicell.kr/product/detail.html?product_no=33",
      "https://curicell.kr/product/detail.html?product_no=129",
      "https://cleanery.co.kr",
      "https://cleanery.co.kr/product/detail.html?product_no=15",
    ],
    global: [
      ...globalCommon,
      "https://lactomedi.jp",
    ],
  },
  mobile: {
    domestic: [
      ...domesticCommon,
      "https://m.curicell.kr",
      "https://m.curicell.kr/product/detail.html?product_no=33",
      "https://m.curicell.kr/product/detail.html?product_no=129",
      "https://m.cleanery.co.kr",
      "https://m.cleanery.co.kr/product/detail.html?product_no=15",
    ],
    global: [
      ...globalCommon,
      "https://lactomedi.jp",
      "https://lactomedi.jp/products/%E3%83%91%E3%83%92%E3%83%A5%E3%83%BC%E3%83%A0%E3%83%9F%E3%82%B9%E3%83%88",
    ],
  },
};
