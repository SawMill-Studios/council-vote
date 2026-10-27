export const COLUMNS = ["pm", "designer", "channel", "testing", "harvest"] as const;
export type Column = (typeof COLUMNS)[number];
export type Beat = 1 | 2 | 3 | 4;
export type DotGroup = "skill" | "hunt";

export interface Point {
  x: number;
  y: number;
}

export interface Sticky {
  id: string;
  clientId: string;
  participantId: string;
  column: Column;
  text: string;
  author: string;
  showName: boolean;
  late: boolean;
  hidden: boolean;
  stackOf: string | null;
  label: string;
  noAuto: boolean;
  createdAt: string;
  updatedAt: string;
  owner: string;
  cadence: string;
  tools: string;
  ai: string;
  today: Point | null;
  year: Point | null;
  demo?: boolean;
  /** Server-only. Never copied onto the public state payload. */
  ip?: string;
}

export interface Dot {
  id: string;
  clientId: string;
  stickyId: string;
  group: DotGroup;
  createdAt: string;
}

export interface VoteDoc {
  participantId: string;
  dots: Dot[];
}

export interface Meta {
  beat: Beat;
  voteOpen: boolean;
  revealed: boolean;
  arrowsOn: boolean;
  locked: boolean;
  postingOpen: boolean;
  updatedAt: string;
}

export interface Presence {
  at: number;
}

export interface RateDoc {
  windowStartedAt: number;
  count: number;
}
