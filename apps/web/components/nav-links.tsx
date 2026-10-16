"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: { href: string; label: string; badge?: number }[] }) {
  const path = usePathname();
  // the most specific matching link wins (/leads/import over /leads)
  const current = items
    .filter((it) => (it.href === "/" ? path === "/" : path === it.href || path.startsWith(`${it.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <ul className="flex gap-1 md:flex-col">
      {items.map((it) => {
        const active = it.href === current;
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm ${active ? "bg-white/12 font-medium text-white" : "text-white/70 hover:text-white"}`}
            >
              {it.label}
              {!!it.badge && <span className="rounded-full bg-ochre px-1.5 text-xs font-medium tabular-nums text-white">{it.badge}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
