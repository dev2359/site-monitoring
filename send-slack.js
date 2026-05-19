/**
 * send-slack.js
 *
 * results/slack-payload.json 의 { main, thread } 를 읽어 Slack 에 전송한다.
 *
 * 동작 모드:
 *  1) SLACK_BOT_TOKEN + SLACK_CHANNEL_ID 가 있으면 chat.postMessage 로 메인 메시지 전송 → 응답의 ts 로 thread_ts 를 잡아 스레드 댓글 전송.
 *  2) 둘 다 없고 SLACK_WEBHOOK_URL 만 있으면 webhook 으로 main 만 전송 (스레드 미지원).
 *  3) 셋 다 없으면 실패 exit.
 *
 * Node 18+, no deps.
 */

const fs = require("fs");
const path = require("path");

const PAYLOAD_PATH = process.env.SLACK_PAYLOAD_PATH || path.join("results", "slack-payload.json");
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "";
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

// 모든 chat.postMessage 호출에 공통 적용 — Slack 의 자동 link/media preview 비활성화.
const UNFURL_OFF = { unfurl_links: false, unfurl_media: false };

async function postViaBot(payload) {
  const auth = { Authorization: `Bearer ${BOT_TOKEN}` };

  const mainBody = { channel: CHANNEL_ID, ...UNFURL_OFF, ...payload.main };
  const mainRes = await postJson("https://slack.com/api/chat.postMessage", mainBody, auth);
  if (!mainRes.body?.ok) {
    throw new Error(`main post failed: ${JSON.stringify(mainRes.body)}`);
  }
  const ts = mainRes.body.ts;
  console.log(`✅ main posted (ts=${ts})`);

  const threadHasContent =
    payload.thread &&
    ((Array.isArray(payload.thread.blocks) && payload.thread.blocks.length > 0) ||
      (typeof payload.thread.text === "string" && payload.thread.text.trim()));

  if (!threadHasContent) {
    console.log("(no thread content to post)");
    return;
  }

  const threadBody = {
    channel: CHANNEL_ID,
    thread_ts: ts,
    ...UNFURL_OFF,
    ...payload.thread,
  };
  const threadRes = await postJson("https://slack.com/api/chat.postMessage", threadBody, auth);
  if (!threadRes.body?.ok) {
    throw new Error(`thread reply failed: ${JSON.stringify(threadRes.body)}`);
  }
  console.log(`✅ thread reply posted (ts=${threadRes.body.ts})`);
}

async function postViaWebhook(payload) {
  // Webhook 은 스레드 미지원. main 만 전송. unfurl 옵션도 같이.
  const body = { ...UNFURL_OFF, ...(payload.main || payload) };
  const res = await postJson(WEBHOOK_URL, body);
  if (res.status >= 400 || res.body?.raw === "invalid_payload") {
    throw new Error(`webhook post failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`✅ webhook posted (status=${res.status}, thread 미지원 모드)`);
}

async function main() {
  if (!fs.existsSync(PAYLOAD_PATH)) {
    console.error(`❌ ${PAYLOAD_PATH} 없음. build-slack-payload.js 먼저 실행 필요.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, "utf-8"));

  if (BOT_TOKEN && CHANNEL_ID) {
    await postViaBot(payload);
  } else if (WEBHOOK_URL) {
    console.warn(
      "⚠️ SLACK_BOT_TOKEN / SLACK_CHANNEL_ID 미설정 — webhook 으로 fallback (스레드 분리 불가)"
    );
    await postViaWebhook(payload);
  } else {
    console.error(
      "❌ Slack 자격증명 누락. SLACK_BOT_TOKEN+SLACK_CHANNEL_ID 또는 SLACK_WEBHOOK_URL 필요."
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌", e?.message || e);
  process.exit(1);
});
