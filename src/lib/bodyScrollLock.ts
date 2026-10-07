// 중첩 모달 안전 body 스크롤 락.
//
// 종전에는 각 모달이 body.style.overflow를 직접 저장/복원했는데, 모달이 두 개
// 겹친 상태에서 먼저 연 모달이 먼저 닫히면 나중 모달이 "hidden"을 이전 값으로
// 복원해 스크롤이 영구히 잠겼다(전역 휠 스크롤 불가 증상). 참조 카운터로
// 마지막 락이 해제될 때만 원래 값을 복원한다.
let lockCount = 0;
let originalOverflow = "";

export function acquireBodyScrollLock(): () => void {
  if (typeof document === "undefined") return () => {};
  if (lockCount === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = originalOverflow;
    }
  };
}
