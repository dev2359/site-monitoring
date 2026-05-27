const urls = require("./urls.js");
// LH_SCOPE=domestic|global 로 측정 그룹 선택 (워크플로 matrix 에서 주입). 미설정 시 domestic.
const SCOPE = (process.env.LH_SCOPE || "domestic").toLowerCase();

module.exports = {
  ci: {
    collect: {
      url: urls.mobile[SCOPE] || urls.mobile.domestic,
      numberOfRuns: 5,
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
	    throttlingMethod: 'simulate',
        // simulate 는 rttMs / throughputKbps key 를 사용. 기존 requestLatencyMs /
        // downloadThroughputKbps 는 devtools 용이라 simulate 에서 무시되어 의도한 5000kbps 가
        // 반영되지 않았음 → simulate 용 key 로 정정.
        throttling: {
          rttMs: 150,
          throughputKbps: 5000,
          cpuSlowdownMultiplier: 1,
        },
	    maxWaitForLoad: 90000,
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './results/mobile',
      // %%HOSTNAME%%, %%PATHNAME%%, %%DATETIME%%, %%EXTENSION%% 이 LHCI의 유효한 placeholder.
      // 과거의 __url.host__-__index__는 리터럴로 처리되어 모든 URL이 같은 파일에 덮어써졌음.
      reportFilenamePattern: 'mobile-%%HOSTNAME%%%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%'
    }
  }
};
