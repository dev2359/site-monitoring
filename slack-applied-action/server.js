/**
 * Slack /applied-action 핸들러 + Message Shortcut(스레드 지원) 핸들러.
 *
 * 엔드포인트:
 *   - POST /applied-action       — 슬래시 커맨드 (메인 채널 전용 — Slack 정책상 스레드 미지원)
 *   - POST /slack/interactivity  — Message Shortcut(message_action) → modal open / Modal 제출(view_submission) → 기록.
 *                                   Shortcut 은 스레드 내 메시지 ⋯ 메뉴에서도 실행 가능 → 결과를 같은 스레드에 게시.
 *
 * 흐름 (슬래시 커맨드):
 *   1. POST /applied-action 호출
 *   2. X-Slack-Signature 검증 (replay 방지 timestamp window 5 분)
 *   3. text 첫 단어가 host 형태(xxx.yyy) 면 host 로 추출, 나머지는 내용
 *   4. GitHub Contents API 로 applied-actions.md 를 읽어 SHA 확인 후 PUT 으로 업데이트
 *   5. SLACK_BOT_TOKEN 이 있으면 chat.postMessage 로 결과 게시, 없으면 인라인 JSON 응답
 *
 * 흐름 (Message Shortcut):
 *   1. 메시지 ⋯ 메뉴에서 Shortcut 클릭 → POST /slack/interactivity (payload.type='message_action')
 *   2. trigger_id 로 views.open 호출해 host/내용 입력 modal 표시
 *   3. 사용자가 modal 제출 → POST /slack/interactivity (payload.type='view_submission')
 *   4. private_metadata 에서 channel/thread_ts 복원, GitHub 업데이트, 스레드(또는 메시지 하단)에 결과 게시
 *
 * 환경변수:
 *   - PORT                  (기본 8080. Railway 가 자동 주입)
 *   - SLACK_SIGNING_SECRET  (필수) — Slack App Basic Information → Signing Secret
 *   - SLACK_BOT_TOKEN       (권장) — xoxb-... . 있으면 chat.postMessage 로 thread_ts 를 살려 스레드 안에 응답 게시. 없으면 인라인 JSON 응답으로 fallback (스레드 안에 있어도 채널로 노출 가능).
 *   - GITHUB_TOKEN          (필수) — Fine-grained PAT. Contents: Read & Write 만
 *   - GITHUB_REPO           (기본 dev2359/site-monitoring)
 *   - GITHUB_FILE_PATH      (기본 applied-actions.md)
 *   - GITHUB_BRANCH         (기본 main)
 *   - COMMIT_AUTHOR_NAME    (기본 applied-action-bot)
 *   - COMMIT_AUTHOR_EMAIL   (기본 applied-action-bot@users.noreply.github.com)
 */

const http = require("http");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8080", 10);
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "dev2359/site-monitoring";
const GITHUB_FILE = process.env.GITHUB_FILE_PATH || "applied-actions.md";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const COMMIT_AUTHOR_NAME = process.env.COMMIT_AUTHOR_NAME || "applied-action-bot";
const COMMIT_AUTHOR_EMAIL =
  process.env.COMMIT_AUTHOR_EMAIL || "applied-action-bot@users.noreply.github.com";

function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false; // 5 min replay window

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expectedSig =
    "v0=" +
    crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(baseString).digest("hex");

  if (expectedSig.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
  } catch {
    return false;
  }
}

function parseUrlEncoded(body) {
  const params = new URLSearchParams(body);
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

// 첫 토큰이 도메인 형태이면 host 로 추출, 아니면 host 미지정으로 처리.
function extractHost(text) {
  const trimmed = text.trim();
  if (!trimmed) return { host: null, content: "" };
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { host: null, content: trimmed };
  const first = m[1];
  const rest = m[2].trim();
  // 도메인 패턴: 영문/숫자/dash + 점 + TLD 2 자 이상
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(first)) {
    return { host: first, content: rest };
  }
  return { host: null, content: trimmed };
}

async function githubGetFile() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "slack-applied-action-bot",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub GET ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { content, sha: data.sha };
}

async function githubPutFile(newContent, sha, commitMessage) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const body = {
    message: commitMessage,
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    sha,
    branch: GITHUB_BRANCH,
    committer: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL },
    author: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL },
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "slack-applied-action-bot",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function appendLine(currentMd, dateStr, host, content) {
  const line = `- [${dateStr}] ${host ? host + " " : ""}${content}`;
  const trimmed = currentMd.replace(/\s+$/, "");
  return `${trimmed}\n${line}\n`;
}

function cleanHost(raw) {
  if (!raw) return null;
  let h = String(raw).trim();
  if (!h) return null;
  h = h.replace(/^https?:\/\//i, "");
  h = h.split("/")[0];
  return h.toLowerCase() || null;
}

// 핵심 기록 로직 (슬래시 커맨드 / Message Shortcut 둘 다에서 호출).
async function recordAppliedActionCore({ host, content, user }) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const { content: currentMd, sha } = await githubGetFile();
  const updated = appendLine(currentMd, dateStr, host, content);
  const summary = content.length > 60 ? content.slice(0, 57) + "..." : content;
  const commitMessage = `chore(applied): ${host ? host + " - " : ""}${summary} (Slack by ${user})`;
  const result = await githubPutFile(updated, sha, commitMessage);
  const commitSha = (result.commit?.sha || "").slice(0, 7);

  return {
    host,
    content,
    commitSha,
    message:
      `✅ applied-actions.md 에 기록됨\n` +
      `*host:* ${host || "_(미지정)_"}\n` +
      `*내용:* ${content}\n` +
      `*commit:* \`${commitSha}\``,
  };
}

// 슬래시 커맨드 wrapper.
async function recordAppliedAction(form) {
  const text = (form.text || "").trim();
  const { host, content } = extractHost(text);
  const user = form.user_name || "unknown";
  const r = await recordAppliedActionCore({ host, content, user });
  return r.message;
}

// Message Shortcut callback_id (Slack App 설정과 정확히 일치해야 함).
const SHORTCUT_CALLBACK_ID = "record_applied_action";
const MODAL_CALLBACK_ID = "applied_action_modal";

// Slack views.open — Message Shortcut 클릭 시 modal 띄우기.
async function slackOpenView(triggerId, view) {
  if (!SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN missing");
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`views.open failed: ${json.error || res.status}`);
  }
  return json;
}

function buildAppliedActionModal({ channelId, threadTs }) {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK_ID,
    title: { type: "plain_text", text: "Applied Action 기록" },
    submit: { type: "plain_text", text: "기록" },
    close: { type: "plain_text", text: "취소" },
    private_metadata: JSON.stringify({ channelId, threadTs }),
    blocks: [
      {
        type: "input",
        block_id: "host_block",
        optional: true,
        label: { type: "plain_text", text: "Host (선택)" },
        element: {
          type: "plain_text_input",
          action_id: "host_input",
          placeholder: { type: "plain_text", text: "wellit.co.kr" },
        },
        hint: {
          type: "plain_text",
          text: "도메인만. https:// 나 path 는 자동 제거됨.",
        },
      },
      {
        type: "input",
        block_id: "content_block",
        label: { type: "plain_text", text: "적용 내용" },
        element: {
          type: "plain_text_input",
          action_id: "content_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "예: hero 배너 WebP 변환 + fetchpriority='high' 적용 (LCP 단축 목적)",
          },
        },
      },
    ],
  };
}

// Shortcut 클릭(payload.type='message_action') → modal open.
// trigger_id 는 3초 안에 사용해야 하므로 동기적으로 처리.
async function handleMessageAction(payload) {
  if (payload.callback_id !== SHORTCUT_CALLBACK_ID) {
    console.warn(`unknown shortcut callback_id: ${payload.callback_id}`);
    return;
  }
  const channelId = payload.channel?.id;
  const msg = payload.message || {};
  // 스레드 안에서 호출했으면 부모(thread_ts) 에 답글. 메인 메시지에서 호출했으면 그 메시지를 thread root 로 사용.
  const threadTs = msg.thread_ts || msg.ts;

  const view = buildAppliedActionModal({ channelId, threadTs });
  await slackOpenView(payload.trigger_id, view);
}

// Modal 제출(payload.type='view_submission') → GitHub 기록 + 스레드 응답.
async function handleViewSubmission(payload) {
  const values = payload.view?.state?.values || {};
  const hostRaw = values.host_block?.host_input?.value || "";
  const content = (values.content_block?.content_input?.value || "").trim();
  const meta = (() => {
    try {
      return JSON.parse(payload.view?.private_metadata || "{}");
    } catch {
      return {};
    }
  })();
  const channel = meta.channelId;
  const threadTs = meta.threadTs;
  const user = payload.user?.username || payload.user?.name || "unknown";

  const host = cleanHost(hostRaw);

  try {
    const r = await recordAppliedActionCore({ host, content, user });
    if (channel) {
      await slackPostMessage({ channel, thread_ts: threadTs, text: r.message });
    }
  } catch (err) {
    console.error("view submission error:", err);
    if (channel) {
      await slackPostMessage({
        channel,
        thread_ts: threadTs,
        text: `❌ 기록 실패: ${err?.message || err}`,
      }).catch((e) => console.error("error posting failure msg:", e));
    }
  }
}

// chat.postMessage — thread_ts 가 있으면 스레드 안에 게시.
async function slackPostMessage({ channel, thread_ts, text }) {
  if (!SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN missing");
  if (!channel) throw new Error("channel missing");
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`chat.postMessage failed: ${json.error || res.status}`);
  }
  return json;
}

// Slack Interactivity 엔드포인트 처리: Message Shortcut(message_action) → modal open / Modal 제출(view_submission) → 기록.
function handleInteractivity(req, res) {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (!SLACK_SIGNING_SECRET || !GITHUB_TOKEN || !SLACK_BOT_TOKEN) {
      res.writeHead(500);
      res.end("server misconfigured (missing env for interactivity)");
      return;
    }
    if (!verifySlackSignature(req, raw)) {
      res.writeHead(401);
      res.end("invalid signature");
      return;
    }

    const form = parseUrlEncoded(raw);
    let payload;
    try {
      payload = JSON.parse(form.payload || "{}");
    } catch (e) {
      res.writeHead(400);
      res.end("invalid payload");
      return;
    }

    if (payload.type === "message_action") {
      // Shortcut 클릭 → modal open. trigger_id 는 3초 안에 사용 필요.
      res.writeHead(200);
      res.end();
      handleMessageAction(payload).catch((err) =>
        console.error("message_action error:", err?.message || err)
      );
      return;
    }

    if (payload.type === "view_submission") {
      // 필수 입력 검증 — 비었으면 modal 에 errors 표시하며 유지.
      const content = (
        payload.view?.state?.values?.content_block?.content_input?.value || ""
      ).trim();
      if (!content) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            response_action: "errors",
            errors: { content_block: "내용을 입력해 주세요." },
          })
        );
        return;
      }

      // 검증 통과 → 200 으로 modal 닫고, GitHub 호출 + chat.postMessage 는 비동기 처리.
      res.writeHead(200);
      res.end();
      handleViewSubmission(payload).catch((err) =>
        console.error("view_submission error:", err?.message || err)
      );
      return;
    }

    // 그 외 type (block_actions 등) — 일단 200 ack 만.
    res.writeHead(200);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/slack/interactivity") {
    handleInteractivity(req, res);
    return;
  }

  if (req.method !== "POST" || req.url !== "/applied-action") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (!SLACK_SIGNING_SECRET || !GITHUB_TOKEN) {
      res.writeHead(500);
      res.end("server misconfigured (missing env)");
      return;
    }
    if (!verifySlackSignature(req, raw)) {
      res.writeHead(401);
      res.end("invalid signature");
      return;
    }

    const form = parseUrlEncoded(raw);
    const text = (form.text || "").trim();

    // 빈 입력 → 사용법을 ephemeral 로 즉시 안내
    if (!text) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text:
            "사용법: `/applied-action <host> <내용>`\n예시: `/applied-action wellit.co.kr hero 배너 WebP 변환 + fetchpriority 적용 (LCP 단축)`",
        })
      );
      return;
    }

    if (SLACK_BOT_TOKEN) {
      // ack 즉시 200(빈 응답) — Slack UI 상엔 슬래시 커맨드만 사라지고 곧 봇 메시지 도착.
      // GitHub 호출 + chat.postMessage 는 비동기로 진행해 3초 timeout 회피.
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");

      const channel = form.channel_id;
      const threadTs = form.thread_ts || undefined;
      (async () => {
        try {
          const msg = await recordAppliedAction(form);
          await slackPostMessage({ channel, thread_ts: threadTs, text: msg });
        } catch (err) {
          console.error("async handler error:", err);
          await slackPostMessage({
            channel,
            thread_ts: threadTs,
            text: `❌ 기록 실패: ${err?.message || err}`,
          }).catch((e) => console.error("error posting failure msg:", e));
        }
      })();
      return;
    }

    // Fallback (SLACK_BOT_TOKEN 미설정): 인라인 JSON 응답.
    // 이 경우 스레드에서 실행해도 결과가 채널로 노출될 수 있음.
    recordAppliedAction(form)
      .then((msg) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ response_type: "in_channel", text: msg }));
      })
      .catch((err) => {
        console.error("handler error:", err);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            response_type: "ephemeral",
            text: `❌ 기록 실패: ${err?.message || err}`,
          })
        );
      });
  });
});

server.listen(PORT, () => {
  console.log(`[slack-applied-action] listening on :${PORT}`);
  console.log(`  GitHub: ${GITHUB_REPO}/${GITHUB_FILE}@${GITHUB_BRANCH}`);
  console.log(`  Signing secret: ${SLACK_SIGNING_SECRET ? "set" : "MISSING ⚠️"}`);
  console.log(`  GitHub token: ${GITHUB_TOKEN ? "set" : "MISSING ⚠️"}`);
  console.log(`  Slack bot token: ${SLACK_BOT_TOKEN ? "set (thread-aware)" : "missing (fallback inline mode)"}`);
});
