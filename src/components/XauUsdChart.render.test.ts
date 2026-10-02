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

/** Test-only page. It is not a route in the desk and it is not a market feed. */
const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#111;color:#fff;margin:0">
<div id="root"></div>
<script type="module">
const texts = [];
const orig = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
  texts.push(String(text));
  return orig.call(this, text, ...rest);
};
window.__chartTexts = texts;
const params = new URLSearchParams(location.search);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { XauUsdChart } = await import("/src/components/XauUsdChart.tsx");
const candles = [
  { timeframe: "M15", time: "2026-08-15T14:00:00.000Z", open: 2320.5, high: 2328.2, low: 2316.4, close: 2324.1, volume: 1840 },
  { timeframe: "M15", time: "2026-08-15T14:15:00.000Z", open: 2324.1, high: 2331.0, low: 2321.7, close: 2329.4, volume: 2210 },
  { timeframe: "M15", time: "2026-08-15T14:30:00.000Z", open: 2329.4, high: 2334.8, low: 2326.0, close: 2327.6, volume: 1964 },
];
createRoot(document.getElementById("root")).render(React.createElement(XauUsdChart, {
  symbol: params.get("symbol") ?? "XAUUSD",
  provenance: params.get("provenance") ?? "LIVE",
  candles,
}));
</script>
</body>
</html>`;

interface Probe {
  pro: boolean;
  canvas: number;
  engine: string | null;
  text: string;
  texts: string[];
}

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

describe.skipIf(CHROME === undefined)("KLineChart Pro widget", () => {
  let vite: ViteDevServer | null = null;
  let chrome: ChildProcess | null = null;
  let profile = "";
  let pageSocket = "";
  const requests: string[] = [];

  afterAll(async () => {
    chrome?.kill();
    await vite?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  it("draws a canonical XAUUSD series and refuses the other provenance labels", async () => {
    const debugPort = await freePort();
    const appPort = await freePort();
    profile = await mkdtemp(join(tmpdir(), "kline-chrome-"));
    vite = await createViteServer({
      configFile: false,
      root: join(import.meta.dirname, "../.."),
      appType: "mpa",
      plugins: [
        react(),
        {
          name: "kline-harness",
          configureServer(dev) {
            dev.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/kline-harness") return next();
              res.setHeader("content-type", "text/html");
              res.end(await dev.transformIndexHtml("/kline-harness", HARNESS));
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
    const created = await openPage(debugPort, `http://127.0.0.1:${appPort}/kline-harness`);
    pageSocket = created.webSocketDebuggerUrl;
    const ws = new WebSocket(pageSocket);
    const pending = new Map<number, (message: { result?: { result?: { value?: string } } }) => void>();
    let nextId = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { request?: { url?: string } };
        result?: { result?: { value?: string } };
      };
      if (message.method === "Network.requestWillBeSent" && message.params?.request?.url) requests.push(message.params.request.url);
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
    await send("Network.enable");
    await send("Runtime.enable");
    await send("Page.enable");

    const live = await show(send, `http://127.0.0.1:${appPort}/kline-harness?symbol=XAUUSD&provenance=LIVE`);
    expect(live.engine).toBe("klinechart-pro");
    expect(live.pro).toBe(true);
    expect(live.canvas).toBeGreaterThan(0);
    expect(live.text).toContain("LIVE · XAUUSD · ready");
    expect(live.text).toContain("M15");
    expect(live.texts).toEqual(expect.arrayContaining(["2,329.40", "2,334.80", "2,326.00", "2,327.60", "2026-08-15 14:30"]));

    const stale = await show(send, `http://127.0.0.1:${appPort}/kline-harness?symbol=XAUUSD&provenance=STALE`);
    expect(stale.pro).toBe(true);
    expect(stale.text).toContain("STALE · XAUUSD · stale");
    expect(stale.text).not.toContain("LIVE · XAUUSD · ready");
    expect(stale.texts).toContain("2,327.60");

    for (const provenance of ["SIMULATOR", "REPLAY", "UNAVAILABLE", "FIXTURE"]) {
      const blocked = await show(send, `http://127.0.0.1:${appPort}/kline-harness?symbol=XAUUSD&provenance=${provenance}`);
      expect(blocked.pro).toBe(false);
      expect(blocked.canvas).toBe(0);
      expect(blocked.text).toContain("Waiting for live XAUUSD market data");
      expect(blocked.text).not.toContain("2,327.60");
      expect(blocked.texts).toEqual([]);
    }

    const foreign = await show(send, `http://127.0.0.1:${appPort}/kline-harness?symbol=EURUSD&provenance=LIVE`);
    expect(foreign.pro).toBe(false);
    expect(foreign.canvas).toBe(0);
    expect(foreign.text).not.toContain("2,327.60");
    expect(foreign.texts).toEqual([]);

    expect(requests.some((url) => /metaapi|polygon|tradingview|charting_library/i.test(url))).toBe(false);
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

async function show(
  send: (method: string, params?: Record<string, unknown>) => Promise<{ result?: { result?: { value?: string } } }>,
  url: string,
): Promise<Probe> {
  await send("Page.navigate", { url });
  let probe: Probe = { pro: false, canvas: 0, engine: null, text: "", texts: [] };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        pro: !!document.querySelector(".klinecharts-pro"),
        canvas: document.querySelectorAll("canvas").length,
        engine: document.querySelector("[data-chart-engine]")?.getAttribute("data-chart-engine") ?? null,
        text: document.body?.innerText ?? "",
        texts: window.__chartTexts ?? []
      })`,
      returnByValue: true,
    });
    probe = JSON.parse(result.result?.result?.value ?? "null") as Probe;
    const waiting = probe.text.includes("Waiting for live XAUUSD market data");
    if ((probe.pro && probe.canvas > 0 && probe.texts.length > 0) || (waiting && probe.engine !== null)) return probe;
  }
  return probe;
}
