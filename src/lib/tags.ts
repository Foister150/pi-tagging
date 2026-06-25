/**
 * Shared session-tag index helpers.
 *
 * Not an extension entry point itself — the package manifest only registers
 * src/tags.ts as an extension; this module is imported from there.
 *
 * Tags are stored centrally in ~/.pi/agent/session-tags.json, keyed by the
 * absolute session file path. Tags are path-style strings, e.g.
 * "pacemaker" or "pacemaker/frontend", forming a file-tree-like hierarchy.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TagRecord {
  /** Absolute session file path (also the index key). */
  path: string;
  /** Session UUID from the header, when known. */
  id?: string;
  /** Working directory the session was started in. */
  cwd?: string;
  /** Cached display name / first message for context. */
  name?: string;
  /** Normalized path-style tags. */
  tags: string[];
  /** ISO timestamp of the last index update for this record. */
  updated: string;
}

export interface TagIndex {
  version: number;
  sessions: Record<string, TagRecord>;
}

const INDEX_VERSION = 1;

export function indexPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "session-tags.json");
}

export function loadIndex(): TagIndex {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as TagIndex;
    if (parsed && typeof parsed === "object" && parsed.sessions) {
      return { version: parsed.version ?? INDEX_VERSION, sessions: parsed.sessions };
    }
  } catch {
    // missing or corrupt → start fresh
  }
  return { version: INDEX_VERSION, sessions: {} };
}

export function saveIndex(idx: TagIndex): void {
  const p = indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, p); // atomic replace
}

/** Normalize a raw tag into a clean path-style tag ("a / b" -> "a/b"). */
export function normalizeTag(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/** De-duplicate + sort a list of tags. */
export function cleanTags(tags: string[]): string[] {
  const set = new Set<string>();
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

interface SessionMeta {
  path: string;
  id?: string;
  cwd?: string;
  name?: string;
}

/** Ensure a record exists for this session; refresh light metadata. */
export function registerSession(meta: SessionMeta): void {
  if (!meta.path) return;
  const idx = loadIndex();
  const cur = idx.sessions[meta.path];
  if (cur) {
    if (meta.id) cur.id = meta.id;
    if (meta.cwd) cur.cwd = meta.cwd;
    if (meta.name) cur.name = meta.name;
    cur.updated = new Date().toISOString();
  } else {
    idx.sessions[meta.path] = {
      path: meta.path,
      id: meta.id,
      cwd: meta.cwd,
      name: meta.name,
      tags: [],
      updated: new Date().toISOString(),
    };
  }
  saveIndex(idx);
}

export function getTags(file: string): string[] {
  return loadIndex().sessions[file]?.tags ?? [];
}

export function setTags(file: string, tags: string[], meta?: SessionMeta): void {
  const idx = loadIndex();
  const rec = idx.sessions[file] ?? {
    path: file,
    tags: [],
    updated: new Date().toISOString(),
  };
  rec.tags = cleanTags(tags);
  if (meta?.id) rec.id = meta.id;
  if (meta?.cwd) rec.cwd = meta.cwd;
  if (meta?.name) rec.name = meta.name;
  rec.updated = new Date().toISOString();
  idx.sessions[file] = rec;
  saveIndex(idx);
}

export function addTags(file: string, tags: string[], meta?: SessionMeta): string[] {
  const next = cleanTags([...getTags(file), ...tags]);
  setTags(file, next, meta);
  return next;
}

export function removeTags(file: string, tags: string[]): string[] {
  const drop = new Set(tags.map(normalizeTag));
  const next = getTags(file).filter((t) => !drop.has(t));
  setTags(file, next);
  return next;
}

/** Remove a session entirely from the index (used after deletion). */
export function removeSession(file: string): void {
  const idx = loadIndex();
  if (idx.sessions[file]) {
    delete idx.sessions[file];
    saveIndex(idx);
  }
}

/** All distinct tags currently in use, sorted. */
export function allTags(): string[] {
  const set = new Set<string>();
  for (const rec of Object.values(loadIndex().sessions)) {
    for (const t of rec.tags) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Reconcile the index against the sessions that actually exist on disk.
 *  - adds missing sessions as untagged records
 *  - refreshes cached metadata
 *  - drops UNTAGGED records whose file no longer exists (tagged records are
 *    kept so that tags set before a file is first written are never lost; the
 *    prune tools explicitly removeSession() on real deletion)
 */
export function reconcile(existing: SessionMeta[]): TagIndex {
  const idx = loadIndex();
  const livePaths = new Set(existing.map((s) => s.path));

  for (const s of existing) {
    const cur = idx.sessions[s.path];
    if (cur) {
      if (s.id) cur.id = s.id;
      if (s.cwd) cur.cwd = s.cwd;
      if (s.name) cur.name = s.name;
    } else {
      idx.sessions[s.path] = {
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        name: s.name,
        tags: [],
        updated: new Date().toISOString(),
      };
    }
  }

  for (const [p, rec] of Object.entries(idx.sessions)) {
    if (livePaths.has(p)) continue;
    if (rec.tags.length === 0 && !fs.existsSync(p)) {
      delete idx.sessions[p];
    }
  }

  saveIndex(idx);
  return idx;
}
