"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function MixmaxRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/mail"); }, [router]);
  return <main className="grid min-h-screen place-items-center"><Link href="/mail">Handle 열기</Link></main>;
}
