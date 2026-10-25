import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import themeLoader from './src/integrations/theme-loader.ts';
import pluginLoader from './src/integrations/plugin-loader.ts';
import clientLoader from './src/integrations/client-loader.ts';
import swup from '@swup/astro';
import { sharedAliases } from './vite.shared.mjs';

const isBuild = process.argv.includes('build');

export default defineConfig({
  session: false,
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    inspectorPort: isBuild ? false : undefined,
  }),
  security: {
    checkOrigin: true,
  },
  integrations: [
    themeLoader(),
    pluginLoader(),
    clientLoader(),
    swup({
      containers: ['#main', '#secondary', '#header', '#footer'],
      cache: true,
      smoothScrolling: true,
      animationDuration: 400,
    }),
  ],
  
  // ============================================================
  // 修复 CSP 拦截 Giscus 和预留 Waline 支持
  // ============================================================
  experimental: {
    csp: {
      // 在保留原有资源的基础上，追加放行 Giscus 和 Waline 的脚本
      scriptDirective: {
        resources: [
          "'self'",
          "'unsafe-inline'",
          "https://giscus.app",
          "https://unpkg.com",          // Waline 的默认 CDN
          "https://cdn.jsdelivr.net"    // Waline 备用 CDN
        ]
      },
      // 追加放行 Giscus 和 Waline 的样式
      styleDirective: {
        resources: [
          "'self'",
          "'unsafe-inline'",
          "https://giscus.app",
          "https://unpkg.com",
          "https://cdn.jsdelivr.net"
        ]
      },
      // 追加放行 iframe（Giscus 和 Waline 都需要）
      directives: [
        "frame-src 'self' https://giscus.app https://*.hbw.me", // 如果你的 Waline 部署在 hbw.me 的子域名，这里无需改；否则改成你的 Waline 域名
        "img-src 'self' data: https: https://giscus.app https://*.hbw.me", // 允许 Waline 的图片/头像
        "connect-src 'self' https://giscus.app https://*.hbw.me"           // 允许 Waline 请求后台接口
      ]
    }
  },

  vite: {
    resolve: {
      alias: sharedAliases,
    },
  },
});
