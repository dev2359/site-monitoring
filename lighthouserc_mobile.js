module.exports = {
  ci: {
    collect: {
      url: [
        'https://wellit.co.kr',
        'https://wellit.co.kr/product/detail.html?product_no=202'
       ],
      numberOfRuns: 3,
      output: ['html', 'json'], 
      settings: {
        emulatedFormFactor: 'mobile',              
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 4,
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
      reportFilenamePattern: 'report-mobile-__url.host__-__index__.__ext__'     
    }
  }
};
