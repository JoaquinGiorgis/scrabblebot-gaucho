// Descarga TODO el historial público con tiempos (cuándo se jugó cada palabra
// respecto de las subastas), el saldo final y los ratings del leaderboard.
//   npx tsx src/train/scout.ts      -> data/scout.jsonl + data/leaderboard.json
import * as fs from "node:fs";
import { DbConnection } from "../module_bindings/index.js";

const ms = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);

DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("scrabblebot")
  .onConnect((conn) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const bots = new Map([...conn.db.bot.iter()].map((b) => [String(b.id), { name: b.name, sim: b.isSimulated, team: String(b.teamId) }]));
        const by = <T extends { matchId: bigint }>(it: Iterable<T>) => {
          const m = new Map<string, T[]>();
          for (const r of it) {
            const k = String(r.matchId);
            if (!m.has(k)) m.set(k, []);
            m.get(k)!.push(r);
          }
          return m;
        };
        const parts = by(conn.db.matchParticipant.iter());
        const res = by(conn.db.auctionResult.iter());
        const words = by(conn.db.wordPlay.iter());
        const top = new Map([...conn.db.auctionTopBidArchive.iter()].map((t) => [String(t.auctionId), Number(t.topBid)]));
        const out: string[] = [];
        for (const m of conn.db.matchState.iter()) {
          if (m.status.tag !== "Ended") continue;
          const id = String(m.id);
          out.push(JSON.stringify({
            matchId: id,
            auctionType: m.auctionType.tag,
            participants: (parts.get(id) ?? []).map((p) => ({ botId: String(p.botId), ...bots.get(String(p.botId)), score: Number(p.score), balance: Number(p.balance) })),
            auctions: (res.get(id) ?? []).sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1)).map((r) => ({
              letter: r.letter,
              winner: r.winnerBotId === undefined ? null : String(r.winnerBotId),
              paid: Number(r.paid),
              top: top.get(String(r.auctionId)) ?? null,
              t: ms(r.closedAt),
            })),
            words: (words.get(id) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1)).map((w) => ({ botId: String(w.botId), word: w.word, reward: Number(w.totalReward), t: ms(w.playedAt) })),
          }));
        }
        const board = [...conn.db.botStats.iter()].map((s) => ({
          botId: String(s.botId), ...bots.get(String(s.botId)), mu: s.openskillMu, sigma: s.openskillSigma, elo: s.rating,
          played: s.matchesPlayed, wins: s.wins, totalScore: Number(s.totalScore),
        }));
        fs.mkdirSync("data", { recursive: true });
        fs.writeFileSync("data/scout.jsonl", out.join("\n") + "\n");
        fs.writeFileSync("data/leaderboard.json", JSON.stringify(board, null, 1));
        console.log(`partidas: ${out.length}, bots con stats: ${board.length}`);
        process.exit(0);
      })
      .subscribe([
        "SELECT * FROM bot",
        "SELECT * FROM bot_stats",
        "SELECT * FROM match_state",
        "SELECT * FROM match_participant",
        "SELECT * FROM auction_result",
        "SELECT * FROM word_play",
        "SELECT * FROM auction_top_bid_archive",
      ]);
  })
  .build();
setTimeout(() => { console.error("timeout"); process.exit(1); }, 120_000);
