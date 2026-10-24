import { Link, useParams } from "react-router-dom";
import { useConn } from "../connection";
import {
  isProvisional,
  PROVISIONAL_ABOVE,
  skill,
  spread,
  standings,
} from "../rating";
import { RatingChart, type RatingPoint } from "../RatingChart";
import { PageHeader, Panel } from "../ui";
import { fmtTimestamp, plural, signed } from "../util";

export default function BotView() {
  const { conn } = useConn();
  const { id } = useParams<{ id: string }>();
  const botId = id && /^\d+$/.test(id) ? BigInt(id) : null;
  if (!conn) return <PageHeader title="Bot…" />;
  const bot = botId === null ? undefined : conn.db.bot.id.find(botId);
  if (!bot) return <PageHeader title="Bot not found" />;

  const stats = conn.db.botStats.botId.find(bot.id);
  const { ranked, rankOf } = standings([...conn.db.botStats.iter()]);
  const history = [...conn.db.ratingHistory.iter()]
    .filter((h) => h.botId === bot.id)
    .sort((a, b) => fmtTimestamp(a.at) - fmtTimestamp(b.at));
  const points: RatingPoint[] = history.map((h) => ({
    at: fmtTimestamp(h.at),
    rating: skill(h),
    spread: spread(h),
    matchId: h.matchId,
  }));

  const standing = !stats
    ? "Unrated"
    : isProvisional(stats)
      ? `Provisional until the ± is within ${PROVISIONAL_ABOVE}`
      : `#${rankOf(stats)} of ${ranked.length}`;

  return (
    <>
      <PageHeader
        title={bot.name}
        subtitle={
          stats
            ? `${skill(stats)} ±${spread(stats)} · ${standing} · ${stats.wins} ${plural(stats.wins, "win", "wins")} in ${stats.matchesPlayed} ${plural(stats.matchesPlayed, "match", "matches")}`
            : standing
        }
        status={<Link to="/leaderboard">← Leaderboard</Link>}
      />
      <Panel full title="Rating over time">
        {points.length > 0 ? (
          <>
            <p className="secondary chart-caption">
              The rating after each match, with its ± as a band.
            </p>
            <RatingChart points={points} />
            <MatchTable points={points} />
          </>
        ) : (
          <div className="empty">No rated matches recorded yet.</div>
        )}
      </Panel>
    </>
  );
}

// The chart's numbers as a table, newest first, folded away by default.
function MatchTable({ points }: { points: RatingPoint[] }) {
  const rows = points.map((p, i) => ({
    ...p,
    change: i > 0 ? p.rating - points[i - 1].rating : null,
  }));
  rows.reverse();
  return (
    <details className="chart-table">
      <summary>Every rated match ({points.length})</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Match</th>
              <th className="num">Rating</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.matchId)}>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>
                  <Link to={`/matches/${r.matchId}`}>#{String(r.matchId)}</Link>
                </td>
                <td className="num">
                  {r.rating}
                  <span className="lb-pm">±{r.spread}</span>
                </td>
                <td className="num">
                  {r.change === null ? "—" : signed(r.change)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
