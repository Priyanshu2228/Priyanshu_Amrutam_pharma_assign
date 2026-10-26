import { z } from 'zod';
import { BadRequestError } from './errors';

/**
 * Keyset (cursor) pagination. Offsets degrade linearly with depth on large tables; a cursor
 * holding the last row's sort key keeps every page an index range scan.
 */
export type CursorValue = string | number;

export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): CursorValue[] | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === arity &&
      parsed.every((v) => typeof v === 'string' || typeof v === 'number')
    ) {
      return parsed as CursorValue[];
    }
  } catch {
    // fall through
  }
  throw new BadRequestError('INVALID_CURSOR', 'Cursor is malformed');
}

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
};

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Callers fetch `limit + 1` rows; the extra row only tells us whether another page exists. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorValue[]): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
