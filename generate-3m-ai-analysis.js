const fs = require("fs");
const path = require("path");

const OPENAI_KEY = process.env.OPENAI_API_KEY;

const CSV_PATH = "results/compare-3m-all.csv";
const OUT_MD = "results/compare-3m-ai.md";

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log("No comparison CSV found");
    return;
  }

  const csv = fs.readFileSync(CSV_PATH, "utf8");

  const prompt = `
You are a web performance expert.

Analyze the following Lighthouse 3-month comparison dataset.

Explain:

1. What improved the most
2. What regressed
3. Overall trend
4. Top 3 recommended actions

Be concise.
Return markdown.

DATA:
${csv.slice(0, 12000)}
`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      max_output_tokens: 500,
      input: prompt,
    }),
  });

  const json = await res.json();

  const text = json.output[0].content[0].text;

  fs.writeFileSync(OUT_MD, text);

  console.log("AI 3-month analysis generated");
}

main();
