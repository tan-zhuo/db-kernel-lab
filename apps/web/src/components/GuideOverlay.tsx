import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Play, X } from 'lucide-react';
import { listEngines } from '@dbkl/simulation-core';
import { ENGINE_GUIDES, type GuideBlock, type GuideSection } from '@/content/engine-guide';
import { findScenario } from '@/content/scenarios';
import { AUTHOR, PROJECT_LINKS } from '@/content/links';
import { runScenario } from '@/content/run-scenario';
import { useSimStore } from '@/state/store';

/**
 * 原理讲解页。
 *
 * 设计意图：把散落在面板提示、事件文案与仓库文档里的原理集中成**可读的长文**，
 * 并且让每个机制都能一键跑起来 —— 读到「区间统计能整块跳过」时，
 * 旁边就有按钮把那个实验放给你看。理论与画面之间不留空隙。
 */
export function GuideOverlay() {
  const open = useSimStore((s) => s.guideOpen);
  const setOpen = useSimStore((s) => s.setGuideOpen);
  const engineId = useSimStore((s) => s.engineId);
  const busy = useSimStore((s) => s.busy);

  // 打开时默认落到「当前引擎」那一页 —— 大多数时候这就是你想看的。
  const [activeKey, setActiveKey] = useState<string>(() => ENGINE_GUIDES[0].key);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const match = ENGINE_GUIDES.find((g) => g.engineId === engineId);
    setActiveKey(match?.key ?? ENGINE_GUIDES[0].key);
  }, [open, engineId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // 切页时回到顶部，否则会停在上一页的滚动位置。
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeKey]);

  const guide = useMemo(() => ENGINE_GUIDES.find((g) => g.key === activeKey) ?? ENGINE_GUIDES[0], [activeKey]);
  const engines = listEngines();

  if (!open) return null;

  const runExperiment = async (scenarioId: string) => {
    const scenario = findScenario(scenarioId);
    if (!scenario) return;
    setOpen(false);
    await runScenario(scenario);
  };

  return (
    <div className="absolute inset-0 z-40 flex bg-ink-950/97 backdrop-blur" data-testid="guide-overlay">
      {/* 左侧导航 */}
      <nav className="flex w-[248px] shrink-0 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-3">
          <BookOpen size={15} className="text-accent-400" />
          <span className="text-[13px] font-semibold text-mute-200">原理讲解</span>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {ENGINE_GUIDES.map((g) => {
            const active = g.key === activeKey;
            const isCurrent = g.engineId !== null && g.engineId === engineId;
            return (
              <li key={g.key}>
                <button
                  data-testid={`guide-nav-${g.key}`}
                  className={`mb-1 w-full rounded-md px-2 py-2 text-left transition-colors ${
                    active ? 'bg-accent-500/15 text-accent-400' : 'text-mute-300 hover:bg-ink-800'
                  }`}
                  onClick={() => setActiveKey(g.key)}
                >
                  <span className="block text-[12px]">{g.nav}</span>
                  {isCurrent && <span className="mt-0.5 block text-[10px] text-mute-400">当前引擎</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-ink-700 p-2">
          <p className="px-1 text-[10px] leading-relaxed text-mute-400">
            正文里的「跑这个实验」会自动切到对应引擎并回放一遍。按 <kbd className="num">Esc</kbd> 关闭。
          </p>
          <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 px-1 text-[10px] text-mute-400">
            <a className="hover:text-accent-400" href={PROJECT_LINKS.repo} target="_blank" rel="noopener noreferrer">
              开源地址
            </a>
            <span className="text-mute-400/50">·</span>
            <a className="hover:text-accent-400" href={PROJECT_LINKS.blog} target="_blank" rel="noopener noreferrer">
              作者博客 {AUTHOR}.xyz
            </a>
          </p>
        </div>
      </nav>

      {/* 正文 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-start gap-3 border-b border-ink-700 px-6 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[19px] font-semibold leading-tight text-strong">{guide.title}</h1>
            <p className="mt-1 text-[12px] leading-relaxed text-mute-400">{guide.tagline}</p>
          </div>
          {guide.engineId && guide.engineId !== engineId && (
            <button
              className="dbkl-btn shrink-0"
              disabled={busy}
              onClick={() => {
                const target = guide.engineId;
                if (target) void useSimStore.getState().switchEngine(target);
                setOpen(false);
              }}
              title={`切到 ${engines.find((e) => e.id === guide.engineId)?.label ?? guide.engineId} 并关闭讲解`}
            >
              切到这个引擎
            </button>
          )}
          <button className="dbkl-btn shrink-0" data-testid="guide-close" onClick={() => setOpen(false)}>
            <X size={14} /> 关闭
          </button>
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto flex max-w-[820px] flex-col gap-7">
            {guide.sections.map((section) => (
              <Section key={section.id} section={section} onRun={runExperiment} busy={busy} />
            ))}
            <p className="border-t border-ink-700 pt-4 text-[11px] leading-relaxed text-mute-400/80">
              更完整的实现说明与「与真实系统的差异」清单见仓库里的
              <code className="mx-1 rounded bg-ink-800 px-1 py-0.5">docs/architecture.md</code>
              与
              <code className="mx-1 rounded bg-ink-800 px-1 py-0.5">docs/event-protocol.md</code>。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  section,
  onRun,
  busy,
}: {
  section: GuideSection;
  onRun: (scenarioId: string) => void;
  busy: boolean;
}) {
  const scenario = section.experiment ? findScenario(section.experiment.scenarioId) : undefined;
  return (
    <section>
      <h2 className="mb-2.5 border-l-2 border-accent-500 pl-2.5 text-[15px] font-semibold text-mute-200">
        {section.title}
      </h2>
      <div className="flex flex-col gap-3">
        {section.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
        {section.experiment && scenario && (
          <button
            className="dbkl-btn dbkl-btn-primary self-start"
            data-testid={`guide-run-${section.experiment.scenarioId}`}
            disabled={busy}
            onClick={() => onRun(section.experiment!.scenarioId)}
            title={scenario.goal}
          >
            <Play size={13} /> {section.experiment.label}
          </button>
        )}
      </div>
    </section>
  );
}

const CALLOUT_STYLE = {
  key: { border: 'border-accent-500/50', bg: 'bg-accent-500/8', label: 'text-accent-400' },
  warn: { border: 'border-orange-500/50', bg: 'bg-orange-500/8', label: 'text-orange-500' },
  tip: { border: 'border-teal-500/50', bg: 'bg-teal-500/8', label: 'text-teal-500' },
} as const;

function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case 'prose':
      return <p className="text-[13px] leading-[1.85] text-mute-300">{inline(block.text)}</p>;

    case 'list':
      return (
        <ul className="flex flex-col gap-1.5 pl-1">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-[1.8] text-mute-300">
              <span className="shrink-0 text-accent-400">{block.ordered ? `${i + 1}.` : '·'}</span>
              <span className="min-w-0">{inline(item)}</span>
            </li>
          ))}
        </ul>
      );

    case 'diagram':
      return (
        <figure className="overflow-x-auto rounded-md border border-ink-700 bg-ink-950 p-3">
          <pre className="num whitespace-pre text-[11.5px] leading-[1.55] text-mute-300">{block.text}</pre>
          {block.caption && <figcaption className="mt-2 text-[10.5px] text-mute-400">{block.caption}</figcaption>}
        </figure>
      );

    case 'table':
      return (
        <div className="overflow-x-auto rounded-md border border-ink-700">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-ink-800 text-mute-400">
                {block.headers.map((h) => (
                  <th key={h} className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-ink-700/70">
                  {row.map((cell, j) => (
                    <td key={j} className={`px-2.5 py-1.5 leading-relaxed ${j === 0 ? 'text-mute-200' : 'text-mute-300'}`}>
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'callout': {
      const style = CALLOUT_STYLE[block.tone];
      return (
        <div className={`rounded-md border ${style.border} ${style.bg} px-3 py-2.5`}>
          <div className={`mb-1 text-[12px] font-medium ${style.label}`}>{block.title}</div>
          <p className="text-[12.5px] leading-[1.8] text-mute-300">{inline(block.text)}</p>
        </div>
      );
    }
  }
}

/**
 * 极简内联标记渲染：`**加粗**` 与 `` `等宽` ``。
 *
 * 刻意不引 markdown 库：正文是自己写的、格式可控，
 * 引一个解析器只会给这个「零依赖、可离线」的项目多背一份包袱。
 */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-mute-200">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="num rounded bg-ink-800 px-1 py-[1px] text-[11.5px] text-teal-500">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
