const db = require('../db');

// Tags are many-per-transaction, so they don't fit cleanly into
// TX_JOIN_SELECT's one-row-per-transaction join -- load them separately and
// attach as t.tags (an array of names). Fine at this scale (a handful of
// tags per transaction, not hundreds). Shared by the Transactions pages and
// the Needs Review queue.
function attachTags(txs) {
  if (!txs.length) return txs;
  const ids = txs.map((t) => t.id);
  const tagRows = db
    .prepare(
      `SELECT tt.transaction_id, tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids);
  const tagsByTx = new Map();
  for (const row of tagRows) {
    if (!tagsByTx.has(row.transaction_id)) tagsByTx.set(row.transaction_id, []);
    tagsByTx.get(row.transaction_id).push(row.name);
  }
  for (const t of txs) t.tags = tagsByTx.get(t.id) || [];
  return txs;
}

module.exports = { attachTags };
