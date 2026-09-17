import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true, // 04 M1：允许局域网访问，供 owner 用手机试玩开发版
    port: 5173,
    allowedHosts: ['serrated-majority-anatomist.ngrok-free.dev'],
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
