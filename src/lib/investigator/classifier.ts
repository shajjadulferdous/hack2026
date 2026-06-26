// Classifier + investigator pipeline.
//
// Combines the matched transaction with keyword/heuristic rules over the
// complaint text to produce the full structured response. Every output
// field is constrained to the spec's enums.

import type {
	AnalyzeRequest,
	AnalyzeResponse,
	CaseType,
	Department,
	Severity,
	Transaction
} from './types';
import { normalizeDigits } from './matcher';
import { matchTransaction } from './matcher';
import {
	hardenCustomerReply,
	hardenRecommendedAction,
	stripPromptInjection
} from './safety';
import { analyzeWithGemini, isGeminiConfigured } from './llm';

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

function bumpSeverity(base: Severity, amount: number): Severity {
	const order: Severity[] = ['low', 'medium', 'high', 'critical'];
	const idx = order.indexOf(base);
	const next = Math.min(order.length - 1, Math.max(0, idx + amount));
	return order[next];
}

function summarizeTxn(txn: Transaction | null): string {
	if (!txn) return 'no transaction in recent history';
	const dt = new Date(txn.timestamp);
	const dtStr = Number.isNaN(dt.getTime()) ? txn.timestamp : dt.toISOString();
	return `${txn.transaction_id} (${txn.type}, ${txn.amount} BDT, ${txn.status}, ${dtStr}, ${txn.counterparty})`;
}

function buildAgentSummary(
	req: AnalyzeRequest,
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

export interface AnalyzerContext {
	match: ReturnType<typeof matchTransaction>;
	classification: ReturnType<typeof classifyComplaint>;
	baseSeverity: Severity;
	baseDepartment: Department;
	baseHumanReviewRequired: boolean;
	baseReasonCodes: string[];
	baseConfidence: number;
}

export function buildContext(req: AnalyzeRequest): AnalyzerContext {
	const safeComplaint = stripPromptInjection(req.complaint ?? '');
	const txnHistory = req.transaction_history ?? [];
	const match = matchTransaction(safeComplaint, txnHistory);
	const cls = classifyComplaint(safeComplaint);

	let severity = cls.severity;
	let humanReviewRequired = false;
	const reasonCodes: string[] = [];

	if (match.verdict === 'inconsistent') {
		reasonCodes.push('evidence_inconsistent');
		severity = bumpSeverity(severity, 1);
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
			severity = bumpSeverity(severity, 1);
			reasonCodes.push('high_value');
			humanReviewRequired = true;
		}
		if (match.transaction.status === 'failed' && cls.caseType !== 'payment_failed') {
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
	if (cls.caseType === 'wrong_transfer') {
		reasonCodes.push('wrong_transfer');
		humanReviewRequired = true;
	}
	if (cls.caseType === 'merchant_settlement_delay') {
		reasonCodes.push('merchant_settlement_delay');
	}

	// Confidence: blend match score and case-rule hit confidence.
	const matchConf = Math.min(1, match.score / 8);
	const ruleConf = cls.hitRule ? 0.8 : 0.4;
	let confidence = 0.5 * matchConf + 0.5 * ruleConf;
	if (match.verdict === 'insufficient_data') confidence = Math.min(confidence, 0.55);
	confidence = Math.max(0.2, Math.min(0.99, Number(confidence.toFixed(2))));

	return {
		match,
		classification: cls,
		baseSeverity: severity,
		baseDepartment: cls.department,
		baseHumanReviewRequired: humanReviewRequired,
		baseReasonCodes: reasonCodes,
		baseConfidence: confidence
	};
}

function buildRuleBasedDraft(
	req: AnalyzeRequest,
	ctx: AnalyzerContext
): {
	agent_summary: string;
	recommended_next_action: string;
	customer_reply: string;
	case_type: AnalyzeResponse['case_type'];
	severity: Severity;
	department: Department;
	human_review_required: boolean;
	confidence: number;
	reason_codes: string[];
} {
	const draftReply = buildCustomerReply(
		ctx.classification.caseType,
		ctx.match.verdict,
		ctx.match.transaction
	);
	const draftAction = buildNextAction(
		ctx.classification.caseType,
		ctx.match.verdict,
		ctx.match.transaction,
		ctx.baseHumanReviewRequired
	);
	return {
		agent_summary: buildAgentSummary(req, ctx.classification.caseType, ctx.match.verdict, ctx.match.transaction),
		recommended_next_action: hardenRecommendedAction(draftAction),
		customer_reply: hardenCustomerReply(draftReply),
		case_type: ctx.classification.caseType,
		severity: ctx.baseSeverity,
		department: ctx.baseDepartment,
		human_review_required: ctx.baseHumanReviewRequired,
		confidence: ctx.baseConfidence,
		reason_codes: ctx.baseReasonCodes
	};
}

export async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
	const ctx = buildContext(req);

	let draft = buildRuleBasedDraft(req, ctx);

	// Optional Gemini refinement. Runs only if the env var is set AND
	// matches succeeds (we always keep the matcher's verdict and id).
	if (isGeminiConfigured()) {
		try {
			const llm = await Promise.race([
				analyzeWithGemini({
					request: req,
					relevant_transaction_id: ctx.match.transaction
						? ctx.match.transaction.transaction_id
						: null,
					evidence_verdict: ctx.match.verdict,
					history_summary: summarizeTxn(ctx.match.transaction)
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('gemini_timeout')), 20_000)
				)
			]);
			draft = {
				...draft,
				case_type: llm.case_type,
				severity: llm.severity,
				department: llm.department,
				agent_summary: llm.agent_summary,
				recommended_next_action: hardenRecommendedAction(llm.recommended_next_action),
				customer_reply: hardenCustomerReply(llm.customer_reply),
				human_review_required: llm.human_review_required || draft.human_review_required,
				confidence: llm.confidence,
				reason_codes: Array.from(
					new Set([...draft.reason_codes, ...llm.reason_codes])
				).slice(0, 10)
			};
			draft.reason_codes.unshift('llm_refined');
		} catch (err) {
			// Fall back to rule-based on any LLM error so we never break the
			// 30-second SLA. The matcher verdict is still authoritative.
			console.warn(
				'[investigator] Gemini call failed, falling back to rule-based:',
				err instanceof Error ? err.message : err
			);
			draft.reason_codes.unshift('llm_fallback_rule_based');
		}
	} else {
		draft.reason_codes.unshift('rule_based');
	}

	// Hard override: phishing always critical + always human review.
	if (draft.case_type === 'phishing_or_social_engineering') {
		draft.severity = 'critical';
		draft.human_review_required = true;
	}

	return {
		ticket_id: req.ticket_id,
		relevant_transaction_id: ctx.match.transaction ? ctx.match.transaction.transaction_id : null,
		evidence_verdict: ctx.match.verdict,
		case_type: draft.case_type,
		severity: draft.severity,
		department: draft.department,
		agent_summary: draft.agent_summary,
		recommended_next_action: draft.recommended_next_action,
		customer_reply: draft.customer_reply,
		human_review_required: draft.human_review_required,
		confidence: draft.confidence,
		reason_codes: draft.reason_codes
	};
}