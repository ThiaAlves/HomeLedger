ALTER TABLE card_bill_payments ADD COLUMN reversal_transfer_id INTEGER REFERENCES transfers(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE card_bill_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 from_bill_id INTEGER NOT NULL REFERENCES card_bills(id) ON DELETE RESTRICT,
 to_bill_id INTEGER NOT NULL REFERENCES card_bills(id) ON DELETE RESTRICT,
 amount_cents INTEGER NOT NULL CHECK(amount_cents != 0),
 voided INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 CHECK(from_bill_id != to_bill_id)
);
--> statement-breakpoint
CREATE INDEX card_movements_from_idx ON card_bill_movements(from_bill_id);
--> statement-breakpoint
CREATE INDEX card_movements_to_idx ON card_bill_movements(to_bill_id);
--> statement-breakpoint
CREATE TABLE card_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL,
 result TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX card_items_bill_idx ON card_bill_items(bill_id);
--> statement-breakpoint
CREATE INDEX card_items_purchase_idx ON card_bill_items(purchase_id);
--> statement-breakpoint
CREATE INDEX card_payments_bill_idx ON card_bill_payments(bill_id);
--> statement-breakpoint
CREATE INDEX payable_payments_installment_idx ON payable_payments(installment_id);
