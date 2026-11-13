"use client";

import { useEffect, useMemo, useState } from "react";
import { createApiClient, fetchHealth } from "~/lib/api-client";
import { useSession } from "~/lib/session";
import type { HealthResponse } from "~/types/api";
import { Console } from "./_components/Console";
import { Banner, selectInput } from "./_components/ui";

export default function Home() {
  const session = useSession();
  const { user, userId } = session;
  const api = useMemo(() => (userId ? createApiClient(userId) : null), [userId]);
  // null while loading, false when the health check itself failed.
  const [health, setHealth] = useState<HealthResponse | false | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then(
      (response) => {
        if (!cancelled) setHealth(response);
      },
      () => {
        if (!cancelled) setHealth(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const isAdmin = user?.role === "admin";

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#1a0b2e] to-[#0f0720]">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="mb-2 text-4xl font-bold text-white">Theater Showtimes Manager</h1>
            <p className="text-gray-400">Upload partner CSV files to manage showtimes</p>
            <p className="mt-3 text-xs text-gray-500" role="status">
              {health === null
                ? "Checking the server..."
                : health === false
                  ? "The server is not responding. Data may not load."
                  : health.llm.configured
                    ? `AI: ${health.llm.model}`
                    : "AI unavailable: rule-based matching only"}
            </p>
          </div>

          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-4">
            <label htmlFor="session-user" className="text-xs uppercase text-gray-500">
              Session
            </label>
            <div className="mt-2 flex flex-col gap-3">
              <select
                id="session-user"
                value={user?.id ?? ""}
                onChange={(e) => session.selectUser(e.target.value)}
                disabled={!session.users}
                className={`w-full ${selectInput}`}
              >
                <option value="" disabled>
                  {session.users ? "Select a user" : "Loading users..."}
                </option>
                {session.users?.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.role})
                  </option>
                ))}
              </select>
              {user ? (
                <div className="text-sm text-gray-400">
                  <div className="flex items-center justify-between">
                    <span>{user.email}</span>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        isAdmin ? "bg-purple-900 text-purple-200" : "bg-gray-700 text-gray-200"
                      }`}
                    >
                      {user.role}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Theaters: {user.theaterIds.length}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-500">No user selected.</div>
              )}
              <button
                type="button"
                onClick={session.signOut}
                disabled={!user}
                className="rounded-lg border border-gray-600 px-3 py-2 text-xs font-semibold text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear selection
              </button>
            </div>
          </div>
        </div>

        {session.error && (
          <div className="mb-6">
            <Banner tone="error">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>The user list could not be loaded. {session.error}</span>
                <button
                  type="button"
                  onClick={session.reload}
                  className="rounded-lg border border-red-700 px-3 py-1 text-xs font-semibold hover:bg-red-900"
                >
                  Try again
                </button>
              </div>
            </Banner>
          </div>
        )}

        {user && api ? (
          <Console
            key={user.id}
            api={api}
            user={user}
            demoReset={health !== null && health !== false && health.demoReset}
            onDemoReset={session.reload}
          />
        ) : (
          !session.error && (
            <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-400">
              {session.users ? "Select a user to see their showtimes." : "Loading..."}
            </div>
          )
        )}
      </div>
    </main>
  );
}
