import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Bot, BotStats } from "../module_bindings/types";
import { botNames, type BotNames } from "../data";
import {
  isProvisional,
  PROVISIONAL_ABOVE,
  skill,
  spread,
  standings,
} from "../rating";
import { PageHeader, Panel } from "../ui";

const MEDALS = ["gold", "silver", "bronze"];
const MEDAL_COLOURS = ["#fbdc8e", "#ced3e0", "#e0a272"];

export default function Leaderboard() {
  const { conn } = useConn();
  const bots = conn ? [...conn.db.bot.iter()] : [];
  const stats = conn ? [...conn.db.botStats.iter()] : [];
  const { ranked, provisional, rankOf } = standings(stats);
  const botName = botNames(conn);

  const tiedAt = (rank: number) => ranked.filter((s) => rankOf(s) === rank);

  const rated = new Set(stats.map((s) => s.botId));
  const unrated = bots.filter((b) => !rated.has(b.id));

  return (
    <>
      <PageHeader
        title="Leaderboard"
        status={`${bots.length} registered bots`}
      />
      <Podium tiedAt={tiedAt} botName={botName} />
      <RatingsTable
        ranked={ranked}
        provisional={provisional}
        unrated={unrated}
        rankOf={rankOf}
        tiedAt={tiedAt}
        botName={botName}
      />
    </>
  );
}

function Podium({
  tiedAt,
  botName,
}: {
  tiedAt: (rank: number) => BotStats[];
  botName: BotNames;
}) {
  // One step per medal rank that someone actually holds. A tie for first
  // leaves no silver, so that step is simply absent.
  const steps = [1, 2, 3]
    .map((rank) => ({ rank, holders: tiedAt(rank) }))
    .filter((step) => step.holders.length > 0);
  if (steps.length === 0) return null;

  return (
    <section className="podium full" aria-label="Top three">
      {steps.map(({ rank, holders }) => {
        const solo = holders.length === 1 ? holders[0] : null;
        const names = holders.map((h) => botName(h.botId));
        return (
          <div key={rank} className={`step ${MEDALS[rank - 1]}`}>
            <div className="step-who">
              <div className="step-name" title={names.join(", ")}>
                {holders.length <= 2
                  ? names.join(" & ")
                  : `${holders.length} bots tied`}
              </div>
              <div className="step-meta">
                {solo
                  ? `${solo.wins} wins · ${solo.matchesPlayed} played`
                  : "tied on rating"}
              </div>
            </div>
            <div className="step-block">
              <div className="step-rank">{rank}</div>
              <div className="step-rating">
                {skill(holders[0])}
                <span>rating</span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="podium-floor" />
    </section>
  );
}

function RatingsTable({
  ranked,
  provisional,
  unrated,
  rankOf,
  tiedAt,
  botName,
}: {
  ranked: BotStats[];
  provisional: BotStats[];
  unrated: Bot[];
  rankOf: (s: BotStats) => number;
  tiedAt: (rank: number) => BotStats[];
  botName: BotNames;
}) {
  return (
    <Panel full className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            <th className="num">Rating</th>
            <th className="num lb-opt">Played</th>
            <th className="num lb-opt">Wins</th>
            <th className="num">Win rate</th>
            <th className="num">Avg score</th>
          </tr>
        </thead>
        <tbody>
          {[...ranked, ...provisional].map((s) => {
            const rank = isProvisional(s) ? null : rankOf(s);
            const tied = rank !== null && tiedAt(rank).length > 1;
            return (
              <tr
                key={String(s.botId)}
                className={rank === null ? "secondary" : undefined}
              >
                <td className="lb-rank">
                  {rank === null ? "—" : `${tied ? "=" : ""}${rank}`}
                  {rank !== null && rank <= 3 && (
                    <span
                      className="rank-dot"
                      style={{ background: MEDAL_COLOURS[rank - 1] }}
                      title={MEDALS[rank - 1]}
                    />
                  )}
                </td>
                <td className="lb-name">
                  <Link to={`/bots/${s.botId}`}>{botName(s.botId)}</Link>
                </td>
                <td
                  className="num lb-rating"
                  title={`${rank === null ? `Provisional until the ± is within ${PROVISIONAL_ABOVE} · ` : ""}OpenSkill μ ${s.openskillMu.toFixed(2)}, σ ${s.openskillSigma.toFixed(2)} · Elo ${s.rating}`}
                >
                  {skill(s)}
                  <span className="lb-pm">±{spread(s)}</span>
                </td>
                <td className="num lb-opt">{s.matchesPlayed}</td>
                <td className="num lb-opt">{s.wins}</td>
                <td className="num">
                  {s.matchesPlayed > 0
                    ? `${((s.wins / s.matchesPlayed) * 100).toFixed(0)}%`
                    : "—"}
                </td>
                <td className="num">
                  {s.matchesPlayed > 0
                    ? (Number(s.totalScore) / s.matchesPlayed).toFixed(1)
                    : "—"}
                </td>
              </tr>
            );
          })}
          {unrated.map((b) => (
            <tr key={String(b.id)} className="secondary">
              <td className="lb-rank">—</td>
              <td className="lb-name">{b.name}</td>
              <td className="num">unrated</td>
              <td className="num lb-opt">0</td>
              <td className="num lb-opt">—</td>
              <td className="num">—</td>
              <td className="num">—</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ranked.length + provisional.length + unrated.length === 0 && (
        <div className="empty">
          No bots registered yet. <Link to="/team/new">Create a team →</Link>
        </div>
      )}
    </Panel>
  );
}
