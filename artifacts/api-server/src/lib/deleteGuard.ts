// deleteGuard.ts — the only permitted path for DELETE on register tables.
//
// A PostgreSQL BEFORE DELETE trigger on sale_line (function
// check_sale_line_delete_allowed, trigger sale_line_delete_guard) blocks every
// DELETE unless the current transaction has set:
//
//   SET LOCAL app.allow_delete = 'confirmed'
//
// SET LOCAL is transaction-scoped, so the flag is automatically cleared on
// COMMIT or ROLLBACK. No other code path should set this variable directly.
// All deletions from sale_line must go through allowDelete().
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Execute fn inside a transaction that satisfies the DB delete guard.
// fn receives the transaction object and must use it (not the global db)
// for any DELETE statements so they run on the same connection that has
// the session variable set.
export async function allowDelete<T>(
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_delete = 'confirmed'`);
    return fn(tx as unknown as typeof db);
  });
}
