#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import compression from "compression";
import express from "express";
import { randomUUID } from "node:crypto";

const VERSION = "2.0.0";
const USER_AGENT = `reddit-mcp/${VERSION} (MCP Server for Reddit data extraction)`;
const BASE_URL = "https://www.reddit.com";
const OAUTH_BASE_URL = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? null;
const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY ?? null;

// ── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry { data: unknown; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

const TTL = {
  info:   10 * 60_000,
  posts:   5 * 60_000,  // 5 min (was 2)
  search:  2 * 60_000,  // 2 min (was 5)
  post:    5 * 60_000,  // 5 min (was 1)
  user:    3 * 60_000,
  docs:   30 * 60_000,  // 30 min for Context7 docs
};

function cacheGet(key: string): unknown | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.data;
}

function cacheSet(key: string, data: unknown, ttl: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// Escape `:` in parts to prevent cache key collisions
function ck(...parts: (string | number | boolean | undefined)[]): string {
  return parts.map(p => String(p ?? "").replace(/:/g, "\\:")).join(":");
}

// Periodic cache GC every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) if (now > e.expiresAt) cache.delete(k);
}, 5 * 60_000).unref();

// ── Reddit OAuth (app-only, optional) ─────────────────────────────────────

let redditToken: { value: string; expiresAt: number } | null = null;

async function getRedditToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (redditToken && Date.now() < redditToken.expiresAt - 300_000) return redditToken.value;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) { console.error("Reddit token fetch failed:", resp.status); return null; }
  const data = await resp.json() as { access_token: string; expires_in: number };
  redditToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return redditToken.value;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  permalink: string;
  selftext: string;
  created_date: string;
  link_flair_text: string | null;
  over_18: boolean;
  stickied: boolean;
  locked: boolean;
  is_video: boolean;
  post_hint: string | null;
  domain: string;
  total_awards_received: number;
  crosspost_parent: string | null;
}

interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_date: string;
  depth: number;
  replies: RedditComment[];
  permalink: string;
  total_awards_received: number;
}

// ── Formatting helpers (declared early for use in parsing) ─────────────────

const SELF_MAX = 2000;
const BODY_MAX = 1000;

function trunc(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + "…(tronqué)" : s;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").substring(0, 19) + " UTC";
}

// Rate limit tracking from Reddit response headers
let rlRemaining = 100;
let rlResetAt = 0;

async function fetchRaw(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const tok = await getRedditToken();
  const base = tok ? OAUTH_BASE_URL : BASE_URL;
  const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
  url.searchParams.set("raw_json", "1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  let lastErr: Error = new Error("Request failed");
  let prevWas429 = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Skip exponential backoff if previous attempt already waited on 429
    if (attempt > 0 && !prevWas429) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    prevWas429 = false;

    const r = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10_000) });

    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get("retry-after") ?? "2", 10);
      const wait = (Number.isNaN(retryAfter) ? 2 : retryAfter) * 1000;
      await new Promise(res => setTimeout(res, wait));
      prevWas429 = true;
      lastErr = new Error("Reddit rate limit hit. Please retry in a moment.");
      continue;
    }
    if (r.status === 403) throw new Error("Accès refusé. Le subreddit est peut-être privé.");
    if (r.status === 404) throw new Error("Introuvable. Vérifiez que le subreddit ou le post existe.");
    if (r.status >= 500) { lastErr = new Error(`Erreur serveur Reddit: ${r.status}`); continue; }
    if (!r.ok) throw new Error(`Erreur API Reddit: ${r.status} ${r.statusText}`);

    // Track rate limit headers for proactive throttling
    const remaining = r.headers.get("x-ratelimit-remaining");
    const reset = r.headers.get("x-ratelimit-reset");
    if (remaining !== null) {
      const parsed = parseFloat(remaining);
      if (!Number.isNaN(parsed)) rlRemaining = parsed;
    }
    if (reset !== null) {
      const parsed = parseFloat(reset);
      if (!Number.isNaN(parsed)) rlResetAt = Date.now() + parsed * 1000;
    }

    if (rlRemaining < 5 && rlResetAt > Date.now()) {
      const delay = rlResetAt - Date.now();
      console.error(`Pause proactive rate-limit: ${delay}ms`);
      await new Promise(res => setTimeout(res, delay));
    }

    return r.json();
  }
  throw lastErr;
}

async function fetchReddit(
  path: string,
  params: Record<string, string> = {},
  cacheKey?: string,
  ttl = 60_000,
): Promise<unknown> {
  if (!cacheKey) return fetchRaw(path, params);

  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const p = fetchRaw(path, params)
    .then(d => { cacheSet(cacheKey, d, ttl); return d; })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, p);
  return p;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parsePost(data: Record<string, unknown>): RedditPost {
  return {
    id:                    data.id as string,
    title:                 data.title as string,
    author:                data.author as string,
    subreddit:             data.subreddit as string,
    score:                 data.score as number,
    upvote_ratio:          data.upvote_ratio as number,
    num_comments:          data.num_comments as number,
    permalink:             `https://www.reddit.com${data.permalink as string}`,
    selftext:              (data.selftext as string) || "",
    created_date:          formatDate(data.created_utc as number),
    link_flair_text:       (data.link_flair_text as string | null) ?? null,
    over_18:               data.over_18 as boolean,
    stickied:              Boolean(data.stickied),
    locked:                Boolean(data.locked),
    is_video:              Boolean(data.is_video),
    post_hint:             (data.post_hint as string | null) ?? null,
    domain:                (data.domain as string) || "",
    total_awards_received: (data.total_awards_received as number) || 0,
    crosspost_parent:      (data.crosspost_parent as string | null) ?? null,
  };
}

function parseComment(data: Record<string, unknown>, depth = 0, maxDepth = 6): RedditComment | null {
  if (depth > maxDepth) return null;
  if (data.kind === "more") return null;
  const d = data.kind === "t1" ? (data.data as Record<string, unknown>) : data;
  if (!d || !d.body || d.body === "[deleted]" || d.body === "[removed]") return null;

  const replies: RedditComment[] = [];
  const rd = d.replies as { data?: { children?: Array<Record<string, unknown>> } } | undefined;
  if (rd?.data?.children) {
    for (const c of rd.data.children) {
      const p = parseComment(c, depth + 1, maxDepth);
      if (p) replies.push(p);
    }
  }

  return {
    id:                    d.id as string,
    author:                (d.author as string) || "[deleted]",
    body:                  trunc(d.body as string, BODY_MAX),
    score:                 d.score as number,
    created_date:          formatDate(d.created_utc as number),
    depth,
    replies,
    permalink:             `https://www.reddit.com${d.permalink as string}`,
    total_awards_received: (d.total_awards_received as number) || 0,
  };
}

function flattenComments(comments: RedditComment[]): RedditComment[] {
  const result: RedditComment[] = [];
  function walk(list: RedditComment[]) {
    for (const c of list) { result.push({ ...c, replies: [] }); walk(c.replies); }
  }
  walk(comments);
  return result;
}

// ── Formatting ─────────────────────────────────────────────────────────────

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
  if (post.link_flair_text)         lines.push(`- **Flair**: ${post.link_flair_text}`);
  if (post.over_18)                  lines.push(`- **NSFW**: oui`);
  if (post.stickied)                 lines.push(`- **Épinglé**: oui`);
  if (post.locked)                   lines.push(`- **Verrouillé**: oui`);
  if (post.is_video)                 lines.push(`- **Vidéo**: oui`);
  if (post.post_hint)                lines.push(`- **Type**: ${post.post_hint}`);
  if (post.domain)                   lines.push(`- **Domaine**: ${post.domain}`);
  if (post.total_awards_received > 0) lines.push(`- **Awards**: ${post.total_awards_received}`);
  if (post.crosspost_parent)         lines.push(`- **Crosspost de**: ${post.crosspost_parent}`);
  if (post.selftext)                 lines.push("", "**Contenu:**", trunc(post.selftext, SELF_MAX));
  return lines.join("\n");
}

function formatComment(c: RedditComment, indent = ""): string {
  const body = c.body.replace(/\n/g, `\n${indent}`);
  const awards = c.total_awards_received > 0 ? ` | Awards: ${c.total_awards_received}` : "";
  return `${indent}**u/${c.author}** | Score: ${c.score}${awards} | ${c.created_date}\n${indent}${body}`;
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_subreddit_posts",
    description: "Récupère les posts d'un subreddit avec titre, score, nombre de commentaires et date. Supporte les tris: hot, new, top, rising.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: { type: "string", description: "Nom du subreddit (sans le r/), ex: 'france', 'programming'" },
        sort: { type: "string", enum: ["hot", "new", "top", "rising"], description: "Tri des posts (défaut: hot)" },
        limit: { type: "number", description: "Nombre de posts à récupérer (1-100, défaut: 25)" },
        time: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Période de temps (défaut: week)" },
        after: { type: "string", description: "Curseur de pagination suivante (fullname du dernier post, ex: t3_xxxxx)" },
        before: { type: "string", description: "Curseur de pagination précédente" },
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
        post_url: { type: "string", description: "URL complète du post Reddit ou son chemin (ex: /r/france/comments/xxxxx/...)" },
        sort_comments: { type: "string", enum: ["best", "top", "new", "controversial", "old", "qa"], description: "Tri des commentaires (défaut: best)" },
        limit_comments: { type: "number", description: "Nombre max de commentaires racine (défaut: 100)" },
        depth: { type: "number", description: "Profondeur max de l'arbre de commentaires (1-10, défaut: 6)" },
        flat: { type: "boolean", description: "Si true, retourne les commentaires à plat (sans arbre). Défaut: false" },
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
        query: { type: "string", description: "Termes de recherche" },
        subreddit: { type: "string", description: "Limiter la recherche à ce subreddit (optionnel)" },
        sort: { type: "string", enum: ["relevance", "hot", "top", "new", "comments"], description: "Tri des résultats (défaut: relevance)" },
        time: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Période (défaut: all)" },
        limit: { type: "number", description: "Nombre de résultats (1-100, défaut: 25)" },
        type: { type: "string", enum: ["link", "self", "comment", "sr"], description: "Filtrer par type (link=lien externe, self=post texte, comment=commentaire, sr=subreddit)" },
        after: { type: "string", description: "Curseur de pagination suivante" },
        before: { type: "string", description: "Curseur de pagination précédente" },
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
        subreddit: { type: "string", description: "Nom du subreddit (sans le r/)" },
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
        username: { type: "string", description: "Nom d'utilisateur Reddit (sans le u/)" },
        type: { type: "string", enum: ["submitted", "comments", "overview"], description: "Type de contenu à récupérer (défaut: overview)" },
        sort: { type: "string", enum: ["hot", "new", "top", "controversial"], description: "Tri (défaut: new)" },
        limit: { type: "number", description: "Nombre d'éléments (1-100, défaut: 25)" },
      },
      required: ["username"],
    },
  },
  {
    name: "search_web",
    description: "Recherche web via Tavily pour obtenir du contexte externe sur des sujets Reddit, vérifier des affirmations ou trouver des sources récentes. Requiert TAVILY_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        query:        { type: "string", description: "Requête de recherche" },
        max_results:  { type: "number", description: "Nombre de résultats (1-10, défaut: 5)" },
        search_depth: { type: "string", enum: ["basic", "advanced"], description: "Profondeur de recherche (défaut: basic)" },
        topic:        { type: "string", enum: ["general", "news"], description: "Type de sujet (défaut: general)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_docs",
    description: "Recherche de documentation officielle via Context7 pour des bibliothèques/frameworks/outils mentionnés dans des posts Reddit (React, Python, Next.js, Docker, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        library:    { type: "string", description: "Nom de la bibliothèque ou du framework (ex: 'react', 'nextjs', 'python', 'docker')" },
        query:      { type: "string", description: "Question ou sujet spécifique dans cette bibliothèque" },
        max_tokens: { type: "number", description: "Taille max du contenu retourné (100-5000, défaut: 3000)" },
      },
      required: ["library", "query"],
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
  const before = args.before as string | undefined;

  const params: Record<string, string> = { limit: limit.toString(), t: time };
  if (after) params.after = after;
  if (before) params.before = before;

  const key = ck("posts", subreddit, sort, limit, time, after ?? "", before ?? "");
  const data = await fetchReddit(`/r/${subreddit}/${sort}.json`, params, key, TTL.posts) as {
    data: { children: Array<{ data: Record<string, unknown> }>; after: string | null; before: string | null }
  };

  if (!data.data?.children?.length) return `Aucun post trouvé dans r/${subreddit}.`;

  const posts = data.data.children.map((c) => parsePost(c.data));
  const lines: string[] = [`# Posts de r/${subreddit} (${sort})\n${posts.length} posts récupérés\n`];

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    lines.push(
      `### ${i + 1}. ${p.title}`,
      `- Score: **${p.score}** | Commentaires: **${p.num_comments}** | Date: ${p.created_date}`,
      `- Auteur: u/${p.author}${p.link_flair_text ? ` | Flair: ${p.link_flair_text}` : ""}${p.over_18 ? " | NSFW" : ""}${p.stickied ? " | Épinglé" : ""}${p.locked ? " | Verrouillé" : ""}`,
      `- URL: ${p.permalink}`,
      ""
    );
  }

  if (data.data.after) {
    lines.push(`**Pagination suivante**: \`after: "${data.data.after}"\``);
  }
  if (data.data.before) {
    lines.push(`**Pagination précédente**: \`before: "${data.data.before}"\``);
  }

  return lines.join("\n");
}

async function handleGetPostWithComments(args: Record<string, unknown>): Promise<string> {
  let url = args.post_url as string;
  if (!url || typeof url !== "string") throw new Error("Erreur: post_url est requis et doit être une chaîne de caractères.");
  const sortComments = (args.sort_comments as string) || "best";
  const limitComments = Math.min(Math.max(Number(args.limit_comments) || 100, 1), 500);
  const maxDepth = Math.min(Math.max(Number(args.depth) || 6, 1), 10);
  const flat = Boolean(args.flat);

  if (url.startsWith("https://www.reddit.com")) url = url.replace("https://www.reddit.com", "");
  if (!url.endsWith(".json")) url = url.replace(/\/$/, "") + ".json";

  // limitComments excluded from cache key — same API data works for all limits
  // depth IS included since Reddit returns different tree depths per value
  const key = ck("post", url, sortComments, maxDepth);
  const data = await fetchReddit(url, { sort: sortComments, limit: limitComments.toString(), depth: maxDepth.toString() }, key, TTL.post) as
    Array<{ data: { children: Array<Record<string, unknown>> } }>;

  if (!Array.isArray(data) || data.length < 2) throw new Error("Réponse inattendue de Reddit.");

  const children0 = data[0]?.data?.children;
  if (!children0?.length) throw new Error("Réponse inattendue: aucun post dans la réponse.");
  const postData = children0[0] as { data: Record<string, unknown> };
  if (!postData?.data) throw new Error("Données du post manquantes.");
  const post = parsePost(postData.data);

  const children1 = data[1]?.data?.children;
  if (!Array.isArray(children1)) throw new Error("Réponse inattendue: pas de commentaires.");
  const comments: RedditComment[] = [];
  for (const c of children1) {
    const parsed = parseComment(c, 0, maxDepth);
    if (parsed) comments.push(parsed);
  }

  const lines: string[] = [
    formatPost(post),
    "",
    "---",
    `## Commentaires (${post.num_comments} total, triés par ${sortComments})`,
    "",
  ];

  if (flat) {
    for (const c of flattenComments(comments)) {
      lines.push(formatComment(c, "  ".repeat(c.depth)), "");
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
  const postType = args.type as string | undefined;
  const after = args.after as string | undefined;
  const before = args.before as string | undefined;

  const path = subreddit ? `/r/${subreddit}/search.json` : `/search.json`;
  const params: Record<string, string> = {
    q: query, sort, t: time, limit: limit.toString(), restrict_sr: subreddit ? "1" : "0",
  };
  if (postType) params.type = postType;
  if (after) params.after = after;
  if (before) params.before = before;

  const key = ck("search", subreddit ?? "", query, sort, time, limit, postType ?? "", after ?? "", before ?? "");
  const data = await fetchReddit(path, params, key, TTL.search) as {
    data: { children: Array<{ data: Record<string, unknown> }>; after: string | null; before: string | null }
  };

  if (!data.data?.children?.length) return `Aucun résultat pour "${query}".`;

  const posts = data.data.children.map((c) => parsePost(c.data));
  const scope = subreddit ? `r/${subreddit}` : "Reddit";
  const lines: string[] = [
    `# Résultats: "${query}" sur ${scope}`,
    `${posts.length} résultats (triés par ${sort}, période: ${time}${postType ? `, type: ${postType}` : ""})\n`,
  ];

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    lines.push(
      `### ${i + 1}. ${p.title}`,
      `- r/${p.subreddit} | Score: **${p.score}** | Commentaires: **${p.num_comments}**`,
      `- Auteur: u/${p.author} | Date: ${p.created_date}${p.link_flair_text ? ` | Flair: ${p.link_flair_text}` : ""}`,
      `- URL: ${p.permalink}`,
      ""
    );
  }

  if (data.data.after) lines.push(`**Pagination suivante**: \`after: "${data.data.after}"\``);
  if (data.data.before) lines.push(`**Pagination précédente**: \`before: "${data.data.before}"\``);

  return lines.join("\n");
}

async function handleGetSubredditInfo(args: Record<string, unknown>): Promise<string> {
  const subreddit = args.subreddit as string;
  const key = ck("info", subreddit);
  const data = await fetchReddit(`/r/${subreddit}/about.json`, {}, key, TTL.info) as { data: Record<string, unknown> };

  const d = data.data;
  return [
    `# r/${d.display_name as string}`,
    `**Titre**: ${d.title as string}`,
    `**Abonnés**: ${(d.subscribers as number).toLocaleString("fr-FR")}`,
    `**Actifs**: ${((d.active_user_count as number) || 0).toLocaleString("fr-FR")}`,
    `**Créé le**: ${formatDate(d.created_utc as number)}`,
    `**Type**: ${d.subreddit_type as string}`,
    `**NSFW**: ${d.over18 ? "oui" : "non"}`,
    "",
    "**Description:**",
    (d.public_description as string) || (d.description as string) || "—",
  ].join("\n");
}

async function handleGetUserPosts(args: Record<string, unknown>): Promise<string> {
  const username = args.username as string;
  const type = (args.type as string) || "overview";
  const sort = (args.sort as string) || "new";
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

  const key = ck("user", username, type, sort, limit);
  const data = await fetchReddit(`/user/${username}/${type}.json`, { sort, limit: limit.toString() }, key, TTL.user) as {
    data: { children: Array<{ kind: string; data: Record<string, unknown> }> }
  };

  if (!data.data?.children?.length) return `Aucun contenu trouvé pour u/${username}.`;

  const lines: string[] = [`# Contenu de u/${username} (${type}, trié par ${sort})\n${data.data.children.length} éléments\n`];

  for (let i = 0; i < data.data.children.length; i++) {
    const item = data.data.children[i];
    if (item.kind === "t3") {
      const p = parsePost(item.data);
      lines.push(
        `### ${i + 1}. [POST] ${p.title}`,
        `- r/${p.subreddit} | Score: **${p.score}** | Commentaires: **${p.num_comments}**`,
        `- Date: ${p.created_date}`,
        `- URL: ${p.permalink}`,
        ""
      );
    } else if (item.kind === "t1") {
      const d = item.data;
      const body = trunc((d.body as string), BODY_MAX);
      lines.push(
        `### ${i + 1}. [COMMENTAIRE] dans r/${d.subreddit as string}`,
        `- Score: **${d.score as number}** | Date: ${formatDate(d.created_utc as number)}`,
        `- Lien: https://www.reddit.com${d.permalink as string}`,
        `> ${body.replace(/\n/g, "\n> ")}`,
        ""
      );
    }
  }

  return lines.join("\n");
}

async function handleSearchWeb(args: Record<string, unknown>): Promise<string> {
  if (!TAVILY_API_KEY) {
    return "Erreur: TAVILY_API_KEY non configuré. Définissez cette variable d'environnement pour utiliser search_web.";
  }

  const query       = args.query as string;
  const maxResults  = Math.min(Math.max(Number(args.max_results) || 5, 1), 10);
  const searchDepth = (args.search_depth as string) || "basic";
  const topic       = (args.topic as string) || "general";

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: searchDepth,
      topic,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    if (resp.status === 401) return "Erreur: Clé API Tavily invalide ou expirée.";
    if (resp.status === 429) return "Erreur: Limite de taux Tavily atteinte. Réessayez dans un moment.";
    return `Erreur Tavily: ${resp.status} ${resp.statusText}`;
  }

  interface TavilyResult { title: string; url: string; content: string; score?: number; }
  interface TavilyResponse { results: TavilyResult[]; query: string; }

  const data = await resp.json() as TavilyResponse;

  if (!data.results?.length) return `Aucun résultat web pour "${query}".`;

  const lines: string[] = [
    `# Résultats web: "${query}"`,
    `${data.results.length} résultat(s) via Tavily\n`,
  ];

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    lines.push(
      `### ${i + 1}. ${r.title}`,
      `- **URL**: ${r.url}`,
      `- ${trunc(r.content, 500)}`,
      ""
    );
  }

  return lines.join("\n");
}

async function handleSearchDocs(args: Record<string, unknown>): Promise<string> {
  const library   = args.library as string;
  const query     = args.query as string;
  const maxTokens = Math.min(Math.max(Number(args.max_tokens) || 3000, 100), 5000);

  const cacheKey = ck("docs", library, query, maxTokens);
  const cached = cacheGet(cacheKey);
  if (cached !== null && typeof cached === "string") return cached;

  const c7Headers: Record<string, string> = { Accept: "application/json" };
  if (CONTEXT7_API_KEY) c7Headers["Authorization"] = `Bearer ${CONTEXT7_API_KEY}`;

  // Step 1: Resolve library ID
  const resolveUrl = new URL("https://mcp.context7.com/v1/libraries");
  resolveUrl.searchParams.set("query", library);

  const resolveResp = await fetch(resolveUrl.toString(), {
    headers: c7Headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!resolveResp.ok) {
    if (resolveResp.status === 401) return "Erreur: Clé API Context7 invalide.";
    return `Erreur Context7 (résolution): ${resolveResp.status} ${resolveResp.statusText}`;
  }

  interface C7Library { id: string; name: string; description?: string; }
  interface C7ResolveResponse { libraries?: C7Library[]; results?: C7Library[]; }

  const resolved = await resolveResp.json() as C7ResolveResponse;
  const libs = Array.isArray(resolved.libraries) ? resolved.libraries :
               Array.isArray(resolved.results) ? resolved.results : [];
  if (!libs.length) {
    return `Aucune bibliothèque trouvée pour "${library}" dans Context7. Essayez un nom plus précis (ex: "react", "vue", "django").`;
  }

  const libraryId = libs[0].id;
  const libraryName = libs[0].name;

  // Step 2: Query docs
  const docsUrl = new URL(`https://mcp.context7.com/v1/libraries/${encodeURIComponent(libraryId)}/docs`);
  docsUrl.searchParams.set("query", query);
  docsUrl.searchParams.set("maxTokens", maxTokens.toString());

  const docsResp = await fetch(docsUrl.toString(), {
    headers: c7Headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!docsResp.ok) {
    return `Erreur Context7 (docs): ${docsResp.status} ${docsResp.statusText}`;
  }

  interface C7DocsResponse { content?: string; text?: string; }
  const docs = await docsResp.json() as C7DocsResponse;
  const content = docs.content ?? docs.text ?? "";

  if (!content) {
    return `Aucune documentation trouvée pour "${query}" dans ${libraryName}.`;
  }

  const result = [
    `# Documentation: ${libraryName}`,
    `**Source**: Context7 (https://context7.com)`,
    `**Requête**: ${query}`,
    `**Bibliothèque ID**: \`${libraryId}\``,
    "",
    "---",
    "",
    content,
  ].join("\n");

  cacheSet(cacheKey, result, TTL.docs);
  return result;
}

// ── Server factory ─────────────────────────────────────────────────────────

function createServer() {
  const s = new Server(
    { name: "reddit-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      let result: string;
      switch (name) {
        case "get_subreddit_posts":    result = await handleGetSubredditPosts(args as Record<string, unknown>); break;
        case "get_post_with_comments": result = await handleGetPostWithComments(args as Record<string, unknown>); break;
        case "search_reddit":          result = await handleSearchReddit(args as Record<string, unknown>); break;
        case "get_subreddit_info":     result = await handleGetSubredditInfo(args as Record<string, unknown>); break;
        case "get_user_posts":         result = await handleGetUserPosts(args as Record<string, unknown>); break;
        case "search_web":             result = await handleSearchWeb(args as Record<string, unknown>); break;
        case "search_docs":            result = await handleSearchDocs(args as Record<string, unknown>); break;
        default: throw new Error(`Outil inconnu: ${name}`);
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

const startTime = Date.now();

async function main() {
  if (!TAVILY_API_KEY) {
    console.error("Avertissement: TAVILY_API_KEY non défini — search_web non fonctionnel.");
  }
  if (!CONTEXT7_API_KEY) {
    console.error("Info: CONTEXT7_API_KEY non défini — search_docs fonctionne sans clé (limite de débit réduite).");
  }

  if (process.env.PORT) {
    const PORT = parseInt(process.env.PORT || "3000", 10);
    if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) throw new Error(`PORT invalide: ${process.env.PORT}`);
    const app = express();
    app.use(compression());
    app.use(express.json());

    app.get("/", (_req, res) => {
      res.json({
        status: "ok",
        name: "reddit-mcp",
        version: VERSION,
        uptime_s: Math.floor((Date.now() - startTime) / 1000),
        cache_entries: cache.size,
        reddit_oauth: !!(process.env.REDDIT_CLIENT_ID),
        tavily_configured: !!TAVILY_API_KEY,
        context7_configured: !!CONTEXT7_API_KEY,
        rate_limit_remaining: rlRemaining,
      });
    });

    const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastSeen: number }>();

    // Clean up sessions idle for > 1 hour
    setInterval(() => {
      const cutoff = Date.now() - 60 * 60_000;
      for (const [id, s] of transports) {
        if (s.lastSeen < cutoff) transports.delete(id);
      }
    }, 10 * 60_000).unref();

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        const s = transports.get(sessionId)!;
        s.lastSeen = Date.now();
        transport = s.transport;
      } else if (sessionId && !transports.has(sessionId)) {
        // Stale or unknown session — tell the client to reinitialize
        res.status(404).json({ error: "Session expirée ou introuvable. Veuillez réinitialiser la connexion MCP." });
        return;
      } else {
        const newSession = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSession,
          onsessioninitialized: (id) => {
            transports.set(id, { transport, lastSeen: Date.now() });
          },
        });
        // Use closure over newSession to avoid transport.sessionId race condition
        transport.onclose = () => { transports.delete(newSession); };
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
      const s = transports.get(sessionId)!;
      s.lastSeen = Date.now();
      await s.transport.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.status(404).json({ error: "Session introuvable" });
      }
    });

    app.listen(PORT, () => {
      const auth = process.env.REDDIT_CLIENT_ID ? "OAuth" : "anonyme";
      console.error(`Reddit MCP v${VERSION} démarré sur le port ${PORT} (Reddit: ${auth})`);
    });
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error(`Reddit MCP v${VERSION} démarré (stdio)`);
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
