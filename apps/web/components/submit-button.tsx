"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes } from "react";

/** A form button that is disabled while its form is submitting, so a double click can't act twice. */
export function SubmitButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return <button {...props} disabled={pending || props.disabled} aria-disabled={pending || props.disabled} className={`${props.className ?? ""} disabled:opacity-50`} />;
}
