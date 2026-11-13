import type { AssessmentUser, Showtime, Theater } from "~/types/assessment";

/** Demo data from the base assessment, kept with its original ids. */
export const seedTheaters: Theater[] = [
  { id: "theater-downtown", name: "Downtown Cinema 7", location: "Seattle, WA", timezone: "America/Los_Angeles" },
  { id: "theater-riverside", name: "Riverside Multiplex", location: "Portland, OR", timezone: "America/Los_Angeles" },
  { id: "theater-uptown", name: "Uptown Arts Theater", location: "San Francisco, CA", timezone: "America/Los_Angeles" },
];

export const seedUsers: AssessmentUser[] = [
  { id: "user-admin-avery", name: "Avery Admin", email: "avery.admin@example.com", role: "admin", theaterIds: ["theater-downtown", "theater-riverside"] },
  { id: "user-admin-casey", name: "Casey Operator", email: "casey.operator@example.com", role: "admin", theaterIds: ["theater-downtown", "theater-riverside", "theater-uptown"] },
  { id: "user-viewer-riley", name: "Riley Viewer", email: "riley.viewer@example.com", role: "viewer", theaterIds: ["theater-downtown"] },
  { id: "user-viewer-morgan", name: "Morgan Multi", email: "morgan.multi@example.com", role: "viewer", theaterIds: ["theater-downtown", "theater-uptown"] },
  { id: "user-viewer-jordan", name: "Jordan NoTheater", email: "jordan.notheater@example.com", role: "viewer", theaterIds: [] },
];

type Row = [
  id: string,
  theater: "downtown" | "riverside" | "uptown",
  movieTitle: string,
  movieStatus: Showtime["movieStatus"],
  auditorium: string,
  startTime: string,
  endTime: string,
  language: string,
  format: string,
  rating: string,
  lastUpdated: string,
  status: Showtime["status"],
];

const rows: Row[] = [
  ["st-dt-001", "downtown", "Spider-Man: Homecoming", "approved", "Auditorium 1", "2025-03-15T18:00:00Z", "2025-03-15T20:13:00Z", "EN", "2D", "PG-13", "2025-03-10T12:00:00Z", "active"],
  ["st-dt-002", "downtown", "Inside Out 2", "approved", "Auditorium 2", "2025-03-15T17:30:00Z", "2025-03-15T19:20:00Z", "EN", "3D", "PG", "2025-03-10T12:00:00Z", "active"],
  ["st-dt-003", "downtown", "Dune: Part Two", "needs-review", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", "EN", "IMAX", "PG-13", "2025-03-12T15:30:00Z", "active"],
  ["st-dt-004", "downtown", "Dune: Part Two", "approved", "Auditorium 1", "2025-03-15T22:45:00Z", "2025-03-16T01:31:00Z", "EN", "2D", "PG-13", "2025-03-12T15:30:00Z", "active"],
  ["st-dt-005", "downtown", "Wonka", "flagged", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z", "EN", "2D", "PG", "2025-03-01T09:00:00Z", "archived"],
  ["st-dt-006", "downtown", "Oppenheimer", "approved", "Auditorium 4", "2025-03-15T21:00:00Z", "2025-03-16T00:00:00Z", "EN", "IMAX", "R", "2025-03-01T09:00:00Z", "archived"],
  ["st-dt-007", "downtown", "Kung Fu Panda 4", "draft", "Auditorium 3", "2025-03-16T17:30:00Z", "2025-03-16T19:05:00Z", "EN", "2D", "PG", "2025-03-14T11:00:00Z", "active"],
  ["st-rv-001", "riverside", "The Fall Guy", "approved", "Auditorium A", "2025-03-15T19:15:00Z", "2025-03-15T21:21:00Z", "EN", "2D", "PG-13", "2025-03-11T10:20:00Z", "active"],
  ["st-rv-002", "riverside", "Ghostbusters: Frozen Empire", "approved", "Auditorium B", "2025-03-15T18:00:00Z", "2025-03-15T20:05:00Z", "EN", "3D", "PG-13", "2025-03-11T10:20:00Z", "active"],
  ["st-rv-003", "riverside", "Civil War", "needs-review", "Auditorium C", "2025-03-15T20:30:00Z", "2025-03-15T22:25:00Z", "EN", "IMAX", "R", "2025-03-13T09:10:00Z", "active"],
  ["st-rv-004", "riverside", "Past Lives", "approved", "Auditorium D", "2025-03-16T01:00:00Z", "2025-03-16T02:45:00Z", "KO", "2D", "PG-13", "2025-03-13T09:10:00Z", "active"],
  ["st-rv-005", "riverside", "The Holdovers", "draft", "Auditorium E", "2025-03-14T22:30:00Z", "2025-03-15T00:42:00Z", "EN", "2D", "R", "2025-02-25T08:00:00Z", "archived"],
  ["st-up-001", "uptown", "Perfect Days", "approved", "Screen 1", "2025-03-15T17:00:00Z", "2025-03-15T18:55:00Z", "JA", "2D", "PG", "2025-03-09T14:00:00Z", "active"],
  ["st-up-002", "uptown", "Anatomy of a Fall", "approved", "Screen 2", "2025-03-15T19:30:00Z", "2025-03-15T21:50:00Z", "FR", "2D", "R", "2025-03-09T14:00:00Z", "active"],
  ["st-up-003", "uptown", "The Boy and the Heron", "flagged", "Screen 1", "2025-03-15T22:10:00Z", "2025-03-16T00:20:00Z", "JA", "IMAX", "PG-13", "2025-03-09T14:00:00Z", "active"],
];

export const seedShowtimes: Showtime[] = rows.map(
  ([id, theater, movieTitle, movieStatus, auditorium, startTime, endTime, language, format, rating, lastUpdated, status]) => ({
    id,
    theaterId: `theater-${theater}`,
    movieTitle,
    movieStatus,
    auditorium,
    startTime,
    endTime,
    language,
    format,
    rating,
    lastUpdated,
    status,
  }),
);

/**
 * Extra catalog titles so matching is not trivial. Several are confusable with scheduled
 * films on purpose ("Dune" vs "Dune: Part Two", "Inside Out" vs "Inside Out 2").
 */
export const seedCatalogTitles = [
  "Dune",
  "Inside Out",
  "Kung Fu Panda",
  "Kung Fu Panda 3",
  "Spider-Man: Far From Home",
  "Spider-Man: No Way Home",
  "Spider-Man: Across the Spider-Verse",
  "Ghostbusters",
  "Ghostbusters: Afterlife",
  "A Quiet Place Part II",
  "A Quiet Place: Day One",
  "Mad Max: Fury Road",
  "Furiosa: A Mad Max Saga",
  "Godzilla Minus One",
  "Godzilla x Kong: The New Empire",
  "Mission: Impossible – Dead Reckoning Part One",
  "Avatar: The Way of Water",
  "Top Gun: Maverick",
  "The Batman",
  "Barbie",
  "Poor Things",
  "The Zone of Interest",
  "Killers of the Flower Moon",
  "Deadpool & Wolverine",
  "Despicable Me 4",
  "Moana 2",
  "Wicked",
  "Gladiator II",
  "Alien: Romulus",
  "Twisters",
  "The Wild Robot",
  "Beetlejuice Beetlejuice",
  "Joker: Folie à Deux",
  "Amélie",
  "WALL·E",
  "Se7en",
];
