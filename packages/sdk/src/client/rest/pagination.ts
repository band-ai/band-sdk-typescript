import { UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { ChatMessageType } from "../../contracts/chatEvents";
import type { RestRequestOptions } from "./requestOptions";
import { OPTIONAL_UNSUPPORTED_MESSAGES } from "./unsupportedMessages";
import type { ContextRestApi, PaginatedResponse, PaginationMetadata, PeerLookupRestApi, PlatformChatMessage } from "./types";
import type { PeerRecord } from "../../contracts/dtos";

interface FetchPageRequest {
  page: number;
  pageSize: number;
}

export type PaginationStrategy = "auto" | "total_pages" | "until_empty";
export type PaginationMetadataValidation = "strategy_aware" | "strict" | "lossy";

export interface PaginationOptions {
  // Positive integer. Defaults to 100.
  pageSize?: number;
  // Positive integer. Defaults to 100.
  maxPages?: number;
  // Pagination termination mode. Defaults to "auto".
  // auto: uses metadata.totalPages when present, otherwise falls back to empty page detection.
  // total_pages: requires metadata.totalPages to be a positive integer.
  // until_empty: continues until an empty page is returned.
  strategy?: PaginationStrategy;
  // Metadata validation mode.
  // strategy_aware: strict when metadata is used for termination, lossy for until_empty.
  // strict: always validate metadata keys when present.
  // lossy: always normalize invalid metadata fields to undefined.
  metadataValidation?: PaginationMetadataValidation;
}

interface FetchPaginatedOptions<T> extends PaginationOptions {
  fetchPage: (request: FetchPageRequest) => Promise<PaginatedResponse<T>>;
}

/** The page size a paged walk asks for. */
export const DEFAULT_PAGE_SIZE = 100;
/** The most pages one walk reads. */
export const DEFAULT_MAX_PAGES = 100;
type PaginationMetadataMode = "strict" | "lossy";
const VALID_PAGINATION_STRATEGIES: ReadonlySet<PaginationStrategy> = new Set([
  "auto",
  "total_pages",
  "until_empty",
]);

export function normalizePaginationMetadata(
  metadata?: Record<string, unknown> | PaginationMetadata,
  options?: { mode?: PaginationMetadataMode },
): PaginationMetadata {
  if (!metadata) {
    return {};
  }

  const mode = options?.mode ?? "strict";
  const snakeCaseMetadata = metadata as Record<string, unknown>;
  const pageRaw = metadata.page ?? snakeCaseMetadata.page;
  const pageSizeRaw = metadata.pageSize ?? snakeCaseMetadata.page_size;
  const totalPagesRaw = metadata.totalPages ?? snakeCaseMetadata.total_pages;
  const totalCountRaw = metadata.totalCount ?? snakeCaseMetadata.total_count;

  // Build passthrough excluding both camelCase and snake_case pagination keys.
  const PAGINATION_KEYS = new Set([
    "page", "pageSize", "totalPages", "totalCount",
    "page_size", "total_pages", "total_count",
  ]);
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!PAGINATION_KEYS.has(key)) {
      passthrough[key] = value;
    }
  }

  const page = toPositiveInteger(pageRaw);
  const pageSize = toPositiveInteger(pageSizeRaw);
  const totalPages = toNonNegativeInteger(totalPagesRaw);
  const totalCount = toNonNegativeInteger(totalCountRaw);

  if (mode === "strict") {
    assertValidMetadataField("page", pageRaw, page);
    assertValidMetadataField("pageSize", pageSizeRaw, pageSize);
    assertValidMetadataField("totalPages", totalPagesRaw, totalPages);
    assertValidMetadataField("totalCount", totalCountRaw, totalCount);
  }

  return {
    ...passthrough,
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
}

function assertValidMetadataField(
  field: string,
  rawValue: unknown,
  normalizedValue: number | undefined,
): void {
  if (rawValue === undefined) {
    return;
  }

  if (normalizedValue === undefined) {
    throw new ValidationError(
      `Invalid pagination metadata '${field}': expected an integer with valid bounds`,
    );
  }
}

export async function fetchPaginated<T>(options: FetchPaginatedOptions<T>): Promise<T[]> {
  const pageSize = resolvePositiveInteger("pageSize", options.pageSize, DEFAULT_PAGE_SIZE);
  const maxPages = resolvePositiveInteger("maxPages", options.maxPages, DEFAULT_MAX_PAGES);
  const strategy = resolvePaginationStrategy(options.strategy);
  const metadataValidation = options.metadataValidation ?? "strategy_aware";
  const allItems: T[] = [];
  let completed = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await options.fetchPage({ page, pageSize });
    if (!Array.isArray(response.data)) {
      throw new ValidationError("Paginated response.data must be an array");
    }

    const items = response.data;
    allItems.push(...items);

    const metadata = normalizePaginationMetadata(response.metadata, {
      mode: resolveMetadataMode(strategy, metadataValidation),
    });
    const totalPages = metadata.totalPages;
    if (strategy === "total_pages") {
      if (typeof totalPages !== "number" || totalPages <= 0) {
        throw new ValidationError(
          "Pagination strategy 'total_pages' requires metadata.totalPages to be a positive number",
        );
      }

      if (page >= totalPages) {
        completed = true;
        break;
      }
      continue;
    }

    if (strategy === "until_empty" && items.length === 0) {
      completed = true;
      break;
    }

    if (strategy === "auto") {
      if (typeof totalPages === "number" && totalPages > 0) {
        if (page >= totalPages) {
          completed = true;
          break;
        }
        continue;
      }

      if (items.length === 0) {
        completed = true;
        break;
      }
    }
  }

  if (!completed) {
    throw new ValidationError(
      `Pagination stopped after maxPages=${maxPages} before reaching a terminal condition`,
    );
  }

  return allItems;
}

/** A cursor page request: the cursor the previous page handed back (none for the first) and the page size. */
export interface CursorPageRequest {
  cursor?: string;
  limit: number;
}

export interface CursorTailOptions<T> {
  /** How many of the last matching items to keep. */
  keep: number;
  /** Which items count; all of them when unset. */
  where?: (item: T) => boolean;
}

/**
 * The last `keep` items passing `where`, oldest first, from a forward cursor walk:
 * it pages until `has_more` is false or no `next_cursor` comes back, or the page cap.
 * Band serves `/context` oldest first, so the tail is the newest.
 */
export async function fetchCursorTail<T>(
  fetchPage: (request: CursorPageRequest) => Promise<PaginatedResponse<T>>,
  { keep, where }: CursorTailOptions<T>,
): Promise<T[]> {
  const tail: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < DEFAULT_MAX_PAGES; page += 1) {
    const { data, metadata } = await fetchPage({ cursor, limit: DEFAULT_PAGE_SIZE });
    tail.push(...(where ? data.filter(where) : data));
    tail.splice(0, Math.max(0, tail.length - keep));
    cursor = typeof metadata?.next_cursor === "string" ? metadata.next_cursor : undefined;
    if (metadata?.has_more !== true || !cursor) {
      break;
    }
  }
  return tail;
}

/** Every peer the agent can reach, all pages in one call; with `notInChat`, those not in that room. */
export async function listAllPeers(
  rest: PeerLookupRestApi,
  { notInChat }: { notInChat?: string } = {},
  options?: RestRequestOptions,
): Promise<PeerRecord[]> {
  const listPeers = rest.listPeers?.bind(rest);
  if (!listPeers) {
    throw new UnsupportedFeatureError(OPTIONAL_UNSUPPORTED_MESSAGES.listPeers);
  }
  return fetchPaginated({
    fetchPage: ({ page, pageSize }) => listPeers({ page, pageSize, notInChat }, options),
  });
}

const TEXT_MESSAGE: ChatMessageType = "text";
/** How many messages `getRecentMessages` returns by default, and at most. */
export const DEFAULT_RECENT_MESSAGES = 20;
export const MAX_RECENT_MESSAGES = 100;

/**
 * The newest `limit` text messages in a room, oldest first. Band's context holds the
 * agent's own messages of every type plus the text messages that mention it.
 */
export async function getRecentMessages(
  rest: ContextRestApi,
  chatId: string,
  limit = DEFAULT_RECENT_MESSAGES,
  options?: RestRequestOptions,
): Promise<PlatformChatMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT_MESSAGES) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_RECENT_MESSAGES}`);
  }
  const getChatContext = rest.getChatContext?.bind(rest);
  if (!getChatContext) {
    throw new UnsupportedFeatureError(OPTIONAL_UNSUPPORTED_MESSAGES.getChatContext);
  }

  return fetchCursorTail((page) => getChatContext({ chatId, ...page }, options), {
    keep: limit,
    where: (message) => message.message_type === TEXT_MESSAGE,
  });
}

function resolveMetadataMode(
  strategy: PaginationStrategy,
  validation: PaginationMetadataValidation,
): PaginationMetadataMode {
  if (validation === "strict") {
    return "strict";
  }

  if (validation === "lossy") {
    return "lossy";
  }

  return strategy === "until_empty" ? "lossy" : "strict";
}

function resolvePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive integer`);
  }

  return value;
}

function resolvePaginationStrategy(value: string | undefined): PaginationStrategy {
  if (value === undefined) {
    return "auto";
  }

  if (VALID_PAGINATION_STRATEGIES.has(value as PaginationStrategy)) {
    return value as PaginationStrategy;
  }

  throw new ValidationError(
    `strategy must be one of: ${[...VALID_PAGINATION_STRATEGIES].join(", ")}`,
  );
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const normalized = toInteger(value);
  if (normalized === undefined || normalized <= 0) {
    return undefined;
  }
  return normalized;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const normalized = toInteger(value);
  if (normalized === undefined || normalized < 0) {
    return undefined;
  }
  return normalized;
}
