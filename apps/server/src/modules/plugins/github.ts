import { validatePluginManifest, type SolPluginDistribution, type SolPluginManifest } from "./types.js";

export interface GithubPluginPreview {
  repository: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  authenticated: boolean;
  manifest: SolPluginManifest;
  distribution: SolPluginDistribution;
}

interface GithubRepoResponse {
  full_name?: string;
  html_url?: string;
  default_branch?: string;
  private?: boolean;
}

interface GithubContentResponse {
  encoding?: string;
  content?: string;
}

interface GithubReleaseAsset {
  name?: string;
  url?: string;
  browser_download_url?: string;
}

interface GithubReleaseResponse {
  tag_name?: string;
  assets?: GithubReleaseAsset[];
}

function token(): string | undefined {
  const value = process.env.SOL_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return value || undefined;
}

function headers(accept = "application/vnd.github+json"): Record<string, string> {
  const result: Record<string, string> = {
    Accept: accept,
    "User-Agent": "SOL-PluginManager/1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const accessToken = token();
  if (accessToken) result.Authorization = `Bearer ${accessToken}`;
  return result;
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    const suffix = response.status === 404
      ? "repository_or_plugin_manifest_not_found"
      : `github_http_${response.status}`;
    throw new Error(suffix);
  }
  return await response.json() as T;
}

export function parseGithubRepository(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("github_repository_required");
  const simple = raw.replace(/^github:/i, "").replace(/\.git$/i, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(simple)) return simple;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_github_repository"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new Error("invalid_github_repository");
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error("invalid_github_repository");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid_github_repository");
  return `${owner}/${repo}`;
}

export async function inspectGithubPlugin(value: string): Promise<GithubPluginPreview> {
  const repository = parseGithubRepository(value);
  const repo = await githubJson<GithubRepoResponse>(`https://api.github.com/repos/${repository}`);
  const defaultBranch = repo.default_branch?.trim() || "main";
  const content = await githubJson<GithubContentResponse>(
    `https://api.github.com/repos/${repository}/contents/sol-plugin.json?ref=${encodeURIComponent(defaultBranch)}`,
  );
  if (content.encoding !== "base64" || typeof content.content !== "string") throw new Error("invalid_github_plugin_manifest");
  const raw = Buffer.from(content.content.replace(/\s+/g, ""), "base64").toString("utf8");
  let manifest: SolPluginManifest;
  try { manifest = validatePluginManifest(JSON.parse(raw) as unknown); }
  catch (error) { throw new Error(`invalid_github_plugin_manifest:${error instanceof Error ? error.message : String(error)}`); }
  if (!manifest.distribution) throw new Error("github_plugin_distribution_missing");
  return {
    repository: repo.full_name || repository,
    htmlUrl: repo.html_url || `https://github.com/${repository}`,
    defaultBranch,
    private: repo.private === true,
    authenticated: !!token(),
    manifest,
    distribution: manifest.distribution,
  };
}

export async function downloadGithubPlugin(preview: GithubPluginPreview, maxBytes = 64 * 1024 * 1024): Promise<{ bytes: Buffer; releaseTag: string }> {
  const distribution = preview.distribution;
  const releaseEndpoint = distribution.tag
    ? `https://api.github.com/repos/${preview.repository}/releases/tags/${encodeURIComponent(distribution.tag)}`
    : `https://api.github.com/repos/${preview.repository}/releases/latest`;
  const release = await githubJson<GithubReleaseResponse>(releaseEndpoint);
  const asset = (release.assets || []).find((candidate) => candidate.name === distribution.asset);
  if (!asset) throw new Error(`github_release_asset_not_found:${distribution.asset}`);
  const accessToken = token();
  const downloadUrl = accessToken && asset.url ? asset.url : asset.browser_download_url;
  if (!downloadUrl) throw new Error("github_release_asset_missing_download_url");
  const response = await fetch(downloadUrl, {
    headers: accessToken && asset.url ? headers("application/octet-stream") : { "User-Agent": "SOL-PluginManager/1" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`github_asset_http_${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("plugin_package_too_large");
  const array = new Uint8Array(await response.arrayBuffer());
  if (array.byteLength > maxBytes) throw new Error("plugin_package_too_large");
  return { bytes: Buffer.from(array), releaseTag: release.tag_name || distribution.tag || "latest" };
}
