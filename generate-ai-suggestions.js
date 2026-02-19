const fs = require("fs");

function main() {
  const input = JSON.parse(fs.readFileSync("results/ai-input.json", "utf-8"));

  // TODO: 여기서 Antigravity 호출해서 suggestions 텍스트를 받아오기
  // const suggestions = await callAntigravity(input);

  const suggestions = `# AI Suggestions (placeholder)

## TL;DR
- (여기에 3줄 요약)

## Root cause hypotheses (Top 3)
1) ...
2) ...
3) ...

## Recommended actions (Top 5)
1) ...
2) ...
3) ...
4) ...
5) ...

## Verification checklist
- LCP가 __ms 이하로 내려가는지 확인
- TBT가 __ms 이하로 내려가는지 확인
`;

  fs.writeFileSync("results/ai-suggestions.md", suggestions, "utf-8");
}

main();
