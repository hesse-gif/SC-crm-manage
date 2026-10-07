"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LauncherPage() {
  const router = useRouter();
  const destination = process.env.NEXT_PUBLIC_MIXMAX_INDEPENDENT === "1" ? "/mail" : "/chat";

  useEffect(() => {
    router.replace(destination);
  }, [router, destination]);

  return (
    <main className="grid min-h-screen place-items-center bg-surface px-6 text-center">
      <div>
        <p className="text-sm font-semibold text-ink-3">Chat 워크스페이스로 이동 중…</p>
        <Link href={destination} className="mt-3 inline-flex min-h-10 items-center rounded-md border border-line bg-paper px-4 text-sm font-semibold text-accent hover:bg-fill">
          바로 열기
        </Link>
      </div>
    </main>
  );
}
