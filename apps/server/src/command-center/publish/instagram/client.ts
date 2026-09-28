// @effect-diagnostics globalFetch:off globalTimers:off preferSchemaOverJson:off
/**
 * Ported verbatim from an earlier app's `lib/instagram/client.ts` (config import and
 * exactOptionalPropertyTypes-compatible error fields are the only changes).
 *
 * Typed client for the Instagram Graph API using "Instagram API with Instagram
 * Login" (host graph.instagram.com — NOT the Facebook-Page graph.facebook.com
 * flow).
 *
 * Endpoints, parameter names, and the API version below were verified against
 * the live Meta docs on 2026-09-25:
 *   - API with Instagram Login (host, scopes, token):
 *     https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 *   - Content publishing (/media, /media_publish, container status_code):
 *     https://developers.facebook.com/docs/instagram-platform/content-publishing
 *   - Long-lived token refresh (GET /refresh_access_token, grant_type=ig_refresh_token, 60-day tokens):
 *     https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
 *   - Insights (media metric=..., account metric/period):
 *     https://developers.facebook.com/docs/instagram-platform/insights
 *   - /me (GET https://graph.instagram.com/v{ver}/me?fields=user_id,username,account_type):
 *     https://developers.facebook.com/docs/instagram-platform/reference/me
 *   - Current Graph API version = v26.0 (released 2026-07-29):
 *     https://developers.facebook.com/docs/graph-api/changelog
 *
 * SECURITY: the access token is passed as an Authorization: Bearer header (or,
 * for /refresh_access_token which requires it, an access_token query param). It
 * is NEVER included in a thrown error message, log line, or Sentry breadcrumb —
 * every outbound string is passed through redact() first.
 */

import { instagramGraphBaseUrl } from "./config.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface InstagramClientOptions {
  accessToken: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Override the base URL (e.g. https://graph.instagram.com/v26.0). */
  baseUrl?: string;
  /** Per-request timeout in ms (covers headers and body). Defaults to 15s. */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface GraphErrorFields {
  message: string;
  status?: number | undefined;
  code?: number | undefined;
  subcode?: number | undefined;
  type?: string | undefined;
  fbtraceId?: string | undefined;
  /** Path only — never carries the token-bearing query string. */
  endpoint?: string | undefined;
}

interface GraphErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * Error thrown for any non-OK Graph response or transport failure. Carries the
 * Graph error code/subcode/type/fbtrace_id for diagnosis. The `message` is
 * already redacted; nothing on this object contains the access token.
 */
export class InstagramApiError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  readonly fbtraceId: string | undefined;
  readonly endpoint: string | undefined;

  constructor(fields: GraphErrorFields) {
    super(fields.message);
    this.name = "InstagramApiError";
    this.status = fields.status;
    this.code = fields.code;
    this.subcode = fields.subcode;
    this.type = fields.type;
    this.fbtraceId = fields.fbtraceId;
    this.endpoint = fields.endpoint;
  }
}

export interface InstagramUser {
  user_id: string;
  username: string;
  account_type?: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until the refreshed token expires (~60 days). */
  expires_in: number;
}

export interface CreateContainerResponse {
  id: string;
}

export interface PublishMediaResponse {
  id: string;
}

/** A media object as returned on the /{ig-user-id}/media edge. */
export interface UserMediaItem {
  id: string;
  caption?: string;
  /** ISO 8601, e.g. "2026-09-25T22:36:43+0000". */
  timestamp?: string;
  permalink?: string;
  media_type?: string;
}

export interface UserMediaResponse {
  data: UserMediaItem[];
  paging?: unknown;
}

export type ContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export interface ContainerStatus {
  id: string;
  status_code: ContainerStatusCode;
}

/** A single insight metric row as returned under `data`. */
export interface InsightValue {
  name: string;
  period?: string;
  title?: string;
  description?: string;
  values?: Array<{ value: unknown; end_time?: string }>;
  total_value?: { value: unknown };
  [key: string]: unknown;
}

export interface InsightsResponse {
  data: InsightValue[];
  paging?: unknown;
}

/** user_tags entry. x/y are only meaningful for feed image tagging. */
export interface UserTag {
  username: string;
  x?: number;
  y?: number;
}

export type CreateMediaContainerParams =
  | {
      mediaType: "IMAGE";
      imageUrl: string;
      caption?: string;
      userTags?: UserTag[];
      altText?: string;
      /** true when this container is a child of a carousel. */
      isCarouselItem?: boolean;
    }
  | {
      mediaType: "REELS";
      videoUrl: string;
      caption?: string;
      userTags?: UserTag[];
      isCarouselItem?: boolean;
    }
  | {
      mediaType: "CAROUSEL";
      /** Child container IDs, in order (max 10). */
      children: string[];
      caption?: string;
    };

export interface AccountInsightsParams {
  metrics: string[];
  period?: string;
  metricType?: string;
  timeframe?: string;
  since?: number;
  until?: number;
}

type QueryValue = string | number | boolean | undefined;

export class InstagramClient {
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: InstagramClientOptions) {
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.baseUrl = options.baseUrl ?? instagramGraphBaseUrl();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Replace every occurrence of the access token with a placeholder. */
  private redact(input: string): string {
    if (!this.accessToken) return input;
    return input.split(this.accessToken).join("[REDACTED]");
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      query?: Record<string, QueryValue>;
      /** Where to place the token. Defaults to the Authorization header. */
      tokenIn?: "header" | "query";
    } = {},
  ): Promise<T> {
    const { method = "GET", query = {}, tokenIn = "header" } = options;
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (tokenIn === "header") {
      headers.Authorization = `Bearer ${this.accessToken}`;
    } else {
      url.searchParams.set("access_token", this.accessToken);
    }

    let response: Response;
    let body: string;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = await response.text();
    } catch (error) {
      throw new InstagramApiError({
        message: `Instagram request failed: ${this.redact(
          error instanceof Error ? error.message : String(error),
        )}`,
        endpoint: path,
      });
    }

    let parsed: unknown;
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const graphError = (parsed as GraphErrorEnvelope | undefined)?.error;
      throw new InstagramApiError({
        message: this.redact(
          graphError?.message ?? `Instagram API error (HTTP ${response.status})`,
        ),
        status: response.status,
        code: graphError?.code,
        subcode: graphError?.error_subcode,
        type: graphError?.type,
        fbtraceId: graphError?.fbtrace_id,
        endpoint: path,
      });
    }

    return (parsed ?? {}) as T;
  }

  /**
   * Resolve the token's owner. GET /me?fields=user_id,username,account_type.
   * Used to validate a pasted token before we persist it.
   */
  async getMe(fields: string[] = ["user_id", "username", "account_type"]): Promise<InstagramUser> {
    return this.request<InstagramUser>("/me", {
      query: { fields: fields.join(",") },
    });
  }

  /**
   * Refresh a long-lived token. GET /refresh_access_token requires the token as
   * a query param (grant_type=ig_refresh_token). Returns a token valid ~60 days.
   */
  async refreshLongLivedToken(): Promise<RefreshTokenResponse> {
    return this.request<RefreshTokenResponse>("/refresh_access_token", {
      query: { grant_type: "ig_refresh_token" },
      tokenIn: "query",
    });
  }

  /**
   * Create a media container. POST /{ig-user-id}/media.
   *   IMAGE    -> image_url (+ caption, alt_text, user_tags, is_carousel_item)
   *   REELS    -> media_type=REELS, video_url (+ caption, user_tags)
   *   CAROUSEL -> media_type=CAROUSEL, children=<comma-separated ids>
   */
  async createMediaContainer(
    igUserId: string,
    params: CreateMediaContainerParams,
  ): Promise<CreateContainerResponse> {
    const query: Record<string, QueryValue> = {};
    if (params.caption !== undefined) query.caption = params.caption;

    if (params.mediaType === "IMAGE") {
      query.image_url = params.imageUrl;
      if (params.altText !== undefined) query.alt_text = params.altText;
      if (params.isCarouselItem) query.is_carousel_item = true;
      if (params.userTags && params.userTags.length > 0) {
        query.user_tags = JSON.stringify(params.userTags);
      }
    } else if (params.mediaType === "REELS") {
      query.media_type = "REELS";
      query.video_url = params.videoUrl;
      if (params.isCarouselItem) query.is_carousel_item = true;
      if (params.userTags && params.userTags.length > 0) {
        query.user_tags = JSON.stringify(params.userTags);
      }
    } else {
      query.media_type = "CAROUSEL";
      query.children = params.children.join(",");
    }

    return this.request<CreateContainerResponse>(`/${encodeURIComponent(igUserId)}/media`, {
      method: "POST",
      query,
    });
  }

  /**
   * Fetch fields on a published media object. GET /{ig-media-id}?fields=...
   * Used after publish to read the canonical `permalink` (the media_publish
   * response only returns the new media id).
   */
  async getMediaFields(
    mediaId: string,
    fields: string[] = ["permalink"],
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/${encodeURIComponent(mediaId)}`, {
      query: { fields: fields.join(",") },
    });
  }

  /** Convenience wrapper: resolve just the permalink of a published media. */
  async getMediaPermalink(mediaId: string): Promise<string | null> {
    const data = await this.getMediaFields(mediaId, ["permalink"]);
    const permalink = data.permalink;
    return typeof permalink === "string" ? permalink : null;
  }

  /**
   * Recent media on the account. GET /{ig-user-id}/media?fields=...&limit=N.
   * Used to recover a media id when a container reports status_code=PUBLISHED
   * (already published) yet we never recorded the resulting media — so we can
   * mark the post published WITHOUT ever re-calling media_publish.
   */
  async getUserMedia(
    igUserId: string,
    options: { fields?: string[]; limit?: number } = {},
  ): Promise<UserMediaResponse> {
    const fields = options.fields ?? ["id", "caption", "timestamp", "permalink"];
    const query: Record<string, QueryValue> = { fields: fields.join(",") };
    if (options.limit !== undefined) query.limit = options.limit;
    return this.request<UserMediaResponse>(`/${encodeURIComponent(igUserId)}/media`, { query });
  }

  /** Poll container readiness. GET /{container-id}?fields=status_code. */
  async getContainerStatus(containerId: string): Promise<ContainerStatus> {
    return this.request<ContainerStatus>(`/${encodeURIComponent(containerId)}`, {
      query: { fields: "status_code" },
    });
  }

  /** Publish a finished container. POST /{ig-user-id}/media_publish. */
  async publishMedia(igUserId: string, creationId: string): Promise<PublishMediaResponse> {
    return this.request<PublishMediaResponse>(`/${encodeURIComponent(igUserId)}/media_publish`, {
      method: "POST",
      query: { creation_id: creationId },
    });
  }

  /** Current publishing rate-limit usage. GET /{ig-user-id}/content_publishing_limit. */
  async getContentPublishingLimit(
    igUserId: string,
    fields: string[] = ["config", "quota_usage"],
  ): Promise<InsightsResponse> {
    return this.request<InsightsResponse>(
      `/${encodeURIComponent(igUserId)}/content_publishing_limit`,
      { query: { fields: fields.join(",") } },
    );
  }

  /** Per-media metrics. GET /{ig-media-id}/insights?metric=reach,likes,... */
  async getMediaInsights(mediaId: string, metrics: string[]): Promise<InsightsResponse> {
    return this.request<InsightsResponse>(`/${encodeURIComponent(mediaId)}/insights`, {
      query: { metric: metrics.join(",") },
    });
  }

  /** Account-level metrics. GET /{ig-user-id}/insights?metric=...&period=... */
  async getAccountInsights(
    igUserId: string,
    params: AccountInsightsParams,
  ): Promise<InsightsResponse> {
    const query: Record<string, QueryValue> = {
      metric: params.metrics.join(","),
    };
    if (params.period !== undefined) query.period = params.period;
    if (params.metricType !== undefined) query.metric_type = params.metricType;
    if (params.timeframe !== undefined) query.timeframe = params.timeframe;
    if (params.since !== undefined) query.since = params.since;
    if (params.until !== undefined) query.until = params.until;

    return this.request<InsightsResponse>(`/${encodeURIComponent(igUserId)}/insights`, { query });
  }
}
