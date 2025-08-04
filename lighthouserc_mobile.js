module.exports = {
  ci: {
    collect: {
      url: [
        'https://wellit.co.kr',
        'https://wellit.co.kr/product/detail.html?product_no=202',
        'https://pronutrition.co.kr',
        'https://pronutrition.co.kr/product/detail.html?product_no=27',
        'https://themedion.com',
        'https://themedion.com/product/detail.html?product_no=12',
        'https://curicell.kr',
        'https://curicell.kr/product/detail.html?product_no=33',
        'https://celladix.co.kr',
        'https://celladix.co.kr/product/detail.html?product_no=10',
        'https://bifigen.com',
        'https://bifigen.com/product/detail.html?product_no=12',
        'https://housweet.co.kr',
        'https://housweet.co.kr/product/detail.html?product_no=74',
        'https://cleanery.co.kr',
        'https://cleanery.co.kr/product/detail.html?product_no=15',
        'https://hedn.kr',
        'https://hedn.kr/product/detail.html?product_no=52'
       ],
      numberOfRuns: 1,
      output: ['html', 'json'], 
      settings: {
        emulatedFormFactor: 'mobile',              
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 1,
          requestLatencyMs: 0,
          downloadThroughputKbps: 0,
          uploadThroughputKbps: 0,
        },
        throttlingMethod: 'devtools'
      }
    },
    upload: {
      target: 'filesystem',
      outputDir: './results/mobile',
      reportFilenamePattern: 'report-mobile-{{url.hostname}}-{{index}}-{{date}}.{{ext}}'
    }
  }
};
