import type * as Party from "partykit/server";

type Choice = 1 | 3 | 5;

type GameStatus = "lobby" | "active" | "ended";

type GameState = {
  status: GameStatus;
  round: number;
  resource: number;
  roundsMax: number;
  regenThreshold: number;
  regenHigh: number;
  regenLow: number;
  collapseAt: number;

  // per-round submissions: round -> connectionId -> choice
  submissions: Record<string, Record<string, { name: string; choice: Choice }>>;

  // last computed summary
  lastSummary: {
    round: number;
    totalExtracted: number;
    beforeRegen: number;
    regenAdded: number;
    newResource: number;
    breakdown: Record<string, number>;
  };

  // players
  players: Record<
    string,
    {
      name: string;
      isHost: boolean;
      connected: boolean;
    }
  >;
};

type ClientMsg =
  | { type: "join"; name: string; isHost: boolean }
  | { type: "choose"; choice: Choice }
  | { type: "host_start" }
  | { type: "host_advance" }
  | { type: "host_reset" }
  | { type: "host_end" };

type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "toast"; message: string };

type PublicState = {
  status: GameStatus;
  round: number;
  resource: number;
  regenNext: number;
  playersCount: number;
  submittedCount: number;
  lastSummary: GameState["lastSummary"];
  // do not expose individual submissions
};

const DEFAULT_STATE: GameState = {
  status: "lobby",
  round: 0,
  resource: 100,
  roundsMax: 6,
  regenThreshold: 40,
  regenHigh: 10,
  regenLow: 2,
  collapseAt: 0,
  submissions: {},
  lastSummary: {
    round: 0,
    totalExtracted: 0,
    beforeRegen: 100,
    regenAdded: 0,
    newResource: 100,
    breakdown: {}
  },
  players: {}
};

function computeRegen(state: GameState, resource: number) {
  if (resource <= state.collapseAt) return 0;
  return resource >= state.regenThreshold ? state.regenHigh : state.regenLow;
}

function publicState(room: Party.Room, state: GameState): PublicState {
  const roundKey = `round_${state.round}`;
  const submittedCount =
    state.round > 0 && state.submissions[roundKey]
      ? Object.keys(state.submissions[roundKey]).length
      : 0;

  const playersCount = Object.keys(state.players).length;
  const regenNext = computeRegen(state, state.resource);

  return {
    status: state.status,
    round: state.round,
    resource: state.resource,
    regenNext,
    playersCount,
    submittedCount,
    lastSummary: state.lastSummary
  };
}

async function loadOrInit(room: Party.Room): Promise<GameState> {
  const saved = await room.storage.get<GameState>("state");
  if (saved) return saved;
  await room.storage.put("state", DEFAULT_STATE);
  return DEFAULT_STATE;
}

async function save(room: Party.Room, state: GameState) {
  await room.storage.put("state", state);
}

function broadcast(room: Party.Room, msg: ServerMsg) {
  room.broadcast(JSON.stringify(msg));
}

export default class CommonsRoom implements Party.Server {
  state!: GameState;

  constructor(public room: Party.Room) {}

  async onStart() {
    this.state = await loadOrInit(this.room);
    // Mark all as disconnected on cold start
    for (const id of Object.keys(this.state.players)) {
      this.state.players[id].connected = false;
    }
    await save(this.room, this.state);
  }

  async onConnect(conn: Party.Connection) {
    // nothing yet; wait for join message
    conn.send(
      JSON.stringify({
        type: "state",
        state: publicState(this.room, this.state)
      } satisfies ServerMsg)
    );
  }

  async onClose(conn: Party.Connection) {
    const p = this.state.players[conn.id];
    if (p) p.connected = false;
    await save(this.room, this.state);
    broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
  }

  private isHost(conn: Party.Connection) {
    return !!this.state.players[conn.id]?.isHost;
  }

  async onMessage(message: string, conn: Party.Connection) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message);
    } catch {
      conn.send(JSON.stringify({ type: "toast", message: "Bad message." } satisfies ServerMsg));
      return;
    }

    if (msg.type === "join") {
      const name = (msg.name || "").trim().slice(0, 24) || "Player";
      this.state.players[conn.id] = {
        name,
        isHost: !!msg.isHost,
        connected: true
      };
      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
      broadcast(this.room, { type: "toast", message: `${name} joined.` });
      return;
    }

    // Require join before any other action
    if (!this.state.players[conn.id]) {
      conn.send(JSON.stringify({ type: "toast", message: "Join first." } satisfies ServerMsg));
      return;
    }

    if (msg.type === "choose") {
      if (this.state.status !== "active" || this.state.round <= 0) {
        conn.send(JSON.stringify({ type: "toast", message: "Game not active." } satisfies ServerMsg));
        return;
      }
      const roundKey = `round_${this.state.round}`;
      this.state.submissions[roundKey] ||= {};
      // one submission per round
      if (this.state.submissions[roundKey][conn.id]) {
        conn.send(JSON.stringify({ type: "toast", message: "Already submitted this round." } satisfies ServerMsg));
        return;
      }
      this.state.submissions[roundKey][conn.id] = {
        name: this.state.players[conn.id].name,
        choice: msg.choice
      };
      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
      return;
    }

    // Host-only messages
    if (!this.isHost(conn)) {
      conn.send(JSON.stringify({ type: "toast", message: "Host only." } satisfies ServerMsg));
      return;
    }

    if (msg.type === "host_start") {
      if (this.state.status === "ended") {
        conn.send(JSON.stringify({ type: "toast", message: "Reset to start again." } satisfies ServerMsg));
        return;
      }
      this.state.status = "active";
      this.state.round = 1;
      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
      broadcast(this.room, { type: "toast", message: "Game started." });
      return;
    }

    if (msg.type === "host_advance") {
      if (this.state.status !== "active" || this.state.round <= 0) return;

      const roundKey = `round_${this.state.round}`;
      const subs = this.state.submissions[roundKey] || {};
      const choices = Object.values(subs).map((x) => x.choice);

      const totalExtracted = choices.reduce((a, b) => a + b, 0);
      const beforeRegen = this.state.resource - totalExtracted;
      const regenAdded = beforeRegen <= this.state.collapseAt ? 0 : computeRegen(this.state, beforeRegen);
      const newResource = beforeRegen + regenAdded;

      const breakdown: Record<string, number> = { "1": 0, "3": 0, "5": 0 };
      for (const c of choices) breakdown[String(c)] = (breakdown[String(c)] || 0) + 1;

      this.state.lastSummary = {
        round: this.state.round,
        totalExtracted,
        beforeRegen,
        regenAdded,
        newResource,
        breakdown
      };

      this.state.resource = newResource;

      if (newResource <= this.state.collapseAt) {
        this.state.status = "ended";
      } else if (this.state.round >= this.state.roundsMax) {
        this.state.status = "ended";
      } else {
        this.state.round += 1;
      }

      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });

      if (this.state.status === "ended") {
        broadcast(this.room, { type: "toast", message: "Game ended (collapse or max rounds)." });
      } else {
        broadcast(this.room, { type: "toast", message: `Advanced to round ${this.state.round}.` });
      }
      return;
    }

    if (msg.type === "host_reset") {
      this.state = structuredClone(DEFAULT_STATE);
      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
      broadcast(this.room, { type: "toast", message: "Room reset." });
      return;
    }

    if (msg.type === "host_end") {
      this.state.status = "ended";
      await save(this.room, this.state);
      broadcast(this.room, { type: "state", state: publicState(this.room, this.state) });
      broadcast(this.room, { type: "toast", message: "Host ended the game." });
      return;
    }
  }
}
