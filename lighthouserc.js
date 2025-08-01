module.exports = {
  ci: {
    collect: {
      url: ['https://wellit.co.kr'],
      numberOfRuns: 1,
      settings: {
        emulatedFormFactor: 'desktop'
      }
    },
    upload: {
      target: 'filesystem',
      outputDir: './results',
      reportFilenamePattern: 'report-{{date}}.html'
    }
  }
};
