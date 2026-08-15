import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';

/**
 * 侧栏：**分组标签页 + 可整体折叠**。
 *
 * 之前所有面板顺着堆在一条竖列里，引擎从 1 个加到 5 个之后就得滚半天才找得到东西，
 * 而真正的主角（3D 视口）反倒被挤在中间。这里做两件事：
 *
 *  1. 把面板按用途分成几组，一次只显示一组 —— 不是所有东西都得同时在屏幕上；
 *  2. 整条侧栏可以收起来，把宽度全让给画面。
 *
 * 折叠状态与当前标签都记在本机：这是长期使用的工具，每次打开都要重新调一遍太烦。
 */

export interface RailTab {
  id: string;
  label: string;
  /** 标签上的小角标，比如「有 3 条积压」。 */
  badge?: string | number;
  /** 内容惰性渲染：没被选中的标签不进 React 树，省掉大量无谓的重算。 */
  render: () => ReactNode;
  /** 为 false 时这个标签整个不出现（按引擎能力裁剪）。 */
  available?: boolean;
}

export function Rail({
  side,
  tabs,
  storageKey,
}: {
  side: 'left' | 'right';
  tabs: RailTab[];
  storageKey: string;
}) {
  const visible = useMemo(() => tabs.filter((t) => t.available !== false), [tabs]);
  const [collapsed, setCollapsed] = useState(() => readBool(`${storageKey}-collapsed`, false));
  const [activeId, setActiveId] = useState(() => readString(`${storageKey}-tab`) ?? visible[0]?.id ?? '');

  // 换引擎会让某些标签消失（比如 LSM 没有索引面板）。
  // 当前标签正好被裁掉时，退回第一个可用的，而不是显示一片空白。
  useEffect(() => {
    if (visible.length === 0) return;
    if (!visible.some((t) => t.id === activeId)) setActiveId(visible[0].id);
  }, [visible, activeId]);

  useEffect(() => write(`${storageKey}-tab`, activeId), [storageKey, activeId]);
  useEffect(() => write(`${storageKey}-collapsed`, String(collapsed)), [storageKey, collapsed]);

  const active = visible.find((t) => t.id === activeId) ?? visible[0];
  const border = side === 'left' ? 'border-r' : 'border-l';

  if (collapsed) {
    const Icon = side === 'left' ? PanelLeftOpen : PanelRightOpen;
    return (
      <aside className={`flex w-9 shrink-0 flex-col items-center gap-2 ${border} border-ink-700 bg-ink-900 py-2`}>
        <button
          className="dbkl-btn !px-1.5"
          data-testid={`rail-${side}-expand`}
          title="展开侧栏"
          onClick={() => setCollapsed(false)}
        >
          <Icon size={14} />
        </button>
        {/* 收起时把标签名竖排出来，仍然一眼知道这边藏着什么 */}
        {visible.map((t) => (
          <button
            key={t.id}
            className="rounded px-1 py-1.5 text-[10px] leading-tight text-mute-400 hover:bg-ink-800 hover:text-mute-200"
            style={{ writingMode: 'vertical-rl' }}
            title={t.label}
            onClick={() => {
              setActiveId(t.id);
              setCollapsed(false);
            }}
          >
            {t.label}
          </button>
        ))}
      </aside>
    );
  }

  const CollapseIcon = side === 'left' ? PanelLeftClose : PanelRightClose;
  return (
    <aside className={`flex w-[330px] shrink-0 flex-col ${border} border-ink-700 bg-ink-900`}>
      <div className="flex items-stretch gap-0.5 border-b border-ink-700 px-1.5 pt-1.5">
        {visible.map((t) => {
          const isActive = t.id === active?.id;
          return (
            <button
              key={t.id}
              data-testid={`tab-${t.id}`}
              className={`relative flex-1 rounded-t px-1 pb-1.5 pt-1 text-[11.5px] transition-colors ${
                isActive
                  ? 'bg-ink-850 font-medium text-accent-400'
                  : 'text-mute-400 hover:bg-ink-850/50 hover:text-mute-200'
              }`}
              onClick={() => setActiveId(t.id)}
            >
              {t.label}
              {t.badge !== undefined && t.badge !== 0 && (
                <span className="num ml-1 rounded bg-accent-500/20 px-1 text-[9px] text-accent-400">{t.badge}</span>
              )}
              {isActive && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent-500" />}
            </button>
          );
        })}
        <button
          className="shrink-0 px-1.5 text-mute-400 hover:text-mute-200"
          data-testid={`rail-${side}-collapse`}
          title="收起侧栏，把宽度让给 3D 视图"
          onClick={() => setCollapsed(true)}
        >
          <CollapseIcon size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{active?.render()}</div>
    </aside>
  );
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readString(key);
  return raw === null ? fallback : raw === 'true';
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式禁用 localStorage：不记住布局偏好即可，功能不受影响。
  }
}
