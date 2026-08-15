import { create } from 'zustand';
import { useEffect, useRef } from 'react';
import type { PageId, TableSchema } from '@dbkl/shared';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_ENGINE_ID,
  DEFAULT_SCHEMA,
  HistoryManager,
  applyEvent,
  createInitialState,
  getEngineFactory,
  type Command,
  type EngineCapability,
  type EngineConfig,
  type LabState,
  type SimulationEvent,
} from '@dbkl/simulation-core';
import {
  DEFAULT_THEME,
  HighlightTracker,
  applyTheme,
  isValidTheme,
  type ThemeId,
} from '@dbkl/visualization';
import { clearLabelCache } from '@/lib/label-texture';
import { SimulationClient } from '@/lib/worker-client';
import { CURRENT_SESSION_ID, createDebouncedSaver, loadSession, type SessionRecord } from '@/lib/persistence';
import { hideBootScreen, setBootStep } from '@/lib/boot-screen';

/** 单帧最多归约的事件数：保证主线程不被一次巨量回放卡住。 */
const MAX_EVENTS_PER_FRAME = 400;
/** 超过该规模的新事件批不自动播放，直接跳到结尾（可再用时间轴回看）。 */
const AUTOPLAY_LIMIT = 3000;

export const highlightTracker = new HighlightTracker();

const client = new SimulationClient();
const saveSession = createDebouncedSaver(700);

export interface SimStore {
  /** 每次状态被推进时自增，供 React 订阅。 */
  version: number;
  state: LabState;
  history: HistoryManager;
  cursor: number;
  playhead: number;
  playing: boolean;
  speed: number;
  autoPlay: boolean;
  loop: { from: number; to: number } | null;
  markers: number[];
  selectedPageId: PageId | null;
  /** LSM 视图里被选中的 SST 文件（SST 不是页，另开一个选中态）。 */
  selectedSstId: string | null;
  focusNonce: number;
  config: EngineConfig;
  commands: Command[];
  busy: boolean;
  status: string;
  error: string | null;
  booted: boolean;
  /** 当前引擎 id（见 simulation-core 的引擎注册表）。 */
  engineId: string;
  engineName: string;
  /** 当前引擎声明的能力，UI 据此决定挂哪些面板与 3D 视图。 */
  capabilities: readonly string[];
  showBufferPool: boolean;
  showLabels: boolean;
  /** 当前配色主题。UI 与 3D 场景共用一套。 */
  theme: ThemeId;
  /** 每次换主题自增：让缓存了颜色的组件重算。 */
  themeVersion: number;

  boot(): Promise<void>;
  run(command: Command): Promise<void>;
  resetEngine(config?: EngineConfig, schema?: TableSchema): Promise<void>;
  /** 换一个存储引擎：清空实验并按新引擎重新建表。 */
  switchEngine(engineId: string, config?: Partial<EngineConfig>): Promise<void>;
  goTo(index: number): void;
  step(delta: number): void;
  jumpToCommand(direction: 1 | -1): void;
  jumpToEvent(predicate: (e: SimulationEvent) => boolean, direction: 1 | -1): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setAutoPlay(on: boolean): void;
  tick(dtMs: number): void;
  toggleMarker(index?: number): void;
  setLoop(loop: { from: number; to: number } | null): void;
  select(pageId: PageId | null): void;
  selectSst(sstId: string | null): void;
  /** 请求相机聚焦：传页号则飞向该页，传 null 则适应整棵树。 */
  focusPage(pageId: PageId | null): void;
  setConfig(patch: Partial<EngineConfig>): void;
  setTheme(theme: ThemeId): void;
  toggleBufferPool(): void;
  toggleLabels(): void;
  exportEvents(): void;
  exportState(): void;
}

export const useSimStore = create<SimStore>()((set, get) => ({
  version: 0,
  state: createInitialState(DEFAULT_ENGINE_CONFIG),
  history: new HistoryManager(DEFAULT_ENGINE_CONFIG),
  cursor: 0,
  playhead: 0,
  playing: false,
  speed: 1,
  autoPlay: true,
  loop: null,
  markers: [],
  selectedPageId: null,
  selectedSstId: null,
  focusNonce: 0,
  config: { ...DEFAULT_ENGINE_CONFIG },
  commands: [],
  busy: false,
  status: '初始化中…',
  error: null,
  booted: false,
  engineId: DEFAULT_ENGINE_ID,
  engineName: '',
  capabilities: [],
  showBufferPool: true,
  showLabels: true,
  theme: readStoredTheme(),
  themeVersion: 0,

  async boot() {
    if (get().booted) return;
    set({ booted: true, busy: true });
    setBootStep('正在读取本地实验会话…');
    const session = await loadSession(CURRENT_SESSION_ID);
    // 老会话里没有 engineId（Phase 1 只有一个引擎），按默认引擎恢复。
    const engineId = session?.engineId ?? DEFAULT_ENGINE_ID;
    const config = { ...DEFAULT_ENGINE_CONFIG, ...(session?.config ?? {}) };
    const commands: Command[] = session?.commands?.length
      ? session.commands
      : [{ kind: 'create_table', schema: DEFAULT_SCHEMA }];

    const history = new HistoryManager(config);
    set({
      config,
      engineId,
      history,
      commands,
      markers: session?.markers ?? [],
      state: createInitialState(config),
      cursor: 0,
      playhead: 0,
    });

    try {
      setBootStep(
        session?.commands?.length
          ? `正在重放上次实验的 ${commands.length} 条命令…`
          : '正在初始化仿真引擎与索引结构…',
      );
      await client.init(engineId, config, commands, (events, progress) => {
        history.push(events);
        if (progress) setBootStep(`重放命令 ${progress.done}/${progress.total}（${history.length} 个事件）`);
      });
      // 恢复的会话直接呈现最终状态，让用户回到上次离开的地方。
      const end = history.length;
      set({
        state: history.stateAt(end),
        cursor: end,
        playhead: history.duration,
        version: get().version + 1,
        busy: false,
        engineName: client.engine?.name ?? '',
        capabilities: client.engine?.capabilities ?? [],
        status: session?.commands?.length
          ? `已从 IndexedDB 恢复上次实验：${commands.length} 条命令 / ${history.length} 个事件`
          : '就绪：表 users 已创建，试试左侧的插入操作',
      });
      hideBootScreen();
    } catch (err) {
      setBootStep('初始化失败，请刷新重试');
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
      hideBootScreen();
    }
  },

  async run(command) {
    if (get().busy) return;
    const { history } = get();
    const startIndex = history.length;
    set({ busy: true, error: null, playing: false });
    try {
      await client.run(command, (events) => {
        history.push(events);
      });
      const produced = history.length - startIndex;
      const commands = [...get().commands, command];
      const autoPlay = get().autoPlay && produced <= AUTOPLAY_LIMIT;

      if (autoPlay) {
        // 回到该命令的起点，然后播放，用户能看到完整过程。
        set({
          state: history.stateAt(startIndex),
          cursor: startIndex,
          playhead: startIndex === 0 ? 0 : history.at(startIndex - 1)!.t,
        });
        highlightTracker.clear();
        set({ playing: true });
      } else {
        set({
          state: history.stateAt(history.length),
          cursor: history.length,
          playhead: history.duration,
        });
        highlightTracker.clear();
      }

      const last = history.commands[history.commands.length - 1];
      set({
        commands,
        busy: false,
        version: get().version + 1,
        status: `${last?.label ?? ''}${last?.note ? ` — ${last.note}` : ''}（+${produced} 事件${
          produced > AUTOPLAY_LIMIT ? '，事件过多已直接跳到结尾' : ''
        }）`,
      });

      saveSession(snapshotSession(get()));
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async resetEngine(config, schema) {
    const cfg = config ?? get().config;
    const tableSchema = schema ?? get().state.schema ?? DEFAULT_SCHEMA;
    const engineId = get().engineId;
    const history = new HistoryManager(cfg);
    set({
      busy: true,
      playing: false,
      config: cfg,
      history,
      commands: [],
      markers: [],
      loop: null,
      selectedPageId: null,
      state: createInitialState(cfg),
      cursor: 0,
      playhead: 0,
    });
    highlightTracker.clear();
    try {
      const bootstrap: Command = { kind: 'create_table', schema: tableSchema };
      await client.reset(engineId, cfg, () => {});
      await client.run(bootstrap, (events) => history.push(events));
      set({
        commands: [bootstrap],
        state: history.stateAt(history.length),
        cursor: history.length,
        playhead: history.duration,
        busy: false,
        version: get().version + 1,
        engineName: client.engine?.name ?? get().engineName,
        capabilities: client.engine?.capabilities ?? get().capabilities,
        status: `已重置：表 ${tableSchema.name} · 引擎 ${getEngineFactory(engineId)?.label ?? engineId}`,
      });
      saveSession(snapshotSession(get()));
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async switchEngine(engineId, configPatch) {
    if (get().busy) return;
    const factory = getEngineFactory(engineId);
    if (!factory) {
      set({ error: `未知引擎 ${engineId}` });
      return;
    }
    // 换引擎 = 换一套物理模型，历史命令在新引擎下未必成立，因此从头开始。
    set({ engineId, config: { ...get().config, ...configPatch }, selectedPageId: null });
    await get().resetEngine({ ...get().config, ...configPatch });
  },

  goTo(index) {
    const { history } = get();
    const target = Math.max(0, Math.min(index, history.length));
    highlightTracker.clear();
    set({
      state: history.stateAt(target),
      cursor: target,
      playhead: target === 0 ? 0 : history.at(target - 1)!.t,
      version: get().version + 1,
    });
  },

  step(delta) {
    const { cursor, history } = get();
    const target = Math.max(0, Math.min(cursor + delta, history.length));
    if (target === cursor) return;
    if (target > cursor) {
      advance(get, set, target);
    } else {
      get().goTo(target);
    }
    set({ playing: false });
  },

  jumpToCommand(direction) {
    const { history, cursor } = get();
    const spans = history.commands;
    if (spans.length === 0) return;
    if (direction > 0) {
      const next = spans.find((s) => s.startSeq > cursor);
      get().goTo(next ? next.startSeq : history.length);
    } else {
      const prev = [...spans].reverse().find((s) => s.startSeq < cursor - 1);
      get().goTo(prev ? prev.startSeq : 0);
    }
    set({ playing: false });
  },

  jumpToEvent(predicate, direction) {
    const { history, cursor } = get();
    const found = history.nextMatching(direction > 0 ? cursor : cursor - 1, predicate, direction);
    if (found === null) {
      set({ status: '没有更多匹配的事件了' });
      return;
    }
    get().goTo(found + 1);
    set({ playing: false });
  },

  play() {
    const { cursor, history } = get();
    if (cursor >= history.length) get().goTo(0);
    set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    if (get().playing) get().pause();
    else get().play();
  },
  setSpeed(speed) {
    set({ speed });
  },
  setAutoPlay(on) {
    set({ autoPlay: on });
  },

  tick(dtMs) {
    const { playing, speed, history, cursor, loop } = get();
    if (!playing || history.length === 0) return;

    if (loop && cursor >= loop.to) {
      get().goTo(loop.from);
      set({ playing: true });
      return;
    }

    const playhead = get().playhead + dtMs * speed;
    let target = history.indexAtTime(playhead);
    if (loop) target = Math.min(target, loop.to);
    target = Math.min(target, cursor + MAX_EVENTS_PER_FRAME, history.length);

    if (target <= cursor) {
      set({ playhead });
      return;
    }
    advance(get, set, target);
    set({ playhead });
    if (get().cursor >= history.length && !loop) set({ playing: false });
  },

  toggleMarker(index) {
    const at = index ?? get().cursor;
    const markers = get().markers.includes(at)
      ? get().markers.filter((m) => m !== at)
      : [...get().markers, at].sort((a, b) => a - b);
    set({ markers });
    saveSession(snapshotSession(get()));
  },

  setLoop(loop) {
    set({ loop });
  },

  select(pageId) {
    set({ selectedPageId: pageId, selectedSstId: null });
  },

  selectSst(sstId) {
    set({ selectedSstId: sstId, selectedPageId: null });
  },

  focusPage(pageId) {
    set({ selectedPageId: pageId, focusNonce: get().focusNonce + 1 });
  },

  setConfig(patch) {
    set({ config: { ...get().config, ...patch } });
  },

  setTheme(theme) {
    if (theme === get().theme) return;
    applyThemeEverywhere(theme);
    set({ theme, themeVersion: get().themeVersion + 1, version: get().version + 1 });
  },

  toggleBufferPool() {
    set({ showBufferPool: !get().showBufferPool });
  },
  toggleLabels() {
    set({ showLabels: !get().showLabels });
  },

  exportEvents() {
    const { history } = get();
    download(
      `dbkl-events-${Date.now()}.json`,
      JSON.stringify(
        {
          version: 2,
          engineId: get().engineId,
          engine: get().engineName,
          config: get().config,
          commands: get().commands,
          events: history.all,
        },
        null,
        2,
      ),
    );
  },

  exportState() {
    download(`dbkl-state-${Date.now()}.json`, JSON.stringify(get().state, null, 2));
  },
}));

/** 增量前进：直接归约事件（不做检查点克隆），并喂给高亮追踪器。 */
function advance(get: () => SimStore, set: (partial: Partial<SimStore>) => void, target: number): void {
  const { history, state, cursor } = get();
  const applied: SimulationEvent[] = [];
  for (let i = cursor; i < target; i++) {
    const e = history.at(i);
    if (!e) break;
    applyEvent(state, e);
    applied.push(e);
  }
  highlightTracker.ingest(applied, performance.now());
  set({ cursor: target, version: get().version + 1 });
}

function snapshotSession(s: SimStore): SessionRecord {
  return {
    id: CURRENT_SESSION_ID,
    name: '当前实验',
    engineId: s.engineId,
    config: s.config,
    commands: s.commands,
    markers: s.markers,
    updatedAt: Date.now(),
    eventCount: s.history.length,
  };
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 订阅 `version` 并返回（可变的）LabState。
 *
 * 状态对象为了性能是原地归约的，因此不能靠引用比较触发重渲染，
 * 统一由 version 号驱动。
 */
export function useLabState(): LabState {
  // 订阅 version（会变），返回 state（引用不变）。
  useSimStore((s) => s.version);
  return useSimStore.getState().state;
}

const THEME_STORAGE_KEY = 'dbkl-theme';

/**
 * 读取已保存的主题。
 *
 * 主题是纯 UI 偏好，与实验数据无关，所以用 localStorage 而不是 IndexedDB ——
 * 它必须在首帧之前同步读到，否则会闪一下默认色。
 */
function readStoredTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidTheme(saved)) return saved;
  } catch {
    // 隐私模式可能禁用 localStorage，回落默认主题即可。
  }
  return DEFAULT_THEME;
}

/**
 * 把主题同时应用到三处：CSS 变量（data-theme）、3D 调色板、以及文字贴图缓存。
 *
 * 文字贴图把颜色**烘进了像素**，不清缓存的话换主题后场景里的标签会保持旧色。
 */
function applyThemeEverywhere(theme: ThemeId): void {
  applyTheme(theme);
  clearLabelCache();
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 存不下就算了，下次回落默认主题。
  }
}

// 模块加载即生效，避免 React 挂载前先闪一帧默认配色。
applyThemeEverywhere(readStoredTheme());

/** 只订阅 version，用于需要「每次状态推进都重画」的组件。 */
export function useVersion(): number {
  return useSimStore((s) => s.version);
}

/**
 * 当前引擎是否具备某项能力。
 *
 * 这是 UI 唯一被允许「按引擎分支」的地方：面板与 3D 视图都只问能力，
 * 不问「你是不是 PostgreSQL」，这样第三方引擎插件也能复用全部视图。
 */
export function useCapability(capability: EngineCapability): boolean {
  return useSimStore((s) => s.capabilities.includes(capability));
}

/** 订阅主题变更：给那些把颜色缓存进 useMemo 的组件当依赖用。 */
export function useThemeVersion(): number {
  return useSimStore((s) => s.themeVersion);
}

/** rAF 播放驱动：挂在应用根组件上。 */
export function usePlaybackDriver(): void {
  const playing = useSimStore((s) => s.playing);
  const last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    last.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - last.current, 100);
      last.current = now;
      useSimStore.getState().tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}
