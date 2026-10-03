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
  vite: {
    resolve: {
      alias: sharedAliases,
    },
  },
});
