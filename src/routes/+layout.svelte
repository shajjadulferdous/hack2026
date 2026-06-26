<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	let { children } = $props();

	let health: 'ok' | 'down' | 'checking' = $state('checking');

	async function pingHealth() {
		try {
			const res = await fetch('/health');
			if (!res.ok) {
				health = 'down';
				return;
			}
			const data = (await res.json()) as { status?: string };
			health = data.status === 'ok' ? 'ok' : 'down';
		} catch {
			health = 'down';
		}
	}

	onMount(() => {
		pingHealth();
		const id = setInterval(pingHealth, 15_000);
		return () => clearInterval(id);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Complaint Investigator</title>
</svelte:head>

<div class="min-h-screen bg-slate-50 text-slate-900">
	<header
		class="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur"
	>
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
			<a href={resolve('/')} class="flex items-center gap-2 text-lg font-semibold tracking-tight">
				<span
					class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow"
				>
					CI
				</span>
				<span>Complaint Investigator</span>
			</a>

			<nav class="flex items-center gap-4 text-sm">
				<a
					href={resolve('/')}
					class="rounded-md px-3 py-1.5 text-slate-700 hover:bg-slate-100"
					aria-current="page">Dashboard</a
				>
				<span
					class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
					class:border-emerald-200={health === 'ok'}
					class:bg-emerald-50={health === 'ok'}
					class:text-emerald-700={health === 'ok'}
					class:border-amber-200={health === 'down'}
					class:bg-amber-50={health === 'down'}
					class:text-amber-700={health === 'down'}
					class:border-slate-200={health === 'checking'}
					class:bg-slate-50={health === 'checking'}
					class:text-slate-600={health === 'checking'}
					title="Service health"
				>
					<span
						class="inline-block h-2 w-2 rounded-full"
						class:bg-emerald-500={health === 'ok'}
						class:bg-amber-500={health === 'down'}
						class:bg-slate-400={health === 'checking'}
					></span>
					{health === 'ok' ? 'Service ready' : health === 'down' ? 'Service down' : 'Checking…'}
				</span>
			</nav>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-6 py-8">
		{@render children()}
	</main>

	<footer class="mx-auto max-w-6xl px-6 py-6 text-xs text-slate-500">
		Internal copilot for support agents — synthetic data only.
	</footer>
</div>
