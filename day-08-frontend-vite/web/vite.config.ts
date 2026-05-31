import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// S3 정적 호스팅(루트)에 그대로 올릴 거라 base 는 기본값 "/" 유지.
// Day 9 에서 CloudFront 묶을 때도 루트 매핑이라 그대로 둠.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
