export {
  category as categorySchema,
  type CategoryRow,
  type CategoryInsert,
} from './category';
export { novel as novelSchema, type NovelRow, type NovelInsert } from './novel';
export {
  chapter as chapterSchema,
  type ChapterRow,
  type ChapterInsert,
} from './chapter';
export {
  novelCategory as novelCategorySchema,
  type NovelCategoryRow,
  type NovelCategoryInsert,
} from './novelCategory';
export {
  repository as repositorySchema,
  type RepositoryRow,
  type RepositoryInsert,
} from './repository';
export {
  ttsDownload as ttsDownloadSchema,
  type TTSDownloadRow,
  type TTSDownloadInsert,
} from './ttsDownload';

import { category } from './category';
import { novel } from './novel';
import { chapter } from './chapter';
import { novelCategory } from './novelCategory';
import { repository } from './repository';
import { ttsDownload } from './ttsDownload';

/**
 * Unified schema object containing all database tables
 * Use this with Drizzle ORM for type-safe database operations
 */
export const schema = {
  category,
  novel,
  chapter,
  novelCategory,
  repository,
  ttsDownload,
} as const;

export type Schema = typeof schema;
