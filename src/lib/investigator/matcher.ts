// Transaction matcher.
//
// Picks the single transaction from the history that the complaint most
// plausibly refers to, and returns evidence on whether that transaction
// supports, contradicts, or is insufficient to judge the claim.
//
// We don't have an LLM available in this template, so we use a transparent
// scoring heuristic:
//   - amount match (with tolerance)
//   - timestamp proximity (parsed "around 2pm today" -> +- 4h of the txn time)
//   - counterparty match (digits in the complaint vs counterparty)
//   - status match (e.g. complaint says "money deducted" but txn failed)
//
// The scorer always returns its confidence and the matched id, even if
// the match is weak. The classifier decides what to do with that.

import type { EvidenceVerdict, Transaction } from './types';

const BANGLA_DIGITS: Record<string, string> = {
	'০': '0',
	'১': '1',
	'২': '2',
	'৩': '3',
	'৪': '4',
	'৫': '5',
	'৬': '6',
	'৭': '7',
	'৮': '8',
	'৯': '9'
};

export function normalizeDigits(input: string): string {
	return input.replace(/[০-৯]/g, (d) => BANGLA_DIGITS[d] ?? d);
}

export function extractDigits(input: string): string[] {
	const norm = normalizeDigits(input);
	const matches = norm.match(/\d[\d\s-]*/g) ?? [];
	return matches
		.map((s) => s.replace(/[\s-]/g, ''))
		.filter((s) => s.length >= 2);
}

export function extractPhoneLike(input: string): string[] {
	const norm = normalizeDigits(input);
	const matches = norm.match(/\+?\d{10,15}/g) ?? [];
	return matches.map((s) => s.replace(/^\+/, ''));
}

function extractAmounts(complaint: string): number[] {
	const text = normalizeDigits(complaint);
	const out: number[] = [];
	const push = (n: number) => {
		if (Number.isFinite(n) && n > 0) out.push(n);
	};
	// Patterns: "5000", "5,000", "5.000", "5k", "5 thousand", "5 lakh".
	// Grouped form is tried FIRST so "5,000" doesn't get split as "5" + "000"
// (JS regex alternation is left-to-right, not longest). Plain \d+ is the
// fallback so un-grouped numbers like "5000" or "01712345678" still match.
	const re = /(?:tk|taka|bdt|৳)?\s*(?:\d{1,3}(?:[,.\s]\d{2,3})+|\d+)(?:\s*(k|thousand|lakh|lac|crore))?\b/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const raw = m[0].replace(/[,.\s]/g, '').replace(/^\D+|\D+$/g, '');
		const num = Number(raw);
		if (!Number.isFinite(num) || num <= 0) continue;
		const tailWord = (m[1] ?? '').toLowerCase();
		const head = text.slice(Math.max(0, m.index - 6), m.index).toLowerCase();
		let value = num;
		if (tailWord === 'k' || tailWord === 'thousand' || /\bthousand\b/.test(head)) {
			value = num * 1000;
		} else if (tailWord === 'lakh' || tailWord === 'lac') {
			value = num * 100000;
		} else if (tailWord === 'crore') {
			value = num * 10000000;
		}
		push(value);
	}
	return out;
}

function parseWhenMs(complaint: string, txnTs: string): number {
	const complaintLower = complaint.toLowerCase();
	const txnDate = new Date(txnTs);
	if (Number.isNaN(txnDate.getTime())) return Number.POSITIVE_INFINITY;

	// "today" / "আজ" -> assume txn is from same UTC day window
	if (/today|আজ|আজকে/.test(complaintLower)) {
		const now = Date.now();
		return Math.abs(now - txnDate.getTime());
	}
	if (/yesterday|গতকাল/.test(complaintLower)) {
		return Math.abs(Date.now() - 24 * 3600 * 1000 - txnDate.getTime());
	}

	// "around 2pm" / "2 ta" -> hour of day
	const hourMatch = complaintLower.match(/\b([0-9]{1,2})\s*(am|pm|টায়|টা|টি|ট\.|ta|tay)\b/);
	if (hourMatch) {
		let h = Number(hourMatch[1]);
		const tag = hourMatch[2];
		if (/pm/i.test(tag) && h < 12) h += 12;
		if (h >= 0 && h < 24) {
			const diff = Math.abs(txnDate.getUTCHours() - h);
			return diff * 3600 * 1000; // ms
		}
	}
	return Number.POSITIVE_INFINITY; // no temporal clue -> don't penalize
}

export interface MatchResult {
	transaction: Transaction | null;
	score: number;
	verdict: EvidenceVerdict;
	reasons: string[];
}

export function matchTransaction(
	complaint: string,
	history: Transaction[] | undefined
): MatchResult {
	if (!history || history.length === 0) {
		return {
			transaction: null,
			score: 0,
			verdict: 'insufficient_data',
			reasons: ['no_transaction_history']
		};
	}

	const complaintDigits = extractDigits(complaint);
	const complaintPhones = extractPhoneLike(complaint);
	const complaintAmounts = extractAmounts(complaint);

	const scored = history.map((txn) => {
		let score = 0;
		const reasons: string[] = [];

		// amount match
		const diffs = complaintAmounts.map((a) => Math.abs(a - txn.amount));
		if (diffs.length > 0) {
			const best = Math.min(...diffs);
			if (best === 0) {
				score += 5;
				reasons.push('amount_exact_match');
			} else if (best <= 1) {
				score += 4;
				reasons.push('amount_close_match');
			} else if (best / Math.max(txn.amount, 1) <= 0.05) {
				score += 3;
				reasons.push('amount_near_match');
			}
		}

		// counterparty match
		const cp = txn.counterparty.replace(/[^\d]/g, '');
		if (cp.length >= 6) {
			if (complaintPhones.some((p) => p.endsWith(cp) || cp.endsWith(p))) {
				score += 4;
				reasons.push('counterparty_match');
			} else if (complaintDigits.some((d) => d.length >= 6 && (d.endsWith(cp) || cp.endsWith(d)))) {
				score += 2;
				reasons.push('counterparty_partial_match');
			}
		}

		// timestamp proximity
		const whenMs = parseWhenMs(complaint, txn.timestamp);
		if (whenMs !== Number.POSITIVE_INFINITY) {
			if (whenMs <= 2 * 3600 * 1000) {
				score += 2;
				reasons.push('time_close');
			} else if (whenMs <= 6 * 3600 * 1000) {
				score += 1;
				reasons.push('time_loose');
			} else {
				score -= 1;
				reasons.push('time_far');
			}
		}

		// status signal
		if (/\b(failed|ব্যর্থ|ফেইল)\b/i.test(complaint) && txn.status === 'failed') {
			score += 2;
			reasons.push('status_failed');
		}
		if (/\b(refund|ফেরত|রিফান্ড)\b/i.test(complaint) && txn.type === 'refund') {
			score += 2;
			reasons.push('refund_txn');
		}
		if (/\bduplicate|ডুপ্লিকেট|দুইবার|দুইবার\b/i.test(complaint) && history.length >= 2) {
			const dupes = history.filter((t) => t.amount === txn.amount && t.type === txn.type);
			if (dupes.length >= 2) {
				score += 3;
				reasons.push('duplicate_pattern');
			}
		}
		return { txn, score, reasons };
	});

	scored.sort((a, b) => b.score - a.score);
	const best = scored[0];

	// Weak match => insufficient data
	if (best.score < 2) {
		return {
			transaction: best.txn,
			score: best.score,
			verdict: 'insufficient_data',
			reasons: ['low_match', ...best.reasons]
		};
	}

	// Decide consistent vs inconsistent.
	// Inconsistent = status clearly contradicts the complaint's claim.
	const verdict = decideVerdict(best.txn, complaint);

	return {
		transaction: best.txn,
		score: best.score,
		verdict,
		reasons: best.reasons
	};
}

function decideVerdict(txn: Transaction, complaint: string): EvidenceVerdict {
	const c = complaint.toLowerCase();
	const isFailedClaim = /\b(failed|ব্যর্থ|ফেইল|কাটেনি|কাটে নাই|কাটেনি)\b/.test(c);
	const isDeductedClaim = /\b(deducted|cut|কেটে|কাটা|কেটেছে|কাটছে|কেটে নিয়েছে)\b/.test(c);
	const isRefundClaim = /\b(refund|reverse|revert|undo|cash\s*back|send\s*back|ফেরত|রিফান্ড|টাকা\s*ফেরত|ফেরত\s*দিন|ফেরত\s*চাই)\b/.test(c);
	const isCashInClaim = /\b(cash\s*in|deposit|জমা|ডিপোজিট|ক্যাশ ইন)\b/.test(c);
	const isSettlementClaim = /\b(settlement|সেটেলমেন্ট|মার্চেন্ট|merchant)\b/.test(c);

	if (isFailedClaim && txn.status === 'completed') return 'inconsistent';
	// "deducted" + txn.status='failed' is NOT inconsistent: the gateway may
	// have reported failed while the customer's balance was still charged.
	// We can't prove either side from the row alone — punt to insufficient_data.
	if (isDeductedClaim && txn.status === 'failed') return 'insufficient_data';
	// A refund request against a non-refund row is NOT by itself inconsistent:
	// the row is a snapshot of past transactions, the customer is asking for
	// FUTURE action. Only return insufficient_data here so the LLM (and the
	// final classifier) can decide whether the merchant-policy / change-of-mind
	// reply is appropriate.
	if (isRefundClaim && txn.type !== 'refund') return 'insufficient_data';
	if (isCashInClaim && txn.status === 'completed' && txn.type === 'cash_in') return 'consistent';
	if (isSettlementClaim && txn.type === 'settlement' && txn.status === 'pending') return 'consistent';
	if (isFailedClaim && txn.status === 'failed') return 'consistent';
	if (isDeductedClaim && txn.status === 'completed') return 'consistent';

	return 'consistent';
}
