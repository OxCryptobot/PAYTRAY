-- PayTray Batch C ledger replay protection for intent-derived entries

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_intent_type_unique
  ON ledger_entries (source_intent_id, entry_type)
  WHERE source_intent_id IS NOT NULL;
