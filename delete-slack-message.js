/**
 * delete-slack-message.js
 *
 * Slack 채널에 게시된 봇 메시지를 삭제한다 (chat.delete API).
 * 봇은 자기 자신이 보낸 메시지만 삭제 가능 (chat:write 권한 충분).
 *
 * 환경변수:
 *   - SLACK_BOT_TOKEN  (필수, xoxb-...)
 *   - SLACK_CHANNEL_ID (필수, C0XXXXXXXX)
 *   - DELETE_TS        (필수, 1759512345.123456 형식)
 *
 * 메시지 ts 얻는 법:
 *   - slack-test-send.yml 실행 로그 마지막의 "main posted (ts=...)" / "thread reply posted (ts=...)" 라인
 *   - 또는 Slack 메시지 우클릭 → "Copy link" → URL 끝의 p1234567890123456 →
 *     앞 10자리 + '.' + 뒤 6자리 = ts (예: 1234567890.123456)
 *
 * Node 18+
 */

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const CHANNEL = process.env.SLACK_CHANNEL_ID || "";
const TS = process.env.DELETE_TS || "";

async function deleteOne(ts) {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: CHANNEL, ts }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`chat.delete failed (ts=${ts}): ${JSON.stringify(json)}`);
  }
  console.log(`✅ deleted ts=${ts}`);
}

async function main() {
  if (!BOT_TOKEN || !CHANNEL || !TS) {
    console.error(
      "❌ Need env: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, DELETE_TS (콤마/공백 구분 시 여러 개 가능)"
    );
    process.exit(1);
  }

  // DELETE_TS 에 콤마/공백으로 여러 ts 가 들어오면 순서대로 삭제 (예: 메인 + thread reply).
  const list = TS.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const ts of list) {
    try {
      await deleteOne(ts);
    } catch (e) {
      console.error(`❌ ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("❌", e?.message || e);
  process.exit(1);
});
