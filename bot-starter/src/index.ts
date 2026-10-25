// Bot en vivo. Usa la política de src/core/policy.ts con los parámetros que
// deja el optimizador en params/{vickrey,firstprice}.json (se recargan solos
// cuando cambian, sin reiniciar ni crear versión nueva).
//
// Primera vez:  BOT_NAME=<name> BOT_TOKEN=<token de /team> npm start
// Después:      BOT_NAME=<name> npm start
// Torneo:       BOT_NAME=<name> TOURNAMENT_ID=<id> npm start
//
// Cada partida terminada se guarda en data/matches.jsonl (pujas, ganadores,
// pujas máximas reveladas al final, palabras) para `npm run learn`.

import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadDict } from "./core/dict.js";
import { chooseWords, decideBid, DEFAULT_PARAMS, type Params } from "./core/policy.js";
import { marketPrices, marketTop } from "./core/prices.js";
import { BAG, emptyRack, idx } from "./core/rules.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1"; // solo torneo, sin partidas de lobby
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const MATCH_LOG = path.join(process.cwd(), "data", "matches.jsonl");

const dict = loadDict();
// Si el asesor reemplaza policy.ts, reiniciamos entre partidas para cargarla.
const POLICY_FILE = path.join(process.cwd(), "src", "core", "policy.ts");
const policyMtime = () => {
  try {
    return fs.statSync(POLICY_FILE).mtimeMs;
  } catch {
    return 0;
  }
};
const POLICY_MTIME_AT_START = policyMtime();
const log = (...a: unknown[]) => console.log(`[${BOT_NAME}]`, ...a);

// ---------- parámetros con recarga en caliente ----------
const paramCache = new Map<string, { mtime: number; p: Params }>();
function params(firstPrice: boolean): Params {
  const f = path.join(process.cwd(), "params", firstPrice ? "firstprice.json" : "vickrey.json");
  try {
    const mtime = fs.statSync(f).mtimeMs;
    const c = paramCache.get(f);
    if (c && c.mtime === mtime) return c.p;
    const p = { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(f, "utf8")) } as Params;
    paramCache.set(f, { mtime, p });
    log(`params cargados de ${path.basename(f)}`);
    return p;
  } catch {
    return DEFAULT_PARAMS;
  }
}

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidSent = new Set<bigint>();
const wordPending = new Map<bigint, string>(); // matchId -> rack para el que ya mandamos palabras
const logged = new Set<bigint>();

function loadToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const fail = (what: string) => (err: unknown) =>
  console.warn(`[${BOT_NAME}] ${what} falló: ${err instanceof Error ? err.message : err}`);

// ---------- estado de una partida desde las tablas ----------
function view(conn: DbConnection, matchId: bigint) {
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running" || myBotId === null) return null;
  const me = [...conn.db.matchParticipant.iter()].find((p) => p.matchId === matchId && p.botId === myBotId);
  if (!me) return null;
  const rack = emptyRack();
  for (const h of conn.db.myRack.iter()) if (h.matchId === matchId) rack[idx(h.letter)]! += h.count;
  // Atril inicial = atril + lo que jugué - lo que gané.
  const start = new Int32Array(rack);
  for (const w of conn.db.wordPlay.iter())
    if (w.matchId === matchId && w.botId === myBotId) for (const c of w.word) start[idx(c)]!++;
  for (const r of conn.db.auctionResult.iter())
    if (r.matchId === matchId && r.winnerBotId === myBotId) start[idx(r.letter)]!--;
  const auctioned = new Int32Array(26);
  for (const a of conn.db.auction.iter()) if (a.matchId === matchId) auctioned[idx(a.letter)]!++;
  const unseen = new Int32Array(26);
  for (let i = 0; i < 26; i++) unseen[i] = Math.max(0, BAG[i]! - auctioned[i]! - Math.max(0, start[i]!));
  const firstPrice = m.auctionType.tag === "FirstPrice";
  return {
    m,
    p: params(firstPrice),
    v: {
      rack,
      balance: Number(me.balance),
      unseen,
      auctionsLeft: m.bagTotal,
      firstPrice,
      won: [...conn.db.auctionResult.iter()].filter((r) => r.matchId === matchId && r.winnerBotId === myBotId).length,
      round: m.currentRound,
      market: marketPrices(),
      marketTop: marketTop(),
    },
  };
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (bidSent.has(auctionId)) return;
  const s = view(conn, matchId);
  if (!s) return;
  bidSent.add(auctionId);
  const amount = decideBid(dict, s.p, s.v, idx(letter));
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(fail(`puja ${auctionId}`));
  log(`m${matchId} '${letter}' puja ${amount} (saldo ${s.v.balance}, quedan ${s.v.auctionsLeft})`);
}

function tryWords(conn: DbConnection) {
  if (myBotId === null) return;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const s = view(conn, p.matchId);
    if (!s) continue;
    const key = `${s.v.auctionsLeft}:${[...s.v.rack].join(",")}`;
    if (wordPending.get(p.matchId) === key) continue;
    wordPending.set(p.matchId, key);
    for (const word of chooseWords(dict, s.p, s.v)) {
      log(`m${p.matchId} juega '${word}'`);
      conn.reducers.submitWord({ matchId: p.matchId, word }).catch(fail(`palabra '${word}'`));
    }
  }
}

// ---------- registro de partidas para aprender ----------
function dumpMatch(conn: DbConnection, matchId: bigint) {
  if (logged.has(matchId)) return;
  logged.add(matchId);
  const m = conn.db.matchState.id.find(matchId);
  const top = new Map<string, number>();
  for (const t of conn.db.auctionTopBidArchive.iter())
    if (t.matchId === matchId) top.set(String(t.auctionId), Number(t.topBid));
  const bots = new Map([...conn.db.bot.iter()].map((b) => [String(b.id), { name: b.name, sim: b.isSimulated }]));
  const rec = {
    matchId: String(matchId),
    at: new Date().toISOString(),
    me: String(myBotId),
    auctionType: m?.auctionType.tag,
    participants: [...conn.db.matchParticipant.iter()]
      .filter((p) => p.matchId === matchId)
      .map((p) => ({ botId: String(p.botId), ...bots.get(String(p.botId)), score: Number(p.score) })),
    auctions: [...conn.db.auctionResult.iter()]
      .filter((r) => r.matchId === matchId)
      .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
      .map((r) => ({
        letter: r.letter,
        winner: r.winnerBotId === undefined ? null : String(r.winnerBotId),
        paid: Number(r.paid),
        top: top.get(String(r.auctionId)) ?? null,
      })),
    words: [...conn.db.wordPlay.iter()]
      .filter((w) => w.matchId === matchId)
      .map((w) => ({ botId: String(w.botId), word: w.word, reward: Number(w.totalReward) })),
  };
  fs.mkdirSync(path.dirname(MATCH_LOG), { recursive: true });
  fs.appendFileSync(MATCH_LOG, JSON.stringify(rec) + "\n");
  const sorted = [...rec.participants].sort((a, b) => b.score - a.score);
  const place = sorted.findIndex((p) => p.botId === rec.me) + 1;
  log(`m${matchId} terminó: puesto ${place}/${sorted.length} — ${sorted.map((p) => `${p.name}:${p.score}`).join(" ")}`);
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null || NO_LOBBY) return;
  const busy = [...conn.db.matchParticipant.iter()].some(
    (p) => p.botId === myBotId && conn.db.matchState.id.find(p.matchId)?.status.tag === "Running",
  );
  if (busy) return;
  const open = [...conn.db.lobby.iter()].find((l) => l.status.tag === "Open");
  if (open && [...conn.db.lobbyMember.iter()].some((lm) => lm.lobbyId === open.id && lm.botId === myBotId)) return;
  conn.reducers.joinLobby({}).catch(fail("entrar al lobby"));
}

// Solo nos suscribimos a nuestras partidas: suscribirse a todo (miles de
// partidas) hacía que cada puja llegara tarde.
const matchSubs = new Map<bigint, { unsubscribe(): void }>();
function subscribeMatch(conn: DbConnection, matchId: bigint) {
  if (matchSubs.has(matchId)) return;
  const id = String(matchId);
  const h = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const m = conn.db.matchState.id.find(matchId);
      if (m?.status.tag !== "Running") {
        // Partida vieja: no nos interesa.
        if (m) {
          h.unsubscribe();
          matchSubs.delete(matchId);
        }
        return;
      }
      log(`m${id}: suscripto`);
      tryWords(conn);
      for (const a of conn.db.auction.iter())
        if (a.matchId === matchId && a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
    })
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${id}`,
      `SELECT * FROM match_participant WHERE match_id = ${id}`,
      `SELECT * FROM auction WHERE match_id = ${id}`,
      `SELECT * FROM auction_result WHERE match_id = ${id}`,
      `SELECT * FROM word_play WHERE match_id = ${id}`,
      `SELECT * FROM auction_top_bid_archive WHERE match_id = ${id}`,
    ]);
  matchSubs.set(matchId, h);
}

function bootstrap(conn: DbConnection) {
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      // Retomar solo la partida más reciente (si sigue en juego).
      let last: bigint | null = null;
      for (const p of conn.db.matchParticipant.iter())
        if (p.botId === myBotId && (last === null || p.matchId > last)) last = p.matchId;
      if (last !== null) subscribeMatch(conn, last);
      setTimeout(() => joinLobby(conn), 1500);
    })
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
  if (TOURNAMENT_ID)
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => log(`inscripto en torneo ${TOURNAMENT_ID}`))
      .catch(fail(`inscripción al torneo ${TOURNAMENT_ID}`));
  // Reintento periódico del lobby (p. ej. tras un rechazo durante el torneo).
  setInterval(() => joinLobby(conn), 15_000);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  fs.writeFileSync(TOKEN_PATH, token);
  log(`conectado como ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      myBotId = conn.db.botCredential.identity.find(myIdentity!)?.botId ?? null;
      if (myBotId === null && BOT_NONCE) {
        conn.reducers.claimCredential({ code: BOT_NONCE }).catch(fail("canjear nonce"));
        setTimeout(() => {
          myBotId = conn.db.botCredential.identity.find(myIdentity!)?.botId ?? null;
          if (myBotId === null) process.exit(1);
          bootstrap(conn);
        }, 1000);
        return;
      }
      if (myBotId === null) {
        console.error("Este token no tiene bot. Generá uno en /team y pasalo en BOT_TOKEN.");
        process.exit(1);
      }
      log(`actuando como '${conn.db.bot.id.find(myBotId)?.name}' (id ${myBotId})`);
      bootstrap(conn);
    })
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
      "SELECT * FROM my_rack",
      "SELECT * FROM tournament",
    ]);

  conn.db.matchParticipant.onInsert((_c, p) => {
    if (myBotId !== null && p.botId === myBotId) subscribeMatch(conn, p.matchId);
  });
  conn.db.auction.onInsert((_c, a) => {
    if (a.status.tag !== "Open") return;
    tryWords(conn); // jugar antes de pujar: la plata de la palabra ya cuenta
    tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryWords(conn));
  conn.db.myRack.onUpdate(() => tryWords(conn));
  conn.db.matchState.onUpdate((_c, old, neu) => {
    if (myBotId === null || old.status.tag === "Ended" || neu.status.tag !== "Ended") return;
    const mine = [...conn.db.matchParticipant.iter()].some((p) => p.matchId === neu.id && p.botId === myBotId);
    if (!mine) return;
    setTimeout(() => {
      dumpMatch(conn, neu.id); // tras esperar el archivo de pujas máximas
      matchSubs.get(neu.id)?.unsubscribe();
      matchSubs.delete(neu.id);
      if (policyMtime() !== POLICY_MTIME_AT_START) {
        log("policy.ts cambió: reinicio para cargar la versión nueva");
        process.exit(0);
      }
    }, 3000);
    joinLobby(conn);
  });
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(BOT_TOKEN ?? loadToken())
  .onConnect(onConnect)
  .onConnectError((_c: ErrorContext, err: Error) => console.error("error de conexión:", err.message))
  .onDisconnect(() => {
    log("desconectado; salgo para que el supervisor me reinicie");
    process.exit(2);
  })
  .build();
