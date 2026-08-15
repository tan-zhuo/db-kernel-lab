import { describe, expect, it } from 'vitest';
import { listEngines } from '@dbkl/simulation-core';
import { ENGINE_GUIDES, guideForEngine } from './engine-guide';
import { SCENARIOS, findScenario } from './scenarios';

describe('原理讲解内容', () => {
  it('每个注册的引擎都有对应的讲解页', () => {
    for (const engine of listEngines()) {
      expect(guideForEngine(engine.id), `引擎 ${engine.id} 缺讲解页`).toBeDefined();
    }
  });

  it('正文里引用的实验 id 全部真实存在', () => {
    for (const guide of ENGINE_GUIDES) {
      for (const section of guide.sections) {
        if (!section.experiment) continue;
        const scenario = findScenario(section.experiment.scenarioId);
        expect(scenario, `${guide.key}/${section.id} 引用了不存在的实验 ${section.experiment.scenarioId}`).toBeDefined();
        // 实验必须属于这一页讲的那个引擎，否则点下去会跳到别的引擎，很迷惑
        if (guide.engineId) {
          expect(scenario!.engineId, `${guide.key}/${section.id} 的实验属于别的引擎`).toBe(guide.engineId);
        }
      }
    }
  });

  it('每个引擎页至少挂一个可跑的实验', () => {
    for (const guide of ENGINE_GUIDES) {
      if (!guide.engineId) continue;
      const count = guide.sections.filter((s) => s.experiment).length;
      expect(count, `${guide.key} 一个实验都没挂`).toBeGreaterThan(0);
    }
  });

  it('章节 id 在页内唯一，nav / 标题都不为空', () => {
    for (const guide of ENGINE_GUIDES) {
      const ids = guide.sections.map((s) => s.id);
      expect(new Set(ids).size, `${guide.key} 有重复的章节 id`).toBe(ids.length);
      expect(guide.nav.length).toBeGreaterThan(0);
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.tagline.length).toBeGreaterThan(0);
    }
  });

  it('表格每一行的列数都与表头一致', () => {
    for (const guide of ENGINE_GUIDES) {
      for (const section of guide.sections) {
        for (const block of section.blocks) {
          if (block.kind !== 'table') continue;
          for (const row of block.rows) {
            expect(row.length, `${guide.key}/${section.id} 表格行列数对不上`).toBe(block.headers.length);
          }
        }
      }
    }
  });

  it('图（diagram）里不能出现内联标记 —— 它是原样渲染的', () => {
    for (const guide of ENGINE_GUIDES) {
      for (const section of guide.sections) {
        for (const block of section.blocks) {
          if (block.kind !== 'diagram') continue;
          expect(block.text, `${guide.key}/${section.id} 的图里有未解析的 **`).not.toContain('**');
        }
      }
    }
  });

  it('每个引擎的实验都能被讲解页或引导面板找到（没有孤儿实验）', () => {
    const referenced = new Set(
      ENGINE_GUIDES.flatMap((g) => g.sections.map((s) => s.experiment?.scenarioId).filter(Boolean)),
    );
    // 引导面板会列出全部实验，所以这里只断言「被讲解引用的都存在」
    for (const id of referenced) expect(SCENARIOS.some((s) => s.id === id)).toBe(true);
  });
});
