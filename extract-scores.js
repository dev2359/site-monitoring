const fs = require('fs');
const path = require('path');

function extractScoresToConsole(dir, typeLabel) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log(`📂 디렉토리에 분석할 JSON 리포트가 없습니다: ${dir}`);
    return;
  }

  console.log(`\n📊 Lighthouse 결과 요약 (${typeLabel.toUpperCase()})`);
  console.log('------------------------------------------------------------');

  files.forEach((file, i) => {
    const fullPath = path.join(dir, file);
    let data;

    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch (err) {
      console.warn(`⚠️ JSON 파싱 실패: ${file}`);
      return;
    }

    const url = data.finalUrl || '(unknown)';
    const c = data.categories;

    if (!c || !c.performance) {
      console.warn(`⚠️ 유효하지 않은 Lighthouse 결과 파일: ${file}`);
      return;
    }

    const scores = {
      Performance: c.performance.score * 100,
      Accessibility: c.accessibility?.score * 100 || 'N/A',
      BestPractices: c['best-practices']?.score * 100 || 'N/A',
      SEO: c.seo?.score * 100 || 'N/A'
    };

    console.log(`${i + 1}. ${url}`);
    for (const [key, val] of Object.entries(scores)) {
      console.log(`   - ${key.padEnd(14)}: ${val}`);
    }
    console.log('');
  });
}

extractScoresToConsole('results/desktop', 'desktop');
extractScoresToConsole('results/mobile', 'mobile');
