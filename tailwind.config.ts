import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral, near-black brand. Used for primary buttons, active nav,
        // and any high-emphasis UI element. Keeps the rest of the surface
        // calm and lets content lead.
        brand: {
          50: "#f6f6f6",
          100: "#ececec",
          200: "#dcdcdc",
          300: "#bdbdbd",
          400: "#8a8a8a",
          500: "#3a3a3a",
          600: "#1f1f1f",
          700: "#171717",
          800: "#0f0f0f",
          900: "#000000",
        },
        ink: {
          DEFAULT: "#0a0a0a",
          muted: "#525252",
          subtle: "#737373",
        },
        surface: {
          DEFAULT: "#ffffff",
          base: "#fafafa",
          alt: "#f5f5f5",
        },
        line: "#ececec",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        serif: [
          "ui-serif",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "Times",
          "serif",
        ],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.25rem",
      },
    },
  },
  plugins: [],
};

export default config;
