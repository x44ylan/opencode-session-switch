/** @jsxImportSource @opentui/solid */
import { MouseButton, TextAttributes, type MouseEvent } from "@opentui/core";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

const PLUGIN_ID = "opencode-session-switch";
const SWITCH_GUARD_MS = 350;
const SESSION_LIST_MAX_HEIGHT = 12;
const SESSION_FETCH_LIMIT = 30;
const RECENT_LIMIT = 8;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

interface SessionView {
  id: string;
  title: string;
  updated: number;
}

interface Tab {
  sessionID: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function toSessionView(value: unknown): SessionView | undefined {
  const session = asRecord(value);
  if (!session || typeof session.id !== "string") return;

  const parentID = session.parentID ?? session.parentId;
  if (typeof parentID === "string" && parentID.trim()) return;

  const time = asRecord(session.time);
  const created = typeof time?.created === "number" ? time.created : 0;
  const updated = typeof time?.updated === "number" ? time.updated : created;
  if (typeof time?.archived === "number") return;
  const viewed = typeof time?.viewed === "number" ? time.viewed : 0;
  return {
    id: session.id,
    title: typeof session.title === "string" && session.title.trim() ? session.title.trim() : "Untitled session",
    updated: Math.max(updated, viewed),
  };
}

/** Open tabs first, in tab order, then the most recently used sessions, capped at RECENT_LIMIT. */
export function orderSessions(sessions: SessionView[], tabs: readonly Tab[], currentID: string): SessionView[] {
  const byID = new Map(sessions.map((session) => [session.id, session]));
  const open = tabs.map((tab) => byID.get(tab.sessionID)).filter((session): session is SessionView => Boolean(session));
  const openIDs = new Set(open.map((session) => session.id));
  const recent = sessions
    .filter((session) => !openIDs.has(session.id))
    .sort((left, right) => right.updated - left.updated)
    .slice(0, RECENT_LIMIT);
  // Keep the session in view listed even when it is older than the recent ones.
  const current = byID.get(currentID);
  if (current && !openIDs.has(currentID) && !recent.includes(current)) recent.push(current);
  return [...open, ...recent];
}

function age(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

function shortTitle(title: string): string {
  return title.length > 26 ? `${title.slice(0, 25)}...` : title;
}

function clickPrimary(event: MouseEvent): boolean {
  if (event.button !== MouseButton.LEFT) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function SidebarSessionSwitch(props: { context: Context; sessionID: string }) {
  const theme = props.context.theme;
  const [sessions, setSessions] = createSignal<SessionView[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [expanded, setExpanded] = createSignal(true);
  const [switchingSessionID, setSwitchingSessionID] = createSignal<string>();
  const [spinnerIndex, setSpinnerIndex] = createSignal(0);
  let refreshing: Promise<void> | undefined;

  // Only sessions from the directory of the session in view; /sessions browses the full history.
  const directory = async () =>
    props.context.data.session.get(props.sessionID)?.location.directory ??
    (await props.context.client.session.get({ sessionID: props.sessionID }).catch(() => undefined))?.location.directory ??
    props.context.location?.directory;

  const refresh = async () => {
    refreshing ??= directory()
      .then((dir) => props.context.client.session.list({ parentID: null, directory: dir, limit: SESSION_FETCH_LIMIT, order: "desc" }))
      .then((result) => {
        setSessions(result.data.map(toSessionView).filter((session): session is SessionView => Boolean(session)));
      })
      .catch(() => {
        props.context.ui.toast.show({ message: "Failed to load sessions", variant: "error", duration: 2500 });
      })
      .finally(() => {
        refreshing = undefined;
        setLoading(false);
      });
    return refreshing;
  };

  const tabs = () => (props.context.ui.tabs.enabled() ? props.context.ui.tabs.list() : []);
  const ordered = createMemo(() => orderSessions(sessions(), tabs(), props.sessionID));
  const isOpen = (sessionID: string) => tabs().some((tab) => tab.sessionID === sessionID);

  // Re-scope the list when the sidebar follows a switch to another session.
  createEffect(() => {
    void props.sessionID;
    void refresh();
  });
  const stopCreated = props.context.data.on("session.created", () => void refresh());
  const stopRenamed = props.context.data.on("session.renamed", () => void refresh());
  const stopDeleted = props.context.data.on("session.deleted", () => void refresh());
  const stopIdle = props.context.data.on("session.idle", () => void refresh());
  const spinnerTimer = setInterval(() => setSpinnerIndex((index) => index + 1), SPINNER_INTERVAL_MS);
  const switchTimers = new Set<ReturnType<typeof setTimeout>>();

  onCleanup(() => {
    clearInterval(spinnerTimer);
    switchTimers.forEach(clearTimeout);
    stopCreated();
    stopRenamed();
    stopDeleted();
    stopIdle();
  });

  const selectSession = (sessionID: string) => {
    if (switchingSessionID() || sessionID === props.sessionID) return;
    setSwitchingSessionID(sessionID);
    if (!props.context.ui.tabs.focus(sessionID)) props.context.ui.router.navigate({ type: "session", sessionID });
    const timer = setTimeout(() => {
      switchTimers.delete(timer);
      setSwitchingSessionID(undefined);
    }, SWITCH_GUARD_MS);
    switchTimers.add(timer);
  };

  return (
    <box flexDirection="column" gap={0} paddingTop={1} paddingBottom={1}>
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        onMouseUp={(event) => {
          if (clickPrimary(event)) setExpanded((value) => !value);
        }}
      >
        <text fg={theme.text.base}>{expanded() ? "▼" : "▶"}</text>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Sessions</text>
      </box>

      <Show when={expanded()}>
        <Show when={!loading()} fallback={<text fg={theme.text.muted}>  Loading sessions...</text>}>
          <Show when={ordered().length > 0} fallback={<text fg={theme.text.muted}>  No other recent sessions</text>}>
            <scrollbox maxHeight={SESSION_LIST_MAX_HEIGHT}>
              <box flexDirection="column" gap={0}>
                <For each={ordered()}>
                  {(session) => {
                    const running = () => props.context.data.session.status(session.id) === "running";
                    const current = () => session.id === props.sessionID;
                    return (
                      <box
                        flexDirection="row"
                        justifyContent="space-between"
                        gap={1}
                        onMouseUp={(event) => {
                          if (clickPrimary(event)) selectSession(session.id);
                        }}
                      >
                        <text
                          fg={
                            current() || switchingSessionID() === session.id
                              ? theme.text.action.primary.base
                              : theme.text.base
                          }
                        >
                          {`  ${shortTitle(session.title)}`}
                        </text>
                        <Show
                          when={running()}
                          fallback={<text fg={theme.text.muted}>{isOpen(session.id) ? "open" : age(session.updated)}</text>}
                        >
                          <text fg={theme.text.muted}>{SPINNER_FRAMES[spinnerIndex() % SPINNER_FRAMES.length]}</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </box>
            </scrollbox>
          </Show>
        </Show>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarSessionSwitch context={context} sessionID={props.sessionID} />,
    });
  },
});
