import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { afterAll, describe, expect, it } from "vitest";

const CHROME = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => existsSync(path));

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#111;color:#fff;margin:0">
<div id="root"></div>
<script type="module">
const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "down";
window.__calls = [];
window.fetch = async (url, init) => {
  window.__calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ?? null });
  if (mode === "down") return new Response("no", { status: 503 });
  const review = mode === "review" ? {
    reviewId: "review-1",
    revision: 1,
    recordedAt: "2026-08-15T15:00:00.000Z",
    facts: {
      decision: { id: "dec-1", direction: "LONG", status: "DRAFT", thesis: "Stored thesis only.", stop: 4624.5, targets: [4648] },
      risk: { id: "risk-1", state: "ACCEPT" },
      policy: { id: "policy-1", state: "ALLOW" },
      approval: { id: "apr-1", approved: true },
      execution: null,
      reconciliation: null,
      position: { state: "NO_POSITION", brokerPositionId: null },
      marketProvenance: "LIVE",
      deviations: [],
    },
    interpretations: [{ recordId: "mem-1", body: "Stored interpretation only." }],
    learnings: [],
  } : "NOT_AVAILABLE";
  const room = {
    source: "store",
    serverNow: "2026-08-15T15:00:00.000Z",
    environment: "PAPER",
    agentPresence: "DECISION_READY",
    market: { provider: "available", observation: { provenance: "LIVE", timeframe: "M15", bid: 4630, ask: 4633, spread: 3, ageMs: 1200, providerTimestamp: "2026-08-15T14:59:58.000Z", candleCount: 0 } },
    decision: { id: "dec-1", direction: "LONG", status: "DRAFT", thesis: "Stored thesis only.", expiry: "2026-08-15T18:00:00.000Z", evidenceQuality: "low", stop: 4624.5, targets: [4648] },
    decisionAvailability: "RECORD",
    risk: { id: "risk-1", state: "ACCEPT", reasons: ["RISK_WITHIN_LIMITS"] },
    policy: { id: "policy-1", state: "ALLOW", progression: "RECOMMENDATION_ONLY", reasons: ["POLICY_RECOMMENDATION_ONLY"] },
    approval: { open: mode === "approval" ? { requestId: "req-1", expiresAt: "2026-08-15T16:00:00.000Z", decisionId: "dec-1" } : null, decision: null },
    gate: null,
    execution: null,
    reconciliation: null,
    position: { availability: "DERIVED", state: "NO_POSITION", brokerPositionId: null, direction: null, brokerQuantity: null },
    monitoring: { availability: "NOT_AVAILABLE", observedAt: null, decision: null, failureCodes: [], brokerHealth: null },
    exit: { proposal: "NOT_AVAILABLE", authorizationRequired: false, closeNotRepresentable: false, execution: null },
    killSwitch: { state: "open", updatedAt: "2026-08-15T14:00:00.000Z" },
    pause: { paused: false, jobId: null },
    nextAction: { action: mode === "approval" ? "WAITING_FOR_APPROVAL" : "NO_TRADE", reason: null, blockingCondition: null, allowedUserAction: mode === "approval" ? "APPROVE" : "NONE", allowedUserActions: mode === "approval" ? ["APPROVE", "REJECT"] : [], expiresAt: null, safety: { killSwitch: "open", paused: false, autonomousOrdersBlocked: true } },
    timeline: [],
    memory: [],
    learning: null,
    review,
    attachedConversation: { availability: "NOT_AVAILABLE", threadId: null, runtimeThreadId: null, providerTurnId: null, runtimeTurnId: null, occurrenceId: null, agentRunId: null },
  };
  return new Response(JSON.stringify({ room, chart: { provenance: "LIVE", timeframe: "M15", candles: [] } }), { status: 200, headers: { "content-type": "application/json" } });
};
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { TradingDesk } = await import("/src/components/TradingDesk.tsx");
createRoot(document.getElementById("root")).render(React.createElement(TradingDesk, { section: "desk" }));
</script>
</body>
</html>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(CHROME === undefined)("trading room browser", () => {
  let vite: ViteDevServer | null = null;
  let chrome: ChildProcess | null = null;
  let profile = "";

  afterAll(async () => {
    chrome?.kill();
    await vite?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  it("shows an unavailable review, a stored review, and posts an authoritative approval", async () => {
    const debugPort = await freePort();
    const appPort = await freePort();
    profile = await mkdtemp(join(tmpdir(), "desk-chrome-"));
    vite = await createViteServer({
      configFile: false,
      root: join(import.meta.dirname, "../.."),
      appType: "mpa",
      plugins: [
        react(),
        {
          name: "desk-harness",
          configureServer(dev) {
            dev.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/desk-harness") return next();
              res.setHeader("content-type", "text/html");
              res.end(await dev.transformIndexHtml("/desk-harness", HARNESS));
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: appPort, strictPort: true },
    });
    await vite.listen();
    chrome = spawn(CHROME!, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore" });
    const page = await openPage(debugPort, `http://127.0.0.1:${appPort}/desk-harness?mode=down`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map<number, (message: { result?: { result?: { value?: string } } }) => void>();
    let nextId = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: string } } };
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
    const send = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<{ result?: { result?: { value?: string } } }>((resolve) => pending.set(id, resolve));
    };
    await send("Runtime.enable");
    await send("Page.enable");

    const down = await text(send);
    expect(down).toContain("المراجعة غير متاحة");
    expect(down).toContain("الحضور غير متاح");
    expect(down).toContain("عمر التسعيرة غير متاح");
    expect(down).not.toContain("موافقة");

    await send("Page.navigate", { url: `http://127.0.0.1:${appPort}/desk-harness?mode=review` });
    const reviewed = await text(send, "الوقائع");
    expect(reviewed).toContain("شراء");
    expect(reviewed).toContain("LONG");
    expect(reviewed).toContain("Stored thesis only.");
    expect(reviewed).toContain("Stored interpretation only.");
    expect(reviewed).toContain("عمر التسعيرة 1200 مللي ثانية");
    expect(reviewed).toContain("لا تعلم مرتبط بهذه المراجعة");
    expect(reviewed).not.toContain("موافقة");
    const direction = await send("Runtime.evaluate", {
      expression: `document.querySelector("main")?.getAttribute("dir")`,
      returnByValue: true,
    });
    expect(direction.result?.result?.value).toBe("rtl");

    await send("Page.navigate", { url: `http://127.0.0.1:${appPort}/desk-harness?mode=approval` });
    await text(send, "موافقة");
    const clicked = await send("Runtime.evaluate", {
      expression: `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "موافقة"); button?.click(); return JSON.stringify(window.__calls); })()`,
      returnByValue: true,
    });
    const calls = JSON.parse(clicked.result?.result?.value ?? "[]") as Array<{ url: string; method: string; body: string | null }>;
    const approval = calls.find((call) => call.method === "POST");
    expect(approval?.url).toContain("/api/trading/desk/approval");
    expect(approval?.body).toContain("req-1");
    expect(approval?.body).toContain("approve");
    ws.close();
  }, 60_000);
});

async function openPage(port: number, url: string): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      if (created.ok) {
        const page = await created.json() as { webSocketDebuggerUrl?: string };
        if (page.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
      }
    } catch {
      // Chrome is still binding the debugging port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome debugging port did not open");
}

async function text(
  send: (method: string, params?: Record<string, unknown>) => Promise<{ result?: { result?: { value?: string } } }>,
  needle?: string,
): Promise<string> {
  let body = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await send("Runtime.evaluate", {
      expression: "document.body?.innerText ?? ''",
      returnByValue: true,
    });
    body = result.result?.result?.value ?? "";
    if (needle ? body.includes(needle) : body.includes("غرفة تداول الذهب")) return body;
  }
  return body;
}
