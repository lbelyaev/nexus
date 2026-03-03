import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#05070d",
          900: "#0b1020",
          800: "#111931",
          100: "#dbe7ff",
        },
        pulse: {
          500: "#26f0ca",
          400: "#46d8ff",
          300: "#73f2b8",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(70, 216, 255, 0.18), 0 12px 40px rgba(8, 15, 35, 0.45)",
      },
    },
  },
  plugins: [],
};

export default config;
