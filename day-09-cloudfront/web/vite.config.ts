import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CloudFront 가 default behavior 로 S3 루트를 매핑하므로 base 는 "/" 유지.
// /api/* 만 두 번째 behavior 로 Function URL 로 빠짐.
//
// dev 서버에서도 동일오리진처럼 보이게 하려고 proxy 설정 — `npm run dev` 로 로컬에서 켜면
// http://localhost:5173/api/* 가 Day 7 Function URL 로 바로 흘러가서 CORS 신경 X.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    proxy: process.env.VITE_FUNCTION_URL_FOR_DEV
      ? {
          '/api': {
            target: process.env.VITE_FUNCTION_URL_FOR_DEV,
            changeOrigin: true,
            secure: true,
            rewrite: (p) => p.replace(/^\/api/, ''),
          },
        }
      : undefined,
  },
});
