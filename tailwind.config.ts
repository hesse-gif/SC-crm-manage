import type { Config } from "tailwindcss";

// haru-ui 시맨틱 토큰 → Tailwind 매핑.
// 원시값은 globals.css의 CSS 변수(space-separated RGB)로 정의하고
// 여기서는 rgb(var(--x) / <alpha-value>)로 래핑해 opacity 모디파이어를 지원한다.
const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("--canvas"),
        surface: token("--surface"),
        paper: token("--paper"),
        line: token("--line"),
        accent: {
          DEFAULT: token("--accent"),
          soft: token("--accent-soft"),
        },
        ink: {
          DEFAULT: token("--ink"),
          2: token("--ink-2"),
          3: token("--ink-3"),
          4: token("--ink-4"),
        },
        fill: {
          DEFAULT: token("--fill"),
          2: token("--fill-2"),
          3: token("--fill-3"),
        },
        ok: { DEFAULT: token("--ok"), soft: token("--ok-soft") },
        warn: { DEFAULT: token("--warn"), soft: token("--warn-soft") },
        danger: { DEFAULT: token("--danger"), soft: token("--danger-soft") },
        info: { DEFAULT: token("--info"), soft: token("--info-soft") },
        ai: { DEFAULT: token("--ai"), soft: token("--ai-soft") },
      },
      borderRadius: {
        xs: "4px",
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "20px",
        // Tailwind 기본 2xl(16px)은 xl(20px)보다 작아 동심원 위계가 역전된다.
        // haru-ui 라운드 스케일을 xs<sm<md<lg<xl<2xl 순으로 정렬(outer=24 > inner=20/16).
        "2xl": "24px",
      },
      fontFamily: {
        sans: [
          '"Pretendard Std Variable"',
          '"Pretendard Variable"',
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "system-ui",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(17,17,17,0.04)",
        pop: "0 8px 28px rgba(17,17,17,0.10)",
      },
      maxWidth: {
        content: "1180px",
      },
    },
  },
  plugins: [],
};

export default config;
