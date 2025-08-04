const fs = require('fs');
const path = require('path');

function extractScores(reportDir, label) {
  const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.json'));
  let csv = 'URL,Type,Performance,Accessibility,BestPractices,SEO\n';

  files.forEach(file => {
    const fullPath = path.join(reportDir, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const json = JSON.parse(content);

    const url = json.finalUrl;
    const categories = json.categories;

    const scoreRow = [
      url,
      label,
      categories.performance.score * 100,
      categories.accessibility.score * 100,
      categories['best-practices'].score * 100,
      categories.seo.score * 100
    ];

    csv += scoreRow.join(',') + '\n';
  });

  const outputFile = `./results/lighthouse-scores-${label}.csv`;
  fs.writeFileSync(outputFile, csv);
  console.log(`✅ Saved ${outputFile}`);
}

extractScores('./results/desktop', 'desktop');
extractScores('./results/mobile', 'mobile');
