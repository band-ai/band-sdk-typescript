/** Which items `fetchCursorTail` keeps from a scripted run of cursor pages, and where it stops walking. */
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE, fetchCursorTail, type CursorPageRequest } from "../src/client/rest/pagination";
import type { PaginatedResponse } from "../src/client/rest/types";

interface Item {
  id: number;
  kind: "text" | "event";
}

/** One scripted page: its items, and the cursor it hands back (none ends the run). */
interface ScriptedPage {
  ids: number[];
  hasMore: boolean;
  nextCursor?: string;
}

const EVERY_THIRD_IS_EVENT = (id: number): Item => ({ id, kind: id % 3 === 0 ? "event" : "text" });

function page(ids: number[], nextCursor?: string): ScriptedPage {
  return { ids, hasMore: nextCursor !== undefined, nextCursor };
}

/** Pages in order, as a cursor run serves them; records each request it is sent. */
function scriptedFetcher(pages: ScriptedPage[]) {
  const requests: CursorPageRequest[] = [];
  const fetchPage = async (request: CursorPageRequest): Promise<PaginatedResponse<Item>> => {
    const served = pages[requests.length] ?? page([]);
    requests.push(request);
    return {
      data: served.ids.map(EVERY_THIRD_IS_EVENT),
      metadata: { has_more: served.hasMore, ...(served.nextCursor ? { next_cursor: served.nextCursor } : {}) },
    };
  };
  return { fetchPage, requests };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
/** A run longer than the page cap, each page pointing at the next. */
const ENDLESS = Array.from({ length: DEFAULT_MAX_PAGES + 1 }, (_, index) => page([index + 1], `c${index + 1}`));

describe("fetchCursorTail", () => {
  it.each([
    {
      name: "several pages keep only the last items, oldest first",
      pages: [page(range(1, 4), "c1"), page(range(5, 8), "c2"), page(range(9, 10))],
      keep: 3,
      kept: [8, 9, 10],
      cursors: [undefined, "c1", "c2"],
    },
    {
      name: "where filters before keeping",
      pages: [page(range(1, 4), "c1"), page(range(5, 9))],
      keep: 3,
      where: (item: Item) => item.kind === "text",
      kept: [5, 7, 8],
      cursors: [undefined, "c1"],
    },
    {
      name: "a page with more to come but no cursor ends the walk",
      pages: [page(range(1, 2), "c1"), { ids: [3, 4], hasMore: true }, page([5])],
      keep: 10,
      kept: [1, 2, 3, 4],
      cursors: [undefined, "c1"],
    },
    {
      name: "the page cap ends the walk",
      pages: ENDLESS,
      keep: 2,
      kept: [DEFAULT_MAX_PAGES - 1, DEFAULT_MAX_PAGES],
      cursors: [undefined, ...range(1, DEFAULT_MAX_PAGES - 1).map((index) => `c${index}`)],
    },
  ])("$name", async ({ pages, keep, where, kept, cursors }) => {
    const { fetchPage, requests } = scriptedFetcher(pages);

    const items = await fetchCursorTail(fetchPage, { keep, where });

    expect(items.map((item) => item.id)).toEqual(kept);
    expect(requests).toEqual(cursors.map((cursor) => ({ cursor, limit: DEFAULT_PAGE_SIZE })));
  });
});
