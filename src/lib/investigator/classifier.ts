// Investigator pipeline.
//
// The LLM (Gemini) is the single source of truth for case_type,
// evidence_verdict, severity, department, agent_summary,
// recommended_next_action, customer_reply, human_review_required,
// confidence, and reason_codes. The deterministic matcher still owns
// relevant_transaction_id (we never let the model invent one).
//
// There is no rule-based fallback. If the API key is missing or the LLM
// call fails (network, quota, timeout), we return a minimal
// "AI quota hit — needs human review" response so we don't hallucinate
// case details from regexes.

import type { AnalyzeRequest, AnalyzeResponse, Transaction } from './types';
import { matchTransaction } from './matcher';
import { hardenCustomerReply, hardenRecommendedAction, stripPromptInjection } from './safety';
import { analyzeWithGemini, GeminiQuotaError, isGeminiConfigured } from './llm';

function summarizeTxn(txn: Transaction | null): string {
	if (!txn) return 'no transaction in recent history';
	const dt = new Date(txn.timestamp);
	const dtStr = Number.isNaN(dt.getTime()) ? txn.timestamp : dt.toISOString();
	return `${txn.transaction_id} (${txn.type}, ${txn.amount} BDT, ${txn.status}, ${dtStr}, ${txn.counterparty})`;
}

// ---------- Main entry point ----------

export async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
	// Matcher always runs — it picks the relevant_transaction_id, which we
	// never let the LLM invent.
	const safeComplaint = stripPromptInjection(req.complaint ?? '');
	const match = matchTransaction(safeComplaint, req.transaction_history ?? []);
	const relevantTransactionId = match.transaction ? match.transaction.transaction_id : null;

	const base: AnalyzeResponse = {
		ticket_id: req.ticket_id,
		relevant_transaction_id: relevantTransactionId,
		evidence_verdict: 'insufficient_data',
		case_type: 'other',
		severity: 'low',
		department: 'customer_support',
		agent_summary: '',
		recommended_next_action: '',
		customer_reply: '',
		human_review_required: false,
		confidence: 0,
		reason_codes: []
	};

	// LLM is the single source of truth for everything except the
	// transaction id. There is no rule-based fallback — if the model fails
	// or the key is missing, we say so honestly and return insufficient_data
	// so a human can pick it up.
	const QUOTA_HIT_REPLY =
		'Thank you for reaching out. Our team is reviewing your case and will ' +
		'follow up through official support channels listed in the app. We will ' +
		'never ask for your PIN, OTP, password, or card number.';
	const QUOTA_HIT_ACTION =
		'Route this ticket to a human reviewer; the AI investigator could not ' +
		'process it right now. Do not confirm any refund or reversal until policy ' +
		'and fraud checks are complete.';

	if (!isGeminiConfigured()) {
		console.warn('[investigator] GEMINI_API_KEY not set; LLM unavailable.');
		return {
			...base,
			agent_summary: 'AI quota unavailable. This ticket needs human review.',
			recommended_next_action: hardenRecommendedAction(QUOTA_HIT_ACTION),
			customer_reply: hardenCustomerReply(QUOTA_HIT_REPLY),
			human_review_required: true,
			confidence: 0,
			reason_codes: ['llm_unavailable']
		};
	}

	try {
		const llm = await Promise.race([
			analyzeWithGemini({
				request: req,
				relevant_transaction_id: relevantTransactionId,
				history_summary: summarizeTxn(match.transaction)
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('gemini_timeout')), 8_000)
			)
		]);
		const confidence = Math.max(0, Math.min(1, Number(llm.confidence) || 0));
		return {
			...base,
			evidence_verdict: llm.evidence_verdict,
			case_type: llm.case_type,
			severity: llm.severity,
			department: llm.department,
			agent_summary: llm.agent_summary,
			recommended_next_action: hardenRecommendedAction(llm.recommended_next_action),
			customer_reply: hardenCustomerReply(llm.customer_reply),
			human_review_required: llm.human_review_required,
			confidence,
			reason_codes: ['llm', ...llm.reason_codes].slice(0, 10)
		};
	} catch (err) {
		const isQuota = err instanceof GeminiQuotaError;
		// Log a short, safe summary — never dump the raw SDK error blob
		// (it can contain quota metadata and retry timing).
		const summary = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
		console.warn(
			`[investigator] Gemini call failed (${isQuota ? 'quota' : 'error'}): ${summary}`
		);
		return {
			...base,
			agent_summary: isQuota
				? 'AI quota hit. This ticket needs human review.'
				: 'AI investigator encountered an error. This ticket needs human review.',
			recommended_next_action: hardenRecommendedAction(QUOTA_HIT_ACTION),
			customer_reply: hardenCustomerReply(QUOTA_HIT_REPLY),
			human_review_required: true,
			confidence: 0,
			reason_codes: [isQuota ? 'llm_quota_hit' : 'llm_error']
		};
	}
}
