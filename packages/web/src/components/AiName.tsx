"use client";
// The §40.14 AI display name for end-user copy ("Draft improvements with Aria", "Aria assessment").
// Read from /api/me through the shared cache, so every badge and card on a page shares one request.
// Admin surfaces never use this — they keep saying "AI".
import { useEffect, useState } from "react";
import { AI_DISPLAY_NAME_DEFAULT } from "@skilly/shared/ai-name";
import { cachedGet } from "./ui";

export function useAiName(): string {
  const [name, setName] = useState(AI_DISPLAY_NAME_DEFAULT);
  useEffect(() => {
    let live = true;
    cachedGet<{ aiDisplayName?: string }>("/api/me")
      .then((j) => {
        if (live && typeof j?.aiDisplayName === "string" && j.aiDisplayName.trim()) setName(j.aiDisplayName);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return name;
}
