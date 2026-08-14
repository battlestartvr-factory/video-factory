export { chunkText, normalizeExtractedText, htmlToText, isExtractableMime } from "./extraction";
export {
  getOrCreateKnowledgeBase,
  listKnowledgeDocuments,
  addKnowledgeDocument,
  searchKnowledge,
  getKnowledgeDocument,
  deleteKnowledgeDocument,
} from "./knowledge-service";
export type { KnowledgeHit, KnowledgeScope } from "./knowledge-service";
