-- E3–E5: audit rows written inside one database transaction (an approval and its outbox row, a chain of state moves)
-- all carried the transaction's start time, so the Console could not show them in the order they happened.
-- clock_timestamp() stamps each row when it is written. Additive; existing rows keep their times.
alter table audit_log alter column at set default clock_timestamp();
