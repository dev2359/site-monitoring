const fs = require('fs');
const path = require('path');

function extractScores(dir, typeLabel) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const rows = [['URL', 'Type', 'Performance', 'Accessibility', 'BestPractices', 'SEO']];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const raw = fs.readFileSync(fullPath, 'utf-8');

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn(`⚠️ JSON 파싱 실패: ${file}`);
      continue;
    }

    const url = data.finalUrl || '(unknown)';
    const c = data.categories;

    if (!c || !c.performance) {
      console.warn(`⚠️ 유효하지 않은 Lighthouse 결과 파일: ${file}`);
      continue;
    }

    const row = [
      url,
      typeLabel,
      c.performance.score * 100,
      c.accessibility?.score * 100 || '',
      c['best-practices']?.score * 100 || '',
      c.seo?.score * 100 || ''
    ];

    rows.push(row);
  }

  const csv = rows.map(row => row.join(',')).join('\n');
  const outPath = `results/lighthouse-scores-${typeLabel}.csv`;
  fs.writeFileSync(outPath, csv);
  console.log(`✅ Saved ${outPath}`);
}

extractScores('results/desktop', 'desktop');
extractScores('results/mobile', 'mobile');
