import { Link } from "react-router-dom";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { useDataset } from "../../lib/dataset.js";

interface Card {
  to: string;
  title: string;
  body: (info: { sessions: number; entities: number; classifierProvider: string | null }) => string;
}

const CARDS: Card[] = [
  {
    to: "/settings/labels",
    title: "Labels",
    body: ({ entities }) => `${entities} entities catalogued. Promote candidates and edit types.`,
  },
  {
    to: "/settings/classifier",
    title: "Classifier",
    body: ({ classifierProvider }) =>
      classifierProvider ? `Active provider: ${classifierProvider}.` : "Classifier provider unknown.",
  },
  {
    to: "/settings/data",
    title: "Data",
    body: ({ sessions }) => `${sessions} sessions in the canonical store. Inspect path and backup posture.`,
  },
  {
    to: "/settings/views",
    title: "Views",
    body: () => "Default landing page, density, sort, density tier.",
  },
];

export function SettingsIndexPage() {
  const { data } = useDataset();
  const info = {
    sessions: data?.meta.sessions_total ?? 0,
    entities: data?.meta.entities_total ?? 0,
    classifierProvider: null,
  };
  return (
    <div className="page-pad">
      <SettingsSubnav />
      <div className="settings-grid">
        {CARDS.map((c) => (
          <Link key={c.to} to={c.to} className="card card-lift settings-card">
            <h3 className="settings-card-title">{c.title}</h3>
            <p className="settings-card-body">{c.body(info)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
