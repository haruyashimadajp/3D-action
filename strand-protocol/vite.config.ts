import { defineConfig, type Plugin } from 'vite';

/**
 * Makes dist/index.html a single self-contained file that runs anywhere:
 *  - double-clicked from disk (file://) — browsers block external module scripts there (CORS, origin "null")
 *  - GitHub HTML Preview (htmlpreview.github.io) — it rewrites every <script> and re-runs it as a classic script
 *  - any static host / GitHub Pages
 * The entry chunk is bundled as an IIFE (no import/export) and inlined as a classic <script> at the end of <body>.
 */
function inlineSingleFile(): Plugin {
  return {
    name: 'strand-inline-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') return;
      let source = typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !file.isEntry) continue;
        const escaped = file.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tag = new RegExp(`<script[^>]*src="[^"]*${escaped}"[^>]*></script>\\s*`);
        if (!tag.test(source)) continue;
        const code = file.code.replace(/<\/script/gi, '<\\/script');
        source = source.replace(tag, '');
        source = source.replace(/<\/body>/i, () => `<script>${code}</script>\n</body>`);
        delete bundle[file.fileName];
      }
      html.source = source;
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    rolldownOptions: {
      output: {
        format: 'iife',
        codeSplitting: false,
      },
    },
  },
  plugins: [inlineSingleFile()],
});
