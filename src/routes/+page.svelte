<script lang="ts">
	type TxnType = 'transfer' | 'payment' | 'cash_in' | 'cash_out' | 'settlement' | 'refund';
	type TxnStatus = 'completed' | 'failed' | 'pending' | 'reversed';

	interface TxnDraft {
		transaction_id: string;
		timestamp: string;
		type: TxnType;
		amount: number | string;
		counterparty: string;
		status: TxnStatus;
	}

	interface AnalyzeResponse {
		ticket_id: string;
		relevant_transaction_id: string | null;
		evidence_verdict: 'consistent' | 'inconsistent' | 'insufficient_data';
		case_type: string;
		severity: 'low' | 'medium' | 'high' | 'critical';
		department: string;
		agent_summary: string;
		recommended_next_action: string;
		customer_reply: string;
		human_review_required: boolean;
		confidence: number;
		reason_codes: string[];
	}

	const txnTypes: TxnType[] = ['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund'];
	const txnStatuses: TxnStatus[] = ['completed', 'failed', 'pending', 'reversed'];
	const languages = ['en', 'bn', 'mixed'] as const;
	const channels = ['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent'] as const;
	const userTypes = ['customer', 'merchant', 'agent', 'unknown'] as const;

	let ticket_id = $state('TKT-' + Math.floor(100 + Math.random() * 900));
	let complaint = $state(
		'I sent 5000 taka to a wrong number around 2pm today. Please help me get the money back.'
	);
	let language = $state<(typeof languages)[number]>('en');
	let channel = $state<(typeof channels)[number]>('in_app_chat');
	let user_type = $state<(typeof userTypes)[number]>('customer');
	let campaign_context = $state('boishakh_bonanza_day_1');

	let txns = $state<TxnDraft[]>([
		{
			transaction_id: 'TXN-9101',
			timestamp: new Date().toISOString().slice(0, 19) + 'Z',
			type: 'transfer',
			amount: 5000,
			counterparty: '+8801719876543',
			status: 'completed'
		}
	]);

	let response = $state<AnalyzeResponse | null>(null);
	let error = $state<string | null>(null);
	let statusCode = $state<number | null>(null);
	let loading = $state(false);

	function addTxn() {
		txns = [
			...txns,
			{
				transaction_id: 'TXN-' + Math.floor(1000 + Math.random() * 9000),
				timestamp: new Date().toISOString().slice(0, 19) + 'Z',
				type: 'transfer',
				amount: 0,
				counterparty: '',
				status: 'completed'
			}
		];
	}

	function removeTxn(i: number) {
		txns = txns.filter((_, idx) => idx !== i);
	}

	function loadSample(kind: 'consistent' | 'inconsistent' | 'no_history' | 'phishing') {
		if (kind === 'consistent') {
			complaint = 'I sent 5000 taka to a wrong number around 2pm today. Please help me get the money back.';
			language = 'en';
			txns = [
				{
					transaction_id: 'TXN-9101',
					timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
					type: 'transfer',
					amount: 5000,
					counterparty: '+8801719876543',
					status: 'completed'
				}
			];
		} else if (kind === 'inconsistent') {
			complaint = 'Money was deducted from my account but the transfer failed! Please refund me.';
			language = 'en';
			txns = [
				{
					transaction_id: 'TXN-7711',
					timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
					type: 'transfer',
					amount: 1200,
					counterparty: '+8801700000000',
					status: 'completed'
				}
			];
		} else if (kind === 'no_history') {
			complaint = 'Please help me — I cannot find my last payment. I think it failed.';
			language = 'en';
			txns = [];
		} else {
			complaint =
				'Someone called me and asked for my OTP and PIN to fix a problem with my account. Are they real?';
			language = 'en';
			txns = [];
		}
		error = null;
		response = null;
	}

	async function submit(e: Event) {
		e.preventDefault();
		error = null;
		response = null;
		statusCode = null;
		loading = true;
		try {
			const body = {
				ticket_id: ticket_id.trim(),
				complaint: complaint.trim(),
				language,
				channel,
				user_type,
				campaign_context: campaign_context.trim() || undefined,
				transaction_history: txns.map((t) => ({
					transaction_id: t.transaction_id.trim(),
					timestamp: new Date(t.timestamp).toISOString(),
					type: t.type,
					amount: Number(t.amount),
					counterparty: t.counterparty.trim(),
					status: t.status
				}))
			};
			const res = await fetch('/analyze-ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			statusCode = res.status;
			const json = (await res.json()) as AnalyzeResponse | { error?: string };
			if (!res.ok) {
				error = ('error' in json && json.error) || `Request failed with ${res.status}`;
			} else {
				response = json as AnalyzeResponse;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Network error';
		} finally {
			loading = false;
		}
	}

	function severityColor(sev: string): string {
		switch (sev) {
			case 'critical':
				return 'bg-red-100 text-red-800 border-red-200';
			case 'high':
				return 'bg-orange-100 text-orange-800 border-orange-200';
			case 'medium':
				return 'bg-amber-100 text-amber-800 border-amber-200';
			default:
				return 'bg-emerald-100 text-emerald-800 border-emerald-200';
		}
	}

	function verdictColor(v: string): string {
		switch (v) {
			case 'consistent':
				return 'bg-emerald-50 text-emerald-700 border-emerald-200';
			case 'inconsistent':
				return 'bg-red-50 text-red-700 border-red-200';
			default:
				return 'bg-slate-50 text-slate-700 border-slate-200';
		}
	}
</script>

<div class="grid gap-6 lg:grid-cols-5">
	<section class="lg:col-span-3">
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
			<header class="mb-4 flex items-center justify-between">
				<div>
					<h1 class="text-xl font-semibold tracking-tight">Investigate a complaint</h1>
					<p class="text-sm text-slate-500">
						Submit a ticket and recent transactions. The investigator will read both sides.
					</p>
				</div>
				<div class="hidden gap-2 sm:flex">
					<button
						type="button"
						class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
						onclick={() => loadSample('consistent')}>Sample: consistent</button
					>
					<button
						type="button"
						class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
						onclick={() => loadSample('inconsistent')}>Sample: inconsistent</button
					>
					<button
						type="button"
						class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
						onclick={() => loadSample('no_history')}>Sample: no history</button
					>
					<button
						type="button"
						class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
						onclick={() => loadSample('phishing')}>Sample: phishing</button
					>
				</div>
			</header>

			<form class="space-y-4" onsubmit={submit}>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="text-sm font-medium text-slate-700">Ticket ID</span>
						<input
							class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
							bind:value={ticket_id}
							required
						/>
					</label>
					<label class="block">
						<span class="text-sm font-medium text-slate-700">Campaign context</span>
						<input
							class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
							bind:value={campaign_context}
						/>
					</label>
				</div>

				<label class="block">
					<span class="text-sm font-medium text-slate-700">Complaint</span>
					<textarea
						class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
						rows="3"
						bind:value={complaint}
						required
					></textarea>
				</label>

				<div class="grid gap-3 sm:grid-cols-3">
					<label class="block">
						<span class="text-sm font-medium text-slate-700">Language</span>
						<select
							class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
							bind:value={language}
						>
							{#each languages as l (l)}<option value={l}>{l}</option>{/each}
						</select>
					</label>
					<label class="block">
						<span class="text-sm font-medium text-slate-700">Channel</span>
						<select
							class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
							bind:value={channel}
						>
							{#each channels as c (c)}<option value={c}>{c}</option>{/each}
						</select>
					</label>
					<label class="block">
						<span class="text-sm font-medium text-slate-700">User type</span>
						<select
							class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
							bind:value={user_type}
						>
							{#each userTypes as u (u)}<option value={u}>{u}</option>{/each}
						</select>
					</label>
				</div>

				<div>
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium text-slate-700">Recent transactions</span>
						<button
							type="button"
							class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
							onclick={addTxn}>+ Add transaction</button
						>
					</div>

					<div class="mt-2 space-y-2">
						{#each txns as t, i (i)}
							<div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
								<div class="grid gap-2 sm:grid-cols-6">
									<label class="block sm:col-span-2">
										<span class="text-xs text-slate-500">Transaction ID</span>
										<input
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.transaction_id}
										/>
									</label>
									<label class="block">
										<span class="text-xs text-slate-500">Amount (BDT)</span>
										<input
											type="number"
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.amount}
										/>
									</label>
									<label class="block">
										<span class="text-xs text-slate-500">Type</span>
										<select
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.type}
										>
											{#each txnTypes as tp (tp)}<option value={tp}>{tp}</option>{/each}
										</select>
									</label>
									<label class="block">
										<span class="text-xs text-slate-500">Status</span>
										<select
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.status}
										>
											{#each txnStatuses as s (s)}<option value={s}>{s}</option>{/each}
										</select>
									</label>
									<label class="block sm:col-span-2">
										<span class="text-xs text-slate-500">Counterparty</span>
										<input
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.counterparty}
										/>
									</label>
									<label class="block sm:col-span-3">
										<span class="text-xs text-slate-500">Timestamp (ISO 8601)</span>
										<input
											class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
											bind:value={t.timestamp}
										/>
									</label>
									<div class="flex items-end justify-end sm:col-span-3">
										<button
											type="button"
											class="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
											onclick={() => removeTxn(i)}
											disabled={txns.length === 1}
										>
											Remove
										</button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<div class="flex items-center justify-between">
					<p class="text-xs text-slate-500">Synthetic data only — no real customers.</p>
					<button
						type="submit"
						class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-500 disabled:opacity-60"
						disabled={loading}
					>
						{loading ? 'Analyzing…' : 'Run investigator'}
					</button>
				</div>
			</form>
		</div>
	</section>

	<section class="lg:col-span-2">
		<div class="sticky top-20 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
			<header class="mb-3">
				<h2 class="text-lg font-semibold tracking-tight">Result</h2>
				<p class="text-sm text-slate-500">Structured output for the support team.</p>
			</header>

			{#if statusCode !== null}
				<p class="mb-3 text-xs text-slate-500">HTTP {statusCode}</p>
			{/if}

			{#if error}
				<div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
					{error}
				</div>
			{/if}

			{#if response}
				<div class="space-y-3">
					<div class="flex flex-wrap items-center gap-2">
						<span class="rounded-md border px-2 py-0.5 text-xs {severityColor(response.severity)}">
							severity: {response.severity}
						</span>
						<span class="rounded-md border px-2 py-0.5 text-xs {verdictColor(response.evidence_verdict)}">
							evidence: {response.evidence_verdict}
						</span>
						<span class="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
							case: {response.case_type}
						</span>
						<span class="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
							dept: {response.department}
						</span>
						{#if response.human_review_required}
							<span class="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-700">
								human review
							</span>
						{/if}
					</div>

					<dl class="grid grid-cols-3 gap-2 text-xs">
						<dt class="text-slate-500">Relevant txn</dt>
						<dd class="col-span-2 font-mono text-slate-800">
							{response.relevant_transaction_id ?? '—'}
						</dd>
						<dt class="text-slate-500">Confidence</dt>
						<dd class="col-span-2 text-slate-800">
							{response.confidence.toFixed(2)}
						</dd>
						<dt class="text-slate-500">Reason codes</dt>
						<dd class="col-span-2">
							{#each response.reason_codes as r (r)}
								<span class="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700"
									>{r}</span
								>
							{/each}
						</dd>
					</dl>

					<div>
						<h3 class="text-sm font-semibold text-slate-700">Agent summary</h3>
						<p class="mt-1 text-sm text-slate-800">{response.agent_summary}</p>
					</div>
					<div>
						<h3 class="text-sm font-semibold text-slate-700">Next action</h3>
						<p class="mt-1 text-sm text-slate-800">{response.recommended_next_action}</p>
					</div>
					<div>
						<h3 class="text-sm font-semibold text-slate-700">Customer reply</h3>
						<p class="mt-1 whitespace-pre-line rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
							{response.customer_reply}
						</p>
					</div>
				</div>
			{:else if !error}
				<p class="text-sm text-slate-500">
					Submit a ticket to see the structured response here.
				</p>
			{/if}
		</div>
	</section>
</div>
