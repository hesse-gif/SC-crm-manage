import type { SVGProps } from "react";

// Substack 레퍼런스 톤에 맞춘 라인 아이콘 (stroke, currentColor).
// haru-ui: 아이콘은 텍스트 직관성을 보조 — 작고 절제되게.
type P = SVGProps<SVGSVGElement>;

function base(props: P) {
  return {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

export const Grid = (p: P) => (
  <svg {...base(p)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const Users = (p: P) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-4.8 5.5-4.8S14.5 16 14.5 19" /><path d="M16 5.2a3 3 0 0 1 0 5.6" /><path d="M17 14.4c2.4.5 4 2.2 4 4.6" /></svg>
);
export const Chat = (p: P) => (
  <svg {...base(p)}><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4.5 3.5V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z" /></svg>
);
export const Ruler = (p: P) => (
  <svg {...base(p)}><path d="M3.8 9.2 14.8 20.2 20.2 14.8 9.2 3.8 3.8 9.2Z" /><path d="M7 7l1.6 1.6M10 10l1.6 1.6M13 13l1.6 1.6" /></svg>
);
export const Doc = (p: P) => (
  <svg {...base(p)}><path d="M6.5 3h7L19 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M13 3v5h5" /><path d="M8 13h8M8 16.5h5" /></svg>
);
export const Check = (p: P) => (
  <svg {...base(p)}><path d="M12 2.8 19.5 6v5.4c0 4.4-3 7.4-7.5 9.8-4.5-2.4-7.5-5.4-7.5-9.8V6L12 2.8Z" /><path d="M8.8 12l2.2 2.2 4.2-4.4" /></svg>
);
export const Pulse = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M4.5 12.5h3l2-4.5 3 8 2-3.5h2.5" /></svg>
);
export const Swatch = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="3.5" width="7" height="17" rx="2" /><path d="M10.5 14.5 16 9a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L13 21" /><circle cx="7" cy="17.5" r=".9" fill="currentColor" stroke="none" /></svg>
);
export const Search = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.5-3.5" /></svg>
);
export const Bell = (p: P) => (
  <svg {...base(p)}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const Plus = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const ChevronRight = (p: P) => (
  <svg {...base(p)}><path d="m9 5 7 7-7 7" /></svg>
);
export const ChevronLeft = (p: P) => (
  <svg {...base(p)}><path d="m15 5-7 7 7 7" /></svg>
);
export const Sparkles = (p: P) => (
  <svg {...base(p)}><path d="M12 3.5 13.7 9 19 10.5 13.7 12 12 17.5 10.3 12 5 10.5 10.3 9 12 3.5Z" /><path d="M18.5 16.5 19.2 18.6 21.3 19.3 19.2 20 18.5 22 17.8 20 15.7 19.3 17.8 18.6 18.5 16.5Z" /></svg>
);
export const Filter = (p: P) => (
  <svg {...base(p)}><path d="M3.5 6h17M6.5 12h11M10 18h4" /></svg>
);
export const Dots = (p: P) => (
  <svg {...base(p)}><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
);
export const Archive = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16v13H4V7Z" /><path d="M3 4h18v3H3V4Z" /><path d="M9 11h6" /></svg>
);
export const Trash = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></svg>
);
export const UserCheck = (p: P) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-4.8 5.5-4.8 1.2 0 2.3.3 3.2.8" /><path d="m15.5 17.5 2 2 4-4" /></svg>
);
export const Paperclip = (p: P) => (
  <svg {...base(p)}><path d="M20 11.5 12 19.4a4.5 4.5 0 0 1-6.4-6.4l8-7.9a3 3 0 0 1 4.3 4.3l-8 7.9a1.5 1.5 0 0 1-2.2-2.2l7.3-7.2" /></svg>
);
export const Send = (p: P) => (
  <svg {...base(p)}><path d="M4.5 12 20 4.5 14.5 20l-3-6.5-7-1.5Z" /></svg>
);
export const Refresh = (p: P) => (
  <svg {...base(p)}><path d="M20 6.5v5h-5" /><path d="M4 17.5v-5h5" /><path d="M18.1 10A6.5 6.5 0 0 0 6.9 7.4L4 10" /><path d="M5.9 14A6.5 6.5 0 0 0 17.1 16.6L20 14" /></svg>
);
export const Alert = (p: P) => (
  <svg {...base(p)}><path d="M12 3.5 21.5 20H2.5L12 3.5Z" /><path d="M12 10v4M12 17h.01" /></svg>
);
export const Close = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const Menu = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const Sign = (p: P) => (
  <svg {...base(p)}><path d="M3 17.5c2-1 2.6-7.5 4.2-7.5 1.2 0 .6 4 2 4 1.2 0 1.6-6 3.2-6 1.4 0 1 5 2.3 5 1 0 1.6-2 2.6-2" /><path d="M3 20.5h18" /></svg>
);
export const Shield = (p: P) => (
  <svg {...base(p)}><path d="M12 3 19 6v5c0 4.2-2.9 7.2-7 9-4.1-1.8-7-4.8-7-9V6l7-3Z" /></svg>
);
export const Google = (p: P) => (
  <svg width={20} height={20} viewBox="0 0 24 24" {...p}>
    <path fill="#4285F4" d="M21.6 12.2c0-.7-.06-1.3-.18-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
    <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 .95-3.4.95-2.6 0-4.8-1.75-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.4 13.95a6 6 0 0 1 0-3.9V7.45H3.1a10 10 0 0 0 0 9.1l3.3-2.6Z" />
    <path fill="#EA4335" d="M12 5.95c1.47 0 2.78.5 3.8 1.5l2.85-2.85A10 10 0 0 0 3.1 7.45l3.3 2.6C7.2 7.7 9.4 5.95 12 5.95Z" />
  </svg>
);
export const ThumbUp = (p: P) => (
  <svg {...base(p)}><path d="M7 10v10H4.5A1.5 1.5 0 0 1 3 18.5v-7A1.5 1.5 0 0 1 4.5 10H7Z" /><path d="M7 10l3.8-6.5c1.2 0 2 .9 2 2.1L12.3 9h5a1.8 1.8 0 0 1 1.77 2.18l-1.3 6.2A2 2 0 0 1 15.8 20H7" /></svg>
);
export const ThumbDown = (p: P) => (
  <svg {...base(p)}><path d="M7 14V4H4.5A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7Z" /><path d="M7 14l3.8 6.5c1.2 0 2-.9 2-2.1L12.3 15h5a1.8 1.8 0 0 0 1.77-2.18l-1.3-6.2A2 2 0 0 0 15.8 4H7" /></svg>
);
export const Book = (p: P) => (
  <svg {...base(p)}><path d="M5 4.5h11A1.5 1.5 0 0 1 17.5 6v14H6.5A1.5 1.5 0 0 1 5 18.5V4.5Z" /><path d="M5 16.5h12.5" /><path d="M8.5 8h6M8.5 11h4" /></svg>
);
export const Table = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" /></svg>
);
export const Play = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M10 8.4l5.2 3.6-5.2 3.6V8.4Z" fill="currentColor" stroke="none" /></svg>
);
export const Cog = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v2.3M12 19.2v2.3M4.6 12H2.3M21.7 12h-2.3M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" /></svg>
);
export const Star = (p: P) => (
  <svg {...base(p)}><path d="M12 3.6l2.5 5.1 5.6.8-4.05 3.95.95 5.55L12 16.9 6.95 19l.95-5.55L3.85 9.5l5.6-.8L12 3.6Z" /></svg>
);
// 출처 브랜드 아이콘 (고정 색상)
export const Youtube = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...p}><rect x="2" y="5" width="20" height="14" rx="4" fill="#FF0000" /><path d="M10 8.6l6 3.4-6 3.4Z" fill="#fff" /></svg>
);
export const Reddit = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="10" fill="#FF4500" /><circle cx="8.6" cy="12.6" r="1.4" fill="#fff" /><circle cx="15.4" cy="12.6" r="1.4" fill="#fff" /><path d="M8.7 15.4c.9.8 2 1.2 3.3 1.2s2.4-.4 3.3-1.2" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
);
export const Download = (p: P) => (
  <svg {...base(p)}><path d="M12 4v10m0 0 4-4m-4 4-4-4" /><path d="M5 20h14" /></svg>
);
export const Upload = (p: P) => (
  <svg {...base(p)}><path d="M12 20v-10m0 0 4 4m-4-4-4 4" /><path d="M5 4h14" /></svg>
);
export const ExternalLink = (p: P) => (
  <svg {...base(p)}><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V14" /></svg>
);

export const icons: Record<string, (p: P) => React.ReactElement> = {
  grid: Grid, users: Users, chat: Chat, ruler: Ruler, doc: Doc,
  check: Check, pulse: Pulse, swatch: Swatch, sparkles: Sparkles, shield: Shield, book: Book, table: Table, send: Send, play: Play, cog: Cog, star: Star, archive: Archive, trash: Trash, userCheck: UserCheck,
};
