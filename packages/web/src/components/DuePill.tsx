"use client";
// The §65.5 due pill — *Due in 2d*, *Due today*, *Overdue*, *Overdue 3d* (whole business days) — with
// the absolute due instant in the viewer's own date format as its tooltip.
import { duePill, duePillLabel, duePillTone } from "@skilly/shared/review-target";
import { Pill } from "./ui";
import { useDateFmt } from "./DateFormat";

export function DuePill({ dueAt, testId = "due-pill" }: { dueAt: string; testId?: string }) {
  const fmt = useDateFmt();
  const pill = duePill(new Date(dueAt), new Date());
  return (
    <span title={`Due ${fmt.dateTime(dueAt)}`} data-testid={testId} data-due={pill.kind}>
      <Pill tone={duePillTone(pill)}>{duePillLabel(pill)}</Pill>
    </span>
  );
}
