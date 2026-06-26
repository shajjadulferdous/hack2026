// Request and response types for the complaint investigator service.
// Enum values are kept as string literal unions so the JSON output
// matches the spec exactly (no extra variants, no different casing).

export type Language = 'en' | 'bn' | 'mixed';
export type Channel =
	| 'in_app_chat'
	| 'call_center'
	| 'email'
	| 'merchant_portal'
	| 'field_agent';
export type UserType = 'customer' | 'merchant' | 'agent' | 'unknown';

export type TxnType =
	| 'transfer'
	| 'payment'
	| 'cash_in'
	| 'cash_out'
	| 'settlement'
	| 'refund';
export type TxnStatus = 'completed' | 'failed' | 'pending' | 'reversed';

export interface Transaction {
	transaction_id: string;
	timestamp: string; // ISO 8601
	type: TxnType;
	amount: number; // BDT
	counterparty: string;
	status: TxnStatus;
}

export interface AnalyzeRequest {
	ticket_id: string;
	complaint: string;
	language?: Language;
	channel?: Channel;
	user_type?: UserType;
	transaction_history?: Transaction[];
	metadata?: Record<string, unknown>;
}

export type EvidenceVerdict = 'consistent' | 'inconsistent' | 'insufficient_data';

export type CaseType =
	| 'wrong_transfer'
	| 'payment_failed'
	| 'refund_request'
	| 'duplicate_payment'
	| 'merchant_settlement_delay'
	| 'agent_cash_in_issue'
	| 'phishing_or_social_engineering'
	| 'other';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Department =
	| 'customer_support'
	| 'dispute_resolution'
	| 'payments_ops'
	| 'merchant_operations'
	| 'agent_operations'
	| 'fraud_risk';

export interface AnalyzeResponse {
	ticket_id: string;
	relevant_transaction_id: string | null;
	evidence_verdict: EvidenceVerdict;
	case_type: CaseType;
	severity: Severity;
	department: Department;
	agent_summary: string;
	recommended_next_action: string;
	customer_reply: string;
	human_review_required: boolean;
	confidence: number;
	reason_codes: string[];
}