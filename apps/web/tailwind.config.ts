import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        stage: '#0b1220',
        brass: '#f59e0b',
        mint: '#34d399',
        slateblue: '#2c3f62',
        ivory: '#f4f6fb'
      },
      boxShadow: {
        halo: '0 12px 30px rgba(12, 20, 35, 0.42)'
      }
    }
  },
  plugins: []
};

export default config;
