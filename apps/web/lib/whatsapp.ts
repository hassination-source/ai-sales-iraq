import { splitSignature } from "@ais/agent";

/** Iraqi mobile numbers only (+9647…): landlines have no WhatsApp. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return /^9647\d{9}$/.test(d) ? d : null;
}

/**
 * Click-to-chat link that opens WhatsApp with the message filled in; the user sends it from their own
 * WhatsApp. The fixed signature is cut to its first two lines (name and company) — a chat isn't a letter.
 */
export function whatsappLink(phone: string | null | undefined, body?: string, signature?: string | null): string | null {
  const n = whatsappNumber(phone);
  if (!n) return null;
  if (!body) return `https://wa.me/${n}`;
  const { main, signature: sig } = splitSignature(body, signature);
  const short = sig ? `${main}\n\n${sig.split("\n").slice(0, 2).join("\n")}` : main;
  return `https://wa.me/${n}?text=${encodeURIComponent(short.slice(0, 1500))}`;
}
