export interface SimilarCreatorResult {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  platform?: string;
  category: string;
  region: string;
  score: number;
  matchReason: string;
}
