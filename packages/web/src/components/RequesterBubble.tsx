"use client";
// A request's requester bubble (§26). A *Platform* request (§62.10) has no person behind it: it
// shows the skilly mark (the navy tile with the cyan diamond, as a bubble) instead of a UserBubble,
// so there is no hover card, Reach out or Follow.
import { UserBubble } from "./UserBubble";

const NAVY = "#082773";
const CYAN = "#14abe3";

export function PlatformMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      data-testid="platform-requester-mark"
      style={{
        width: size, height: size, borderRadius: "50%", background: NAVY, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <span style={{ width: Math.round(size * 0.36), height: Math.round(size * 0.36), background: CYAN, borderRadius: Math.max(1, Math.round(size * 0.08)), transform: "rotate(45deg)" }} />
    </span>
  );
}

export function RequesterBubble({ userId, name, avatar, size = 20 }: { userId: string | null; name: string; avatar: string | null; size?: number }) {
  return userId ? <UserBubble name={name} avatar={avatar} userId={userId} size={size} /> : <PlatformMark size={size} />;
}
