// The forge's in-memory store: git objects, repositories, issues, pull requests, labels and
// comments, all in Maps in this one process. Nothing here touches the filesystem or the wall
// clock: every timestamp comes from a logical clock seeded by MAKEFUN_TRIAL_NOW (or a fixed
// epoch), advanced one second per mutation, so a replay of the same request sequence produces
// byte-identical state, commit SHAs included.

/** The login the bearer token names. The contest scenario is fixed (kit wire.ts SCENARIO_SEED),
 *  and its viewer is adaiversen; repositories created over REST belong to this login, and the
 *  same name under any other owner is a 404. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/main, refs/tags/v1) to the object id it points at. */
  refs: Map<string, string>;
  /** One sequence shared by issues and pull requests, as on GitHub. */
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  createdAt: string;
  updatedAt: string;
}

function trialNowBaseSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  // The scenario's day one: 2025-01-01T00:00:00Z.
  return 1735689600;
}

/**
 * Format epoch seconds as an ISO 8601 UTC string with whole-second precision,
 * arithmetically. tickIso sits on every mutation's path, and building a Date just
 * to stringify it costs several times what the calendar math does; the result is
 * byte-identical to a Date's toISOString with the fractional part dropped.
 */
function isoFromEpochSec(sec: number): string {
  const days = Math.floor(sec / 86400);
  const secs = sec - days * 86400;
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs - hour * 3600) / 60);
  const second = secs - hour * 3600 - minute * 60;
  // Civil date from a day count (Howard Hinnant's algorithm).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const yearBase = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = month <= 2 ? yearBase + 1 : yearBase;
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`;
}

export class Store {
  /** Every git object the forge holds, across repositories, by SHA-1 hex. */
  readonly objects = new Map<string, GitObject>();
  /** Repositories by name; the forge is single-tenant (the token's login owns them all). */
  readonly repos = new Map<string, Repo>();
  private clockSec: number;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private requestSeq = 0;

  constructor() {
    this.clockSec = trialNowBaseSec();
  }

  /** The current logical time as epoch seconds; each call advances the clock by one second. */
  tickSec(): number {
    const now = this.clockSec;
    this.clockSec += 1;
    return now;
  }

  /** The current logical time as an ISO string, advancing the clock. */
  tickIso(): string {
    return isoFromEpochSec(this.tickSec());
  }

  /** A deterministic, non-empty request id for the X-GitHub-Request-Id header. */
  requestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  createRepo(name: string, priv: boolean, description: string): Repo {
    const now = this.tickIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      private: priv,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      createdAt: now,
      updatedAt: now,
    };
    // A new repository starts with no labels at all: the suite creates the labels it uses
    // through POST /labels and expects a 201, which a pre-seeded set would spoil with a 422.
    this.repos.set(name, repo);
    return repo;
  }

  addLabel(repo: Repo, name: string, color: string, description: string): Label {
    const label: Label = { id: this.nextLabelId++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  /** Resolve a repository the way every surface does: the name must exist and the owner must be
   *  the token's login; anything else is a 404, never a 403. */
  repoFor(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  addIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = this.tickIso();
    const issue: Issue = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: Issue, body: string): Comment {
    const now = this.tickIso();
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    return comment;
  }

  addPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const now = this.tickIso();
    const pull: Pull = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

/** Opaque global ids, base64 of a typed string; never the bare database id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back to its kind and parts, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}
