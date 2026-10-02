import { useEffect, useState } from "react";

import { XauUsdChart } from "./XauUsdChart.tsx";
import type { CanonicalCandle } from "../trading/kline-adapter.ts";

type Room = {
  source: string;
  serverNow: string;
  environment: string | null;
  agentPresence: string;
  market: {
    provider: string;
    observation: {
      provenance: string;
      timeframe: string | null;
      bid: number | null;
      ask: number | null;
      spread: number | null;
      ageMs: number | null;
      candleCount: number;
    } | null;
  };
  decision: { id: string; direction: string; status: string; thesis: string; expiry: string; evidenceQuality: string; stop?: number; targets: number[] } | null;
  decisionAvailability: string;
  risk: { id: string; state: string; reasons: string[] } | null;
  policy: { id: string; state: string; progression: string; reasons: string[] } | null;
  approval: { open: { requestId: string; expiresAt: string; decisionId: string } | null; decision: { id: string; state: string; reasons: string[] } | null };
  gate: { id: string; state: string; reasons: string[] } | null;
  execution: { id: string; state: string; reasons: string[]; brokerCalled: boolean } | null;
  reconciliation: { id: string; state: string } | null;
  position: { availability: string; state: string | null; brokerPositionId: string | null; direction: string | null; brokerQuantity: number | null };
  monitoring: { availability: string; observedAt: string | null; decision: string | null; failureCodes: string[]; brokerHealth: string | null };
  exit: { proposal: string; authorizationRequired: boolean; closeNotRepresentable: boolean; execution: { id: string; state: string; brokerCalled: boolean } | null };
  killSwitch: { state: string; updatedAt: string | null };
  pause: { paused: boolean; jobId: string | null };
  nextAction: {
    action: string;
    reason: string | null;
    blockingCondition: string | null;
    allowedUserAction: string;
    allowedUserActions: string[];
    expiresAt: string | null;
    safety: { killSwitch: string; paused: boolean; autonomousOrdersBlocked: boolean };
  };
  timeline: { eventId: string; type: string; at: string; actor: string; monitoringDecision: string | null; failureCodes: string[] }[];
  memory: { recordId: string; kind: string; recordedAt: string; body: string }[];
  review: string;
  attachedConversation: { availability: string; threadId: string | null; providerTurnId: string | null; occurrenceId: string | null; agentRunId: string | null };
};

type DeskChart = { provenance: string; timeframe: string | null; candles: readonly CanonicalCandle[] };
type DeskPayload = { room: Room; chart?: DeskChart };

const SECTIONS = ["desk", "trading", "research", "automation", "lab", "settings"] as const;
const EMPTY_CANDLES: readonly CanonicalCandle[] = [];
const NO_EVENTS: readonly { readonly type: string; readonly at: string }[] = [];

const PRESENCE_AR: Record<string, string> = {
  PAUSED: "متوقف مؤقتًا",
  ERROR: "توقفت الجولة بخطأ",
  CONFIRMING: "بانتظار تأكيد الوسيط",
  EXIT_WORKING: "إغلاق معتمد قيد التأكيد",
  DEGRADED: "المطابقة متدهورة",
  MONITORING: "مراقبة صفقة مؤكدة",
  AWAITING_APPROVAL: "بانتظار موافقتك",
  DECISION_READY: "قرار مسجل",
  ANALYZING: "تحليل مسجل ولم يكتمل",
  OBSERVING: "رصد سوق مسجل",
  WAITING_FOR_DATA: "بانتظار سوق موثوق",
  IDLE: "لا عمل مسجل",
};

const ACTION_AR: Record<string, string> = {
  STORE_UNAVAILABLE: "سجل التداول غير متاح",
  BLOCKED_KILL_SWITCH_UNKNOWN: "مفتاح الإيقاف غير معروف، والتنفيذ مغلق",
  BLOCKED_KILL_SWITCH: "مفتاح الإيقاف مفعّل",
  BLOCKED_DESYNCED: "دفاتر الوسيط غير متطابقة",
  WAITING_FOR_RECONCILIATION: "بانتظار مطابقة الوسيط",
  PAUSED: "المهمة متوقفة مؤقتًا",
  WAITING_FOR_APPROVAL: "بانتظار الموافقة",
  WAITING_FOR_RISK_REASSESSMENT: "يلزم إعادة تقييم المخاطر",
  WAITING_FOR_POLICY_REASSESSMENT: "يلزم إعادة تقييم السياسة",
  WAITING_FOR_GATE_APPROVAL: "بوابة التنفيذ تطلب موافقة",
  ELIGIBLE_NOT_SUBMITTED: "مؤهل ولم يُرسل أمر",
  EXIT_RECOMMENDED: "اقتراح خروج غير قابل للتنفيذ",
  EXIT_WORKING: "أمر الإغلاق مقبول ولم يُغلق بعد",
  WAITING_FOR_BROKER_CONFIRMATION: "بانتظار تأكيد الوسيط",
  MONITORING: "آخر دورة مراقبة مسجلة",
  POSITION_OPEN_NO_CYCLE: "صفقة مفتوحة بلا دورة مراقبة مخزنة",
  NO_TRADE: "لا صفقة",
  WAIT: "انتظار",
  EXPIRED: "انتهى القرار",
  REJECTED: "رُفض القرار",
  ANALYSIS_STARTED: "بدأ تحليل ولم يُسجل اكتماله",
  WAITING_FOR_TRUSTED_MARKET: "بانتظار سوق موثوق",
  NO_RECORDED_NEXT_STEP: "لا خطوة تالية مسجلة",
};

const POSITION_AR: Record<string, string> = {
  NO_POSITION: "لا صفقة لدى الوسيط",
  POSITION_PENDING: "الأمر مقبول والصفقة لم تُؤكد",
  POSITION_UNKNOWN: "حالة الصفقة غير معروفة",
  POSITION_OPEN: "صفقة مفتوحة ومطابقة",
  POSITION_PARTIALLY_OPEN: "كمية ناقصة أو مطابقة متدهورة",
  POSITION_CLOSING: "الإغلاق مقبول والصفقة ما زالت قائمة",
  POSITION_CLOSED: "أُغلقت الصفقة بعد مطابقة",
  POSITION_DESYNCED: "تعارض مع الوسيط",
};

function label(map: Record<string, string>, code: string | null | undefined): string {
  if (!code) return "غير متاح";
  return map[code] ?? code;
}

/** One trading room. It renders the server snapshot and does not decide. */
export function TradingDesk({ section }: { section: (typeof SECTIONS)[number] }) {
  const [payload, setPayload] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = () => {
    const controller = new AbortController();
    void fetch("/api/trading/desk", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("desk unavailable");
        return response.json() as Promise<DeskPayload>;
      })
      .then((body) => {
        setPayload(body);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("تعذر تحميل غرفة التداول.");
      });
    return controller;
  };
  useEffect(() => {
    const controller = load();
    return () => controller.abort();
  }, []);
  const room = payload?.room ?? null;
  const recordedPresence = room !== null && room.source === "store" && room.nextAction.action !== "STORE_UNAVAILABLE";
  const chart = payload?.chart;
  const provenance = chart?.provenance ?? room?.market.observation?.provenance ?? "UNAVAILABLE";
  const candles = chart?.candles ?? EMPTY_CANDLES;
  const actions = room?.nextAction.allowedUserActions ?? [];
  const settle = (answer: "approve" | "reject") => {
    const requestId = room?.approval.open?.requestId;
    if (!requestId || pending) return;
    setPending(true);
    void fetch("/api/trading/desk/approval", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, answer }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("approval rejected");
      load();
    }).catch(() => {
      setError("لم تُقبل الموافقة. لم يتغير التنفيذ.");
    }).finally(() => setPending(false));
  };
  return (
    <main className="trading-desk min-h-dvh bg-app px-4 py-6 text-ink" dir="rtl" data-section={section}>
      <header className="mb-6">
        <h1 className="text-xl">غرفة تداول الذهب</h1>
        <p className="text-ink-secondary">XAUUSD · {room?.environment ?? "غير محدد"}</p>
      </header>
      <section aria-label="Safety" className="mb-4 rounded border border-white/10 p-3">
        <h2 className="text-sm text-ink-secondary">السلامة</h2>
        {room === null ? <p>مفتاح الإيقاف غير متاح.</p> : <p>مفتاح الإيقاف: {room.killSwitch.state === "engaged" ? "مفعّل" : room.killSwitch.state === "open" ? "غير مفعّل" : "غير معروف"}</p>}
        {room === null ? <p>الإيقاف المؤقت غير متاح.</p> : <p>{room.pause.paused ? "الإيقاف المؤقت مفعّل. هذا ليس مفتاح الإيقاف." : "لا إيقاف مؤقت مسجل."}</p>}
        {room?.nextAction.safety.autonomousOrdersBlocked ? <p>الأوامر الذاتية ممنوعة.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
      <section aria-label="Market" className="mb-4">
        <h2 className="text-sm text-ink-secondary">السوق</h2>
        <p>توفر المزود: {room?.market.provider ?? "unavailable"}</p>
        <p dir="ltr">provenance {provenance}</p>
        {room?.market.observation?.bid != null ? <p dir="ltr">{room.market.observation.bid} / {room.market.observation.ask}</p> : <p>لا تسعيرة في هذه اللقطة.</p>}
      </section>
      <section aria-label="Agent presence" className="mb-4">
        <h2 className="text-sm text-ink-secondary">حضور الوكيل</h2>
        {recordedPresence ? <p>{label(PRESENCE_AR, room.agentPresence)}</p> : <p>الحضور غير متاح.</p>}
        <p dir="ltr">{recordedPresence ? room.agentPresence : "UNAVAILABLE"}</p>
      </section>
      <section aria-label="Next action" className="mb-4">
        <h2 className="text-sm text-ink-secondary">الخطوة التالية</h2>
        <p>{label(ACTION_AR, room?.nextAction.action)}</p>
        {room?.nextAction.blockingCondition ? <p dir="ltr">{room.nextAction.blockingCondition}</p> : null}
        {room?.nextAction.expiresAt ? <p dir="ltr">{room.nextAction.expiresAt}</p> : null}
        {actions.includes("APPROVE") && actions.includes("REJECT") ? (
          <div className="mt-3 flex gap-2">
            <button type="button" className="min-h-11 min-w-11 rounded bg-white/10 px-4 py-2" disabled={pending} onClick={() => settle("approve")}>موافقة</button>
            <button type="button" className="min-h-11 min-w-11 rounded bg-white/10 px-4 py-2" disabled={pending} onClick={() => settle("reject")}>رفض</button>
          </div>
        ) : null}
        {actions.includes("ASK") ? <p>السؤال يتم في المحادثة الأصلية المرتبطة، وليس من محرك آخر.</p> : null}
      </section>
      <section aria-label="Decision" className="mb-4">
        <h2 className="text-sm text-ink-secondary">القرار</h2>
        {room === null ? <p>القرار غير متاح.</p> : room.decision ? (
          <>
            <p dir="ltr">{room.decision.direction} · {room.decision.status}</p>
            <p>{room.decision.thesis}</p>
            <p dir="ltr">{room.decision.stop ?? "—"} · {room.decision.targets.join(", ") || "—"}</p>
          </>
        ) : <p>لا قرار مخزن. {room.decisionAvailability === "NOT_AVAILABLE" ? "الغياب مسجل." : ""}</p>}
      </section>
      <section aria-label="Risk and policy" className="mb-4">
        <h2 className="text-sm text-ink-secondary">المخاطر والسياسة</h2>
        {room === null ? <p>المخاطر والسياسة غير متاحة.</p> : (
          <>
            <p>{room.risk ? room.risk.state : "لا تقييم مخاطر في اللقطة"}</p>
            <p>{room.policy ? `${room.policy.state} · ${room.policy.progression}` : "لا تقييم سياسة في اللقطة"}</p>
            <p>{room.gate ? room.gate.state : "لا بوابة تنفيذ في اللقطة"}</p>
          </>
        )}
      </section>
      <section aria-label="Position" className="mb-4">
        <h2 className="text-sm text-ink-secondary">الصفقة والتنفيذ</h2>
        {room === null ? <p>الصفقة والتنفيذ غير متاحين.</p> : (
          <>
            <p>{room.position.availability === "NOT_AVAILABLE" ? "غير متاح" : label(POSITION_AR, room.position.state)}</p>
            {room.position.brokerPositionId ? <p dir="ltr">{room.position.direction} {room.position.brokerQuantity} · {room.position.brokerPositionId}</p> : null}
            <p>{room.execution ? room.execution.state : "لا تنفيذ مسجل"}</p>
            <p>{room.execution?.brokerCalled ? "الوسيط استُدعي." : "لا تأكيد أن الوسيط استُدعي."}</p>
            <p>{room.reconciliation ? room.reconciliation.state : "لا مطابقة في اللقطة"}</p>
            {room.exit.authorizationRequired ? <p>الخروج مقترح ويحتاج تفويضًا. لم يُرسل أمر إغلاق.</p> : null}
            {room.exit.execution ? <p dir="ltr">exit {room.exit.execution.state}</p> : null}
          </>
        )}
      </section>
      <section aria-label="Monitoring" className="mb-4">
        <h2 className="text-sm text-ink-secondary">المراقبة</h2>
        {room === null ? <p>المراقبة غير متاحة.</p> : room.monitoring.availability === "NOT_AVAILABLE" ? <p>لا دورة مراقبة مخزنة.</p> : (
          <p dir="ltr">{room.monitoring.availability} · {room.monitoring.decision ?? "—"} · {room.monitoring.observedAt ?? ""}</p>
        )}
      </section>
      <section aria-label="Chart" className="mb-4" dir="ltr">
        <XauUsdChart symbol="XAUUSD" provenance={provenance} candles={candles} positionState={room?.position.state ?? null} events={NO_EVENTS} />
      </section>
      <section aria-label="Timeline" className="mb-4">
        <h2 className="text-sm text-ink-secondary">السجل</h2>
        {room && room.timeline.length === 0 ? <p>لا أحداث تداول مسجلة.</p> : null}
        <ol>
          {room?.timeline.map((entry) => (
            <li key={entry.eventId} dir="ltr">{entry.at} · {entry.type}{entry.monitoringDecision ? ` · ${entry.monitoringDecision}` : ""}</li>
          ))}
        </ol>
      </section>
      <section aria-label="Memory" className="mb-4">
        <h2 className="text-sm text-ink-secondary">الذاكرة</h2>
        <p>المراجعة: دليل زمني فقط، ولا يوجد متن مراجعة.</p>
        {room && room.memory.length === 0 ? <p>لا ذاكرة تداول لهذه الجولة.</p> : null}
        <ul>
          {room?.memory.map((item) => <li key={item.recordId}>{item.kind}: {item.body}</li>)}
        </ul>
      </section>
      <section aria-label="Conversation" className="mb-4">
        <h2 className="text-sm text-ink-secondary">المحادثة</h2>
        {room === null ? <p>المحادثة غير متاحة.</p> : room.attachedConversation.availability === "ATTACHED" ? (
          <p dir="ltr">thread {room.attachedConversation.threadId} · turn {room.attachedConversation.providerTurnId}</p>
        ) : <p>لا محادثة مرتبطة. لن تُنشأ محادثة جديدة من هنا.</p>}
      </section>
    </main>
  );
}

export function tradingDeskSection(pathname: string): (typeof SECTIONS)[number] | null {
  const name = pathname.replace(/\/+$/, "").slice(1);
  return (SECTIONS as readonly string[]).includes(name) ? name as (typeof SECTIONS)[number] : null;
}
