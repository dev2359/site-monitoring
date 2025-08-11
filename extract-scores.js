const fs = require('fs');
const path = require('path');

function extractScoresToConsole(dir, typeLabel) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  console.log(`\n📊 Lighthouse 결과 요약 (${typeLabel.toUpperCase()})`);
  console.log('------------------------------------------------------------');

  if (files.length === 0) {
    console.log('❌ JSON 파일이 없습니다.');
    return;
  }

  files.forEach((file, i) => {
    const fullPath = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch (err) {
      console.log(`⚠️ ${file} → JSON 파싱 실패`);
      return;
    }

    if (!data.categories) {
      console.log(`⚠️ ${file} → 유효하지 않은 결과`);
      if (data.runtimeError) {
        console.log(`   오류 코드: ${data.runtimeError.code}`);
        console.log(`   오류 메시지: ${data.runtimeError.message}`);
      }
      return;
    }

    const url = data.finalUrl || '(unknown)';
    const c = data.categories;
    console.log(`${i + 1}. ${url}`);
    console.log(`   Performance   : ${c.performance.score * 100}`);
    console.log(`   Accessibility : ${c.accessibility?.score * 100 || 'N/A'}`);
    console.log(`   BestPractices : ${c['best-practices']?.score * 100 || 'N/A'}`);
    console.log(`   SEO           : ${c.seo?.score * 100 || 'N/A'}`);
    console.log('');
  });
}

extractScoresToConsole('results/desktop', 'desktop');
extractScoresToConsole('results/mobile', 'mobile');
