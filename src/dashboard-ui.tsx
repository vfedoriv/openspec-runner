import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useInput, useWindowSize, useFocus } from "ink";
import { startDashboardCollector } from "./dashboard-client.js";
import { actionsFor, type DashboardAction, type PreviewInput } from "./dashboard-actions.js";
import { runDashboardAction } from "./dashboard-action-runner.js";
import { dashboardViews, selectDashboardRows, preserveSelection, detailLines, safeText, mergeActivity, activityLineCount, activityViewport, filterActivity, preserveActivityOffset, type DashboardFilters } from "./dashboard-view.js";
import type { DashboardOptions, DashboardSnapshot } from "./dashboard-types.js";
import type { ActivityEntry } from "./activity-types.js";
type Collector = ReturnType<typeof startDashboardCollector>;
export function DashboardUi({ snapshot, collector, failure, quit, lifetime }: { snapshot?: DashboardSnapshot; collector: Collector; failure?: string; quit(): void; lifetime: AbortSignal }) {
  const { columns, rows: height } = useWindowSize();
  useFocus({ autoFocus: true });
  const [tab, setTab] = useState(0), [selected, setSelected] = useState<string>(), [pane, setPane] = useState<"list" | "details" | "activity">("list");
  const [filters, setFilters] = useState<DashboardFilters>({ search: "", includeCompleted: false, includeOlderAttempts: false, sort: "name" });
  const [edit, setEdit] = useState<"search" | "status" | "harness" | "owner" | "activity" | "tasks" | "model" | "effort">(), [text, setText] = useState("");
  const [help, setHelp] = useState(false), [offset, setOffset] = useState(0), [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[]>([]), [activityError, setActivityError] = useState(""), [activitySearch, setActivitySearch] = useState("");
  const [following, setFollowing] = useState(true), [mode, setMode] = useState<"raw" | "normalized">("normalized"), [activityOffset, setActivityOffset] = useState(0);
  const [menu, setMenu] = useState<DashboardAction[]>(), [actionIndex, setActionIndex] = useState(0), [output, setOutput] = useState(""), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ action: DashboardAction; input: PreviewInput }>();
  const actionController = useRef<AbortController | undefined>(undefined), activityController = useRef<AbortController | undefined>(undefined), generation = useRef(0);
  const followingRef = useRef(true), expandedRef = useRef(false), entriesRef = useRef<ActivityEntry[]>([]), activitySearchRef = useRef("");
  const changeFollowing = (value: boolean) => { followingRef.current = value; setFollowing(value); };
  const cursor = useRef<{ older?: string; newer?: string }>({}), loading = useRef(false);
  const view = dashboardViews[tab], list = snapshot ? selectDashboardRows(snapshot, view, filters) : [];
  const chosen = preserveSelection(list, selected), target = list.find(r => r.id === chosen)?.targetId;
  const session = snapshot?.sessions.find(s => s.id === target);
  const visibleEntries = filterActivity(entries, activitySearch);
  useEffect(() => { setSelected(chosen); }, [chosen]);
  useEffect(() => { setOffset(0); setOutput(""); setMenu(undefined); actionController.current?.abort(); actionController.current = undefined; setBusy(false); }, [target, tab]);
  const load = async (direction: "older" | "newer", initial = false) => {
    if (!session?.log || loading.current || lifetime.aborted) return;
    const own = generation.current, controller = new AbortController(); activityController.current = controller; loading.current = true;
    try {
      const page = await collector.readActivity({ log: session.log, sidecar: session.activityPath, identity: { attemptId: session.attempt.id, harness: session.attempt.agent ?? "unknown" }, direction, mode, cursor: initial ? undefined : cursor.current[direction] }, controller.signal);
      if (own !== generation.current || lifetime.aborted) return;
      if (page.reset) cursor.current = {};
      if (page.cursor !== undefined) cursor.current[direction] = page.cursor;
      if (initial) cursor.current.newer = page.cursor;
      const previous = entriesRef.current;
      const merged = mergeActivity(previous, page, direction);
      entriesRef.current = merged; setEntries(merged); setActivityError(page.errors.join("; "));
      if (initial || page.reset || followingRef.current || direction === "older" && page.entries.length > 0) setActivityOffset(0);
      else if (direction === "newer") {
        const before = filterActivity(previous, activitySearchRef.current);
        const after = filterActivity(merged, activitySearchRef.current);
        setActivityOffset(current => preserveActivityOffset(before, after, current, expandedRef.current));
      }
    } catch (error) { if (own === generation.current && !controller.signal.aborted) setActivityError(safeText(error instanceof Error ? error.message : error)); }
    finally { if (own === generation.current) loading.current = false; }
  };
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    generation.current++; activityController.current?.abort(); loading.current = false; cursor.current = {}; entriesRef.current = []; setEntries([]); setActivityError(""); changeFollowing(true); setActivityOffset(0);
    void load("older", true);
    return () => { generation.current++; activityController.current?.abort(); };
  }, [session?.id, session?.log, session?.activityPath, session?.attempt.id, session?.attempt.agent, mode]);
  useEffect(() => { if (!following || !session) return; const timer = setInterval(() => { void loadRef.current("newer"); }, 2000); return () => clearInterval(timer); }, [following, session?.id, session?.log, session?.activityPath, session?.attempt.id, session?.attempt.agent, mode]);
  useEffect(() => { const stop = () => { actionController.current?.abort(); activityController.current?.abort(); }; lifetime.addEventListener("abort", stop); return () => { stop(); lifetime.removeEventListener("abort", stop); }; }, [lifetime]);
  const execute = async (action: DashboardAction, input?: PreviewInput) => {
    if (!snapshot || busy) return;
    if (!action.available) { setOutput(action.reason ?? "Unavailable"); return; }
    setPane("details"); setOffset(0);
    const controller = new AbortController(); actionController.current = controller; setBusy(true); setMenu(undefined); setOutput("Working… Escape cancels");
    try { const result = await runDashboardAction({ snapshot, action, input, signal: controller.signal }); if (!controller.signal.aborted && !lifetime.aborted) setOutput(result.text); }
    catch (error) { if (!lifetime.aborted && !controller.signal.aborted && actionController.current === controller) setOutput(safeText(error instanceof Error ? error.message : error)); }
    finally { if (actionController.current === controller) setBusy(false); }
  };
  const beginEdit = (kind: typeof edit, initial = "") => { setEdit(kind); setText(initial); };
  useInput((input, key) => {
    if (edit) {
      if (key.escape) { setEdit(undefined); setPreview(undefined); return; }
      if (key.return) {
        const value = text.trim();
        if (edit === "activity") { activitySearchRef.current = value; setActivitySearch(value); setActivityOffset(0); }
        else if (edit === "search") setFilters(f => ({ ...f, search: value }));
        else if (["status", "harness", "owner"].includes(edit)) setFilters(f => ({ ...f, [edit]: value || undefined }));
        else if (preview) {
          const updated = { ...preview, input: { ...preview.input, ...(edit === "tasks" ? { taskIds: value.split(",").map(t => t.trim()).filter(Boolean) } : { [edit]: value || undefined }) } };
          setPreview(updated);
          const feature = snapshot?.features.find(f => f.id === target || f.id === snapshot.tasks.find(t => t.id === target)?.featureId);
          if (edit === "tasks" && !feature?.state) { beginEdit("model"); return; }
          if (edit === "model") { beginEdit("effort"); return; }
          void execute(updated.action, updated.input); setPreview(undefined);
        }
        setEdit(undefined); return;
      }
      if (key.backspace || key.delete) setText(t => t.slice(0, -1)); else if (!key.ctrl && !key.meta) setText(t => (t + safeText(input)).slice(0, 500));
      return;
    }
    if (input === "q" || key.ctrl && input === "c") { quit(); return; }
    if (key.escape) { actionController.current?.abort(); setMenu(undefined); setHelp(false); setOutput(""); setPane("list"); return; }
    if (input === "?") { setHelp(h => !h); return; }
    if (input === "r") { collector.refresh(); return; }
    if (input === "/") { beginEdit(pane === "activity" ? "activity" : "search", pane === "activity" ? activitySearch : filters.search); return; }
    if (input === "s" || input === "h" || input === "o") { beginEdit(input === "s" ? "status" : input === "h" ? "harness" : "owner"); return; }
    if (input === "c") { setFilters(f => ({ ...f, includeCompleted: !f.includeCompleted })); return; }
    if (input === "v") { setFilters(f => ({ ...f, includeOlderAttempts: !f.includeOlderAttempts })); return; }
    if (input === "z") { setFilters(f => ({ ...f, sort: f.sort === "name" ? "attention" : "name" })); return; }
    if (input === "f") { changeFollowing(true); setActivityOffset(0); void load("newer"); return; }
    if (input === "p") { changeFollowing(!followingRef.current); return; }
    if (input === "w") { setMode(m => m === "raw" ? "normalized" : "raw"); return; }
    if (input === "b") { changeFollowing(false); void load("older"); return; }
    if (input === "x") {
      const next = !expanded; expandedRef.current = next; changeFollowing(false); setExpanded(next);
      const index = Math.max(0, visibleEntries.length - 1 - activityOffset);
      setActivityOffset(next ? activityLineCount(visibleEntries.slice(index + 1), true) + Math.max(0, activityLineCount(visibleEntries[index] ? [visibleEntries[index]] : [], true) - Math.max(3, height - 7)) : 0);
      return;
    }
    if (input === "a" && snapshot && target) { setMenu(actionsFor(snapshot, target)); setActionIndex(0); return; }
    if (menu) {
      if (key.upArrow || key.downArrow) setActionIndex(i => Math.max(0, Math.min(menu.length - 1, i + (key.upArrow ? -1 : 1))));
      if (key.return) { const action = menu[actionIndex]; if (!action) return; if (action.kind === "preview" && action.available && /launch-preview|retry-preview/.test(action.id)) { setPreview({ action, input: {} }); beginEdit("tasks", snapshot?.tasks.find(t => t.id === target)?.task.id); } else void execute(action); }
      return;
    }
    if (key.leftArrow || key.rightArrow) { setTab(t => (t + (key.leftArrow ? 4 : 1)) % 5); setPane("list"); return; }
    if (key.tab) { setPane(p => p === "list" ? "details" : p === "details" && session ? "activity" : "list"); return; }
    if (key.return) { setPane(p => p === "list" ? "details" : session ? "activity" : "details"); return; }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (pane === "list") { const i = Math.max(0, list.findIndex(r => r.id === chosen)); setSelected(list[Math.max(0, Math.min(list.length - 1, i + delta))]?.id); }
      else if (pane === "activity") { changeFollowing(false); setActivityOffset(o => Math.max(0, Math.min(activityLineCount(visibleEntries, expanded) - 1, o - delta))); }
      else setOffset(o => Math.max(0, o + delta));
    }
  });
  const capacity = Math.max(3, height - 7), width = Math.max(15, columns - 2), narrow = columns < 70;
  let lines: string[];
  if (help) lines = ["←/→ views · ↑/↓ selection/scroll · Tab pane", "Enter details · Esc back/cancel · / search", "s status · h harness · o owner (empty clears)", "c completed · v older attempts · z sort", "a actions (Enter executes explicit preview)", "w raw · p pause · f resume · b older page", "x expand activity · r refresh · q exit", "Activity outcomes do not establish completion"];
  else if (menu) lines = menu.slice(Math.max(0, actionIndex - capacity + 1), actionIndex + capacity).map((a, i) => `${a.id === menu[actionIndex]?.id ? "›" : " "} ${a.label}${a.available ? "" : ` — unavailable: ${a.reason}`}`);
  else if (pane === "activity") {
    lines = activityViewport(visibleEntries, expanded, activityOffset, capacity);
    if (!lines.length) lines = [session?.log ? "No activity available" : "No recorded log for this session"];
    if (activityError) lines.unshift(`Activity error: ${activityError}`);
  } else if (pane === "details") lines = (output ? safeText(output).split("\n") : snapshot && target ? detailLines(snapshot, target) : ["No selected evidence"]).slice(offset, offset + capacity);
  else {
    const index = Math.max(0, list.findIndex(r => r.id === chosen)), start = Math.max(0, index - capacity + 1);
    lines = list.slice(start, start + capacity).map(r => `${r.id === chosen ? "›" : " "} ${r.label}`);
    if (!lines.length) lines = [snapshot ? "No matching work" : "Collecting… keyboard remains available"];
  }
  const slots = snapshot ? `${snapshot.sessions.filter(s => ["preparing", "running", "launching", "manual"].includes(s.phase)).length}/${snapshot.repository.maxParallel ?? "unknown"}` : "unknown";
  return <Box flexDirection="column" height={height} width={columns}>
    <Text color="cyan">{safeText(narrow ? `${view} / ${pane} · ←/→` : dashboardViews.map((v, i) => i === tab ? `[${v}]` : v).join("  ")).slice(0, width)}</Text>
    <Text>{safeText(`Tasks ${snapshot?.features.reduce((n, f) => n + f.completed, 0) ?? 0}/${snapshot?.tasks.length ?? 0} · slots ${slots} · attention ${snapshot?.attention.length ?? 0} · ${pane}${busy ? " · busy" : ""}`).slice(0, width)}</Text>
    <Text color="yellow">{safeText(failure ?? snapshot?.errors.map(e => `${e.stale ? "STALE" : "ERROR"} ${e.source}: ${e.message}`).join("; ") ?? "").slice(0, width)}</Text>
    <Text dimColor>{safeText(`/${filters.search} s:${filters.status ?? "all"} h:${filters.harness ?? "all"} o:${filters.owner ?? "all"} c:${filters.includeCompleted} v:${filters.includeOlderAttempts} z:${filters.sort}`).slice(0, width)}</Text>
    {lines.slice(0, capacity).map((line, i) => <Text key={i} wrap="truncate">{safeText(line).slice(0, width)}</Text>)}
    <Text color="green">{edit ? safeText(`${edit}: ${text} · Enter apply/Esc cancel`).slice(0, width) : pane === "activity" ? `${mode} · ${following ? "following" : "PAUSED — f resume"} · w raw p pause b older x expand` : "↑↓ Tab Enter / r ? q · a actions"}</Text>
    <Text dimColor>{safeText(narrow ? "s/h/o filters c/v toggles z sort" : "s status h harness o owner c completed v older z sort · ←→ views").slice(0, width)}</Text>
  </Box>;
}
export async function runDashboardUi(options: DashboardOptions): Promise<void> {
  const lifetime = new AbortController(); let snapshot: DashboardSnapshot | undefined, failure: string | undefined;
  let instance: ReturnType<typeof render> | undefined, resolveExit!: () => void;
  const finished = new Promise<void>(resolve => { resolveExit = resolve; });
  const quit = () => { lifetime.abort(); resolveExit(); };
  const collector = startDashboardCollector(options, next => { snapshot = next; failure = undefined; update(); }, message => { failure = message; update(); });
  const update = () => { if (!lifetime.signal.aborted) instance?.rerender(<DashboardUi snapshot={snapshot} collector={collector} failure={failure} quit={quit} lifetime={lifetime.signal} />); };
  // Keep this listener registered until asynchronous terminal cleanup finishes.
  const interrupt = () => quit(); process.on("SIGINT", interrupt);
  try {
    instance = render(<DashboardUi snapshot={snapshot} collector={collector} failure={failure} quit={quit} lifetime={lifetime.signal} />, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, interactive: true, exitOnCtrlC: false, patchConsole: false, alternateScreen: true });
    await Promise.race([finished, instance.waitUntilExit()]);
  } finally {
    lifetime.abort(); await collector.close(); instance?.unmount(); instance?.cleanup(); process.removeListener("SIGINT", interrupt);
  }
}
