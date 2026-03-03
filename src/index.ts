#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";

const USER_AGENT = "reddit-mcp/1.0 (MCP Server for Reddit data extraction)";
const BASE_URL = "https://www.reddit.com";

// ── Types ──────────────────────────────────────────────────────────────────

interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  url: string;
  permalink: string;
  selftext: string;
  created_utc: number;
  created_date: string;
  is_self: boolean;
  link_flair_text: string | null;
  over_18: boolean;
}

interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  created_date: string;
  depth: number;
  replies: RedditComment[];
  permalink: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace("T", " ").substring(0, 19) + " UTC";
}

async function fetchReddit(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  url.searchParams.set("raw_json", "1");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (response.status === 429) {
    throw new Error("Reddit rate limit hit. Please wait a moment before retrying.");
  }
  if (response.status === 403) {
    throw new Error("Access denied. The subreddit may be private.");
  }
  if (response.status === 404) {
    throw new Error("Not found. Check that the subreddit or post exists.");
  }
  if (!response.ok) {
    throw new Error(`Reddit API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function parsePost(data: Record<string, unknown>): RedditPost {
  return {
    id: data.id as string,
    title: data.title as string,
    author: data.author as string,
    subreddit: data.subreddit as string,
    score: data.score as number,
    upvote_ratio: data.upvote_ratio as number,
    num_comments: data.num_comments as number,
    url: data.url as string,
    permalink: `https://www.reddit.com${data.permalink as string}`,
    selftext: (data.selftext as string) || "",
    created_utc: data.created_utc as number,
    created_date: formatDate(data.created_utc as number),
    is_self: data.is_self as boolean,
    link_flair_text: (data.link_flair_text as string | null) ?? null,
    over_18: data.over_18 as boolean,
  };
}

function parseComment(data: Record<string, unknown>, depth = 0): RedditComment | null {
  if (data.kind === "more") return null;

  const d = data.kind === "t1" ? (data.data as Record<string, unknown>) : data;
  if (!d || d.body === "[deleted]" || d.body === "[removed]") return null;

  const replies: RedditComment[] = [];
  const repliesData = d.replies as { data?: { children?: Array<Record<string, unknown>> } } | undefined;
  if (repliesData?.data?.children) {
    for (const child of repliesData.data.children) {
      const parsed = parseComment(child, depth + 1);
      if (parsed) replies.push(parsed);
    }
  }

  return {
    id: d.id as string,
    author: (d.author as string) || "[deleted]",
    body: d.body as string,
    score: d.score as number,
    created_utc: d.created_utc as number,
    created_date: formatDate(d.created_utc as number),
    depth,
    replies,
    permalink: `https://www.reddit.com${d.permalink as string}`,
  };
}

function flattenComments(comments: RedditComment[], maxDepth = 999): RedditComment[] {
  const result: RedditComment[] = [];
  function walk(list: RedditComment[]) {
    for (const c of list) {
      if (c.depth <= maxDepth) {
        result.push({ ...c, replies: [] });
        walk(c.replies);
      }
    }
  }
  walk(comments);
  return result;
}

function formatPost(post: RedditPost): string {
  const lines = [
    `## ${post.title}`,
    `- **Subreddit**: r/${post.subreddit}`,
    `- **Auteur**: u/${post.author}`,
    `- **Score**: ${post.score} (${Math.round(post.upvote_ratio * 100)}% upvotes)`,
    `- **Commentaires**: ${post.num_comments}`,
    `- **Date**: ${post.created_date}`,
    `- **Lien**: ${post.permalink}`,
  ];
  if (post.link_flair_text) lines.push(`- **Flair**: ${post.link_flair_text}`);
  if (post.over_18) lines.push(`- **NSFW**: oui`);
  if (post.selftext) {
    lines.push("", "**Contenu:**", post.selftext.length > 2000 ? post.selftext.substring(0, 2000) + "\n…(tronqué)" : post.selftext);
  }
  return lines.join("\n");
}

function formatComment(c: RedditComment, indent = ""): string {
  const lines = [
    `${indent}**u/${c.author}** | Score: ${c.score} | ${c.created_date}`,
    `${indent}${c.body.replace(/\n/g, `\n${indent}`)}`,
  ];
  return lines.join("\n");
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_subreddit_posts",
    description: "Récupère les posts d'un subreddit avec titre, score, nombre de commentaires et date. Supporte les tris: hot, new, top, rising.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: {
          type: "string",
          description: "Nom du subreddit (sans le r/), ex: 'france', 'programming'",
        },
        sort: {
          type: "string",
          enum: ["hot", "new", "top", "rising"],
          description: "Tri des posts (défaut: hot)",
        },
        limit: {
          type: "number",
          description: "Nombre de posts à récupérer (1-100, défaut: 25)",
        },
        time: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          description: "Période pour le tri 'top' (défaut: week)",
        },
        after: {
          type: "string",
          description: "Curseur de pagination (fullname du dernier post, ex: t3_xxxxx)",
        },
      },
      required: ["subreddit"],
    },
  },
  {
    name: "get_post_with_comments",
    description: "Récupère un post Reddit complet avec tous ses commentaires, scores et dates.",
    inputSchema: {
      type: "object",
      properties: {
        post_url: {
          type: "string",
          description: "URL complète du post Reddit ou son chemin (ex: /r/france/comments/xxxxx/...)",
        },
        sort_comments: {
          type: "string",
          enum: ["best", "top", "new", "controversial", "old", "qa"],
          description: "Tri des commentaires (défaut: best)",
        },
        limit_comments: {
          type: "number",
          description: "Nombre max de commentaires racine (défaut: 100)",
        },
        flat: {
          type: "boolean",
          description: "Si true, retourne les commentaires à plat (sans arbre). Défaut: false",
        },
      },
      required: ["post_url"],
    },
  },
  {
    name: "search_reddit",
    description: "Recherche des posts sur Reddit (global ou dans un subreddit).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Termes de recherche",
        },
        subreddit: {
          type: "string",
          description: "Limiter la recherche à ce subreddit (optionnel)",
        },
        sort: {
          type: "string",
          enum: ["relevance", "hot", "top", "new", "comments"],
          description: "Tri des résultats (défaut: relevance)",
        },
        time: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year", "all"],
          description: "Période (défaut: all)",
        },
        limit: {
          type: "number",
          description: "Nombre de résultats (1-100, défaut: 25)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_subreddit_info",
    description: "Récupère les informations et métadonnées d'un subreddit (description, abonnés, date de création, règles).",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: {
          type: "string",
          description: "Nom du subreddit (sans le r/)",
        },
      },
      required: ["subreddit"],
    },
  },
  {
    name: "get_user_posts",
    description: "Récupère les posts et/ou commentaires d'un utilisateur Reddit avec leurs scores et dates.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Nom d'utilisateur Reddit (sans le u/)",
        },
        type: {
          type: "string",
          enum: ["submitted", "comments", "overview"],
          description: "Type de contenu à récupérer (défaut: overview)",
        },
        sort: {
          type: "string",
          enum: ["hot", "new", "top", "controversial"],
          description: "Tri (défaut: new)",
        },
        limit: {
          type: "number",
          description: "Nombre d'éléments (1-100, défaut: 25)",
        },
      },
      required: ["username"],
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────────────────

async function handleGetSubredditPosts(args: Record<string, unknown>): Promise<string> {
  const subreddit = args.subreddit as string;
  const sort = (args.sort as string) || "hot";
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const time = (args.time as string) || "week";
  const after = args.after as string | undefined;

  const params: Record<string, string> = { limit: limit.toString() };
  if (sort === "top") params.t = time;
  if (after) params.after = after;

  const data = await fetchReddit(`/r/${subreddit}/${sort}.json`, params) as {
    data: { children: Array<{ data: Record<string, unknown> }>; after: string | null }
  };

  if (!data.data?.children?.length) {
    return `Aucun post trouvé dans r/${subreddit}.`;
  }

  const posts = data.data.children.map((c) => parsePost(c.data));
  const lines: string[] = [
    `# Posts de r/${subreddit} (${sort})`,
    `Récupéré ${posts.length} posts\n`,
  ];

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    lines.push(
      `### ${i + 1}. ${p.title}`,
      `- Score: **${p.score}** | Commentaires: **${p.num_comments}** | Date: ${p.created_date}`,
      `- Auteur: u/${p.author} | Flair: ${p.link_flair_text || "—"}`,
      `- ID: \`${p.id}\` | Fullname: \`t3_${p.id}\``,
      `- URL: ${p.permalink}`,
      ""
    );
  }

  if (data.data.after) {
    lines.push(`\n**Pagination**: utilisez \`after: "${data.data.after}"\` pour la page suivante.`);
  }

  return lines.join("\n");
}

async function handleGetPostWithComments(args: Record<string, unknown>): Promise<string> {
  let url = args.post_url as string;
  const sortComments = (args.sort_comments as string) || "best";
  const limitComments = Math.min(Math.max(Number(args.limit_comments) || 100, 1), 500);
  const flat = Boolean(args.flat);

  // Normalise l'URL
  if (url.startsWith("https://www.reddit.com")) {
    url = url.replace("https://www.reddit.com", "");
  }
  if (!url.endsWith(".json")) {
    url = url.replace(/\/$/, "") + ".json";
  }

  const data = await fetchReddit(url, {
    sort: sortComments,
    limit: limitComments.toString(),
    depth: "10",
  }) as Array<{ data: { children: Array<Record<string, unknown>> } }>;

  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Réponse inattendue de Reddit.");
  }

  // Post
  const postData = data[0].data.children[0] as { data: Record<string, unknown> };
  const post = parsePost(postData.data);

  // Commentaires
  const rawComments = data[1].data.children as Array<Record<string, unknown>>;
  const comments: RedditComment[] = [];
  for (const c of rawComments) {
    const parsed = parseComment(c, 0);
    if (parsed) comments.push(parsed);
  }

  const lines: string[] = [
    formatPost(post),
    "",
    `---`,
    `## Commentaires (${post.num_comments} total, triés par ${sortComments})`,
    "",
  ];

  if (flat) {
    const flatList = flattenComments(comments);
    for (const c of flatList) {
      const indent = "  ".repeat(c.depth);
      lines.push(formatComment(c, indent), "");
    }
  } else {
    function renderTree(list: RedditComment[], depth: number) {
      const indent = "  ".repeat(depth);
      for (const c of list) {
        lines.push(formatComment(c, indent), "");
        if (c.replies.length > 0) renderTree(c.replies, depth + 1);
      }
    }
    renderTree(comments, 0);
  }

  return lines.join("\n");
}

async function handleSearchReddit(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  const subreddit = args.subreddit as string | undefined;
  const sort = (args.sort as string) || "relevance";
  const time = (args.time as string) || "all";
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

  const path = subreddit ? `/r/${subreddit}/search.json` : `/search.json`;
  const params: Record<string, string> = {
    q: query,
    sort,
    t: time,
    limit: limit.toString(),
    restrict_sr: subreddit ? "1" : "0",
  };

  const data = await fetchReddit(path, params) as {
    data: { children: Array<{ data: Record<string, unknown> }>; after: string | null }
  };

  if (!data.data?.children?.length) {
    return `Aucun résultat pour "${query}".`;
  }

  const posts = data.data.children.map((c) => parsePost(c.data));
  const scope = subreddit ? `r/${subreddit}` : "Reddit";
  const lines: string[] = [
    `# Résultats de recherche: "${query}" sur ${scope}`,
    `${posts.length} résultats (triés par ${sort}, période: ${time})\n`,
  ];

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    lines.push(
      `### ${i + 1}. ${p.title}`,
      `- r/${p.subreddit} | Score: **${p.score}** | Commentaires: **${p.num_comments}**`,
      `- Auteur: u/${p.author} | Date: ${p.created_date}`,
      `- URL: ${p.permalink}`,
      ""
    );
  }

  return lines.join("\n");
}

async function handleGetSubredditInfo(args: Record<string, unknown>): Promise<string> {
  const subreddit = args.subreddit as string;

  const data = await fetchReddit(`/r/${subreddit}/about.json`) as {
    data: Record<string, unknown>
  };

  const d = data.data;
  const lines = [
    `# r/${d.display_name as string}`,
    `**Titre**: ${d.title as string}`,
    `**Abonnés**: ${(d.subscribers as number).toLocaleString("fr-FR")}`,
    `**Actifs**: ${(d.active_user_count as number || 0).toLocaleString("fr-FR")}`,
    `**Créé le**: ${formatDate(d.created_utc as number)}`,
    `**Type**: ${d.subreddit_type as string}`,
    `**NSFW**: ${d.over18 ? "oui" : "non"}`,
    "",
    "**Description:**",
    (d.public_description as string) || (d.description as string) || "—",
  ];

  return lines.join("\n");
}

async function handleGetUserPosts(args: Record<string, unknown>): Promise<string> {
  const username = args.username as string;
  const type = (args.type as string) || "overview";
  const sort = (args.sort as string) || "new";
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

  const data = await fetchReddit(`/user/${username}/${type}.json`, {
    sort,
    limit: limit.toString(),
  }) as { data: { children: Array<{ kind: string; data: Record<string, unknown> }> } };

  if (!data.data?.children?.length) {
    return `Aucun contenu trouvé pour u/${username}.`;
  }

  const lines: string[] = [
    `# Contenu de u/${username} (${type}, trié par ${sort})`,
    `${data.data.children.length} éléments\n`,
  ];

  for (let i = 0; i < data.data.children.length; i++) {
    const item = data.data.children[i];

    if (item.kind === "t3") {
      // Post
      const p = parsePost(item.data);
      lines.push(
        `### ${i + 1}. [POST] ${p.title}`,
        `- r/${p.subreddit} | Score: **${p.score}** | Commentaires: **${p.num_comments}**`,
        `- Date: ${p.created_date}`,
        `- URL: ${p.permalink}`,
        ""
      );
    } else if (item.kind === "t1") {
      // Comment
      const d = item.data;
      lines.push(
        `### ${i + 1}. [COMMENTAIRE] dans r/${d.subreddit as string}`,
        `- Score: **${d.score as number}** | Date: ${formatDate(d.created_utc as number)}`,
        `- Lien: https://www.reddit.com${d.permalink as string}`,
        `> ${(d.body as string).replace(/\n/g, "\n> ").substring(0, 500)}${(d.body as string).length > 500 ? "\n> …(tronqué)" : ""}`,
        ""
      );
    }
  }

  return lines.join("\n");
}


// ── Server factory ─────────────────────────────────────────────────────────

function createServer() {
  const s = new Server(
    { name: "reddit-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      let result: string;
      switch (name) {
        case "get_subreddit_posts":
          result = await handleGetSubredditPosts(args as Record<string, unknown>);
          break;
        case "get_post_with_comments":
          result = await handleGetPostWithComments(args as Record<string, unknown>);
          break;
        case "search_reddit":
          result = await handleSearchReddit(args as Record<string, unknown>);
          break;
        case "get_subreddit_info":
          result = await handleGetSubredditInfo(args as Record<string, unknown>);
          break;
        case "get_user_posts":
          result = await handleGetUserPosts(args as Record<string, unknown>);
          break;
        default:
          throw new Error(`Outil inconnu: ${name}`);
      }
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Erreur: ${message}` }], isError: true };
    }
  });
  return s;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Si PORT est défini (Railway, cloud) → mode HTTP
  // Sinon (Claude Desktop, local) → mode stdio
  if (process.env.PORT) {
    const PORT = parseInt(process.env.PORT);
    const app = express();
    app.use(express.json());

    app.get("/", (_req, res) => {
      res.json({ status: "ok", name: "reddit-mcp", version: "1.0.0" });
    });

    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else {
        const newSession = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSession,
          onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createServer().connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(404).json({ error: "Session introuvable" });
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
      } else {
        res.status(404).json({ error: "Session introuvable" });
      }
    });

    app.listen(PORT, () => {
      console.error(`Reddit MCP server en ligne sur le port ${PORT}`);
    });
  } else {
    // Mode stdio pour Claude Desktop local
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error("Reddit MCP server démarré (stdio)");
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
