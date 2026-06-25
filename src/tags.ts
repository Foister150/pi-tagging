import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  addTags,
  allTags,
  getTags,
  loadIndex,
  normalizeTag,
  reconcile,
  registerSession,
  removeSession,
  removeTags,
  setTags,
} from "./lib/tags.ts";

/**
 * /tag       — view/add/remove tags on the CURRENT session.
 * /tag <t…>  — quick-add one or more path-style tags (e.g. /tag pacemaker/frontend).
 * /tag pick  — choose any session, then edit its tags.
 *
 * /tag-view  — browse all sessions as a tag tree. Top level shows tags like
 *              "pacemaker", "extension-development", plus an "etc" bucket for
 *              untagged sessions. Drill into sub-tags / sessions; on a session
 *              you can switch, delete, rename, or edit tags.
 *
 * Tags live in ~/.pi/agent/session-tags.json and are refreshed in the
 * background on every session start.
 */

const ETC = "etc"; // top-level bucket for untagged sessions

export default function (pi: ExtensionAPI) {
  // --- Keep the index fresh in the background -----------------------------
  pi.on("session_start", async (_event, ctx) => {
    try {
      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) return; // ephemeral / no-session
      registerSession({
        path: file,
        id: ctx.sessionManager.getSessionId?.(),
        cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
        name: ctx.sessionManager.getSessionName?.() ?? undefined,
      });
    } catch {
      // never block session start on index bookkeeping
    }
  });

  // --- /tag ---------------------------------------------------------------
  pi.registerCommand("tag", {
    description:
      "Tag sessions. /tag (edit current) · /tag <tag…> (quick add) · /tag pick (choose a session)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "pick", label: "pick — choose another session to tag" },
        ...allTags().map((t) => ({ value: t, label: t })),
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (arg === "pick") {
        const target = await pickSession(ctx, "Pick a session to tag");
        if (target) await editTags(pi, ctx, target);
        return;
      }

      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) {
        ctx.ui.notify("No active session file (ephemeral session).", "warning");
        return;
      }
      const current: SessionMeta = {
        path: file,
        id: ctx.sessionManager.getSessionId?.(),
        cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
        name: ctx.sessionManager.getSessionName?.() ?? undefined,
      };

      if (arg) {
        // Quick-add: split on whitespace, each token is a path-style tag.
        const toAdd = arg.split(/\s+/).map(normalizeTag).filter(Boolean);
        if (toAdd.length === 0) {
          ctx.ui.notify("No valid tags given.", "warning");
          return;
        }
        const next = addTags(file, toAdd, current);
        ctx.ui.notify(`Tags: ${next.join(", ") || "(none)"}`, "info");
        return;
      }

      await editTags(pi, ctx, current);
    },
  });

  // --- /tag-view ----------------------------------------------------------
  pi.registerCommand("tag-view", {
    description: "Browse all sessions as a tag tree and act on them",
    handler: async (_args, ctx) => {
      await tagView(pi, ctx);
    },
  });
}

// ===========================================================================
// Types
// ===========================================================================

interface SessionMeta {
  path: string;
  id?: string;
  cwd?: string;
  name?: string;
}

interface TreeNode {
  name: string;
  fullPath: string; // tag path to this node ("pacemaker/frontend")
  children: Map<string, TreeNode>;
  sessions: SessionInfo[]; // sessions tagged exactly at this node
}

// ===========================================================================
// Helpers
// ===========================================================================

function homeShorten(p: string): string {
  const home = os.homedir();
  return p && home && p.startsWith(home) ? `~${p.slice(home.length)}` : p || "(unknown)";
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sessionTitle(s: SessionInfo): string {
  return (s.name?.trim() || s.firstMessage?.trim() || "(empty session)")
    .replace(/\s+/g, " ")
    .slice(0, 56);
}

/** Effective tags for a session: its tags, or ["etc"] when untagged. */
function effectiveTags(file: string): string[] {
  const tags = getTags(file);
  return tags.length > 0 ? tags : [ETC];
}

function trashAvailable(): boolean {
  try {
    const r = spawnSync("trash", ["--help"], { stdio: "ignore" });
    return r.status === 0 || r.status === 1;
  } catch {
    return false;
  }
}

/** Move a session file to trash (recoverable) and drop it from the index. */
function deleteSession(file: string): { ok: boolean; dest: string; error?: string } {
  try {
    if (trashAvailable()) {
      const r = spawnSync("trash", [file], { stdio: "ignore" });
      if (r.status !== 0) throw new Error(`trash exited ${r.status}`);
      removeSession(file);
      return { ok: true, dest: "system trash" };
    }
    const dir = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "sessions-trash",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(file, path.join(dir, path.basename(file)));
    removeSession(file);
    return { ok: true, dest: homeShorten(dir) };
  } catch (err) {
    return { ok: false, dest: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Append a session_info entry to an arbitrary session file to rename it. */
function renameSessionFile(file: string, name: string): void {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  let parentId: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as { id?: unknown };
      if (typeof e.id === "string") {
        parentId = e.id;
        break;
      }
    } catch {
      // skip malformed
    }
  }
  const entry = {
    type: "session_info",
    id: randomUUID().slice(0, 8),
    parentId,
    timestamp: new Date().toISOString(),
    name: name.trim(),
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

async function loadAllSessions(ctx: any): Promise<SessionInfo[]> {
  ctx.ui.setStatus("tag", "Scanning sessions…");
  try {
    const sessions = await SessionManager.listAll();
    reconcile(
      sessions.map((s) => ({ path: s.path, id: s.id, cwd: s.cwd, name: s.name })),
    );
    return sessions;
  } finally {
    ctx.ui.setStatus("tag", undefined);
  }
}

async function pickSession(ctx: any, title: string): Promise<SessionMeta | null> {
  const sessions = await loadAllSessions(ctx);
  if (sessions.length === 0) {
    ctx.ui.notify("No saved sessions found.", "info");
    return null;
  }
  const current = ctx.sessionManager.getSessionFile?.();
  const labels = sessions.map((s) => {
    const marker = s.path === current ? "● " : "  ";
    const tags = getTags(s.path);
    const tagStr = tags.length ? `  {${tags.join(", ")}}` : "";
    return `${marker}${fmtDate(s.modified)}  ${homeShorten(s.cwd)}  —  ${sessionTitle(s)}${tagStr}`;
  });
  const choice = await ctx.ui.select(title, labels);
  if (!choice) return null;
  const picked = sessions[labels.indexOf(choice)];
  if (!picked) return null;
  return { path: picked.path, id: picked.id, cwd: picked.cwd, name: picked.name };
}

// ===========================================================================
// Tag editing
// ===========================================================================

async function editTags(pi: ExtensionAPI, ctx: any, target: SessionMeta): Promise<void> {
  while (true) {
    const tags = getTags(target.path);
    const ADD = "➕ Add tag(s)…";
    const DONE = "✓ Done";
    const removeLabels = tags.map((t) => `➖ Remove: ${t}`);
    const options = [ADD, ...removeLabels, DONE];

    const header =
      tags.length > 0
        ? `Tags on "${target.name?.slice(0, 40) || path.basename(target.path)}": ${tags.join(", ")}`
        : `No tags yet on "${target.name?.slice(0, 40) || path.basename(target.path)}"`;

    const choice = await ctx.ui.select(header, options);
    if (!choice || choice === DONE) return;

    if (choice === ADD) {
      const entered = await ctx.ui.input(
        "Add tag(s) — space-separated, path-style e.g. pacemaker/frontend:",
      );
      const toAdd = (entered ?? "").split(/\s+/).map(normalizeTag).filter(Boolean);
      if (toAdd.length > 0) {
        addTags(target.path, toAdd, target);
        ctx.ui.notify(`Added: ${toAdd.join(", ")}`, "info");
      }
      continue;
    }

    // Remove
    const tag = choice.replace(/^➖ Remove: /, "");
    removeTags(target.path, [tag]);
    ctx.ui.notify(`Removed: ${tag}`, "info");
  }
}

// ===========================================================================
// Tag tree view
// ===========================================================================

function buildTree(sessions: SessionInfo[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map(), sessions: [] };
  for (const s of sessions) {
    for (const tag of effectiveTags(s.path)) {
      const segments = tag.split("/").filter(Boolean);
      let node = root;
      const acc: string[] = [];
      for (const seg of segments) {
        acc.push(seg);
        let child = node.children.get(seg);
        if (!child) {
          child = { name: seg, fullPath: acc.join("/"), children: new Map(), sessions: [] };
          node.children.set(seg, child);
        }
        node = child;
      }
      node.sessions.push(s);
    }
  }
  return root;
}

function subtreeCount(node: TreeNode): number {
  let n = node.sessions.length;
  for (const child of node.children.values()) n += subtreeCount(child);
  return n;
}

function nodeAtPath(root: TreeNode, segments: string[]): TreeNode | null {
  let node = root;
  for (const seg of segments) {
    const child = node.children.get(seg);
    if (!child) return null;
    node = child;
  }
  return node;
}

async function tagView(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/tag-view needs interactive TUI mode.", "warning");
    return;
  }

  let sessions = await loadAllSessions(ctx);
  if (sessions.length === 0) {
    ctx.ui.notify("No saved sessions found.", "info");
    return;
  }

  const currentFile = ctx.sessionManager.getSessionFile?.() as string | undefined;
  let stack: string[] = []; // current tag path segments

  while (true) {
    const root = buildTree(sessions);
    const node = nodeAtPath(root, stack);
    if (!node) {
      stack = []; // path no longer exists (tags changed) → reset to root
      continue;
    }

    const UP = "⬆  ..";
    const folderEntries = [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ kind: "folder" as const, node: c }));
    const sessionEntries = [...node.sessions]
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map((s) => ({ kind: "session" as const, session: s }));

    const entries: Array<
      | { kind: "up" }
      | { kind: "folder"; node: TreeNode }
      | { kind: "session"; session: SessionInfo }
    > = [];
    if (stack.length > 0) entries.push({ kind: "up" });
    entries.push(...folderEntries);
    entries.push(...sessionEntries);

    const labels = entries.map((e) => {
      if (e.kind === "up") return UP;
      if (e.kind === "folder") {
        const count = subtreeCount(e.node);
        return `📁 ${e.node.name}/   (${count})`;
      }
      const s = e.session;
      const marker = s.path === currentFile ? "● " : "  ";
      return `🗎 ${marker}${fmtDate(s.modified)}  [${s.messageCount}]  ${homeShorten(s.cwd)}  —  ${sessionTitle(s)}`;
    });

    const title =
      stack.length === 0
        ? `tag-view  /   (${sessions.length} sessions)`
        : `tag-view  /${stack.join("/")}`;

    const choice = await ctx.ui.select(title, labels);
    if (!choice) return; // cancelled → exit

    const picked = entries[labels.indexOf(choice)];
    if (!picked) continue;

    if (picked.kind === "up") {
      stack.pop();
      continue;
    }
    if (picked.kind === "folder") {
      stack.push(picked.node.name);
      continue;
    }

    // Session selected → action menu.
    const action = await sessionActions(pi, ctx, picked.session, currentFile);
    if (action === "switched") return;
    if (action === "deleted" || action === "changed") {
      sessions = await loadAllSessions(ctx); // refresh after mutation
    }
  }
}

async function sessionActions(
  pi: ExtensionAPI,
  ctx: any,
  s: SessionInfo,
  currentFile: string | undefined,
): Promise<"switched" | "deleted" | "changed" | "back"> {
  const isCurrent = s.path === currentFile;
  const tags = getTags(s.path);

  const SWITCH = isCurrent ? "↪  (current session)" : "↪  Switch / resume";
  const TAGS = "🏷  Edit tags";
  const RENAME = "✏️  Rename";
  const DELETE = "🗑  Delete (to trash)";
  const BACK = "←  Back";

  const opts = [SWITCH, TAGS, RENAME];
  if (!isCurrent) opts.push(DELETE);
  opts.push(BACK);

  const header = `${sessionTitle(s)}  ·  ${homeShorten(s.cwd)}${tags.length ? `  ·  {${tags.join(", ")}}` : ""}`;
  const choice = await ctx.ui.select(header, opts);
  if (!choice || choice === BACK) return "back";

  if (choice === SWITCH) {
    if (isCurrent) {
      ctx.ui.notify("Already in this session.", "info");
      return "back";
    }
    await ctx.switchSession(s.path, {
      withSession: async (replaced: any) => {
        replaced.ui.notify(`Switched to ${homeShorten(s.cwd)}`, "info");
      },
    });
    return "switched";
  }

  if (choice === TAGS) {
    await editTags(pi, ctx, { path: s.path, id: s.id, cwd: s.cwd, name: s.name });
    return "changed";
  }

  if (choice === RENAME) {
    const name = await ctx.ui.input("New session name:", s.name ?? "");
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "back";
    try {
      if (isCurrent) {
        pi.setSessionName(trimmed);
      } else {
        renameSessionFile(s.path, trimmed);
      }
      // refresh cached name in index
      const idx = loadIndex();
      if (idx.sessions[s.path]) {
        idx.sessions[s.path].name = trimmed;
        setTags(s.path, idx.sessions[s.path].tags, { path: s.path, name: trimmed });
      }
      ctx.ui.notify(`Renamed to "${trimmed}".`, "info");
    } catch (err) {
      ctx.ui.notify(
        `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    return "changed";
  }

  if (choice === DELETE) {
    const ok = await ctx.ui.confirm(
      "Delete session?",
      `"${sessionTitle(s)}" will be moved to trash (recoverable).`,
    );
    if (!ok) return "back";
    const res = deleteSession(s.path);
    if (res.ok) {
      ctx.ui.notify(`Deleted → ${res.dest}.`, "info");
      return "deleted";
    }
    ctx.ui.notify(`Delete failed: ${res.error}`, "error");
    return "back";
  }

  return "back";
}
