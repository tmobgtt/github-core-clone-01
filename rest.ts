// The REST v3 surface: the API root and meta, the viewer, repositories and their contents,
// branches and git refs, commits, labels, issues and comments, pull requests and merges.
// Every answer is JSON with a request id; errors are JSON with a message; an unknown route is
// a 404 and a malformed body a 400. Repositories belong to the token's login: the same name
// under another owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  ZERO_OID,
  buildTreeFromFlat,
  createCommit,
  diffFlats,
  flattenTree,
  getObject,
  hashObject,
  historyFrom,
  mergeBase,
  mergeFlats,
  parseCommit,
  parseTree,
  peelToCommit,
  treeEntryAt,
  type FlatTree,
} from './git.ts';
import { isRecord, readJson, sendEmpty, sendError, sendJson, stringField } from './http.ts';

// ------------------------------------------------------------------ serializers

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`).toString('base64'),
    avatar_url: '',
    html_url: `/${VIEWER.login}`,
    type: VIEWER.type,
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    html_url: `/${VIEWER.login}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    clone_url: `/${VIEWER.login}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_pull_requests: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as Label)),
    user: userJson(),
    comments: issue.comments.length,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
  };
}

function refSha(repo: Repo, branch: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const side = (ref: string): Record<string, unknown> => ({
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha: refSha(repo, ref),
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: side(pull.headRef),
    base: side(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
  };
}

function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

export function commitJson(store: Store, sha: string): Record<string, unknown> | null {
  const object = getObject(store, sha);
  if (object === null || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: identityJson(commit.author),
      committer: identityJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: '',
    url: '',
  };
}

// ------------------------------------------------------------------ pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice `items` for the page and build the Link header (absolute, same-origin) for it. */
function paginate<T>(req: IncomingMessage, pathname: string, query: URLSearchParams, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageOf(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const host = req.headers.host ?? 'entry';
  const linkFor = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<http://${host}${pathname}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`${linkFor(page + 1)}; rel="next"`);
    links.push(`${linkFor(lastPage)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${linkFor(1)}; rel="first"`);
    links.push(`${linkFor(page - 1)}; rel="prev"`);
  }
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ------------------------------------------------------------------ the router

/** Handle one /api/v3 request. `segments` is the path after /api/v3, split and decoded. */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  const head = segments[0] ?? '';

  if (segments.length === 0) {
    if (method !== 'GET') return sendError(store, res, 404, 'Not Found');
    return sendJson(
      store,
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
        emojis_url: '/api/v3/emojis',
        meta_url: '/api/v3/meta',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendError(store, res, 404, 'Not Found');
    return sendJson(store, res, 200, {
      installed_version: '1.0.0-forge',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      verifiable_password_authentication: false,
    });
  }

  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(store, res, 404, 'Not Found');
    return sendJson(store, res, 200, {
      ...userJson(),
      public_repos: store.repos.size,
      total_private_repos: [...store.repos.values()].filter((repo) => repo.private).length,
    });
  }

  if (head === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(repo));
      const { slice, headers } = paginate(req, pathname, query, all);
      return sendJson(store, res, 200, slice, headers);
    }
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const name = stringField(parsed.value, 'name');
      if (name === undefined || name === '') return sendError(store, res, 422, 'Repository creation failed: name is required');
      if (store.repos.has(name)) {
        return sendError(store, res, 422, `Repository creation failed: a repository named "${name}" already exists`);
      }
      const repo = store.createRepo(name, parsed.value.private === true, stringField(parsed.value, 'description') ?? '');
      return sendJson(store, res, 201, repoJson(repo));
    }
    return sendError(store, res, 404, 'Not Found');
  }

  if (head === 'repos' && segments.length >= 3) {
    const repo = store.repoFor(segments[1] as string, segments[2] as string);
    if (repo === null) return sendError(store, res, 404, 'Not Found');
    return handleRepo(store, req, res, pathname, repo, segments.slice(3), query);
  }

  return sendError(store, res, 404, 'Not Found');
}

// ------------------------------------------------------------------ one repository

async function handleRepo(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(store, res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const description = stringField(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      const name = stringField(parsed.value, 'name');
      if (name !== undefined && name !== '' && name !== repo.name && !store.repos.has(name)) {
        store.repos.delete(repo.name);
        repo.name = name;
        store.repos.set(name, repo);
      }
      repo.updatedAt = store.tickIso();
      return sendJson(store, res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return sendEmpty(store, res, 204);
    }
    return sendError(store, res, 404, 'Not Found');
  }

  const area = rest[0] as string;
  if (area === 'contents') return handleContents(store, req, res, repo, rest.slice(1).join('/'), query);
  if (area === 'branches') return handleBranches(store, req, res, repo, rest.slice(1).join('/'));
  if (area === 'git' && rest[1] === 'refs') return handleGitRefs(store, req, res, repo, rest.slice(2).join('/'));
  if (area === 'commits') return handleCommits(store, req, res, pathname, repo, rest.slice(1), query);
  if (area === 'labels') return handleLabels(store, req, res, repo, rest.slice(1).join('/'));
  if (area === 'issues') return handleIssues(store, req, res, pathname, repo, rest.slice(1), query);
  if (area === 'pulls') return handlePulls(store, req, res, pathname, repo, rest.slice(1), query);
  return sendError(store, res, 404, 'Not Found');
}

/** The commit a ref parameter names: a branch, a full ref, a commit id, or the default branch. */
function resolveCommit(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip === undefined ? null : peelToCommit(store, tip);
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = getObject(store, ref);
    if (object !== null && object.type === 'commit') return ref;
    if (object !== null && object.type === 'tag') return peelToCommit(store, ref);
    return null;
  }
  const branchTip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  return branchTip === undefined ? null : peelToCommit(store, branchTip);
}

function commitTree(store: Store, commitSha: string): string | null {
  const object = getObject(store, commitSha);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ------------------------------------------------------------------ contents

async function handleContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const commit = resolveCommit(store, repo, query.get('ref'));
    if (commit === null) return sendError(store, res, 404, 'Not Found');
    const tree = commitTree(store, commit);
    if (tree === null) return sendError(store, res, 404, 'Not Found');
    const entry = treeEntryAt(store, tree, cleanPath);
    if (entry === null) return sendError(store, res, 404, 'Not Found');
    if (entry.mode === '40000') {
      const dirObject = getObject(store, entry.sha);
      if (dirObject === null) return sendError(store, res, 404, 'Not Found');
      const entries = parseTree(dirObject.data).map((child) => {
        const childPath = cleanPath === '' ? child.name : `${cleanPath}/${child.name}`;
        const base: Record<string, unknown> = {
          name: child.name,
          path: childPath,
          sha: child.sha,
          type: child.mode === '40000' ? 'dir' : 'file',
          url: '',
          html_url: '',
          download_url: null,
        };
        if (child.mode !== '40000') {
          const blob = getObject(store, child.sha);
          base.size = blob === null ? 0 : blob.data.length;
        }
        return base;
      });
      entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      return sendJson(store, res, 200, entries);
    }
    const blob = getObject(store, entry.sha);
    if (blob === null) return sendError(store, res, 404, 'Not Found');
    const name = cleanPath.split('/').pop() ?? cleanPath;
    return sendJson(store, res, 200, {
      name,
      path: cleanPath,
      sha: entry.sha,
      size: blob.data.length,
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      url: '',
      html_url: '',
      download_url: null,
    });
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const body = parsed.value;
    const message = stringField(body, 'message') ?? (method === 'PUT' ? `Update ${cleanPath}` : `Delete ${cleanPath}`);
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let baseCommit = tip === undefined ? null : peelToCommit(store, tip);
    if (baseCommit === null && branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      baseCommit = defaultTip === undefined ? null : peelToCommit(store, defaultTip);
    }
    const baseTree = baseCommit === null ? hashObject(store, 'tree', Buffer.alloc(0)) : commitTree(store, baseCommit);
    if (baseTree === null) return sendError(store, res, 404, 'Not Found');
    const flat: FlatTree = flattenTree(store, baseTree);
    const existing = flat.get(cleanPath);

    if (method === 'DELETE') {
      if (existing === undefined) return sendError(store, res, 404, 'Not Found');
      const sha = stringField(body, 'sha');
      if (sha !== undefined && sha !== existing.sha) return sendError(store, res, 409, 'sha does not match');
      flat.delete(cleanPath);
      const tree = buildTreeFromFlat(store, flat);
      const commit = createCommit(store, tree, baseCommit === null ? [] : [baseCommit], message);
      repo.refs.set(refName, commit);
      repo.updatedAt = store.tickIso();
      return sendJson(store, res, 200, { content: null, commit: { sha: commit } });
    }

    const content = stringField(body, 'content');
    if (content === undefined) return sendError(store, res, 422, 'content is required');
    const sha = stringField(body, 'sha');
    if (sha !== undefined && (existing === undefined || sha !== existing.sha)) {
      return sendError(store, res, 409, 'sha does not match');
    }
    const blobSha = hashObject(store, 'blob', Buffer.from(content, 'base64'));
    flat.set(cleanPath, { mode: existing?.mode ?? '100644', sha: blobSha });
    const tree = buildTreeFromFlat(store, flat);
    const commit = createCommit(store, tree, baseCommit === null ? [] : [baseCommit], message);
    repo.refs.set(refName, commit);
    repo.updatedAt = store.tickIso();
    const blob = getObject(store, blobSha);
    return sendJson(store, res, existing === undefined ? 201 : 200, {
      content: {
        name: cleanPath.split('/').pop() ?? cleanPath,
        path: cleanPath,
        sha: blobSha,
        size: blob === null ? 0 : blob.data.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commit, message },
    });
  }

  return sendError(store, res, 404, 'Not Found');
}

// ------------------------------------------------------------------ branches and refs

function handleBranches(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, name: string): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET') return sendError(store, res, 404, 'Not Found');
  if (name === '') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: '' }, protected: false }));
    return sendJson(store, res, 200, branches);
  }
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return sendError(store, res, 404, 'Not Found');
  const commit = commitJson(store, sha);
  return sendJson(store, res, 200, {
    name,
    commit: { sha, url: '', author: commit?.commit !== undefined ? (commit.commit as Record<string, unknown>).author : undefined },
    protected: false,
  });
}

async function handleGitRefs(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string): Promise<void> {
  const method = req.method ?? 'GET';
  const fullRef = tail === '' ? '' : tail.startsWith('refs/') ? tail : `refs/${tail}`;
  if (method === 'GET' && tail === '') {
    const all = [...repo.refs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ref, sha]) => ({ ref, node_id: '', url: '', object: { sha, type: getObject(store, sha)?.type ?? 'commit', url: '' } }));
    return sendJson(store, res, 200, all);
  }
  if (method === 'GET') {
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) return sendError(store, res, 404, 'Not Found');
    return sendJson(store, res, 200, {
      ref: fullRef,
      node_id: '',
      url: '',
      object: { sha, type: getObject(store, sha)?.type ?? 'commit', url: '' },
    });
  }
  if (method === 'POST' && tail === '') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const ref = stringField(parsed.value, 'ref');
    let sha = stringField(parsed.value, 'sha');
    if (ref === undefined || !ref.startsWith('refs/')) return sendError(store, res, 422, 'ref is required');
    if (sha !== undefined && getObject(store, sha) === null) {
      const resolved = resolveCommit(store, repo, sha);
      if (resolved === null) return sendError(store, res, 422, 'sha is not a known object');
      sha = resolved;
    }
    if (sha === undefined) return sendError(store, res, 422, 'sha is required');
    if (repo.refs.has(ref)) return sendError(store, res, 422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return sendJson(store, res, 201, {
      ref,
      node_id: '',
      url: '',
      object: { sha, type: getObject(store, sha)?.type ?? 'commit', url: '' },
    });
  }
  if (method === 'DELETE' && tail !== '') {
    if (!repo.refs.has(fullRef)) return sendError(store, res, 404, 'Not Found');
    repo.refs.delete(fullRef);
    return sendEmpty(store, res, 204);
  }
  return sendError(store, res, 404, 'Not Found');
}

// ------------------------------------------------------------------ commits

function handleCommits(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET') return sendError(store, res, 404, 'Not Found');
  if (rest.length === 1 && rest[0] !== '') {
    const sha = rest[0] as string;
    const commit = commitJson(store, sha);
    if (commit === null) return sendError(store, res, 404, 'Not Found');
    return sendJson(store, res, 200, commit);
  }
  const start = resolveCommit(store, repo, query.get('sha'));
  if (start === null) return sendError(store, res, 404, 'Not Found');
  const shas = historyFrom(store, start, 1000);
  const items = shas
    .map((sha) => commitJson(store, sha))
    .filter((commit) => commit !== null);
  const paged = paginate(req, pathname, query, items);
  return sendJson(store, res, 200, paged.slice, paged.headers);
}

// ------------------------------------------------------------------ labels

async function handleLabels(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, name: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET' && name === '') {
    const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((label) => labelJson(label));
    return sendJson(store, res, 200, labels);
  }
  if (method === 'POST' && name === '') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const labelName = stringField(parsed.value, 'name');
    if (labelName === undefined || labelName === '') return sendError(store, res, 422, 'name is required');
    if (repo.labels.has(labelName)) return sendError(store, res, 422, 'Validation Failed: label already exists');
    const label = store.addLabel(
      repo,
      labelName,
      (stringField(parsed.value, 'color') ?? 'ededed').replace(/^#/, ''),
      stringField(parsed.value, 'description') ?? '',
    );
    return sendJson(store, res, 201, labelJson(label));
  }
  const existing = repo.labels.get(name);
  if (existing === undefined) return sendError(store, res, 404, 'Not Found');
  if (method === 'GET') return sendJson(store, res, 200, labelJson(existing));
  if (method === 'PATCH') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const color = stringField(parsed.value, 'color');
    if (color !== undefined) existing.color = color.replace(/^#/, '');
    const description = stringField(parsed.value, 'description');
    if (description !== undefined) existing.description = description;
    const newName = stringField(parsed.value, 'new_name') ?? stringField(parsed.value, 'name');
    if (newName !== undefined && newName !== name) {
      repo.labels.delete(name);
      existing.name = newName;
      repo.labels.set(newName, existing);
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.map((held) => (held === name ? newName : held));
      }
    }
    return sendJson(store, res, 200, labelJson(existing));
  }
  if (method === 'DELETE') {
    repo.labels.delete(name);
    return sendEmpty(store, res, 204);
  }
  return sendError(store, res, 404, 'Not Found');
}

// ------------------------------------------------------------------ issues and comments

function labelNamesOf(repo: Repo, body: Record<string, unknown>): { ok: true; names: string[] } | { ok: false } {
  const raw = body.labels;
  if (raw === undefined) return { ok: true, names: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null;
    if (name === null || !repo.labels.has(name)) return { ok: false };
    names.push(name);
  }
  return { ok: true, names };
}

async function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const title = stringField(parsed.value, 'title');
      if (title === undefined || title === '') return sendError(store, res, 422, 'title is required');
      const labels = labelNamesOf(repo, parsed.value);
      if (!labels.ok) return sendError(store, res, 422, 'Validation Failed: an issue label does not exist in the repository');
      const issue = store.addIssue(repo, title, stringField(parsed.value, 'body') ?? '', labels.names);
      repo.updatedAt = issue.updatedAt;
      return sendJson(store, res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const labelFilter = (query.get('labels') ?? '').split(',').filter((name) => name !== '');
      interface Row {
        number: number;
        createdAt: string;
        json: Record<string, unknown>;
        state: string;
        labels: string[];
      }
      const rows: Row[] = [];
      for (const issue of repo.issues.values()) {
        rows.push({ number: issue.number, createdAt: issue.createdAt, json: issueJson(repo, issue), state: issue.state, labels: issue.labels });
      }
      for (const pull of repo.pulls.values()) {
        const json = issueJsonForPull(repo, pull);
        rows.push({ number: pull.number, createdAt: pull.createdAt, json, state: pull.state, labels: [] });
      }
      const filtered = rows.filter(
        (row) =>
          (state === 'all' || row.state === state) &&
          labelFilter.every((name) => row.labels.includes(name)),
      );
      filtered.sort((a, b) => {
        const byTime = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
        return direction === 'asc' ? byTime : -byTime;
      });
      const { slice, headers } = paginate(req, pathname, query, filtered.map((row) => row.json));
      return sendJson(store, res, 200, slice, headers);
    }
    return sendError(store, res, 404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return sendError(store, res, 404, 'Not Found');
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (rest.length === 2 && rest[1] === 'comments') {
    const holder = issue ?? (pull === undefined ? undefined : pullAsIssue(repo, pull));
    if (holder === undefined) return sendError(store, res, 404, 'Not Found');
    if (method === 'GET') {
      return sendJson(store, res, 200, holder.comments.map((comment) => commentJson(repo, holder.number, comment)));
    }
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const body = stringField(parsed.value, 'body');
      if (body === undefined) return sendError(store, res, 422, 'body is required');
      const comment = store.addComment(holder, body);
      return sendJson(store, res, 201, commentJson(repo, holder.number, comment));
    }
    return sendError(store, res, 404, 'Not Found');
  }

  if (rest.length !== 1) return sendError(store, res, 404, 'Not Found');
  if (issue === undefined) {
    if (pull !== undefined && method === 'GET') return sendJson(store, res, 200, issueJsonForPull(repo, pull));
    if (pull !== undefined && method === 'PATCH') {
      // GitHub lets a pull request be edited through the issues endpoint too.
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const state = stringField(parsed.value, 'state');
      if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
      const title = stringField(parsed.value, 'title');
      if (title !== undefined) pull.title = title;
      const body = stringField(parsed.value, 'body');
      if (body !== undefined) pull.body = body;
      pull.updatedAt = store.tickIso();
      return sendJson(store, res, 200, issueJsonForPull(repo, pull));
    }
    return sendError(store, res, 404, 'Not Found');
  }
  if (method === 'GET') return sendJson(store, res, 200, issueJson(repo, issue));
  if (method === 'PATCH') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const state = stringField(parsed.value, 'state');
    if (state === 'closed' || state === 'open') issue.state = state;
    const title = stringField(parsed.value, 'title');
    if (title !== undefined) issue.title = title;
    const body = stringField(parsed.value, 'body');
    if (body !== undefined) issue.body = body;
    if (parsed.value.labels !== undefined) {
      const labels = labelNamesOf(repo, parsed.value);
      if (!labels.ok) return sendError(store, res, 422, 'Validation Failed: an issue label does not exist in the repository');
      issue.labels = labels.names;
    }
    issue.updatedAt = store.tickIso();
    return sendJson(store, res, 200, issueJson(repo, issue));
  }
  return sendError(store, res, 404, 'Not Found');
}

/** Pull requests share the issue number sequence; comments live on a shadow issue record. */
const pullCommentHolders = new WeakMap<Pull, Issue>();
export function pullAsIssue(repo: Repo, pull: Pull): Issue {
  let holder = pullCommentHolders.get(pull);
  if (holder === undefined) {
    holder = {
      number: pull.number,
      id: pull.id,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      comments: [],
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
    };
    pullCommentHolders.set(pull, holder);
  }
  void repo;
  return holder;
}

function issueJsonForPull(repo: Repo, pull: Pull): Record<string, unknown> {
  const json = issueJson(repo, pullAsIssue(repo, pull));
  json.pull_request = { url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`, html_url: '', diff_url: '', patch_url: '' };
  if (pull.merged) json.state = 'closed';
  return json;
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `/${VIEWER.login}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ------------------------------------------------------------------ pull requests

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  conflict?: boolean;
}

/** Merge a pull request into its base branch: three-way tree merge against the merge base. */
export function mergePull(store: Store, repo: Repo, pull: Pull, method: string): MergeOutcome {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, conflict: true };
  const baseCommit = peelToCommit(store, baseTip);
  const headCommit = peelToCommit(store, headTip);
  if (baseCommit === null || headCommit === null) return { ok: false, conflict: true };
  const base = mergeBase(store, baseCommit, headCommit) ?? baseCommit;
  const baseTree = commitTree(store, base);
  const oursTree = commitTree(store, baseCommit);
  const theirsTree = commitTree(store, headCommit);
  if (baseTree === null || oursTree === null || theirsTree === null) return { ok: false, conflict: true };
  const baseFlat = flattenTree(store, baseTree);
  const oursFlat = flattenTree(store, oursTree);
  const theirsFlat = flattenTree(store, theirsTree);
  const { merged, conflicts } = mergeFlats(baseFlat, oursFlat, theirsFlat);
  if (conflicts.length > 0) return { ok: false, conflict: true };
  const mergedTree = buildTreeFromFlat(store, merged);

  let newTip: string;
  if (method === 'rebase') {
    // Replay the head-only commits, oldest first, onto the base tip.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = headCommit;
    while (cursor !== null && cursor !== base && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      const object = getObject(store, cursor);
      if (object === null || object.type !== 'commit') break;
      const parents = parseCommit(object.data).parents;
      cursor = parents[0] ?? null;
    }
    chain.reverse();
    let current = baseCommit;
    let currentFlat = oursFlat;
    for (const original of chain) {
      const object = getObject(store, original);
      if (object === null || object.type !== 'commit') return { ok: false, conflict: true };
      const commit = parseCommit(object.data);
      const parentTree = commit.parents[0] === undefined ? null : commitTree(store, commit.parents[0]);
      const parentFlat = parentTree === null ? new Map() : flattenTree(store, parentTree);
      const step = mergeFlats(parentFlat, currentFlat, flattenTree(store, commit.tree));
      if (step.conflicts.length > 0) return { ok: false, conflict: true };
      const tree = buildTreeFromFlat(store, step.merged);
      current = createCommit(store, tree, [current], commit.message);
      currentFlat = step.merged;
    }
    newTip = current;
  } else if (method === 'squash') {
    const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
    newTip = createCommit(store, mergedTree, [baseCommit], message);
  } else {
    newTip = createCommit(store, mergedTree, [baseCommit, headCommit], `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, newTip);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.tickIso();
  pull.mergeCommitSha = newTip;
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.updatedAt;
  return { ok: true, sha: newTip };
}

/** The files a pull request changes, diffed against its merge base. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const baseCommit = peelToCommit(store, baseTip);
  const headCommit = peelToCommit(store, headTip);
  if (baseCommit === null || headCommit === null) return [];
  const base = mergeBase(store, baseCommit, headCommit);
  const baseTree = base === null ? null : commitTree(store, base);
  const headTree = commitTree(store, headCommit);
  if (headTree === null) return [];
  const baseFlat: FlatTree = baseTree === null ? new Map() : flattenTree(store, baseTree);
  const headFlat = flattenTree(store, headTree);
  return diffFlats(store, baseFlat, headFlat).map((change) => ({
    sha: headFlat.get(change.path)?.sha ?? baseFlat.get(change.path)?.sha ?? '',
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
}

async function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
      const title = stringField(parsed.value, 'title');
      const headRaw = stringField(parsed.value, 'head');
      const baseRaw = stringField(parsed.value, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return sendError(store, res, 422, 'title, head and base are required');
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (!repo.refs.has(`refs/heads/${head}`)) return sendError(store, res, 422, `Invalid head branch: ${head}`);
      if (!repo.refs.has(`refs/heads/${base}`)) return sendError(store, res, 422, `Invalid base branch: ${base}`);
      const pull = store.addPull(repo, title, stringField(parsed.value, 'body') ?? '', head, base);
      repo.updatedAt = pull.updatedAt;
      return sendJson(store, res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const all = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(repo, pull));
      const { slice, headers } = paginate(req, pathname, query, all);
      return sendJson(store, res, 200, slice, headers);
    }
    return sendError(store, res, 404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return sendError(store, res, 404, 'Not Found');

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return sendJson(store, res, 200, pullFiles(store, repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = await readJson(req);
    if (!parsed.ok) return sendError(store, res, 400, 'Invalid JSON');
    const body = isRecord(parsed.value) ? parsed.value : {};
    if (pull.merged || pull.state === 'closed') return sendError(store, res, 405, 'Pull Request is not mergeable');
    const mergeMethod = stringField(body, 'merge_method') ?? 'merge';
    const outcome = mergePull(store, repo, pull, mergeMethod);
    if (!outcome.ok || outcome.sha === undefined) return sendError(store, res, 405, 'Pull Request is not mergeable');
    return sendJson(store, res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (rest.length === 1 && method === 'GET') return sendJson(store, res, 200, pullJson(repo, pull));
  if (rest.length === 1 && method === 'PATCH') {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(store, res, 400, 'Invalid JSON');
    const title = stringField(parsed.value, 'title');
    if (title !== undefined) pull.title = title;
    const bodyText = stringField(parsed.value, 'body');
    if (bodyText !== undefined) pull.body = bodyText;
    const state = stringField(parsed.value, 'state');
    if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
    pull.updatedAt = store.tickIso();
    return sendJson(store, res, 200, pullJson(repo, pull));
  }
  return sendError(store, res, 404, 'Not Found');
}
