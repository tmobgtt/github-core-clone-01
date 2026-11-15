// The MCP endpoint: Model Context Protocol over streamable HTTP, JSON-RPC 2.0. The forge
// speaks the initialize era (2025-11-25 and earlier): server/discover is refused with -32601,
// which the suite accepts as a pre-discover server as long as initialize works. The tools act
// on the same store as REST, so an object created over MCP is the same object over REST, with
// the same stable ids. tools/list is a fixed literal: two calls answer byte for byte alike.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, type Repo } from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';
import { isRecord, readBody } from './http.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'One of merge, squash or rebase.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
];

/** The tools/list answer, built once so two calls are byte-identical. */
const TOOLS_RESULT = {
  tools: TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return store.repoFor(owner, repo);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcOutcome | null {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) return null;
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcResult(currentId(args), toolFailure(`Missing required argument: ${required}`));
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return rpcResult(currentId(args), toolSuccess(repoJson(existing)));
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return rpcResult(currentId(args), toolSuccess(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      return rpcResult(currentId(args), toolSuccess(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const issue = store.addIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return rpcResult(currentId(args), toolSuccess(issueJson(repo, issue)));
    }
    case 'list_issues': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return rpcResult(currentId(args), toolSuccess(issues));
    }
    case 'get_issue': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return rpcResult(currentId(args), toolFailure('Issue not found'));
      return rpcResult(currentId(args), toolSuccess(issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const head = String(args.head).includes(':') ? (String(args.head).split(':').pop() as string) : String(args.head);
      const base = String(args.base).includes(':') ? (String(args.base).split(':').pop() as string) : String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) return rpcResult(currentId(args), toolFailure(`Invalid head branch: ${head}`));
      if (!repo.refs.has(`refs/heads/${base}`)) return rpcResult(currentId(args), toolFailure(`Invalid base branch: ${base}`));
      const pull = store.addPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return rpcResult(currentId(args), toolSuccess(pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return rpcResult(currentId(args), toolFailure('Pull request not found'));
      if (pull.merged) {
        return rpcResult(currentId(args), toolSuccess({ ...pullJson(repo, pull), sha: pull.mergeCommitSha, merged: true }));
      }
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const outcome = mergePull(store, repo, pull, method);
      if (!outcome.ok || outcome.sha === undefined) return rpcResult(currentId(args), toolFailure('Pull Request is not mergeable'));
      return rpcResult(
        currentId(args),
        toolSuccess({ ...pullJson(repo, pull), sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' }),
      );
    }
    case 'add_issue_comment': {
      const repo = repoArg(store, args);
      if (repo === null) return rpcResult(currentId(args), toolFailure('Repository not found'));
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return rpcResult(currentId(args), toolFailure('Issue not found'));
      const comment = store.addComment(issue, String(args.body));
      return rpcResult(
        currentId(args),
        toolSuccess({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt }),
      );
    }
    default:
      return null;
  }
}

// tools/call needs the request id for its answer; it travels through this slot because the
// dispatch signature is shared with the other methods.
let pendingId: unknown = null;
function currentId(_args: Record<string, unknown>): unknown {
  return pendingId;
}

function handleRpc(store: Store, request: Record<string, unknown>): RpcOutcome {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.has(asked) ? asked : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      pendingId = id;
      try {
        const outcome = callTool(store, name, args);
        if (outcome !== null) return outcome;
      } finally {
        pendingId = null;
      }
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      // server/discover included: a pre-discover server refuses methods it does not know.
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp. A body that is not JSON answers HTTP 400 with a -32700 parse error. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const answer = (outcome: RpcOutcome): void => {
    if (outcome.payload === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    const text = JSON.stringify(outcome.payload);
    res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (Array.isArray(parsed)) {
    const outcomes = parsed
      .filter((item) => isRecord(item))
      .map((item) => handleRpc(store, item as Record<string, unknown>))
      .filter((outcome) => outcome.payload !== null)
      .map((outcome) => outcome.payload);
    const text = JSON.stringify(outcomes);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  if (!isRecord(parsed)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
    return;
  }
  // A notification (no id) is answered with an empty 202, never a JSON-RPC body.
  if (parsed.id === undefined && typeof parsed.method === 'string' && parsed.method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  answer(handleRpc(store, parsed));
}

// Referenced for the module's consumers that want the same identity the server reports.
export const MCP_SERVER_INFO = SERVER_INFO;
export { VIEWER };
