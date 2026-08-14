import { describe, expect, it } from "vitest";
import {
  combineRankScore,
  extractSearchTerms,
  scoreChunkContent,
  scoreFilename,
} from "@/lib/knowledge/retrieval";

const DOCUMENT = {
  filename: "Финансовая грамотность.pdf",
  content: "... Урок 3. Волшебная Копилка ...",
};

describe("knowledge retrieval ranking", () => {
  it("extracts meaningful terms from natural language queries", () => {
    const terms = extractSearchTerms("Что ты можешь рассказать про Урок 3 Волшебная Копилка?");
    expect(terms).toContain("урок");
    expect(terms).toContain("волшебная");
    expect(terms).toContain("копилка");
  });

  it('finds chunk content for "Волшебная Копилка"', () => {
    const terms = extractSearchTerms("Волшебная Копилка");
    const score = scoreChunkContent(DOCUMENT.content, "Волшебная Копилка", terms);
    expect(score).toBeGreaterThan(0);
  });

  it('finds chunk content for "расскажи про урок 3"', () => {
    const query = "расскажи про урок 3";
    const terms = extractSearchTerms(query);
    const score = scoreChunkContent(DOCUMENT.content, query, terms);
    expect(score).toBeGreaterThan(0);
  });

  it('finds document by filename for "документ Финансовая грамотность"', () => {
    const query = "документ Финансовая грамотность";
    const terms = extractSearchTerms(query);
    const score = scoreFilename(DOCUMENT.filename, query, terms);
    expect(score).toBeGreaterThan(0);
  });

  it("combines filename, FTS and content scores", () => {
    const query = "Финансовая грамотность";
    const terms = extractSearchTerms(query);
    const total = combineRankScore({
      ftsRank: 0.2,
      filenameScore: scoreFilename(DOCUMENT.filename, query, terms),
      contentScore: scoreChunkContent(DOCUMENT.content, query, terms),
    });
    expect(total).toBeGreaterThan(0.3);
  });
});
