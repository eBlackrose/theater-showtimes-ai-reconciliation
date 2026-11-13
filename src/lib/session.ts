"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage, fetchUsers } from "~/lib/api-client";
import type { AssessmentUser } from "~/types/assessment";

const STORAGE_KEY = "scope-assessment-user-id";

/**
 * The stand-in for a login: the chosen user is remembered in localStorage and sent as
 * `X-User-Id`. Without a stored choice the first user is selected, as the base app did.
 */
export function useSession() {
  const [users, setUsers] = useState<AssessmentUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchUsers().then(
      (list) => {
        if (cancelled) return;
        setUsers(list);
        setError(null);
        const stored = window.localStorage.getItem(STORAGE_KEY);
        const fallback = list.some((u) => u.id === stored) ? stored : (list[0]?.id ?? null);
        setUserId((current) => current ?? fallback);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const selectUser = useCallback((id: string) => {
    window.localStorage.setItem(STORAGE_KEY, id);
    setUserId(id);
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUserId(null);
  }, []);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    users,
    error,
    userId,
    user: users?.find((candidate) => candidate.id === userId) ?? null,
    selectUser,
    signOut,
    reload,
  };
}
