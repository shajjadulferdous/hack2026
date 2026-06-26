// Investigator pipeline.
//
// Two paths:
//
//  1. LLM path (preferred) — when GEMINI_API_KEY is set, the model is the
//     single source of truth for case_type, evidence_verdict, severity,
//     department, agent_summary, recommended_next_action, customer_reply,
//     human_review_required, confidence, and reason_codes. The deterministic
//     matcher still picks the relevant_transaction_id (we never let the
//     model hallucinate one).
//
//  2. Rule-based fallback — used when the API key is missing or the LLM
//     call fails. Reasonable but not as accurate.
//
// All strings are run through the safety filter (hardenCustomerReply /
// hardenRecommendedAction / stripPromptInjection) regardless of which path
// produced them.

import type {
	AnalyzeRequest,
	AnalyzeResponse,
	CaseType,
	Department,
	Severity,
	Transaction
} from './types';
import { normalizeDigits, matchTransaction } from './matcher';
import {
	hardenCustomerReply,
	hardenRecommendedAction,
	stripPromptInjection
} from './safety';
import { analyzeWithGemini, isGeminiConfigured } from './llm';

// ---------- Rule-based fallback (only used when LLM is unavailable) ----------

interface CaseRule {
	caseType: CaseType;
	department: Department;
	defaultSeverity: Severity;
	patterns: RegExp[];
	banglaPatterns?: RegExp[];
}

const CASE_RULES: CaseRule[] = [
	{
		caseType: 'wrong_transfer',
		department: 'dispute_resolution',
		defaultSeverity: 'high',
		patterns: [
			/\bwrong\s*(number|person|recipient|account)\b/i,
			/\bsent\s+.*\s+to\s+(the\s+)?wrong\b/i,
			/\bmis\s*sent\b/i,
			/\bmistaken(ly)?\b/i,
			/\bby\s+mistake\b/i
		],
		banglaPatterns: [/\bভুল\b/, /\bভুল\s*নাম্বার\b/, /\bভুল\s*নম্বর\b/, /\bভুল\s*মানুষ\b/]
	},
	{
		caseType: 'payment_failed',
		department: 'payments_ops',
		defaultSeverity: 'medium',
		patterns: [
			/\bpayment\s+failed\b/i,
			/\btransaction\s+failed\b/i,
			/\bmoney\s+deducted\b/i,
			/\bbalance\s+(was\s+)?deducted\b/i,
			/\bdouble\s+charged\b/i
		],
		banglaPatterns: [/\bব্যর্থ\b/, /\bকাটেনি\b/, /\bকেটে\s*গেছে\b/, /\bকেটে\s*নিয়েছে\b/]
	},
	{
		caseType: 'duplicate_payment',
		department: 'payments_ops',
		defaultSeverity: 'medium',
		patterns: [/\bduplicate\s+(payment|charge|deduction)\b/i, /\bcharged\s+twice\b/i, /\btwo\s+times\b/i, /\bdouble\s+(payment|charge)\b/i],
		banglaPatterns: [/\bদুইবার\b/, /\bডুপ্লিকেট\b/]
	},
	{
		caseType: 'refund_request',
		department: 'customer_support',
		defaultSeverity: 'low',
		patterns: [/\brefund\b/i, /\breturn\s+(my\s+)?money\b/i, /\bchargeback\b/i],
		banglaPatterns: [/\bফেরত\b/, /\bরিফান্ড\b/, /\bটাকা\s*ফেরত\b/]
	},
	{
		caseType: 'merchant_settlement_delay',
		department: 'merchant_operations',
		defaultSeverity: 'medium',
		patterns: [/\bsettlement\b/i, /\bmerchant\s+(payout|payment)\b/i, /\bsettlement\s+delayed\b/i],
		banglaPatterns: [/\bসেটেলমেন্ট\b/, /\bমার্চেন্ট\b/]
	},
	{
		caseType: 'agent_cash_in_issue',
		department: 'agent_operations',
		defaultSeverity: 'high',
		patterns: [/\bcash\s*in\b/i, /\bdeposit\b/i, /\bagent\s+(did\s+not|didn't)\s+(give|receive|deposit)\b/i],
		banglaPatterns: [/\bক্যাশ\s*ইন\b/, /\bজমা\b/, /\bডিপোজিট\b/, /\bএজেন্ট\b/]
	},
	{
		caseType: 'phishing_or_social_engineering',
		department: 'fraud_risk',
		defaultSeverity: 'critical',
		patterns: [
			/\bphish(ing)?\b/i,
			/\bscam(mer)?\b/i,
			/\bfraud(ulent)?\b/i,
			/\bsomeone\s+(asked|calling|pretending)\b/i,
			/\bgave\s+(my\s+)?(pin|otp|password|code)\b/i,
			/\bsuspicious\s+(sms|call|message|link)\b/i
		],
		banglaPatterns: [/\bপ্রতারণা\b/, /\bফিশিং\b/, /\bস্ক্যাম\b/, /\bপিন\s*দিয়েছি\b/, /\bওটিপি\s*দিয়েছি\b/]
	}
];

function classifyComplaint(
	complaint: string
): { caseType: CaseType; department: Department; severity: Severity; hitRule: CaseRule | null } {
	const norm = normalizeDigits(complaint);
	for (const rule of CASE_RULES) {
		const enHit = rule.patterns.some((re) => re.test(norm));
		const bnHit = (rule.banglaPatterns ?? []).some((re) => re.test(complaint));
		if (enHit || bnHit) {
			return {
				caseType: rule.caseType,
				department: rule.department,
				severity: rule.defaultSeverity,
				hitRule: rule
			};
		}
	}
	return {
		caseType: 'other',
		department: 'customer_support',
		severity: 'low',
		hitRule: null
	};
}

function summarizeTxn(txn: Transaction | null): string {
	if (!txn) return 'no transaction in recent history';
	const dt = new Date(txn.timestamp);
	const dtStr = Number.isNaN(dt.getTime()) ? txn.timestamp : dt.toISOString();
	return `${txn.transaction_id} (${txn.type}, ${txn.amount} BDT, ${txn.status}, ${dtStr}, ${txn.counterparty})`;
}

function buildAgentSummary(
	caseType: CaseType,
	verdict: AnalyzeResponse['evidence_verdict'],
	txn: Transaction | null
): string {
	const txnPart = summarizeTxn(txn);
	if (caseType === 'phishing_or_social_engineering') {
		return `Customer reports a possible social-engineering or phishing attempt. Most relevant record: ${txnPart}. Verdict: ${verdict}.`;
	}
	if (caseType === 'wrong_transfer') {
		return `Customer reports sending money to the wrong recipient. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	if (caseType === 'payment_failed') {
		return `Customer reports a failed payment or balance deduction issue. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	if (caseType === 'duplicate_payment') {
		return `Customer reports a possible duplicate charge. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	if (caseType === 'merchant_settlement_delay') {
		return `Customer (likely merchant) reports delayed settlement. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	if (caseType === 'agent_cash_in_issue') {
		return `Customer reports a cash-in via an agent that is not reflected. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	if (caseType === 'refund_request') {
		return `Customer is asking for a refund. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
	}
	return `Customer reported an issue that did not match a known category. Most relevant record: ${txnPart}. Evidence: ${verdict}.`;
}

function buildNextAction(
	caseType: CaseType,
	verdict: AnalyzeResponse['evidence_verdict'],
	txn: Transaction | null,
	humanReviewRequired: boolean
): string {
	const txnRef = txn ? txn.transaction_id : 'the reported transaction';
	if (verdict === 'inconsistent') {
		return `Verify ${txnRef} details with the customer via official channels; the data does not support the claim. Escalate to human review if the customer insists.`;
	}
	if (verdict === 'insufficient_data') {
		return `Ask the customer for the transaction reference and exact timestamp through official channels, then re-run the investigator with the additional transaction details.`;
	}
	switch (caseType) {
		case 'wrong_transfer':
			return `Verify ${txnRef} with the customer via official channels, then escalate to dispute resolution for possible recovery through official channels only.`;
		case 'payment_failed':
			return `Check the gateway status for ${txnRef}. If the customer's balance was deducted, queue a reversal review with payments operations.`;
		case 'duplicate_payment':
			return `Confirm whether ${txnRef} and any matching duplicate were both charged, then queue a refund review with payments operations.`;
		case 'refund_request':
			return `Validate the refund eligibility against policy, then forward to the appropriate operations team.`;
		case 'merchant_settlement_delay':
			return `Look up the settlement batch for ${txnRef} and confirm ETA with merchant operations.`;
		case 'agent_cash_in_issue':
			return `Pull the agent's slip and the cash-in journal entry for ${txnRef}, then escalate to agent operations.`;
		case 'phishing_or_social_engineering':
			return `Flag the involved counterparty for fraud review and advise the customer only via official channels.`;
		default:
			return `Review the complaint with the appropriate team${humanReviewRequired ? ' (human review required)' : ''}.`;
	}
}

function buildCustomerReply(
	caseType: CaseType,
	verdict: AnalyzeResponse['evidence_verdict'],
	txn: Transaction | null
): string {
	const txnRef = txn ? txn.transaction_id : 'your recent transaction';
	if (caseType === 'phishing_or_social_engineering') {
		return (
			`Thank you for flagging this. For your safety, please do not share your PIN, OTP, password, or ` +
			`card number with anyone. Our team will only contact you through our official support channels ` +
			`listed in the app. We will review your case and follow up there.`
		);
	}
	if (verdict === 'inconsistent') {
		return (
			`Thank you for reaching out about ${txnRef}. Based on the records we have, the transaction does ` +
			`not match the issue you described. Any eligible adjustment will be returned through official ` +
			`channels after our team completes the review. We will only contact you through our official ` +
			`support channels.`
		);
	}
	if (verdict === 'insufficient_data') {
		return (
			`Thank you for contacting us about ${txnRef}. We need a few more details to investigate. ` +
			`Please reply with the transaction reference and the exact time, only through our official ` +
			`support channels. Do not share any PIN, OTP, password, or card number.`
		);
	}
	return (
		`Thank you for contacting us about ${txnRef}. We have noted your concern and our team is reviewing ` +
		`the case. Any eligible amount will be returned through official channels after the review is ` +
		`complete. We will only contact you through our official support channels, and we will never ask ` +
		`for your PIN, OTP, password, or card number.`
	);
}

function buildRuleBasedDraft(req: AnalyzeRequest): {
	agent_summary: string;
	recommended_next_action: string;
	customer_reply: string;
	case_type: CaseType;
	severity: Severity;
	department: Department;
	human_review_required: boolean;
	confidence: number;
	reason_codes: string[];
} {
	const safeComplaint = stripPromptInjection(req.complaint ?? '');
	const cls = classifyComplaint(safeComplaint);
	const match = matchTransaction(safeComplaint, req.transaction_history ?? []);

	let severity = cls.severity;
	let humanReviewRequired = false;
	const reasonCodes: string[] = ['rule_based'];

	if (match.verdict === 'inconsistent') {
		reasonCodes.push('evidence_inconsistent');
		humanReviewRequired = true;
	} else if (match.verdict === 'insufficient_data') {
		reasonCodes.push('insufficient_data');
		humanReviewRequired = true;
	} else {
		reasonCodes.push('evidence_consistent');
	}

	if (match.transaction) {
		reasonCodes.push('transaction_match');
		if (match.transaction.amount >= 20000) {
			severity = cls.severity === 'critical' ? 'critical' : 'high';
			reasonCodes.push('high_value');
			humanReviewRequired = true;
		}
	} else {
		reasonCodes.push('no_transaction_match');
		humanReviewRequired = true;
	}

	if (cls.caseType === 'phishing_or_social_engineering') {
		humanReviewRequired = true;
		severity = 'critical';
		reasonCodes.push('phishing_signal');
	}

	const draftReply = buildCustomerReply(cls.caseType, match.verdict, match.transaction);
	const draftAction = buildNextAction(
		cls.caseType,
		match.verdict,
		match.transaction,
		humanReviewRequired
	);

	return {
		agent_summary: buildAgentSummary(cls.caseType, match.verdict, match.transaction),
		recommended_next_action: hardenRecommendedAction(draftAction),
		customer_reply: hardenCustomerReply(draftReply),
		case_type: cls.caseType,
		severity,
		department: cls.department,
		human_review_required: humanReviewRequired,
		confidence: 0.7,
		reason_codes: reasonCodes
	};
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

	// LLM path — preferred. One call, model is the source of truth for
	// everything except the transaction id (and the post-hoc safety filter).
	if (isGeminiConfigured()) {
		try {
			const llm = await Promise.race([
				analyzeWithGemini({
					request: req,
					relevant_transaction_id: relevantTransactionId,
					evidence_verdict: match.verdict,
					history_summary: summarizeTxn(match.transaction)
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('gemini_timeout')), 25_000)
				)
			]);
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
				confidence: llm.confidence,
				reason_codes: ['llm', ...llm.reason_codes].slice(0, 10)
			};
		} catch (err) {
			console.warn(
				'[investigator] Gemini call failed, falling back to rule-based:',
				err instanceof Error ? err.message : err
			);
			const rule = buildRuleBasedDraft(req);
			return {
				...base,
				evidence_verdict: match.verdict,
				...rule,
				reason_codes: ['llm_fallback_rule_based', ...rule.reason_codes].slice(0, 10)
			};
		}
	}

	// No API key — pure rule-based fallback.
	const rule = buildRuleBasedDraft(req);
	return {
		...base,
		evidence_verdict: match.verdict,
		...rule
	};
}
