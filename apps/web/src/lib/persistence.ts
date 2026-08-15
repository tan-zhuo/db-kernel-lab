import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Command, EngineConfig } from '@dbkl/simulation-core';

/**
 * 实验会话的本地持久化（IndexedDB，无后端）。
 *
 * 只存「命令日志 + 配置」而不是事件流：引擎是确定性的，
 * 重放命令即可逐字节还原同一条事件流，存储量小两个数量级。
 */

export interface SessionRecord {
  id: string;
  name: string;
  /** 引擎 id。Phase 1 的旧会话没有这个字段，读出来是 undefined ⇒ 回落到默认引擎。 */
  engineId?: string;
  config: EngineConfig;
  commands: Command[];
  markers: number[];
  updatedAt: number;
  eventCount: number;
}

interface DbklDB extends DBSchema {
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { 'by-updated': number };
  };
}

const DB_NAME = 'db-kernel-lab';
const DB_VERSION = 1;
export const CURRENT_SESSION_ID = 'current';

let dbPromise: Promise<IDBPDatabase<DbklDB>> | null = null;

function db(): Promise<IDBPDatabase<DbklDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DbklDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const store = database.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('by-updated', 'updatedAt');
      },
    });
  }
  return dbPromise;
}

export async function saveSession(record: SessionRecord): Promise<void> {
  try {
    (await db()).put('sessions', record);
  } catch (err) {
    console.warn('[dbkl] 会话保存失败（可能是隐私模式禁用了 IndexedDB）', err);
  }
}

export async function loadSession(id = CURRENT_SESSION_ID): Promise<SessionRecord | undefined> {
  try {
    return await (await db()).get('sessions', id);
  } catch (err) {
    console.warn('[dbkl] 会话读取失败', err);
    return undefined;
  }
}

export async function listSessions(): Promise<SessionRecord[]> {
  try {
    const all = await (await db()).getAllFromIndex('sessions', 'by-updated');
    return all.reverse();
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await (await db()).delete('sessions', id);
  } catch (err) {
    console.warn('[dbkl] 会话删除失败', err);
  }
}

/** 另存为具名快照，便于「对比实验」选择两次历史运行。 */
export async function forkSession(record: SessionRecord, name: string): Promise<string> {
  const id = `snap-${Date.now().toString(36)}`;
  await saveSession({ ...record, id, name, updatedAt: Date.now() });
  return id;
}

/** 简单的防抖保存器：批量插入过程中不会疯狂写盘。 */
export function createDebouncedSaver(delayMs = 800): (record: SessionRecord) => void {
  let timer: number | undefined;
  let latest: SessionRecord | null = null;
  return (record: SessionRecord) => {
    latest = record;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (latest) void saveSession(latest);
      timer = undefined;
    }, delayMs) as unknown as number;
  };
}
