/**
 * Slack /applied-action slash command handler.
 *
 * 흐름:
 *   1. Slack 슬래시 커맨드가 POST /applied-action 으로 호출됨
 *   2. X-Slack-Signature 검증 (replay 방지 timestamp window 5 분)
 *   3. text 에서 첫 단어가 host 형태(xxx.yyy) 면 host 로 추출, 나머지는 내용
 *   4. GitHub Contents API 로 applied-actions.md 를 읽어 SHA 확인 후 PUT 으로 업데이트
 *   5. Slack 에 in_channel 메시지로 결과 응답 (commit short SHA 포함)
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

// GitHub 업데이트 + 결과 텍스트 반환 (UI 응답 형식은 호출부에서 결정).
async function recordAppliedAction(form) {
  const text = (form.text || "").trim();
  const { host, content } = extractHost(text);
  const dateStr = new Date().toISOString().slice(0, 10);
  const user = form.user_name || "unknown";

  const { content: currentMd, sha } = await githubGetFile();
  const updated = appendLine(currentMd, dateStr, host, content);
  const summary = content.length > 60 ? content.slice(0, 57) + "..." : content;
  const commitMessage = `chore(applied): ${host ? host + " - " : ""}${summary} (Slack by ${user})`;
  const result = await githubPutFile(updated, sha, commitMessage);
  const commitSha = (result.commit?.sha || "").slice(0, 7);

  return (
    `✅ applied-actions.md 에 기록됨\n` +
    `*host:* ${host || "_(미지정)_"}\n` +
    `*내용:* ${content}\n` +
    `*commit:* \`${commitSha}\``
  );
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
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
