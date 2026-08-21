import { describe, expect, it } from "vitest";
import {
  hasClearResearchSourceTitleMismatch,
  sourceCoverageCategories,
  type SourceCoverageCategory,
} from "@/lib/research-intelligence/shared-source-pool";

type ProductionSourceShape = {
  name: string;
  searchTitle: string;
  fetchedTitle: string;
  domain: string;
  url: string;
  text: string;
  fetchStatus: "ok" | "not_found";
};

const productionShapes: ProductionSourceShape[] = [
  {
    name: "Steam Party Animals direct store page",
    searchTitle: "https://store.steampowered.com/app/1260320/Party_Animals/",
    fetchedTitle: "Party Animals on Steam",
    domain: "store.steampowered.com",
    url: "https://store.steampowered.com/app/1260320/Party_Animals/",
    text: "Party Animals is a multiplayer physics party game with co-op and competitive interactions.",
    fetchStatus: "ok",
  },
  {
    name: "YouTube gameplay source with host-only fetched title",
    searchTitle: "A Superb, Speedy Racer",
    fetchedTitle: "www.youtube.com",
    domain: "www.youtube.com",
    url: "https://www.youtube.com/watch?v=LZhccM6NLNQ",
    text: "Real gameplay footage showing player movement and match flow.",
    fetchStatus: "ok",
  },
  {
    name: "PC Gamer Gang Beasts editorial review",
    searchTitle: "Gang Beasts review",
    fetchedTitle: "Gang Beasts review | PC Gamer",
    domain: "www.pcgamer.com",
    url: "https://www.pcgamer.com/gang-beasts-review/",
    text: "The review discusses physics, movement, controls, chaotic multiplayer interactions and player-facing strengths and weaknesses.",
    fetchStatus: "ok",
  },
  {
    name: "YouTube Knockout City review with host-only fetched title",
    searchTitle: "Knockout City Review",
    fetchedTitle: "www.youtube.com",
    domain: "www.youtube.com",
    url: "https://www.youtube.com/watch?v=Lp9YNM5_bzI",
    text: "Gameplay review footage demonstrates camera readability, movement and team interactions.",
    fetchStatus: "ok",
  },
  {
    name: "YouTube Party Animals review with host-only fetched title",
    searchTitle: "Party Animals Review",
    fetchedTitle: "www.youtube.com",
    domain: "www.youtube.com",
    url: "https://www.youtube.com/watch?v=cCDGRIfdHFk",
    text: "Gameplay review footage demonstrates physics interactions and readable player action.",
    fetchStatus: "ok",
  },
  {
    name: "Rock Paper Shotgun retired article",
    searchTitle: "Gang Beasts Is A Physics-Driven Jelly Baby Brawler",
    fetchedTitle: "",
    domain: "www.rockpapershotgun.com",
    url: "https://www.rockpapershotgun.com/gang-beasts-alpha-release",
    text: "",
    fetchStatus: "not_found",
  },
  {
    name: "Steam Community Party Animals discussion redirect",
    searchTitle: "Party Animals Forum Physics Thread",
    fetchedTitle: "Party Animals General Discussions :: Steam Community",
    domain: "steamcommunity.com",
    url: "https://steamcommunity.com/app/1260320/discussions/0/",
    text: "Players discuss Party Animals physics, controls, frustration, fun and multiplayer interactions.",
    fetchStatus: "ok",
  },
];

describe("2026-08-21 production source identity regression", () => {
  it("replays all seven observed source shapes without false identity rejection", () => {
    const accepted: ProductionSourceShape[] = [];
    const rejected: ProductionSourceShape[] = [];

    for (const shape of productionShapes) {
      if (shape.fetchStatus !== "ok") {
        rejected.push(shape);
        continue;
      }

      const mismatch = hasClearResearchSourceTitleMismatch(shape.searchTitle, shape.fetchedTitle);
      expect(mismatch, shape.name).toBe(false);
      accepted.push(shape);
    }

    expect(accepted).toHaveLength(6);
    expect(rejected.map((shape) => shape.name)).toEqual([
      "Rock Paper Shotgun retired article",
    ]);
  });

  it("preserves the required verified coverage from the six fetchable production shapes", () => {
    const coverage = new Set<SourceCoverageCategory>();

    for (const shape of productionShapes) {
      if (shape.fetchStatus !== "ok") continue;
      if (hasClearResearchSourceTitleMismatch(shape.searchTitle, shape.fetchedTitle)) continue;
      for (const category of sourceCoverageCategories({
        title: shape.fetchedTitle || shape.searchTitle,
        domain: shape.domain,
        url: shape.url,
        text: shape.text,
      })) {
        coverage.add(category);
      }
    }

    expect([...coverage]).toEqual(expect.arrayContaining([
      "competitor",
      "mechanics",
      "player_voice",
      "gameplay_visual",
    ]));
  });

  it("still rejects a real cross-game title mismatch", () => {
    expect(
      hasClearResearchSourceTitleMismatch(
        "Gang Beasts review",
        "Totally Accurate Battle Simulator on Steam",
      ),
    ).toBe(true);
  });
});
