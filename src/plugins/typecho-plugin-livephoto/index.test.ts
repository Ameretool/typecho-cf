import { describe, expect, it } from 'vitest';
import init from './index';

function setupHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-livephoto',
    addHook: (point: string, _id: string, handler: Function) => {
      hooks.set(point, handler);
    },
  } as any);
  return hooks;
}

describe('LivePhoto plugin', () => {
  it('registers the frontend and admin editor hooks', () => {
    const hooks = setupHooks();
    expect(hooks.has('archive:footer')).toBe(true);
    expect(hooks.has('admin:writePost:bottom')).toBe(true);
    expect(hooks.has('admin:writePage:bottom')).toBe(true);
    // [LivePhoto] markdown rendering moved to core src/lib/markdown.ts
    expect(hooks.has('content:markdown')).toBe(false);
    expect(hooks.has('content:content')).toBe(false);
  });

  it('archive:footer appends the LivePhoto/Lightbox init script', () => {
    const hooks = setupHooks();
    const footer = hooks.get('archive:footer') as Function;
    const out = footer('<footer></footer>', { options: {} });
    expect(out).toContain('<footer></footer>');
    expect(out).toContain('/js/live.js');
    expect(out).toContain('LivePhoto.init');
    expect(out).toContain('Lightbox.init');
    expect(out).toContain('var enableLivePhoto = true;');
    expect(out).toContain('var enableLightbox = true;');
  });

  it('archive:footer honours enableLivePhoto / enableLightbox toggles', () => {
    const hooks = setupHooks();
    const footer = hooks.get('archive:footer') as Function;
    const out = footer('<footer></footer>', {
      options: {
        'plugin:typecho-plugin-livephoto': JSON.stringify({ enableLivePhoto: '0', enableLightbox: '0' }),
      },
    });
    expect(out).toContain('var enableLivePhoto = false;');
    expect(out).toContain('var enableLightbox = false;');
  });

  it('admin editor hooks append the LivePhoto dialog UI', () => {
    const hooks = setupHooks();
    for (const point of ['admin:writePost:bottom', 'admin:writePage:bottom']) {
      const handler = hooks.get(point) as Function;
      const out = handler('<form></form>');
      expect(out).toContain('<form></form>');
      expect(out).toContain('livephoto-dialog');
      expect(out).toContain('[LivePhoto photo="');
    }
  });
});
