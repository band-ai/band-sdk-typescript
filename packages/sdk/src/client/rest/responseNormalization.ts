import { asOptionalRecord } from "../../core/coercion";
import type { ContactRequestsResult, MetadataMap } from "../../contracts/dtos";

function asMetadataMap(value: unknown): MetadataMap | undefined {
  return asOptionalRecord(value) as MetadataMap | undefined;
}

function normalizeContactRequestDirection(value: unknown): MetadataMap | undefined {
  const direction = asMetadataMap(value);
  if (!direction) {
    return undefined;
  }

  return {
    total:
      typeof direction.total === "number"
        ? direction.total
        : typeof direction.total_count === "number"
          ? direction.total_count
          : undefined,
    totalPages:
      typeof direction.totalPages === "number"
        ? direction.totalPages
        : typeof direction.total_pages === "number"
          ? direction.total_pages
          : undefined,
  };
}

export function normalizeContactRequestsResult(result: ContactRequestsResult): ContactRequestsResult {
  const metadata = asMetadataMap(result.metadata);
  return {
    received: Array.isArray(result.received) ? result.received : [],
    sent: Array.isArray(result.sent) ? result.sent : [],
    metadata: metadata
      ? {
        page:
          typeof metadata.page === "number"
            ? metadata.page
            : typeof metadata.page_number === "number"
              ? metadata.page_number
              : undefined,
        pageSize:
          typeof metadata.pageSize === "number"
            ? metadata.pageSize
            : typeof metadata.page_size === "number"
              ? metadata.page_size
              : undefined,
        received: normalizeContactRequestDirection(metadata.received),
        sent: normalizeContactRequestDirection(metadata.sent),
      }
      : undefined,
  };
}
