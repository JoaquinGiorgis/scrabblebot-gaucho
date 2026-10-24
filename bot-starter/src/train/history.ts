// Descarga el historial público de partidas terminadas a data/history.jsonl
// (mismo formato que data/matches.jsonl, con me = null).
//   FROM=3000 npx tsx src/train/history.ts
import * as fs from "node:fs";
import { DbConnection } from "../module_bindings/index.js";

const FROM = Number(process.env.FROM ?? 3000);
DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("scrabblebot")
  .onConnect((conn) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const bots = new Map([...conn.db.bot.iter()].map((b) => [String(b.id), { name: b.name, sim: b.isSimulated }]));
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
            me: null,
            auctionType: m.auctionType.tag,
            endedAt: m.endedAt ? Number(m.endedAt.microsSinceUnixEpoch / 1000n) : null,
            participants: (parts.get(id) ?? []).map((p) => ({ botId: String(p.botId), ...bots.get(String(p.botId)), score: Number(p.score) })),
            auctions: (res.get(id) ?? []).sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1)).map((r) => ({
              letter: r.letter,
              winner: r.winnerBotId === undefined ? null : String(r.winnerBotId),
              paid: Number(r.paid),
              top: top.get(String(r.auctionId)) ?? null,
            })),
            words: (words.get(id) ?? []).map((w) => ({ botId: String(w.botId), word: w.word, reward: Number(w.totalReward) })),
          }));
        }
        fs.mkdirSync("data", { recursive: true });
        fs.writeFileSync("data/history.jsonl", out.join("\n") + "\n");
        console.log(`partidas guardadas: ${out.length}`);
        process.exit(0);
      })
      .subscribe([
        "SELECT * FROM bot",
        `SELECT * FROM match_state WHERE id >= ${FROM}`,
        `SELECT * FROM match_participant WHERE match_id >= ${FROM}`,
        `SELECT * FROM auction_result WHERE match_id >= ${FROM}`,
        `SELECT * FROM word_play WHERE match_id >= ${FROM}`,
        `SELECT * FROM auction_top_bid_archive WHERE match_id >= ${FROM}`,
      ]);
  })
  .build();
setTimeout(() => { console.error("timeout"); process.exit(1); }, 90_000);
