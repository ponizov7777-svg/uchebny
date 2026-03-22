/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./admin.html", "./yuridicheskie/**/*.html"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 10px 30px rgba(2, 6, 23, 0.12)",
        neon: "0 0 20px rgba(251, 191, 36, 0.3)",
        neonRed: "0 0 20px rgba(239, 68, 68, 0.3)",
      },
    },
  },
  plugins: [],
};

