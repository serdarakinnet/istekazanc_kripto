/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: {
          950: '#05070a',
          900: '#0b0f14',
          850: '#101722',
        },
        neon: {
          green: '#00ff88',
          red: '#ff3b5c',
          cyan: '#4ce6ff',
        },
      },
    },
  },
  plugins: [],
};
