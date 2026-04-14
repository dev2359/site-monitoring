module.exports = {
  ci: {
    collect: {
      
      url: [
        'https://wellit.co.kr',
        'https://wellit.co.kr/product/detail.html?product_no=14',
        'https://wellit.co.kr/product/detail.html?product_no=202',
        'https://pronutrition.co.kr',
        'https://pronutrition.co.kr/product/detail.html?product_no=38',
        'https://pronutrition.co.kr/product/detail.html?product_no=86',
        'https://themedion.com',
        'https://themedion.com/product/detail.html?product_no=12',
        'https://themedion.com/product/detail.html?product_no=46',
	    'https://themedion.com/product/detail.html?product_no=99',
        'https://m.curicell.kr',
        'https://m.curicell.kr/product/detail.html?product_no=33',
	    'https://m.curicell.kr/product/detail.html?product_no=129',
        'https://celladix.co.kr',
        'https://celladix.co.kr/product/detail.html?product_no=10',
	    'https://celladix.co.kr/product/detail.html?product_no=169',
        'https://bifigen.com',
        'https://bifigen.com/product/detail.html?product_no=12',
	    'https://bifigen.com/product/detail.html?product_no=68',
        'https://housweet.co.kr',
	    'https://housweet.kr/product/detail.html?product_no=71',
        'https://housweet.co.kr/product/detail.html?product_no=74',
        'https://m.cleanery.co.kr',
        'https://m.cleanery.co.kr/product/detail.html?product_no=15',
        'https://hedn.kr',
        'https://hedn.kr/product/detail.html?product_no=64',
	    'https://lactomedi.com',
      	'https://lactomedi.com/collections/best-sellers',
      	'https://lactomedi.com/products/intimate-care-gel-for-women',
      	'https://celladix.us',
      	'https://celladix.us/collections/best-sellers',
      	'https://celladix.us/products/131-pore-clearing-serum',
      	'https://lactomedi.sg',
      	'https://lactomedi.sg/products/intimate-care-gel-for-women',
      	'https://celladix.sg',
      	'https://celladix.sg/products/https-celladix-sg-products-celladix-131-pore-clearing-serum'
       ],
      numberOfRuns: 3,
      output: ["html", "json"],
      settings: {
        formFactor: "mobile",
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
          disabled: false,
        },
	    throttlingMethod: 'devtools',
        throttling: {
          requestLatencyMs: 562.5,
          downloadThroughputKbps: 1474.56,
          uploadThroughputKbps: 675,
          cpuSlowdownMultiplier: 4,
        },
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './results/mobile',
      reportFilenamePattern: 'report-mobile-__url.host__-__index__'     
    }
  }
};
