CREATE TABLE commitments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,
 source_subscription_id INTEGER UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('once','recurring','installment','consortium','housing')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 total_installments INTEGER NOT NULL,
 first_number INTEGER NOT NULL DEFAULT 1,
 first_due TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 details TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE payable_installments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 commitment_id INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
 number INTEGER NOT NULL,
 due_date TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 cancelled INTEGER NOT NULL DEFAULT 0,
 UNIQUE(commitment_id, number)
);
--> statement-breakpoint
CREATE TABLE payable_payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 installment_id INTEGER NOT NULL REFERENCES payable_installments(id) ON DELETE RESTRICT,
 transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 payment_key TEXT NOT NULL UNIQUE,
 date TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX commitments_user_idx ON commitments(user_id);
--> statement-breakpoint
CREATE INDEX installments_due_idx ON payable_installments(due_date);
--> statement-breakpoint
CREATE TABLE card_bills (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 due_date TEXT NOT NULL,
 closed INTEGER NOT NULL DEFAULT 0,
 UNIQUE(account_id,due_date)
);
--> statement-breakpoint
CREATE TABLE card_purchases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,
 total_cents INTEGER NOT NULL,
 installments INTEGER NOT NULL,
 purchase_date TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE card_bill_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 bill_id INTEGER NOT NULL REFERENCES card_bills(id) ON DELETE RESTRICT,
 purchase_id INTEGER NOT NULL REFERENCES card_purchases(id) ON DELETE RESTRICT,
 transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
 number INTEGER NOT NULL,
 amount_cents INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE card_bill_payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 bill_id INTEGER NOT NULL REFERENCES card_bills(id) ON DELETE RESTRICT,
 transfer_id INTEGER NOT NULL UNIQUE REFERENCES transfers(id) ON DELETE RESTRICT,
 amount_cents INTEGER NOT NULL,
 payment_key TEXT NOT NULL UNIQUE,
 date TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE contract_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 commitment_id INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 event_key TEXT UNIQUE,
 date TEXT NOT NULL,
 amount_cents INTEGER NOT NULL DEFAULT 0,
 outstanding_cents INTEGER,
 notes TEXT NOT NULL DEFAULT '',
 transaction_id INTEGER REFERENCES transactions(id) ON DELETE RESTRICT
);
