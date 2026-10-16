"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { describeEvent, type AgentEvent, type Lang } from "@/lib/events";
import { loadEvents } from "@/app/(app)/agent-actions";

const DOT: Record<AgentEvent["level"], string> = {
  info: "bg-muted/50",
  success: "bg-lapis",
  warning: "bg-ochre",
  error: "bg-brick",
};

/** Live list of what the agent is doing. Polls while the tab is visible. */
export function ActivityFeed({ initial, lang, segments, live }: { initial: AgentEvent[]; lang: Lang; segments: Record<string, string>; live: boolean }) {
  const [events, setEvents] = useState(initial);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const latest = useRef(initial[0]?.id ?? 0);
  const ar = lang === "ar";

  useEffect(() => {
    let stop = false;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await loadEvents(latest.current);
        if (stop || !next.length) return;
        latest.current = next[0]!.id;
        setFresh(new Set(next.map((e) => e.id)));
        setEvents((old) => [...next, ...old].slice(0, 100));
      } catch {
        // a missed poll is harmless; the next one catches up
      }
    }
    const id = setInterval(poll, live ? 4000 : 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [live]);

  if (!events.length)
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center">
        <p className="font-medium">{ar ? "لا يوجد نشاط بعد" : "No activity yet"}</p>
        <p className="mt-1 text-sm text-muted">{ar ? "ابدأ مهمة وسترى هنا كل خطوة يقوم بها الوكيل." : "Start a mission and every step the agent takes shows up here."}</p>
      </div>
    );

  const time = (iso: string) => new Intl.DateTimeFormat(ar ? "ar-IQ" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const day = (iso: string) => new Intl.DateTimeFormat(ar ? "ar-IQ" : "en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));

  let lastDay = "";
  return (
    <ol className="relative space-y-0" aria-live="polite">
      {events.map((e) => {
        const d = day(e.created_at);
        const header = d !== lastDay ? (lastDay = d) : null;
        const text = describeEvent(e, lang, (k) => segments[k] ?? k);
        return (
          <li key={e.id}>
            {header && <p className="pb-2 pt-4 text-xs font-medium text-muted first:pt-0">{header}</p>}
            <div className={`flex gap-3 rounded-md px-2 py-2 ${fresh.has(e.id) ? "bg-lapis-soft/60" : ""}`}>
              <span className={`mt-2 size-2 shrink-0 rounded-full ${DOT[e.level]}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed">
                  {e.draft_id ? (
                    <Link href="/approvals" className="hover:text-lapis">{text}</Link>
                  ) : e.company_id ? (
                    <Link href={`/leads/${e.company_id}`} className="hover:text-lapis">{text}</Link>
                  ) : (
                    text
                  )}
                </p>
              </div>
              <time className="shrink-0 text-xs tabular-nums text-muted" dateTime={e.created_at}>{time(e.created_at)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
