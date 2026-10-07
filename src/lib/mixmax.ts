"use client";
import { useEffect, useState } from "react";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, onSnapshot, query, where, orderBy, limit, type QueryConstraint } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "./firebase";

export type MixmaxRow = { id: string; [key: string]: unknown };
export interface MixmaxMember { uid: string; email: string; workspaceId: string; role: string }
export const value = (row: MixmaxRow | null | undefined, key: string) => typeof row?.[key] === "string" ? row[key] as string : "";
export async function command<T = Record<string, unknown>>(name: string, data: Record<string, unknown> = {}): Promise<T> { return (await httpsCallable<Record<string, unknown>, T>(functions, name)(data)).data; }
export async function login() { const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: "select_account" }); await signInWithPopup(auth, provider); }
export const logout = () => signOut(auth);
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : "요청을 처리하지 못했습니다."; }
export function useMixmaxSession() {
  const [state, setState] = useState<{ user: User | null; member: MixmaxMember | null; loading: boolean; error: string }>({ user: null, member: null, loading: true, error: "" });
  useEffect(() => {
    let generation = 0;
    const unsubscribe = onAuthStateChanged(auth, async user => {
      const current = ++generation;
      setState({ user, member: null, loading: Boolean(user), error: "" });
      if (!user) return;
      try { const result = await command<{ member: MixmaxMember }>("mixmaxBootstrap"); if (current === generation) setState({ user, member: result.member, loading: false, error: "" }); }
      catch (error) { if (current === generation) setState({ user, member: null, loading: false, error: errorMessage(error) }); }
    });
    return () => { generation++; unsubscribe(); };
  }, []);
  return state;
}
export function useMixmaxRows(member: MixmaxMember | null, name: string, options: { threadId?: string; sort?: string; count?: number; owner?: boolean; enabled?: boolean } = {}) {
  const { threadId, sort, count = 200, owner = false, enabled = true } = options;
  const [result, setResult] = useState<{ rows: MixmaxRow[]; loading: boolean; error: string }>({ rows: [], loading: true, error: "" });
  const scope = `${member?.uid ?? ""}:${member?.workspaceId ?? ""}:${name}:${threadId ?? ""}:${sort ?? ""}:${count}:${owner}:${enabled}`;
  const [loadedScope, setLoadedScope] = useState("");
  useEffect(() => {
    setResult({ rows: [], loading: Boolean(member && enabled), error: "" }); setLoadedScope(scope);
    if (!member || !enabled) return;
    const constraints: QueryConstraint[] = [where("workspaceId", "==", member.workspaceId)];
    if (threadId) constraints.push(where("threadId", "==", threadId));
    if (owner) constraints.push(["mixmax_drafts", "mixmax_sends"].includes(name) ? where("ownerUid", "in", [member.uid, ""]) : where("ownerUid", "==", member.uid));
    if (sort) constraints.push(orderBy(sort, "desc"));
    constraints.push(limit(count));
    return onSnapshot(query(collection(db, name), ...constraints), snapshot => {
      setResult({ rows: snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })), loading: false, error: "" });
    }, error => setResult({ rows: [], loading: false, error: errorMessage(error) }));
  }, [scope, member?.uid, member?.workspaceId, name, threadId, sort, count, owner, enabled]);
  return loadedScope === scope ? result : { rows: [], loading: Boolean(member && enabled), error: "" };
}
