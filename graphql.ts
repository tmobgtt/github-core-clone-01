// A small GraphQL engine for the forge: a tokenizer and parser for the documents gh and
// github-mcp-server actually send (named operations, variables, aliases, inline and named
// fragments, input objects, enum and list literals, @include/@skip), and an executor over a
// hand-written schema whose types resolve against the same store the REST surface uses.
// Unknown fields answer the GitHub way: HTTP 200, the field null, and an errors entry naming
// the field. Unknown repositories are data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, globalId, parseGlobalId, type Issue, type Pull, type Repo } from './store.ts';
import { flattenTree, getObject, mergeBase, mergeFlats, parseCommit, peelToCommit } from './git.ts';
import { mergePull, pullAsIssue, pullFiles } from './rest.ts';
import { isRecord, readBody, sendJson } from './http.ts';

// ------------------------------------------------------------------ syntax

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  directives: Map<string, Map<string, Value>>;
  selectionSet: Selection[] | null;
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, Value>;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: Selection[] }>;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: match[1] !== undefined || match[2] !== undefined ? 'float' : 'int', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Array<{ kind: string; value: string }>;
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.at] as { kind: string; value: string };
  }

  private next(): { kind: string; value: string } {
    return this.tokens[this.at++] as { kind: string; value: string };
  }

  private expect(kind: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, found ${token.kind} ${token.value}`);
    return token;
  }

  private skip(kind: string): boolean {
    if (this.peek().kind === kind) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        const name = this.peek().kind === 'name' ? this.next().value : null;
        const variableDefaults = new Map<string, Value>();
        if (this.skip('(')) {
          while (this.peek().kind !== ')') {
            this.expect('$');
            const varName = this.expect('name').value;
            this.expect(':');
            this.parseType();
            if (this.skip('=')) variableDefaults.set(varName, this.parseValue());
            this.parseDirectives();
          }
          this.expect(')');
        }
        this.parseDirectives();
        operations.push({ type, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private parseDirectives(): Map<string, Map<string, Value>> {
    const directives = new Map<string, Map<string, Value>>();
    while (this.skip('@')) {
      const name = this.expect('name').value;
      directives.set(name, this.peek().kind === '(' ? this.parseArguments() : new Map());
    }
    return directives;
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case '$':
        return { kind: 'variable', name: this.expect('name').value };
      case 'int':
        return { kind: 'int', value: parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case '[': {
        const values: Value[] = [];
        while (this.peek().kind !== ']') values.push(this.parseValue());
        this.expect(']');
        return { kind: 'list', values };
      }
      case '{': {
        const fields = new Map<string, Value>();
        while (this.peek().kind !== '}') {
          const name = this.expect('name').value;
          this.expect(':');
          fields.set(name, this.parseValue());
        }
        this.expect('}');
        return { kind: 'object', fields };
      }
      default:
        throw new Error(`unexpected value token ${token.kind}`);
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === '@' || this.peek().kind === '{') {
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expect('name').value;
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.expect('name').value;
      let alias: string | null = null;
      let name = first;
      if (this.skip(':')) {
        alias = first;
        name = this.expect('name').value;
      }
      const args = this.peek().kind === '(' ? this.parseArguments() : new Map<string, Value>();
      const directives = this.parseDirectives();
      const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, directives, selectionSet } });
    }
    this.expect('}');
    return selections;
  }
}

/** Turn an AST value into a plain JS value, substituting variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ execution

interface GqlObj {
  gqlType: string;
  data: Record<string, unknown>;
}

function obj(gqlType: string, data: Record<string, unknown>): GqlObj {
  return { gqlType, data };
}

function isObj(value: unknown): value is GqlObj {
  return isRecord(value) && typeof (value as GqlObj).gqlType === 'string';
}

interface Ctx {
  store: Store;
  fragments: Document['fragments'];
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: Ctx, data: Record<string, unknown>, args: Record<string, unknown>) => unknown;

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Slice a full item list by first/after (or last/before) into a connection object. */
function connection(type: string, items: unknown[], args: Record<string, unknown>): GqlObj {
  let start = 0;
  const afterIndex = indexOfCursor(args.after);
  if (afterIndex >= 0) start = afterIndex + 1;
  let end = items.length;
  const beforeIndex = indexOfCursor(args.before);
  if (beforeIndex >= 0) end = Math.min(end, beforeIndex);
  let page = items.slice(start, end);
  let pageStart = start;
  if (typeof args.first === 'number') {
    page = page.slice(0, Math.max(0, args.first));
  } else if (typeof args.last === 'number') {
    const keep = Math.max(0, args.last);
    pageStart = start + Math.max(0, page.length - keep);
    page = page.slice(page.length - keep);
  }
  const pageInfo = {
    hasNextPage: pageStart + page.length < items.length,
    hasPreviousPage: pageStart > 0,
    startCursor: page.length > 0 ? cursorOf(pageStart) : null,
    endCursor: page.length > 0 ? cursorOf(pageStart + page.length - 1) : null,
  };
  return obj(type, {
    nodesRaw: page,
    edgesRaw: page.map((node, i) => obj('Edge', { node, cursor: cursorOf(pageStart + i) })),
    pageInfo: obj('PageInfo', pageInfo),
    totalCount: items.length,
  });
}

const CONNECTION_FIELDS: Record<string, Resolver> = {
  nodes: (_ctx, data) => data.nodesRaw,
  edges: (_ctx, data) => data.edgesRaw,
  pageInfo: (_ctx, data) => data.pageInfo,
  totalCount: (_ctx, data) => data.totalCount,
};

const PAGE_INFO_FIELDS: Record<string, Resolver> = {
  hasNextPage: (_ctx, data) => data.hasNextPage,
  hasPreviousPage: (_ctx, data) => data.hasPreviousPage,
  startCursor: (_ctx, data) => data.startCursor,
  endCursor: (_ctx, data) => data.endCursor,
};

// ------------------------------------------------------------------ domain resolvers

function userObj(): GqlObj {
  return obj('User', {});
}

const USER_FIELDS: Record<string, Resolver> = {
  login: () => VIEWER.login,
  id: () => globalId('User', VIEWER.id),
  databaseId: () => VIEWER.id,
  name: () => VIEWER.name,
  email: () => VIEWER.email,
  url: () => '',
  avatarUrl: () => '',
  isViewer: () => true,
};

function repoObj(repo: Repo): GqlObj {
  return obj('Repository', { repo });
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return obj('PullRequest', { repo, pull });
}

function commentObj(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): GqlObj {
  return obj('IssueComment', { repo, issue, comment });
}

const REPOSITORY_FIELDS: Record<string, Resolver> = {
  id: (_ctx, data) => globalId('Repository', (data.repo as Repo).id),
  databaseId: (_ctx, data) => (data.repo as Repo).id,
  name: (_ctx, data) => (data.repo as Repo).name,
  nameWithOwner: (_ctx, data) => `${VIEWER.login}/${(data.repo as Repo).name}`,
  owner: () => userObj(),
  description: (_ctx, data) => (data.repo as Repo).description,
  isPrivate: (_ctx, data) => (data.repo as Repo).private,
  visibility: (_ctx, data) => ((data.repo as Repo).private ? 'PRIVATE' : 'PUBLIC'),
  isFork: () => false,
  isArchived: () => false,
  url: () => '',
  createdAt: (_ctx, data) => (data.repo as Repo).createdAt,
  updatedAt: (_ctx, data) => (data.repo as Repo).updatedAt,
  pushedAt: (_ctx, data) => (data.repo as Repo).updatedAt,
  stargazerCount: () => 0,
  forkCount: () => 0,
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  hasPullRequestsEnabled: () => true,
  defaultBranchRef: (ctx, data) => {
    const repo = data.repo as Repo;
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return null;
    return obj('Ref', { name: repo.defaultBranch, oid: tip });
  },
  issue: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
    return issue === undefined ? null : issueObj(repo, issue);
  },
  issues: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    let issues = [...repo.issues.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    if (states !== null) {
      issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
    const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
    issues.sort((a, b) => (a.number - b.number) * (direction === 'DESC' ? -1 : 1));
    return connection('IssueConnection', issues.map((issue) => issueObj(repo, issue)), args);
  },
  pullRequest: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
    return pull === undefined ? null : pullObj(repo, pull);
  },
  pullRequests: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    let pulls = [...repo.pulls.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    if (states !== null) {
      pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
    }
    pulls.sort((a, b) => a.number - b.number);
    return connection('PullRequestConnection', pulls.map((pull) => pullObj(repo, pull)), args);
  },
  labels: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    const labels = [...repo.labels.values()].map((label) =>
      obj('Label', { id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description }),
    );
    return connection('LabelConnection', labels, args);
  },
};

const REF_FIELDS: Record<string, Resolver> = {
  name: (_ctx, data) => data.name,
  prefix: () => 'refs/heads/',
  target: (_ctx, data) => obj('Commit', { sha: data.oid }),
};

const COMMIT_FIELDS: Record<string, Resolver> = {
  oid: (_ctx, data) => data.sha,
  message: (ctx, data) => {
    const object = getObject(ctx.store, data.sha as string);
    return object === null ? '' : parseCommit(object.data).message;
  },
  messageHeadline: (ctx, data) => {
    const object = getObject(ctx.store, data.sha as string);
    return object === null ? '' : parseCommit(object.data).message.split('\n')[0];
  },
  tree: (ctx, data) => {
    const object = getObject(ctx.store, data.sha as string);
    if (object === null) return null;
    return obj('Tree', { oid: parseCommit(object.data).tree });
  },
  committedDate: (ctx, data) => {
    const object = getObject(ctx.store, data.sha as string);
    if (object === null) return '2025-01-01T00:00:00Z';
    const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(object.data).committer);
    return match === null ? '2025-01-01T00:00:00Z' : new Date(Number(match[1]) * 1000).toISOString().replace('.000Z', 'Z');
  },
};

const ISSUE_FIELDS: Record<string, Resolver> = {
  id: (_ctx, data) => globalId('Issue', (data.repo as Repo).id, (data.issue as Issue).number),
  databaseId: (_ctx, data) => (data.issue as Issue).id,
  number: (_ctx, data) => (data.issue as Issue).number,
  title: (_ctx, data) => (data.issue as Issue).title,
  body: (_ctx, data) => (data.issue as Issue).body,
  bodyText: (_ctx, data) => (data.issue as Issue).body,
  state: (_ctx, data) => ((data.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  closed: (_ctx, data) => (data.issue as Issue).state === 'closed',
  closedAt: (_ctx, data) => ((data.issue as Issue).state === 'closed' ? (data.issue as Issue).updatedAt : null),
  author: () => userObj(),
  repository: (_ctx, data) => repoObj(data.repo as Repo),
  url: () => '',
  createdAt: (_ctx, data) => (data.issue as Issue).createdAt,
  updatedAt: (_ctx, data) => (data.issue as Issue).updatedAt,
  labels: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    const issue = data.issue as Issue;
    const labels = issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => obj('Label', { id: globalId('Label', (label as { id: number }).id), name: (label as { name: string }).name, color: (label as { color: string }).color, description: (label as { description: string }).description }));
    return connection('LabelConnection', labels, args);
  },
  comments: (_ctx, data, args) => {
    const repo = data.repo as Repo;
    const issue = data.issue as Issue;
    return connection('IssueCommentConnection', issue.comments.map((comment) => commentObj(repo, issue, comment)), args);
  },
};

const COMMENT_FIELDS: Record<string, Resolver> = {
  id: (_ctx, data) => globalId('IssueComment', (data.repo as Repo).id, (data.issue as Issue).number, (data.comment as { id: number }).id),
  databaseId: (_ctx, data) => (data.comment as { id: number }).id,
  body: (_ctx, data) => (data.comment as { body: string }).body,
  bodyText: (_ctx, data) => (data.comment as { body: string }).body,
  author: () => userObj(),
  createdAt: (_ctx, data) => (data.comment as { createdAt: string }).createdAt,
  updatedAt: (_ctx, data) => (data.comment as { updatedAt: string }).updatedAt,
  url: () => '',
};

const LABEL_FIELDS: Record<string, Resolver> = {
  id: (_ctx, data) => data.id,
  name: (_ctx, data) => data.name,
  color: (_ctx, data) => data.color,
  description: (_ctx, data) => data.description,
};

/** The real mergeability: run the same three-way tree merge the merge path uses, read-only. */
function pullMergeable(ctx: Ctx, repo: Repo, pull: Pull): string {
  const store = ctx.store;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const baseCommit = peelToCommit(store, baseTip);
  const headCommit = peelToCommit(store, headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const base = mergeBase(store, baseCommit, headCommit);
  if (base === null) return 'UNKNOWN';
  const treeOf = (sha: string): string | null => {
    const object = getObject(store, sha);
    return object === null || object.type !== 'commit' ? null : parseCommit(object.data).tree;
  };
  const baseTree = treeOf(base);
  const oursTree = treeOf(baseCommit);
  const theirsTree = treeOf(headCommit);
  if (baseTree === null || oursTree === null || theirsTree === null) return 'UNKNOWN';
  const { conflicts } = mergeFlats(flattenTree(store, baseTree), flattenTree(store, oursTree), flattenTree(store, theirsTree));
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

const PULL_FIELDS: Record<string, Resolver> = {
  id: (_ctx, data) => globalId('PullRequest', (data.repo as Repo).id, (data.pull as Pull).number),
  databaseId: (_ctx, data) => (data.pull as Pull).id,
  number: (_ctx, data) => (data.pull as Pull).number,
  title: (_ctx, data) => (data.pull as Pull).title,
  body: (_ctx, data) => (data.pull as Pull).body,
  state: (_ctx, data) => {
    const pull = data.pull as Pull;
    return pull.merged ? 'MERGED' : pull.state.toUpperCase();
  },
  merged: (_ctx, data) => (data.pull as Pull).merged,
  mergedAt: (_ctx, data) => (data.pull as Pull).mergedAt,
  closed: (_ctx, data) => (data.pull as Pull).state === 'closed',
  closedAt: (_ctx, data) => ((data.pull as Pull).state === 'closed' ? (data.pull as Pull).updatedAt : null),
  author: () => userObj(),
  repository: (_ctx, data) => repoObj(data.repo as Repo),
  headRefName: (_ctx, data) => (data.pull as Pull).headRef,
  baseRefName: (_ctx, data) => (data.pull as Pull).baseRef,
  headRefOid: (_ctx, data) => (data.repo as Repo).refs.get(`refs/heads/${(data.pull as Pull).headRef}`) ?? '0'.repeat(40),
  baseRefOid: (_ctx, data) => (data.repo as Repo).refs.get(`refs/heads/${(data.pull as Pull).baseRef}`) ?? '0'.repeat(40),
  mergeable: (ctx, data) => pullMergeable(ctx, data.repo as Repo, data.pull as Pull),
  mergeCommit: (_ctx, data) => {
    const sha = (data.pull as Pull).mergeCommitSha;
    return sha === null ? null : obj('Commit', { sha });
  },
  isDraft: () => false,
  url: () => '',
  createdAt: (_ctx, data) => (data.pull as Pull).createdAt,
  updatedAt: (_ctx, data) => (data.pull as Pull).updatedAt,
  files: (ctx, data, args) => {
    const repo = data.repo as Repo;
    const pull = data.pull as Pull;
    const files = pullFiles(ctx.store, repo, pull).map((file) =>
      obj('PullRequestChangedFile', {
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }),
    );
    return connection('PullRequestChangedFileConnection', files, args);
  },
};

const CHANGED_FILE_FIELDS: Record<string, Resolver> = {
  path: (_ctx, data) => data.path,
  additions: (_ctx, data) => data.additions,
  deletions: (_ctx, data) => data.deletions,
  changeType: (_ctx, data) => data.changeType,
};

// ------------------------------------------------------------------ introspection

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Array<[string, string]>;
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      ['viewer', 'User'],
      ['repository', 'Repository'],
      ['node', 'Node'],
      ['user', 'User'],
      ['organization', 'Organization'],
      ['search', 'SearchResultItemConnection'],
      ['rateLimit', 'RateLimit'],
      ['__type', '__Type'],
      ['__schema', '__Schema'],
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      ['createIssue', 'CreateIssuePayload'],
      ['closeIssue', 'CloseIssuePayload'],
      ['reopenIssue', 'ReopenIssuePayload'],
      ['createPullRequest', 'CreatePullRequestPayload'],
      ['mergePullRequest', 'MergePullRequestPayload'],
      ['addComment', 'AddCommentPayload'],
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      ['id', 'ID'],
      ['databaseId', 'Int'],
      ['login', 'String'],
      ['name', 'String'],
      ['email', 'String'],
      ['url', 'URI'],
      ['avatarUrl', 'URI'],
      ['isViewer', 'Boolean'],
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      ['id', 'ID'],
      ['databaseId', 'Int'],
      ['name', 'String'],
      ['nameWithOwner', 'String'],
      ['owner', 'RepositoryOwner'],
      ['description', 'String'],
      ['isPrivate', 'Boolean'],
      ['visibility', 'RepositoryVisibility'],
      ['defaultBranchRef', 'Ref'],
      ['viewerPermission', 'RepositoryPermission'],
      ['hasIssuesEnabled', 'Boolean'],
      ['hasPullRequestsEnabled', 'Boolean'],
      ['issue', 'Issue'],
      ['issues', 'IssueConnection'],
      ['pullRequest', 'PullRequest'],
      ['pullRequests', 'PullRequestConnection'],
      ['labels', 'LabelConnection'],
      ['createdAt', 'DateTime'],
      ['updatedAt', 'DateTime'],
      ['pushedAt', 'DateTime'],
      ['stargazerCount', 'Int'],
      ['forkCount', 'Int'],
      ['url', 'URI'],
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      ['id', 'ID'],
      ['databaseId', 'Int'],
      ['number', 'Int'],
      ['title', 'String'],
      ['body', 'String'],
      ['state', 'IssueState'],
      ['closed', 'Boolean'],
      ['closedAt', 'DateTime'],
      ['author', 'Actor'],
      ['repository', 'Repository'],
      ['labels', 'LabelConnection'],
      ['comments', 'IssueCommentConnection'],
      ['createdAt', 'DateTime'],
      ['updatedAt', 'DateTime'],
      ['url', 'URI'],
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      ['id', 'ID'],
      ['databaseId', 'Int'],
      ['number', 'Int'],
      ['title', 'String'],
      ['body', 'String'],
      ['state', 'PullRequestState'],
      ['merged', 'Boolean'],
      ['mergedAt', 'DateTime'],
      ['mergeable', 'MergeableState'],
      ['mergeCommit', 'Commit'],
      ['headRefName', 'String'],
      ['baseRefName', 'String'],
      ['headRefOid', 'GitObjectID'],
      ['baseRefOid', 'GitObjectID'],
      ['files', 'PullRequestChangedFileConnection'],
      ['author', 'Actor'],
      ['repository', 'Repository'],
      ['isDraft', 'Boolean'],
      ['closed', 'Boolean'],
      ['closedAt', 'DateTime'],
      ['createdAt', 'DateTime'],
      ['updatedAt', 'DateTime'],
      ['url', 'URI'],
    ],
  },
  Label: { kind: 'OBJECT', fields: [['id', 'ID'], ['name', 'String'], ['color', 'String'], ['description', 'String']] },
  IssueComment: {
    kind: 'OBJECT',
    fields: [['id', 'ID'], ['databaseId', 'Int'], ['body', 'String'], ['author', 'Actor'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['url', 'URI']],
  },
  Ref: { kind: 'OBJECT', fields: [['name', 'String'], ['prefix', 'String'], ['target', 'GitObject']] },
  Commit: {
    kind: 'OBJECT',
    fields: [['oid', 'GitObjectID'], ['message', 'String'], ['messageHeadline', 'String'], ['tree', 'Tree'], ['committedDate', 'DateTime']],
  },
  Tree: { kind: 'OBJECT', fields: [['oid', 'GitObjectID']] },
  PageInfo: {
    kind: 'OBJECT',
    fields: [['hasNextPage', 'Boolean'], ['hasPreviousPage', 'Boolean'], ['startCursor', 'String'], ['endCursor', 'String']],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [['path', 'String'], ['additions', 'Int'], ['deletions', 'Int'], ['changeType', 'PatchStatus']],
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: [['limit', 'Int'], ['cost', 'Int'], ['remaining', 'Int'], ['used', 'Int'], ['resetAt', 'DateTime'], ['nodeCount', 'Int']],
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: [['issueCount', 'Int'], ['repositoryCount', 'Int'], ['userCount', 'Int'], ['nodes', 'SearchResultItem'], ['edges', 'SearchResultItemEdge'], ['pageInfo', 'PageInfo']],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PatchStatus: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
};

const TYPE_FIELDS: Record<string, Resolver> = {
  kind: (_ctx, data) => TYPE_DEFS[data.name as string]?.kind ?? 'OBJECT',
  name: (_ctx, data) => data.name,
  description: () => null,
  fields: (_ctx, data) => {
    const def = TYPE_DEFS[data.name as string];
    if (def === undefined || def.fields === undefined) return null;
    return def.fields.map(([name, typeName]) => obj('__Field', { name, typeName }));
  },
  enumValues: (_ctx, data) => {
    const def = TYPE_DEFS[data.name as string];
    if (def === undefined || def.enumValues === undefined) return null;
    return def.enumValues.map((name) => obj('__EnumValue', { name }));
  },
  possibleTypes: () => null,
  interfaces: () => [],
  ofType: () => null,
  inputFields: () => null,
  specifiedByURL: () => null,
};

const FIELD_TYPE_FIELDS: Record<string, Resolver> = {
  name: (_ctx, data) => data.name,
  description: () => null,
  args: () => [],
  type: (_ctx, data) => obj('__Type', { name: data.typeName }),
  isDeprecated: () => false,
  deprecationReason: () => null,
};

const ENUM_VALUE_FIELDS: Record<string, Resolver> = {
  name: (_ctx, data) => data.name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};

const SCHEMA_FIELDS: Record<string, Resolver> = {
  queryType: () => obj('__Type', { name: 'Query' }),
  mutationType: () => obj('__Type', { name: 'Mutation' }),
  subscriptionType: () => null,
  types: () => Object.keys(TYPE_DEFS).map((name) => obj('__Type', { name })),
  directives: () => [],
};

// ------------------------------------------------------------------ root resolvers

function repoByGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.parts[0]);
  for (const repo of ctx.store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function nodeById(ctx: Ctx, id: unknown): GqlObj | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'User') return Number(parsed.parts[0]) === VIEWER.id ? userObj() : null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : repoObj(repo);
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const dbId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== dbId) continue;
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueObj(repo, issue);
      }
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObj(repo, pull);
    }
    return null;
  }
  if (parsed.kind === 'IssueComment') {
    const dbId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    const commentId = Number(parsed.parts[2]);
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== dbId) continue;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      const comment = issue.comments.find((held) => held.id === commentId);
      return comment === undefined ? null : commentObj(repo, issue, comment);
    }
    return null;
  }
  return null;
}

const QUERY_FIELDS: Record<string, Resolver> = {
  viewer: () => userObj(),
  user: (_ctx, _data, args) => (args.login === VIEWER.login ? userObj() : null),
  organization: () => null,
  repository: (ctx, _data, args) => {
    if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
    const repo = ctx.store.repoFor(args.owner, args.name);
    return repo === null ? null : repoObj(repo);
  },
  node: (ctx, _data, args) => nodeById(ctx, args.id),
  __type: (_ctx, _data, args) =>
    typeof args.name === 'string' && TYPE_DEFS[args.name] !== undefined ? obj('__Type', { name: args.name }) : null,
  __schema: () => obj('__Schema', {}),
  rateLimit: () => obj('RateLimit', {}),
  search: (_ctx, _data, args) =>
    obj('SearchResultItemConnection', {
      nodesRaw: [],
      edgesRaw: [],
      pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
      totalCount: 0,
    }),
};

const RATE_LIMIT_FIELDS: Record<string, Resolver> = {
  limit: () => 5000,
  cost: () => 1,
  remaining: () => 4999,
  used: () => 1,
  resetAt: () => '2025-01-01T01:00:00Z',
  nodeCount: () => 0,
};

const SEARCH_FIELDS: Record<string, Resolver> = {
  ...CONNECTION_FIELDS,
  issueCount: () => 0,
  repositoryCount: () => 0,
  userCount: () => 0,
  discussionCount: () => 0,
};

function payload(type: string, fields: Record<string, unknown>): GqlObj {
  return obj(type, fields);
}

const MUTATION_FIELDS: Record<string, Resolver> = {
  createIssue: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const repo = repoByGlobalId(ctx, input.repositoryId);
    if (repo === null) throw new Error('repositoryId does not name a repository');
    if (typeof input.title !== 'string' || input.title === '') throw new Error('title is required');
    const issue = ctx.store.addIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
    return payload('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  closeIssue: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const node = nodeById(ctx, input.issueId);
    if (node === null || node.gqlType !== 'Issue') throw new Error('issueId does not name an issue');
    const issue = node.data.issue as Issue;
    issue.state = 'closed';
    issue.updatedAt = ctx.store.tickIso();
    return payload('CloseIssuePayload', { issue: node, clientMutationId: input.clientMutationId ?? null });
  },
  reopenIssue: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const node = nodeById(ctx, input.issueId);
    if (node === null || node.gqlType !== 'Issue') throw new Error('issueId does not name an issue');
    const issue = node.data.issue as Issue;
    issue.state = 'open';
    issue.updatedAt = ctx.store.tickIso();
    return payload('ReopenIssuePayload', { issue: node, clientMutationId: input.clientMutationId ?? null });
  },
  createPullRequest: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const repo = repoByGlobalId(ctx, input.repositoryId);
    if (repo === null) throw new Error('repositoryId does not name a repository');
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`headRefName ${head} does not name a branch`);
    if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`baseRefName ${base} does not name a branch`);
    const pull = ctx.store.addPull(
      repo,
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
      head,
      base,
    );
    return payload('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null });
  },
  mergePullRequest: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const node = nodeById(ctx, input.pullRequestId);
    if (node === null || node.gqlType !== 'PullRequest') throw new Error('pullRequestId does not name a pull request');
    const repo = node.data.repo as Repo;
    const pull = node.data.pull as Pull;
    if (pull.merged) throw new Error('Pull request is already merged');
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
    const outcome = mergePull(ctx.store, repo, pull, method);
    if (!outcome.ok) throw new Error('Pull request is not mergeable');
    return payload('MergePullRequestPayload', { pullRequest: node, clientMutationId: input.clientMutationId ?? null });
  },
  addComment: (ctx, _data, args) => {
    const input = isRecord(args.input) ? args.input : {};
    const node = nodeById(ctx, input.subjectId);
    if (node === null || (node.gqlType !== 'Issue' && node.gqlType !== 'PullRequest')) {
      throw new Error('subjectId does not name an issue or pull request');
    }
    if (typeof input.body !== 'string') throw new Error('body is required');
    const repo = node.data.repo as Repo;
    const issue: Issue =
      node.gqlType === 'Issue' ? (node.data.issue as Issue) : pullAsIssue(repo, node.data.pull as Pull);
    const comment = ctx.store.addComment(issue, input.body);
    const commentNode = commentObj(repo, issue, comment);
    return payload('AddCommentPayload', {
      commentEdge: obj('IssueCommentEdge', { node: commentNode, cursor: '' }),
      subject: node,
      clientMutationId: input.clientMutationId ?? null,
    });
  },
};

const PAYLOAD_FIELDS: Record<string, Resolver> = {
  issue: (_ctx, data) => data.issue,
  pullRequest: (_ctx, data) => data.pullRequest,
  commentEdge: (_ctx, data) => data.commentEdge,
  subject: (_ctx, data) => data.subject,
  clientMutationId: (_ctx, data) => data.clientMutationId,
};

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: QUERY_FIELDS,
  Mutation: MUTATION_FIELDS,
  User: USER_FIELDS,
  Repository: REPOSITORY_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  PullRequestChangedFile: CHANGED_FILE_FIELDS,
  IssueComment: COMMENT_FIELDS,
  Label: LABEL_FIELDS,
  Ref: REF_FIELDS,
  Commit: COMMIT_FIELDS,
  Tree: { oid: (_ctx, data) => data.oid },
  PageInfo: PAGE_INFO_FIELDS,
  IssueConnection: CONNECTION_FIELDS,
  PullRequestConnection: CONNECTION_FIELDS,
  LabelConnection: CONNECTION_FIELDS,
  IssueCommentConnection: CONNECTION_FIELDS,
  PullRequestChangedFileConnection: CONNECTION_FIELDS,
  SearchResultItemConnection: SEARCH_FIELDS,
  RateLimit: RATE_LIMIT_FIELDS,
  Edge: { node: (_ctx, data) => data.node, cursor: (_ctx, data) => data.cursor },
  IssueCommentEdge: { node: (_ctx, data) => data.node, cursor: (_ctx, data) => data.cursor },
  __Type: TYPE_FIELDS,
  __Field: FIELD_TYPE_FIELDS,
  __EnumValue: ENUM_VALUE_FIELDS,
  __Schema: SCHEMA_FIELDS,
  CreateIssuePayload: PAYLOAD_FIELDS,
  CloseIssuePayload: PAYLOAD_FIELDS,
  ReopenIssuePayload: PAYLOAD_FIELDS,
  CreatePullRequestPayload: PAYLOAD_FIELDS,
  MergePullRequestPayload: PAYLOAD_FIELDS,
  AddCommentPayload: PAYLOAD_FIELDS,
};

// ------------------------------------------------------------------ the executor

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = resolveValue(value, variables);
  return out;
}

function directiveAllows(ctx: Ctx, field: FieldNode): boolean {
  for (const [name, args] of field.directives) {
    if (name !== 'include' && name !== 'skip') continue;
    const ifValue = args.get('if');
    const flag = ifValue === undefined ? undefined : resolveValue(ifValue, ctx.variables);
    if (name === 'include' && flag === false) return false;
    if (name === 'skip' && flag === true) return false;
  }
  return true;
}

function completeValue(ctx: Ctx, value: unknown, selectionSet: Selection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selectionSet));
  if (isObj(value)) {
    if (selectionSet === null) return {};
    const out: Record<string, unknown> = {};
    executeSelectionSet(ctx, value.gqlType, value.data, selectionSet, out);
    return out;
  }
  return value;
}

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  data: Record<string, unknown>,
  selections: Selection[],
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelectionSet(ctx, typeName, data, selection.selectionSet, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        executeSelectionSet(ctx, typeName, data, fragment.selectionSet, out);
      }
      continue;
    }
    const field = selection.field;
    if (!directiveAllows(ctx, field)) continue;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = FIELDS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = resolver(ctx, data, resolveArgs(field, ctx.variables));
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, raw, field.selectionSet);
  }
}

function executeOperation(store: Store, item: unknown): { status: number; payload: Record<string, unknown> } {
  if (!isRecord(item) || typeof item.query !== 'string') {
    return { status: 400, payload: { errors: [{ message: 'A GraphQL query string is required' }] } };
  }
  let document: Document;
  try {
    document = new Parser(item.query).parseDocument();
  } catch (error) {
    return { status: 400, payload: { errors: [{ message: error instanceof Error ? error.message : 'Syntax error' }] } };
  }
  const operationName = typeof item.operationName === 'string' ? item.operationName : null;
  const operation =
    document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) {
    return { status: 400, payload: { errors: [{ message: 'No operation found' }] } };
  }
  const provided = isRecord(item.variables) ? item.variables : {};
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of operation.variableDefaults) {
    variables[name] = resolveValue(defaultValue, provided);
  }
  Object.assign(variables, provided);
  const ctx: Ctx = { store, fragments: document.fragments, variables, errors: [] };
  const data: Record<string, unknown> = {};
  executeSelectionSet(ctx, operation.type === 'mutation' ? 'Mutation' : 'Query', {}, operation.selectionSet, data);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return { status: 200, payload };
}

/** POST /api/graphql: one operation, or a JSON array of them answered in order. */
export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => executeOperation(store, item).payload);
    sendJson(store, res, 200, results);
    return;
  }
  const { status, payload } = executeOperation(store, parsed);
  sendJson(store, res, status, payload);
}
