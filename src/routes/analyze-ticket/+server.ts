import { json, type RequestHandler } from '@sveltejs/kit';
import { analyze } from '$lib/investigator/classifier';
import type { AnalyzeRequest, Transaction } from '$lib/investigator/types';

const ALLOWED_LANGS: ReadonlySet<string> = new Set(['en', 'bn', 'mixed']);
const ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
	'in_app_chat',
	'call_center',
	'email',
	'merchant_portal',
	'field_agent'
]);
const ALLOWED_USER_TYPES: ReadonlySet<string> = new Set(['customer', 'merchant', 'agent', 'unknown']);
const ALLOWED_TXN_TYPES: ReadonlySet<string> = new Set([
	'transfer',
	'payment',
	'cash_in',
	'cash_out',
	'settlement',
	'refund'
]);
const ALLOWED_TXN_STATUSES: ReadonlySet<string> = new Set([
	'completed',
	'failed',
	'pending',
	'reversed'
]);

function bad(message: string, status: 400 | 422 = 400) {
	return json({ error: message }, { status });
}

export const POST: RequestHandler = async ({ request }) => {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return bad('Invalid JSON body.');
	}

	if (!raw || typeof raw !== 'object') {
		return bad('Request body must be a JSON object.');
	}
	const body = raw as Record<string, unknown>;

	if (typeof body.ticket_id !== 'string' || body.ticket_id.trim() === '') {
		return bad('Missing or empty "ticket_id".', 400);
	}
	if (typeof body.complaint !== 'string') {
		return bad('Missing "complaint" string.', 400);
	}
	if (body.complaint.trim() === '') {
		return bad('"complaint" must not be empty.', 422);
	}

	if (body.language !== undefined && !ALLOWED_LANGS.has(String(body.language))) {
		return bad('Invalid "language".', 422);
	}
	if (body.channel !== undefined && !ALLOWED_CHANNELS.has(String(body.channel))) {
		return bad('Invalid "channel".', 422);
	}
	if (body.user_type !== undefined && !ALLOWED_USER_TYPES.has(String(body.user_type))) {
		return bad('Invalid "user_type".', 422);
	}

	let txns: Transaction[] | undefined = undefined;
	if (body.transaction_history !== undefined) {
		if (!Array.isArray(body.transaction_history)) {
			return bad('"transaction_history" must be an array.', 422);
		}
		txns = [];
		for (const item of body.transaction_history as unknown[]) {
			if (!item || typeof item !== 'object') {
				return bad('Each transaction must be an object.', 422);
			}
			const t = item as Record<string, unknown>;
			if (typeof t.transaction_id !== 'string' || t.transaction_id.trim() === '') {
				return bad('Each transaction needs a non-empty "transaction_id".', 422);
			}
			if (typeof t.timestamp !== 'string' || Number.isNaN(new Date(t.timestamp).getTime())) {
				return bad('Each transaction needs a valid ISO 8601 "timestamp".', 422);
			}
			if (typeof t.type !== 'string' || !ALLOWED_TXN_TYPES.has(t.type)) {
				return bad(`Invalid transaction "type": ${String(t.type)}`, 422);
			}
			if (typeof t.amount !== 'number' || !Number.isFinite(t.amount)) {
				return bad('Each transaction needs a numeric "amount".', 422);
			}
			if (typeof t.counterparty !== 'string') {
				return bad('Each transaction needs a "counterparty" string.', 422);
			}
			if (typeof t.status !== 'string' || !ALLOWED_TXN_STATUSES.has(t.status)) {
				return bad(`Invalid transaction "status": ${String(t.status)}`, 422);
			}
			txns.push({
				transaction_id: t.transaction_id,
				timestamp: t.timestamp,
				type: t.type as Transaction['type'],
				amount: t.amount,
				counterparty: t.counterparty,
				status: t.status as Transaction['status']
			});
		}
	}

	const req: AnalyzeRequest = {
		ticket_id: body.ticket_id,
		complaint: body.complaint,
		language: body.language as AnalyzeRequest['language'],
		channel: body.channel as AnalyzeRequest['channel'],
		user_type: body.user_type as AnalyzeRequest['user_type'],
		campaign_context: typeof body.campaign_context === 'string' ? body.campaign_context : undefined,
		transaction_history: txns,
		metadata: body.metadata as Record<string, unknown> | undefined
	};

	try {
		const result = analyze(req);
		return json(result, { status: 200 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Internal error';
		return json({ error: message }, { status: 500 });
	}
};