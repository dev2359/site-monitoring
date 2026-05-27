const urls = require("./urls.js");
// LH_SCOPE=domestic|global 로 측정 그룹 선택 (워크플로 matrix 에서 주입). 미설정 시 domestic.
const SCOPE = (process.env.LH_SCOPE || "domestic").toLowerCase();

module.exports = {
  ci: {
    collect: {
      url: urls.desktop[SCOPE] || urls.desktop.domestic,
      numberOfRuns: 5,
      output: ["html", "json"],
      settings: {
        formFactor: "desktop",
        // 로컬 Chrome DevTools 의 desktop Lighthouse 와 동일하게 매칭 (1350x940, DPR 1).
        screenEmulation: {
          mobile: false,
          width: 1350,
          height: 940,
          deviceScaleFactor: 1,
          disabled: false,
        },
        // 로컬 DevTools 기본값과 동일하게 simulate 로 변경 — runner 의 지리적 latency 가
        // 실제 throttle 에 더해지지 않고 rttMs 모델값으로 대체됨.
        throttlingMethod: "simulate",
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 1,
          requestLatencyMs: 0,
          downloadThroughputKbps: 0,
          uploadThroughputKbps: 0,
        },
		maxWaitForLoad: 90000,
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './results/desktop',
      // %%HOSTNAME%%, %%PATHNAME%%, %%DATETIME%%, %%EXTENSION%% 이 LHCI의 유효한 placeholder.
      // 과거의 __url.host__-__index__는 리터럴로 처리되어 모든 URL이 같은 파일에 덮어써졌음.
      reportFilenamePattern: 'pc-%%HOSTNAME%%%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%'
    }
  }
};
