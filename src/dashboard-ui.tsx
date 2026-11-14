import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useInput, useWindowSize, useFocus } from "ink";
import { startDashboardCollector } from "./dashboard-client.js";
import { actionsFor, projectTarget, taskInputLimit, type DashboardAction, type DashboardField, type PreviewInput } from "./dashboard-actions.js";
import { runDashboardAction } from "./dashboard-action-runner.js";
import { dashboardViews, dashboardFilterChoices, defaultDashboardFilters, selectDashboardRows, preserveSelection, featureTimeline, firstRunRows, detailLines, safeText, mergeActivity, activityLineCount, activityViewport, filterActivity, preserveActivityOffset, type DashboardFilters, type DashboardFilterKey, type DashboardView } from "./dashboard-view.js";
import type { DashboardOptions, DashboardSnapshot } from "./dashboard-types.js";
import type { ActivityEntry } from "./activity-types.js";
import { dashboardFrame, dashboardLayout, type DashboardLine } from "./dashboard-layout.js";
type Collector = ReturnType<typeof startDashboardCollector>;
export function DashboardUi({ snapshot, collector, failure, quit, lifetime }: { snapshot?: DashboardSnapshot; collector: Collector; failure?: string; quit(): void; lifetime: AbortSignal }) {
  const { columns, rows: height } = useWindowSize();
  useFocus({ autoFocus: true });
  const [tab, setTab] = useState(0), [pane, setPane] = useState<"list" | "details" | "activity">("list");
  const view = dashboardViews[tab];
  const [viewFilters, setViewFilters] = useState<Partial<Record<DashboardView, DashboardFilters>>>({});
  const [selections, setSelections] = useState<Partial<Record<DashboardView, string>>>({});
  const [picker, setPicker] = useState<{ field: DashboardFilterKey; query: string; choice: string | undefined }>();
  const filters = viewFilters[view] ?? defaultDashboardFilters;
  const selected = selections[view];
  const setFilters = (update: (previous: DashboardFilters) => DashboardFilters) =>
    setViewFilters(previous => ({ ...previous, [view]: update(previous[view] ?? defaultDashboardFilters) }));
  const setSelected = (id?: string) => setSelections(previous => ({ ...previous, [view]: id }));
  const [edit, setEdit] = useState<"search" | "activity" | "tasks" | "model" | "effort" | "modelForSetup" | "launchAgent" | "launchBase" | "settingsFile" | DashboardField>(), [text, setText] = useState("");
  const [help, setHelp] = useState(false), [offset, setOffset] = useState(0), [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[]>([]), [activityError, setActivityError] = useState(""), [activitySearch, setActivitySearch] = useState("");
  const [following, setFollowing] = useState(true), [mode, setMode] = useState<"raw" | "normalized">("normalized"), [activityOffset, setActivityOffset] = useState(0);
  const [menu, setMenu] = useState<DashboardAction[]>(), [actionIndex, setActionIndex] = useState(0), [output, setOutput] = useState(""), [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<{ featureId: string; selected?: string; details?: boolean }>();
  const [preview, setPreview] = useState<{ action: DashboardAction; input: PreviewInput }>();
  const actionController = useRef<AbortController | undefined>(undefined), activityController = useRef<AbortController | undefined>(undefined), generation = useRef(0);
  const followingRef = useRef(true), expandedRef = useRef(false), entriesRef = useRef<ActivityEntry[]>([]), activitySearchRef = useRef("");
  const changeFollowing = (value: boolean) => { followingRef.current = value; setFollowing(value); };
  const cursor = useRef<{ older?: string; newer?: string }>({}), loading = useRef(false);
  const [validated, setValidated] = useState<ReadonlySet<string>>(() => new Set());
  const filtering = !!(filters.search || filters.status || filters.harness || filters.owner);
  const guidance = snapshot && !failure && view === "Overview" && !filtering ? firstRunRows(snapshot, validated) : [];
  const list = snapshot ? [...guidance, ...selectDashboardRows(snapshot, view, filters)] : [];
  const chosen = preserveSelection(list, selected), target = list.find(r => r.id === chosen)?.targetId;
  const timelineEvents = timeline && snapshot ? featureTimeline(snapshot, timeline.featureId) : [];
  const timelineIndex = Math.max(0, timelineEvents.findIndex(event => event.id === timeline?.selected));
  const timelineEvent = timelineEvents[timelineIndex];
  const session = snapshot?.sessions.find(s => s.id === target);
  const visibleEntries = filterActivity(entries, activitySearch);
  const error = failure ?? snapshot?.errors.map(e => `${e.stale ? "STALE" : "ERROR"} ${e.source}: ${e.message}`).join("; ") ?? "";
  const layout = dashboardLayout({ columns, rows: height, error, table: !timeline && view === "Features" && pane === "list" && !help && !menu && !picker });

  useEffect(() => { setOffset(0); if (pane === "list") setOutput(""); setMenu(undefined); actionController.current?.abort(); actionController.current = undefined; setBusy(false); }, [target, tab]);
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
  const [confirmation, setConfirmation] = useState<{ action: DashboardAction; input?: PreviewInput; text: string }>();
  const [launchFollowup, setLaunchFollowup] = useState<{ action: DashboardAction; input?: PreviewInput }>();
  const applying = useRef(false);
  const execute = async (action: DashboardAction, input?: PreviewInput, approved?: string) => {
    if (!snapshot || busy || actionController.current) return;
    if (!action.available) { setOutput(action.reason ?? "Unavailable"); return; }
    setLaunchFollowup(undefined);
    setPane("details"); setOffset(0);
    const controller = new AbortController(); actionController.current = controller; setBusy(true); setMenu(undefined); const checking = /:managed-(plan|final|archive)$/.test(action.id);
    setOutput(approved ? "Applying change…" : checking ? "Running checks…" : "Working… Escape cancels");
    applying.current = !!approved || checking;
    try { const result = await runDashboardAction({ snapshot, action, input, signal: controller.signal, confirmation: approved });
      if (!controller.signal.aborted && !lifetime.aborted) {
        setOutput(result.text);
        if (action.id.endsWith(":validate")) {
          const feature = snapshot.features.find(feature => action.id === `${feature.id}:validate`);
          if (feature?.planFingerprint) setValidated(previous => new Set([...previous, `${feature.id}:${feature.planFingerprint}`]));
        }
        if (result.confirmation) setConfirmation({ action, input, text: result.confirmation });
        if (target && /:(launch|retry)-preview$/.test(action.id)) {
          const next = actionsFor(snapshot, target).find(candidate => candidate.id === action.id.replace(/-preview$/, "-run"));
          if (next?.available) setLaunchFollowup({ action: next, input });
        }
      } }
    catch (error) {
      if (!lifetime.aborted && !controller.signal.aborted && actionController.current === controller) {
        setOutput(safeText(error instanceof Error ? error.message : error));
        if (approved && /:handoff-(component-export|receipt-accept)$/.test(action.id))
          setConfirmation({ action, input, text: approved });
      }
    }
    finally {
      if (approved || checking) collector.refresh();
      applying.current = false;
      if (actionController.current === controller) { actionController.current = undefined; setBusy(false); }
    }
  };
  const beginEdit = (kind: typeof edit, initial = "") => { setEdit(kind); setText(initial); };
  const overviewSelection = useRef<string | undefined>(undefined);
  const openAction = (action: DashboardAction, tasks?: string, rowId?: string) => {
    overviewSelection.current = rowId;
    if (action.kind === "timeline" && target && snapshot) {
      setMenu(undefined);
      setTimeline({ featureId: target, selected: featureTimeline(snapshot, target)[0]?.id });
      return;
    }
    if (action.available && /:(?:(launch|retry)-(preview|run)|integrate-run)$/.test(action.id)) {
      setPreview({ action, input: {} });
      beginEdit("tasks", tasks ?? action.initialTasks);
    } else if (action.available && action.fields?.length) {
      setMenu(undefined); setPreview({ action, input: {} }); beginEdit(action.fields[0]);
    } else if (action.available && action.id.endsWith(":managed-plan")) {
      setMenu(undefined); setPreview({ action, input: {} }); beginEdit("settingsFile");
    } else if (action.kind === "change" && action.id.startsWith("project:init:copilot")) {
      setMenu(undefined); setPreview({ action, input: {} }); beginEdit("modelForSetup");
    } else void execute(action);
  };
  const choices = picker && snapshot ? dashboardFilterChoices(snapshot, view, filters, picker.field)
    .filter(choice => choice.label.toLowerCase().includes(picker.query.toLowerCase()) || choice.value !== undefined && choice.value === filters[picker.field]) : [];
  const selectedChoice = choices.findIndex(choice => choice.value === picker?.choice);
  const matchingChoice = choices.findIndex(choice => choice.label.toLowerCase().includes(picker?.query.toLowerCase() ?? ""));
  const choiceIndex = Math.max(0, selectedChoice < 0 ? matchingChoice : selectedChoice);
  useInput((input, key) => {
    if (picker) {
      if (key.escape) setPicker(undefined);
      else if (key.return && choices[choiceIndex]) {
        const value = choices[choiceIndex].value;
        setFilters(previous => ({ ...previous, [picker.field]: value }));
        setPicker(undefined);
      } else if (key.upArrow || key.downArrow) {
        const index = Math.max(0, Math.min(choices.length - 1, choiceIndex + (key.upArrow ? -1 : 1)));
        setPicker({ ...picker, choice: choices[index]?.value });
      } else if (key.backspace || key.delete)
        setPicker({ ...picker, query: picker.query.slice(0, -1), choice: undefined });
      else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f]/.test(input))
        setPicker({ ...picker, query: (picker.query + safeText(input)).slice(0, taskInputLimit), choice: undefined });
      return;
    }
    if (applying.current) return;
    if (timeline) {
      if (input === "q" || key.ctrl && input === "c") { quit(); return; }
      if (input === "r") collector.refresh();
      if (key.escape) {
        if (timeline.details) setTimeline({ ...timeline, details: false });
        else setTimeline(undefined);
      }
      if (key.return && timelineEvent && !timeline.details) {
        setOffset(0);
        setTimeline({ ...timeline, selected: timelineEvent.id, details: true });
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        if (timeline.details) setOffset(value => Math.max(0, value + delta));
        else setTimeline({ ...timeline, selected: timelineEvents[Math.max(0, Math.min(timelineEvents.length - 1, timelineIndex + delta))]?.id });
      }
      return;
    }
    if (key.return && overviewSelection.current && (confirmation || edit) &&
        !list.some(row => row.id === overviewSelection.current && row.primary === (confirmation?.action.id ?? preview?.action.id))) {
      overviewSelection.current = undefined;
      setConfirmation(undefined); setEdit(undefined); setPreview(undefined);
      setPane("details"); setOutput("Selection changed; review the current item again"); return;
    }
    if (confirmation && (key.return || key.escape)) {
      setConfirmation(undefined);
      if (key.return) void execute(confirmation.action, confirmation.input, confirmation.text);
      else setOutput("Cancelled");
      return;
    }
    if (confirmation && !key.upArrow && !key.downArrow) return;
    if (edit) {
      if (key.escape) { setEdit(undefined); setPreview(undefined); return; }
      if (key.return) {
        const value = text.trim();
        if (edit === "activity") { activitySearchRef.current = value; setActivitySearch(value); setActivityOffset(0); }
        else if (edit === "search") setFilters(f => ({ ...f, search: value }));
        else if (preview) {
          const updated = { ...preview, input: { ...preview.input, ...(edit === "tasks" ? { taskIds: value.split(",").map(t => t.trim()).filter(Boolean) } : { [edit]: value || undefined }) } };
          setPreview(updated);
          const fields = updated.action.fields;
          const nextField = fields?.[fields.indexOf(edit as DashboardField) + 1];
          if (nextField) { beginEdit(nextField); return; }
          const feature = snapshot?.features.find(f => f.id === target || f.id === snapshot.tasks.find(t => t.id === target)?.featureId);
          if (edit === "tasks" && !updated.action.id.endsWith(":integrate-run") && !feature?.state) { beginEdit("model"); return; }
          if (edit === "model") { beginEdit("effort"); return; }
          if (edit === "effort") { beginEdit("launchAgent"); return; }
          if (edit === "launchAgent") { beginEdit("launchBase"); return; }
          void execute(updated.action, updated.input); setPreview(undefined);
        }
        setEdit(undefined); return;
      }
      if (edit === "tasks" && key.ctrl && input === "u") setText("");
      else if (key.backspace || key.delete) setText(t => t.slice(0, -1));
      else if (!key.ctrl && !key.meta) setText(t => (t + safeText(input)).slice(0, taskInputLimit));
      return;
    }
    if (input === "l" && pane === "details" && output && launchFollowup) {
      void execute(launchFollowup.action, launchFollowup.input);
      return;
    }
    if (input === "q" || key.ctrl && input === "c") { quit(); return; }
    if (key.escape) { actionController.current?.abort(); setMenu(undefined); setHelp(false); setOutput(""); setPane("list"); return; }
    if (input === "?") { setHelp(h => !h); return; }
    if (input === "r") { collector.refresh(); return; }
    if (input === "/") { beginEdit(pane === "activity" ? "activity" : "search", pane === "activity" ? activitySearch : filters.search); return; }
    if (input === "s" || input === "h" || input === "o") {
      const field = input === "s" ? "status" : input === "h" ? "harness" : "owner";
      setMenu(undefined); setHelp(false);
      setPicker({ field, query: "", choice: filters[field] }); return;
    }
    if (input === "0" && pane !== "activity") { setFilters(() => defaultDashboardFilters); setPane("list"); return; }
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
      setActivityOffset(next ? activityLineCount(visibleEntries.slice(index + 1), true) + Math.max(0, activityLineCount(visibleEntries[index] ? [visibleEntries[index]] : [], true) - layout.capacity) : 0);
      return;
    }
    if (input === "g" && snapshot) { setMenu(actionsFor(snapshot, projectTarget)); setActionIndex(0); return; }
    if (input === "a" && snapshot && target) { setMenu(actionsFor(snapshot, target)); setActionIndex(0); return; }
    if (menu) {
      if (key.upArrow || key.downArrow) setActionIndex(i => Math.max(0, Math.min(menu.length - 1, i + (key.upArrow ? -1 : 1))));
      if (key.return && snapshot) {
        const menuTarget = menu[actionIndex]?.id.startsWith("project:") ? projectTarget : target;
        if (!menuTarget) return;
        const action = actionsFor(snapshot, menuTarget).find(candidate => candidate.id === menu[actionIndex]?.id);
        if (!action) return;
        openAction(action);
      }
      return;
    }
    if (key.leftArrow || key.rightArrow) { setTab(t => (t + (key.leftArrow ? 4 : 1)) % 5); setPane("list"); return; }
    if (key.tab) { setPane(p => p === "list" ? "details" : p === "details" && session ? "activity" : "list"); return; }
    if (key.return && pane === "list" && view === "Overview" && snapshot && target) {
      const row = list.find(entry => entry.id === chosen);
      if (row?.projectSetup) {
        overviewSelection.current = undefined;
        setMenu(actionsFor(snapshot, projectTarget).filter(entry => entry.id.startsWith("project:init:")));
        setActionIndex(0); return;
      }
      if (row?.id.startsWith("first-run:") && !row.primary) {
        setOutput(row.label); setOffset(0); setPane("details"); return;
      }
      const action = row?.primary && actionsFor(snapshot, target).find(entry => entry.id === row.primary && entry.available);
      if (action) { openAction(action, row.tasks, row.id); return; }
    }
    if (key.return) { setPane(p => p === "list" ? "details" : session ? "activity" : "details"); return; }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (pane === "list") { const i = Math.max(0, list.findIndex(r => r.id === chosen)); setSelected(list[Math.max(0, Math.min(list.length - 1, i + delta))]?.id); }
      else if (pane === "activity") { changeFollowing(false); setActivityOffset(o => Math.max(0, Math.min(activityLineCount(visibleEntries, expanded) - 1, o - delta))); }
      else setOffset(o => Math.max(0, o + delta));
    }
  });
  const { capacity, compact } = layout;
  let lines: DashboardLine[];
  if (picker) {
    const room = Math.max(1, capacity - 1);
    const start = Math.max(0, choiceIndex - room + 1);
    lines = [`Filter by ${picker.field} · ${picker.query || "type to search"}`,
      ...choices.slice(start, start + room).map((choice, index) =>
        `${index + start === choiceIndex ? "▸" : " "} ${choice.label} (${choice.count})${choice.value === filters[picker.field] ? " · current" : ""}`)];
    if (!choices.length) lines.push("No matching choices");
  } else if (timeline && snapshot) {
    const feature = snapshot.features.find(row => row.id === timeline.featureId);
    const source = snapshot.sources[timeline.featureId];
    const heading = `Timeline · ${feature?.change ?? timeline.featureId}${source?.stale ? ` · STALE · observed ${source.collectedAt}` : ""}`;
    const room = Math.max(1, capacity - 1);
    if (timeline.details) {
      const evidence = timelineEvents.find(event => event.id === timeline.selected);
      const details = evidence ? [evidence.title, evidence.at ?? "Time not recorded",
        ...(evidence.evidence ? JSON.stringify(evidence.evidence, null, 2).split("\n") : []),
        ...detailLines(snapshot, evidence.targetId)] : ["Selected milestone is no longer available"];
      lines = [heading, ...details.slice(Math.min(offset, Math.max(0, details.length - room)), Math.min(offset, Math.max(0, details.length - room)) + room)];
    } else {
      const start = Math.max(0, timelineIndex - room + 1);
      lines = [heading, ...timelineEvents.slice(start, start + room).map((event, index) =>
        `${index + start === timelineIndex ? "▸" : " "} ${event.at ?? "Undated"} · ${event.title}`)];
      if (!timelineEvents.length) lines.push("No recorded milestones");
    }
  } else if (help) lines = ["←/→ views · ↑/↓ selection/scroll · Tab pane", "Enter details · Esc back/cancel · / search", "s status · h harness · o owner · 0 reset", "c completed · v older attempts · z sort", "a row actions · g project actions", "w raw · p pause · f resume · b older page", "x expand activity · r refresh · q exit", "Activity outcomes do not establish completion"];
  else if (menu) lines = menu.slice(Math.max(0, actionIndex - capacity + 1), actionIndex + capacity).map(a => `${a.id === menu[actionIndex]?.id ? "▸" : " "} ${a.label}${a.available ? "" : ` — unavailable: ${a.reason}`}`);
  else if (pane === "activity") {
    lines = activityViewport(visibleEntries, expanded, activityOffset, capacity);
    if (!lines.length) lines = [session?.log ? "No activity available" : "No recorded log for this session"];
    if (activityError) lines.unshift(`Activity error: ${activityError}`);
  } else if (pane === "details") lines = (output ? safeText(output).split("\n") : snapshot && target ? detailLines(snapshot, target) : ["No selected evidence"]).slice(offset, offset + capacity);
  else {
    const index = Math.max(0, list.findIndex(r => r.id === chosen)), start = Math.max(0, index - capacity + 1);
    lines = list.slice(start, start + capacity).map(r => {
      const marker = r.id === chosen ? "▸" : " ";
      if (!layout.table) return `${marker} ${r.label}`;
      const task = snapshot?.tasks.find(t => t.id === r.targetId);
      if (task) return [`${marker} ${task.task.id}`, task.task.description, task.ready ? "Ready" : task.reasons.join("; ") || "not ready"];
      const feature = snapshot?.features.find(f => f.id === r.targetId);
      return [marker, feature?.change ?? r.targetId, `${feature?.phase ?? "unmanaged"} · ${feature?.completed}/${feature?.total} ${feature?.origin === "shared" ? "components delivered" : "tasks satisfied"}`];
    });
    if (!lines.length) {
      const available = snapshot && selectDashboardRows(snapshot, view, { ...defaultDashboardFilters, includeCompleted: true, includeOlderAttempts: true });
      lines = !snapshot ? ["Collecting… keyboard remains available"] : available?.length ?
        ["No matching rows · 0 reset", ...(!filters.includeCompleted || !filters.includeOlderAttempts ? ["c show completed · v show older attempts"] : [])] :
        [view === "Overview" ? "No data yet · g project actions" : "No data yet"];
    }
  }
  const localFeatures = snapshot?.features.filter(feature => feature.origin === "local") ?? [];
  const satisfiedTasks = localFeatures.reduce((count, feature) => count + feature.completed, 0);
  const totalTasks = localFeatures.reduce((count, feature) => count + feature.total, 0);
  const slots = snapshot ? `${snapshot.sessions.filter(s => ["preparing", "running", "launching", "manual"].includes(s.phase)).length}/${snapshot.repository.maxParallel ?? "unknown"}` : "unknown";
  const frame = dashboardFrame({
    columns, rows: height, table: layout.table, error,
    title: compact ? `${view} / ${pane} · ←/→` : dashboardViews.map((v, i) => i === tab ? `[${v}]` : v).join(" │ "),
    status: `Tasks ${satisfiedTasks}/${totalTasks} · slots ${slots} · attention ${snapshot?.attention.length ?? 0} · ${pane}${busy ? " · busy" : ""}`,
    filters: `/${filters.search} s:${filters.status ?? "all"} h:${filters.harness ?? "all"} o:${filters.owner ?? "all"} c:${filters.includeCompleted} v:${filters.includeOlderAttempts} z:${filters.sort}`,
    lines,
    footer: [picker ? "↑↓ choose · Enter apply · Esc cancel" : timeline ? "↑↓ browse · Enter evidence · Esc back · r refresh" : confirmation ? "Enter confirm · Esc cancel" : launchFollowup && pane === "details" && output && !edit ? "l review launch/retry · Esc back" : edit ? `${edit}: ${text} · Enter apply/Esc cancel` : pane === "activity" ? `${mode} · ${following ? "following" : "PAUSED — f resume"} · w raw p pause b older x expand` : "↑↓ Tab Enter / r ? q · a actions · g project", "s status h harness o owner c completed v older z sort · 0 reset · ←→ views"],
  });
  return <Box flexDirection="column" height={height} width={columns}>
    {frame.map((line, index) => <Text key={index} wrap="truncate" color={index === 1 ? "cyan" : error && index === (compact ? 3 : 4) ? "yellow" : index === frame.length - (compact ? 2 : 3) ? "green" : undefined} dimColor={!compact && index === frame.length - 2}>{line}</Text>)}
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
