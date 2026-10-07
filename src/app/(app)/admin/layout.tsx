import type { ReactNode } from "react";
import { AdminGate } from "@/components/shell/AdminGate";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminGate>{children}</AdminGate>;
}
