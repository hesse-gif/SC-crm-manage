export type ReviewQueueSurfaceState = {
  loading: boolean;
  error: string;
  settled: boolean;
  showItems: boolean;
  showEmpty: boolean;
};

export type ReviewQueueSurfaceInput = {
  authReady: boolean;
  canRead: boolean;
  loaded: boolean;
  error?: string;
  targetLoading?: boolean;
  itemCount: number;
};

const READ_PERMISSION_ERROR = "이 목록을 읽을 권한이 없습니다.";

export function reviewQueueSurfaceState(input: ReviewQueueSurfaceInput): ReviewQueueSurfaceState {
  const error = input.error?.trim() || (input.authReady && !input.canRead ? READ_PERMISSION_ERROR : "");
  const loading = !error && (
    !input.authReady
    || (input.canRead && !input.loaded)
    || Boolean(input.targetLoading)
  );
  const settled = input.authReady
    && input.canRead
    && input.loaded
    && !input.targetLoading
    && !error;
  const showItems = input.itemCount > 0;

  return {
    loading,
    error,
    settled,
    showItems,
    showEmpty: settled && !showItems,
  };
}
