/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: {
          950: '#0b1326',
          900: '#171f33',
          850: '#222a3d',
        },
        neon: {
          green: '#05e777',
          red: '#de211c',
          cyan: '#0066ff',
        },
        outline: {
          500: '#424656',
          400: '#8c90a1',
        },
        surface: {
          variant: '#2d3449',
          bright: '#31394d',
          low: '#131b2e',
        },
        text: {
          primary: '#dae2fd',
          muted: '#c2c6d8',
        },
      },
    },
  },
  plugins: [],
};
