import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  HIGHLIGHT_COLOR,
  PALETTE,
  THEMES,
  THEME_LIST,
  applyTheme,
  currentThemeId,
  isValidTheme,
  levelColor,
  type ThemeId,
} from '../src';

const IDS = Object.keys(THEMES) as ThemeId[];
const HEX = /^#[0-9a-f]{6}$/i;

/** 每个测试跑完把主题复位，避免相互串味。 */
function withTheme<T>(id: ThemeId, body: () => T): T {
  const before = currentThemeId();
  try {
    applyTheme(id);
    return body();
  } finally {
    applyTheme(before);
  }
}

describe('主题定义', () => {
  it('所有主题的字段集完全一致（防止漏配某个颜色）', () => {
    const reference = Object.keys(THEMES[DEFAULT_THEME]).sort();
    for (const id of IDS) {
      expect(Object.keys(THEMES[id]).sort(), `主题 ${id} 的字段集`).toEqual(reference);
    }
  });

  it('所有颜色都是合法的 6 位十六进制', () => {
    for (const id of IDS) {
      const theme = THEMES[id];
      for (const [key, value] of Object.entries(theme)) {
        if (Array.isArray(value)) {
          value.forEach((c, i) => expect(c, `${id}.${key}[${i}]`).toMatch(HEX));
        } else {
          expect(value, `${id}.${key}`).toMatch(HEX);
        }
      }
    }
  });

  it('每个主题都有足够的 SST 层级色', () => {
    for (const id of IDS) {
      expect(THEMES[id].sstLevel.length, `主题 ${id}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('THEME_LIST 与 THEMES 一一对应，且色卡取自真实主题', () => {
    expect(THEME_LIST.map((t) => t.id).sort()).toEqual([...IDS].sort());
    for (const meta of THEME_LIST) {
      const theme = THEMES[meta.id];
      expect(meta.swatch[0], `${meta.id} 色卡首格应是背景色`).toBe(theme.background);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
    }
  });

  it('浅色主题的文字必须比背景暗，深色主题反之（否则会看不见）', () => {
    for (const meta of THEME_LIST) {
      const theme = THEMES[meta.id];
      const bg = luminance(theme.background);
      const fg = luminance(theme.textPrimary);
      if (meta.dark) expect(fg, `${meta.id} 深色主题文字应更亮`).toBeGreaterThan(bg);
      else expect(fg, `${meta.id} 浅色主题文字应更暗`).toBeLessThan(bg);
      // 不管哪种主题，正文与背景的明度差都要够大
      expect(Math.abs(fg - bg), `${meta.id} 正文对比度`).toBeGreaterThan(0.35);
    }
  });

  it('isValidTheme 只认已注册的 id', () => {
    expect(isValidTheme('light')).toBe(true);
    expect(isValidTheme('nope')).toBe(false);
    expect(isValidTheme(null)).toBe(false);
    expect(isValidTheme(undefined)).toBe(false);
  });
});

describe('切换主题', () => {
  it('applyTheme 就地覆盖 PALETTE（活对象，读的人不用重新拿引用）', () => {
    const held = PALETTE; // 模拟组件在模块加载时就持有了引用
    withTheme('light', () => {
      expect(held.background).toBe(THEMES.light.background);
      expect(held).toBe(PALETTE);
    });
    withTheme('deep', () => {
      expect(held.background).toBe(THEMES.deep.background);
    });
  });

  it('HIGHLIGHT_COLOR 是 getter，会跟着主题走', () => {
    withTheme('deep', () => {
      expect(HIGHLIGHT_COLOR.insert).toBe(THEMES.deep.insert);
      expect(HIGHLIGHT_COLOR.delete).toBe(THEMES.deep.remove);
    });
    withTheme('light', () => {
      expect(HIGHLIGHT_COLOR.insert).toBe(THEMES.light.insert);
      expect(HIGHLIGHT_COLOR.delete).toBe(THEMES.light.remove);
    });
  });

  it('levelColor 跟着主题走，越界取最后一档', () => {
    withTheme('light', () => {
      expect(levelColor(0)).toBe(THEMES.light.sstLevel[0]);
      expect(levelColor(99)).toBe(THEMES.light.sstLevel[THEMES.light.sstLevel.length - 1]);
    });
  });

  it('currentThemeId 反映最后一次切换', () => {
    withTheme('warm', () => expect(currentThemeId()).toBe('warm'));
  });
});

/** 相对亮度（sRGB 近似），只用来做「够不够看得见」的粗判。 */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
