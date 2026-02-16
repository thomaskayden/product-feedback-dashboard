import { useEffect, useState } from 'react';
import { Button, Text, SkeletonLine } from '@cloudflare/kumo';

interface FeedbackItem {
	id: number;
	source: string;
	sentiment: string;
	comment: string;
	timestamp: string;
}

interface Summary {
	overall_summary: string;
	by_source: { source: string; total_items: number; dominant_sentiment: string }[];
	top_urgent_issues: string[];
}

type KpiEntry = { label: string; count: number; enterpriseCount: number } | null;
type KpiLowEntry = { issues: { label: string; count: number; enterpriseCount: number }[] } | null;

function App() {
	const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
	const [summary, setSummary] = useState<Summary | null>(null);
	const [kpiThemes, setKpiThemes] = useState<{ critical: KpiEntry; monitor: KpiEntry; low: KpiLowEntry } | null>(null);
	const [loadingFeedback, setLoadingFeedback] = useState(true);
	const [loadingSummary, setLoadingSummary] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedbackDisplayLimit, setFeedbackDisplayLimit] = useState(20);
	const [priorityFilter, setPriorityFilter] = useState<'all' | 'critical' | 'monitor' | 'low'>('all');
	const [sourceFilter, setSourceFilter] = useState<string>('all');
	const [searchQuery, setSearchQuery] = useState('');

	const SOURCE_OPTIONS: { value: string; label: string }[] = [
		{ value: 'all', label: 'All Sources' },
		{ value: 'GitHub issues', label: 'GitHub Issues' },
		{ value: 'Customer Support Tickets', label: 'Customer Support Tickets' },
		{ value: 'Discord', label: 'Discord' },
		{ value: 'email', label: 'Email' },
		{ value: 'community forums', label: 'Community Forums' },
		{ value: 'X/Twitter', label: 'X/Twitter' },
	];

	useEffect(() => {
		fetch('/api/feedback')
			.then(async (r) => {
				const data = await r.json();
				if (!r.ok) {
					const msg = (data?.error ?? data?.details ?? `Request failed: ${r.status}`);
					throw new Error(msg);
				}
				if (!Array.isArray(data)) {
					throw new Error(data?.error ?? 'Invalid feedback response');
				}
				return data as FeedbackItem[];
			})
			.then((data) => {
				setFeedback(data);
				setLoadingFeedback(false);
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err));
				setLoadingFeedback(false);
			});

		setLoadingSummary(true);
		fetch('/api/summary')
			.then((r) => r.json())
			.then((data) => {
				setSummary(data);
				setLoadingSummary(false);
			})
			.catch(() => {
				setLoadingSummary(false);
			});

		fetch('/api/kpi-themes')
			.then((r) => r.json())
			.then((data) => {
				const entry = (x: unknown) =>
					x && typeof x === 'object' && 'label' in x && 'count' in x
						? {
								label: String((x as { label: unknown }).label),
								count: Number((x as { count: unknown }).count) || 0,
								enterpriseCount: Number((x as { enterpriseCount?: unknown }).enterpriseCount) || 0,
							}
						: null;
				const parseLow = (x: unknown): KpiLowEntry => {
					if (!x || typeof x !== 'object' || !('issues' in x)) return null;
					const arr = (x as { issues: unknown }).issues;
					if (!Array.isArray(arr) || arr.length === 0) return null;
					const issues = arr
						.filter((i) => i && typeof i === 'object' && 'label' in i && 'count' in i)
						.map((i) => ({
							label: String((i as { label: unknown }).label),
							count: Number((i as { count: unknown }).count) || 0,
							enterpriseCount: Number((i as { enterpriseCount?: unknown }).enterpriseCount) || 0,
						}));
					return issues.length > 0 ? { issues } : null;
				};
				if (data?.critical !== undefined || data?.monitor !== undefined || data?.low !== undefined) {
					setKpiThemes({
						critical: entry(data.critical),
						monitor: entry(data.monitor),
						low: parseLow(data.low),
					});
				}
			})
			.catch(() => {});
	}, []);

	if (error) {
		return (
			<div className="dashboard min-h-screen">
				<div className="dashboard-inner max-w-2xl">
					<div className="dashboard-card p-8">
						<Text>Error: {error}</Text>
					</div>
				</div>
			</div>
		);
	}

	const sentimentPillClass = (sentiment: string) => {
		const s = sentiment.toLowerCase();
		if (s === 'positive') return 'dashboard-pill dashboard-pill-positive';
		if (s === 'negative') return 'dashboard-pill dashboard-pill-negative';
		return 'dashboard-pill dashboard-pill-neutral';
	};

	const criticalCount = feedback.filter((f) => f.sentiment.toLowerCase() === 'negative').length;
	const monitorCount = feedback.filter((f) => f.sentiment.toLowerCase() === 'neutral').length;
	const lowCount = feedback.filter((f) => f.sentiment.toLowerCase() === 'positive').length;

	/** UTC date YYYY-MM-DD for today and yesterday. */
	const getTodayYesterday = () => {
		const now = new Date();
		const today = now.toISOString().slice(0, 10);
		const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
		return { today, yesterday };
	};
	const dateOf = (ts: string) => (isNaN(new Date(ts).getTime()) ? '' : new Date(ts).toISOString().slice(0, 10));

	/** Map a single comment to a canonical theme. Order of checks matters. */
	const getThemeForComment = (comment: string): string => {
		const text = (comment ?? '').toLowerCase();
		if (/\b(login|sso|auth|password|authenticate|sign.?in|log.?in)\b/.test(text)) return 'Authentication / Login Issues';
		if (/\b(api|rate.?limit|timeout|500|endpoint)\b/.test(text)) return 'API Timeout Errors';
		if (/\b(deploy|token|session|invalid)\b/.test(text)) return 'Deployment / Session Issues';
		if (/\b(ui|interface|ux|design|bug)\b/.test(text)) return 'UI / UX Issues';
		if (/\b(email|notification|alert)\b/.test(text)) return 'Notifications / Alerts';
		if (/\b(reset|forgot|recovery)\b/.test(text)) return 'Account Recovery';
		if (/\b(status|confusion|tracking)\b/.test(text)) return 'Issue / Ticket Status';
		if (/\b(dashboard|latency|slow|performance)\b/.test(text)) return 'Dashboard Latency';
		if (/\b(documentation|docs|guide|scattered)\b/.test(text)) return 'Documentation Confusion';
		return 'Other';
	};

	/** Build global theme counts for fallback when a bucket has no distinct theme. */
	const globalThemeCounts = new Map<string, number>();
	for (const f of feedback) {
		const theme = getThemeForComment(f.comment);
		if (theme !== 'Other') globalThemeCounts.set(theme, (globalThemeCounts.get(theme) ?? 0) + 1);
	}
	const globallyRankedThemes = [...globalThemeCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([t]) => t);

	/** Pick next unused theme from global ranking. Used when bucket would otherwise show a duplicate. */
	const nextGlobalTheme = (exclude: string[]): string => {
		const excludeSet = new Set(exclude);
		return globallyRankedThemes.find((t) => !excludeSet.has(t)) ?? 'Various feedback';
	};

	const MONITOR_PREFERRED_THEME = 'Authentication / Login Issues';

	/** Compute the most frequent theme within a priority bucket, excluding themes already used by higher-priority cards. */
	const getTopThemeForPriority = (
		priority: 'critical' | 'monitor' | 'low',
		exclude: string[] = [],
		preferTheme?: string,
	): string => {
		const sentimentFilter =
			priority === 'critical' ? 'negative' : priority === 'monitor' ? 'neutral' : 'positive';
		const bucketItems = feedback.filter((f) => f.sentiment.toLowerCase() === sentimentFilter);
		if (bucketItems.length === 0) return 'No dominant issue';

		const themeCounts = new Map<string, number>();
		for (const f of bucketItems) {
			const theme = getThemeForComment(f.comment);
			themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
		}

		const excludeSet = new Set(exclude);
		if (preferTheme && priority === 'monitor' && !excludeSet.has(preferTheme) && (themeCounts.get(preferTheme) ?? 0) > 0) {
			return preferTheme;
		}
		const sorted = [...themeCounts.entries()]
			.filter(([t]) => t !== 'Other' && !excludeSet.has(t))
			.sort((a, b) => b[1] - a[1]);
		const top = sorted[0]?.[0];
		return top ?? nextGlobalTheme(exclude);
	};

	/** Top 3 themes by today's count for Trend Snapshot (change-over-time focus). */
	const trendSnapshotData = (() => {
		const { today, yesterday } = getTodayYesterday();
		const todayItems = feedback.filter((f) => dateOf(f.timestamp) === today);
		const yesterdayItems = feedback.filter((f) => dateOf(f.timestamp) === yesterday);
		const todayByTheme = new Map<string, number>();
		const yesterdayByTheme = new Map<string, number>();
		for (const f of todayItems) {
			const theme = getThemeForComment(f.comment);
			if (theme === 'Other') continue;
			todayByTheme.set(theme, (todayByTheme.get(theme) ?? 0) + 1);
		}
		for (const f of yesterdayItems) {
			const theme = getThemeForComment(f.comment);
			if (theme === 'Other') continue;
			yesterdayByTheme.set(theme, (yesterdayByTheme.get(theme) ?? 0) + 1);
		}
		const allThemes = new Set([...todayByTheme.keys(), ...yesterdayByTheme.keys()]);
		return [...allThemes]
			.map((theme) => {
				const todayCount = todayByTheme.get(theme) ?? 0;
				const yesterdayCount = yesterdayByTheme.get(theme) ?? 0;
				const delta = todayCount - yesterdayCount;
				return { theme, yesterdayCount, todayCount, delta };
			})
			.filter((r) => (r.todayCount > 0 || r.yesterdayCount > 0) && r.delta !== 0)
			.sort((a, b) => b.todayCount - a.todayCount)
			.slice(0, 3);
	})();

	/** Count feedback in a bucket matching a given theme. For fallback when API has no data. */
	const getCountForTheme = (
		priority: 'critical' | 'monitor' | 'low',
		theme: string,
	): { count: number; enterpriseCount: number } => {
		const sentiment = priority === 'critical' ? 'negative' : priority === 'monitor' ? 'neutral' : 'positive';
		const bucket = feedback.filter((f) => f.sentiment.toLowerCase() === sentiment);
		const matching = bucket.filter((f) => getThemeForComment(f.comment) === theme);
		const enterpriseCount = matching.filter((f) =>
			['customer support tickets', 'email'].includes(f.source.toLowerCase()),
		).length;
		return { count: matching.length, enterpriseCount };
	};

	const KPI_EXCLUDED = ['Notifications / Alerts', 'Issue / Ticket Status'];
	const fallbackCritical = getTopThemeForPriority('critical');
	const fallbackMonitor = getTopThemeForPriority('monitor', [fallbackCritical], MONITOR_PREFERRED_THEME);

	/** Top 3 themes for Low Impact bucket (fallback when API has no data). Always returns at least one issue when bucket has data. */
	const getTopThemesForLow = (): { label: string; count: number; enterpriseCount: number }[] => {
		const sentimentFilter = 'positive';
		const bucketItems = feedback.filter((f) => f.sentiment.toLowerCase() === sentimentFilter);
		if (bucketItems.length === 0) return [];
		const buildIssues = (exclude: string[], includeOther = false) => {
			const themeCounts = new Map<string, FeedbackItem[]>();
			for (const f of bucketItems) {
				const theme = getThemeForComment(f.comment);
				if ((!includeOther && theme === 'Other') || exclude.includes(theme)) continue;
				const key = theme === 'Other' && includeOther ? 'Various feedback' : theme;
				if (!themeCounts.has(key)) themeCounts.set(key, []);
				themeCounts.get(key)!.push(f);
			}
			return [...themeCounts.entries()]
				.sort((a, b) => b[1].length - a[1].length)
				.slice(0, 3)
				.map(([label, items]) => ({
					label,
					count: items.length,
					enterpriseCount: items.filter((f) => ['customer support tickets', 'email'].includes(f.source.toLowerCase())).length,
				}));
		};
		const excludeWithKpi = [fallbackCritical, fallbackMonitor, ...KPI_EXCLUDED];
		let issues = buildIssues(excludeWithKpi);
		if (issues.length === 0) issues = buildIssues([fallbackCritical, fallbackMonitor]);
		if (issues.length === 0) issues = buildIssues([fallbackCritical, fallbackMonitor], true);
		return issues;
	};

	const fallbackCriticalStats = getCountForTheme('critical', fallbackCritical);
	const fallbackMonitorStats = getCountForTheme('monitor', fallbackMonitor);
	const fallbackLowIssues = getTopThemesForLow();

	const criticalIssueLabel = kpiThemes?.critical?.label ?? fallbackCritical;
	const monitorIssueLabel =
		(kpiThemes?.monitor?.label && kpiThemes.monitor.label !== criticalIssueLabel)
			? kpiThemes.monitor.label
			: fallbackMonitor;

	const criticalDisplayCount = kpiThemes?.critical?.count ?? fallbackCriticalStats.count;
	const monitorDisplayCount = kpiThemes?.monitor?.count ?? fallbackMonitorStats.count;

	const lowIssues = kpiThemes?.low?.issues ?? fallbackLowIssues;

	const criticalEnterpriseDisplay = kpiThemes?.critical?.enterpriseCount ?? fallbackCriticalStats.enterpriseCount;
	const monitorEnterpriseDisplay = kpiThemes?.monitor?.enterpriseCount ?? fallbackMonitorStats.enterpriseCount;

	/** Top recurring themes: group by theme, count mentions, sort by frequency. Exclude 'Other'. */
	const recurringThemes = (() => {
		const byTheme = new Map<string, { count: number; sources: Map<string, number> }>();
		for (const f of feedback) {
			const theme = getThemeForComment(f.comment);
			if (theme === 'Other') continue;
			if (!byTheme.has(theme)) byTheme.set(theme, { count: 0, sources: new Map() });
			const rec = byTheme.get(theme)!;
			rec.count += 1;
			rec.sources.set(f.source, (rec.sources.get(f.source) ?? 0) + 1);
		}
		return [...byTheme.entries()]
			.sort((a, b) => b[1].count - a[1].count)
			.slice(0, 5)
			.map(([theme, { count, sources }]) => {
				const primarySource = [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
				return { theme, count, primarySource };
			});
	})();

	/** Executive Summary: Starts with "We". Simple, non-technical. Top issue first, second briefly. No multiple numbers. 1–2 sentences. */
	const renderExecSummary = () => {
		if (feedback.length === 0) {
			return <span>We have no feedback recorded yet.</span>;
		}
		if (criticalDisplayCount > 0) {
			const sent1 =
				criticalEnterpriseDisplay > 0 ? (
					<>We are seeing <span className="dashboard-exec-bold">{criticalIssueLabel}</span> impact the most users today, especially enterprise customers.</>
				) : (
					<>We are seeing <span className="dashboard-exec-bold">{criticalIssueLabel}</span> impact the most users today.</>
				);
			const sent2 =
				monitorDisplayCount > 0 ? (
					<> <span className="dashboard-exec-bold">{monitorIssueLabel}</span> is also coming up frequently.</>
				) : null;
			return <>{sent1}{sent2}</>;
		}
		return <>We are not seeing a dominant critical issue today. The mix is spread across sources.</>;
	};

	const sortedFeedback = [...feedback].sort((a, b) => {
		const order = { negative: 0, neutral: 1, positive: 2 };
		return (order[a.sentiment.toLowerCase() as keyof typeof order] ?? 2) - (order[b.sentiment.toLowerCase() as keyof typeof order] ?? 2);
	});

	const priorityFromSentiment = (s: string) => {
		const lower = s.toLowerCase();
		if (lower === 'negative') return 'critical';
		if (lower === 'neutral') return 'monitor';
		return 'low';
	};

	const filteredBySource =
		sourceFilter === 'all'
			? sortedFeedback
			: sortedFeedback.filter((f) => f.source.toLowerCase() === sourceFilter.toLowerCase());

	const filteredByPriority = filteredBySource.filter((item) => {
		if (priorityFilter === 'all') return true;
		return priorityFromSentiment(item.sentiment) === priorityFilter;
	});

	const filteredFeedback = searchQuery.trim()
		? filteredByPriority.filter((item) => {
				const q = searchQuery.trim().toLowerCase();
				const commentMatch = (item.comment ?? '').toLowerCase().includes(q);
				const sourceMatch = (item.source ?? '').toLowerCase().includes(q);
				const themeMatch = getThemeForComment(item.comment).toLowerCase().includes(q);
				return commentMatch || sourceMatch || themeMatch;
		  })
		: filteredByPriority;

	const displayFeedback = filteredFeedback.slice(0, feedbackDisplayLimit);

	const sourceFilteredCriticalCount = filteredBySource.filter((f) => f.sentiment.toLowerCase() === 'negative').length;
	const sourceFilteredMonitorCount = filteredBySource.filter((f) => f.sentiment.toLowerCase() === 'neutral').length;
	const sourceFilteredLowCount = filteredBySource.filter((f) => f.sentiment.toLowerCase() === 'positive').length;

	return (
		<div className="dashboard min-h-screen">
			<div className="dashboard-inner">
				<header className="dashboard-header">
					<div className="dashboard-header-left">
						<h1>Product Feedback Dashboard</h1>
					</div>
					<div className="dashboard-header-right">
						<Button variant="secondary" onClick={() => window.location.reload()}>
							Refresh
						</Button>
					</div>
				</header>

				{!loadingFeedback && (
					<section className="daily-brief" aria-labelledby="daily-brief-heading">
						<h2 id="daily-brief-heading" className="daily-brief-title">Daily Brief</h2>
						<p className="daily-brief-summary">
							Today we received <span className="daily-brief-summary-hero">{feedback.length}</span> feedback item{feedback.length !== 1 ? 's' : ''} across{' '}
							<span className="daily-brief-summary-hero">{new Set(feedback.map((f) => f.source)).size}</span> source{new Set(feedback.map((f) => f.source)).size !== 1 ? 's' : ''}.
						</p>
						<div className="daily-brief-cards" role="group" aria-label="KPI overview">
							<div className="daily-brief-card daily-brief-card-critical" role="group" aria-labelledby="kpi-critical-heading">
								<p id="kpi-critical-heading" className="inline-block px-2.5 py-1.5 mb-4 text-xs font-semibold uppercase tracking-wider rounded-full bg-[rgba(185,28,28,0.12)] text-[#b91c1c]">Critical</p>
								<div className="daily-brief-card-narrative">
									{criticalDisplayCount === 0 ? (
										<span className="daily-brief-card-connector">No reports</span>
									) : (
										<>
											<span className="daily-brief-card-hero">{criticalDisplayCount}</span>
											<span className="daily-brief-card-connector"> {criticalDisplayCount === 1 ? 'customer reports' : 'customers report'} </span>
											<span className="daily-brief-card-hero">{criticalIssueLabel}</span>
										</>
									)}
								</div>
								{criticalEnterpriseDisplay > 0 && (
									<p className="daily-brief-card-enterprise">
										including {criticalEnterpriseDisplay} enterprise {criticalEnterpriseDisplay === 1 ? 'customer' : 'customers'}
									</p>
								)}
							</div>
							<div className="daily-brief-card daily-brief-card-monitor" role="group" aria-labelledby="kpi-monitor-heading">
								<p id="kpi-monitor-heading" className="inline-block px-2.5 py-1.5 mb-4 text-xs font-semibold uppercase tracking-wider rounded-full bg-[rgba(180,83,9,0.12)] text-[#b45309]">Monitor</p>
								<div className="daily-brief-card-narrative">
									{monitorDisplayCount === 0 ? (
										<span className="daily-brief-card-connector">No reports</span>
									) : (
										<>
											<span className="daily-brief-card-hero">{monitorDisplayCount}</span>
											<span className="daily-brief-card-connector"> {monitorDisplayCount === 1 ? 'customer reports' : 'customers report'} </span>
											<span className="daily-brief-card-hero">{monitorIssueLabel}</span>
										</>
									)}
								</div>
								{monitorEnterpriseDisplay > 0 && (
									<p className="daily-brief-card-enterprise">
										including {monitorEnterpriseDisplay} enterprise {monitorEnterpriseDisplay === 1 ? 'customer' : 'customers'}
									</p>
								)}
							</div>
							<div className="daily-brief-card daily-brief-card-low" role="group" aria-labelledby="kpi-low-heading">
								<p id="kpi-low-heading" className="inline-block px-2.5 py-1.5 mb-4 text-xs font-semibold uppercase tracking-wider rounded-full bg-[rgba(5,150,105,0.12)] text-[#059669]">Low Impact</p>
								<div className="daily-brief-card-narrative">
									{lowIssues.length === 0 ? (
										<span className="daily-brief-card-connector">No reports</span>
									) : (
										<ul className="list-none space-y-1.5 p-0 m-0">
											{lowIssues.map((issue, i) => (
												<li key={i}>
													<span className="daily-brief-card-hero">{issue.count}</span>
													<span className="daily-brief-card-connector"> {issue.count === 1 ? 'customer reports' : 'customers report'} </span>
													<span className="daily-brief-card-hero">{issue.label}</span>
												</li>
											))}
										</ul>
									)}
								</div>
							</div>
						</div>
					</section>
				)}

				<div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
					<div className="lg:col-span-2 space-y-12">
						<section className="dashboard-card">
							<p className="dashboard-section-title">Executive Summary</p>
							{loadingSummary || loadingFeedback ? (
								<div className="flex flex-col gap-3">
									<SkeletonLine className="w-4/5 h-4" />
									<SkeletonLine className="w-3/5 h-4" />
									<SkeletonLine className="w-2/3 h-4" />
								</div>
							) : feedback.length > 0 || summary ? (
								<div className="dashboard-exec-summary">
									{renderExecSummary()}
								</div>
							) : (
								<Text>Unable to load summary</Text>
							)}
						</section>

						<section className="dashboard-card trend-snapshot-card">
							<p className="dashboard-section-title">Trend Snapshot</p>
							<p className="trend-snapshot-subtitle">Change since yesterday</p>
							{loadingFeedback ? (
								<div className="space-y-5">
									<SkeletonLine className="w-2/3 h-4" />
									<SkeletonLine className="w-1/2 h-4" />
									<SkeletonLine className="w-3/5 h-4" />
								</div>
							) : trendSnapshotData.length > 0 ? (
								<ul className="trend-snapshot-list" role="list" aria-label="Theme trends">
									{trendSnapshotData.map(({ theme, delta }, i) => {
										const arrow = delta > 0 ? '▲' : '▼';
										const deltaClass = delta > 0 ? 'trend-delta-increase' : 'trend-delta-decrease';
										const deltaText = delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
										return (
											<li key={i} className="trend-snapshot-item">
												<span className="trend-snapshot-theme">{theme}</span>
												<span className={`trend-snapshot-delta ${deltaClass}`}>
													{arrow} {deltaText}
												</span>
											</li>
										);
									})}
								</ul>
							) : feedback.length > 0 ? (
								<p className="trend-snapshot-empty">No movement since yesterday.</p>
							) : null}
						</section>
					</div>

					<div>
						{loadingFeedback ? (
							<section className="dashboard-card">
								<p className="dashboard-section-title">Top Recurring Themes</p>
								<SkeletonLine className="w-9/10 h-4" />
							</section>
						) : recurringThemes.length > 0 ? (
							<section className="dashboard-card">
								<p className="dashboard-section-title">Top Recurring Themes</p>
								<ul className="dashboard-themes-list" role="list" aria-label="Top recurring themes">
									{recurringThemes.map(({ theme, count, primarySource }, i) => (
										<li key={i} className="dashboard-themes-item">
											<span className="dashboard-themes-title">{theme}</span>
											<span className="dashboard-themes-meta">
												{count} mention{count !== 1 ? 's' : ''}
												{primarySource && (
													<span className="dashboard-themes-source"> · {primarySource}</span>
												)}
											</span>
										</li>
									))}
								</ul>
							</section>
						) : feedback.length > 0 ? (
							<section className="dashboard-card">
								<p className="dashboard-section-title">Top Recurring Themes</p>
								<p className="dashboard-themes-empty text-[#94a3b8] text-sm">No recurring themes identified yet.</p>
							</section>
						) : null}
					</div>
				</div>

				<section className="mt-16">
					<div className="mb-4">
						<div className="flex flex-wrap items-center justify-between gap-4 mb-3">
							<p className="dashboard-section-title mb-0">All Feedback</p>
						</div>
						{!loadingFeedback && feedback.length > 0 && (
							<div className="feedback-search-row mb-3">
								<input
									type="search"
									placeholder="Search feedback…"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									className="feedback-search-input"
									aria-label="Search feedback by comment, source, or theme"
								/>
							</div>
						)}
						{!loadingFeedback && feedback.length > 0 && (
							<div className="flex flex-wrap items-center justify-between gap-4 mb-3">
								<div className="feedback-filter-pill feedback-filter-pill-priority" role="group" aria-label="Filter by priority">
									<button
										type="button"
										className={`feedback-filter-btn ${priorityFilter === 'all' ? 'feedback-filter-btn-active' : ''}`}
										onClick={() => setPriorityFilter('all')}
									>
										All ({sourceFilter === 'all' ? feedback.length : filteredBySource.length})
									</button>
									<button
										type="button"
										className={`feedback-filter-btn feedback-filter-btn-critical ${priorityFilter === 'critical' ? 'feedback-filter-btn-active' : ''}`}
										onClick={() => setPriorityFilter('critical')}
									>
										Critical ({sourceFilter === 'all' ? criticalCount : sourceFilteredCriticalCount})
									</button>
									<button
										type="button"
										className={`feedback-filter-btn feedback-filter-btn-monitor ${priorityFilter === 'monitor' ? 'feedback-filter-btn-active' : ''}`}
										onClick={() => setPriorityFilter('monitor')}
									>
										Monitor ({sourceFilter === 'all' ? monitorCount : sourceFilteredMonitorCount})
									</button>
									<button
										type="button"
										className={`feedback-filter-btn feedback-filter-btn-low ${priorityFilter === 'low' ? 'feedback-filter-btn-active' : ''}`}
										onClick={() => setPriorityFilter('low')}
									>
										Low Impact ({sourceFilter === 'all' ? lowCount : sourceFilteredLowCount})
									</button>
								</div>
							</div>
						)}
						{!loadingFeedback && feedback.length > 0 && (
							<div className="flex flex-wrap items-center gap-3 mb-3 feedback-filter-source-row">
								<div className="feedback-filter-pill feedback-filter-pill-source" role="group" aria-label="Filter by source">
									{SOURCE_OPTIONS.map((opt) => {
										const count =
											opt.value === 'all'
												? feedback.length
												: feedback.filter((f) => f.source.toLowerCase() === opt.value.toLowerCase()).length;
										return (
											<button
												key={opt.value}
												type="button"
												className={`feedback-filter-btn feedback-filter-btn-source ${sourceFilter === opt.value ? 'feedback-filter-btn-active' : ''}`}
												onClick={() => setSourceFilter(opt.value)}
											>
												{opt.label} <span className="feedback-filter-count">({count})</span>
											</button>
										);
									})}
								</div>
							</div>
						)}
						{!loadingFeedback && feedback.length > 0 && (
							<p className="feedback-showing-label text-sm text-[#64748b]">
								{filteredFeedback.length > 0
									? `Showing ${Math.min(feedbackDisplayLimit, filteredFeedback.length)} of ${filteredFeedback.length} feedback item${filteredFeedback.length !== 1 ? 's' : ''}.`
									: 'No results match your search.'}
							</p>
						)}
					</div>
					{loadingFeedback ? (
						<div className="dashboard-table-wrap p-6">
							<SkeletonLine className="w-full h-4" />
							<SkeletonLine className="w-full h-4" />
						</div>
					) : feedback.length === 0 ? (
						<div className="dashboard-table-wrap p-10 text-center text-[#64748b]">
							<Text>No feedback recorded yet.</Text>
						</div>
					) : filteredFeedback.length === 0 ? (
						<div className="dashboard-table-wrap p-10 text-center text-[#94a3b8] feedback-empty-state">
							<Text>
								{searchQuery.trim()
									? 'No results match your search. Try different keywords or filters.'
									: 'No feedback items in this category.'}
							</Text>
						</div>
					) : (
						<div className="dashboard-table-wrap feedback-table-transition">
							<table className="dashboard-table" role="table" aria-label="All feedback">
								<thead>
									<tr>
										<th>Source</th>
										<th>Sentiment</th>
										<th>Comment</th>
										<th>Date</th>
									</tr>
								</thead>
								<tbody>
									{displayFeedback.map((item) => (
										<tr key={item.id}>
											<td>{item.source}</td>
											<td>
												<span className={sentimentPillClass(item.sentiment)}>
													{item.sentiment}
												</span>
											</td>
											<td className="comment-cell" title={item.comment}>
												{item.comment}
											</td>
											<td>{new Date(item.timestamp).toLocaleDateString()}</td>
										</tr>
									))}
								</tbody>
							</table>
							{feedbackDisplayLimit < filteredFeedback.length ? (
								<button
									className="dashboard-table-expand"
									onClick={() => setFeedbackDisplayLimit((n) => n + 20)}
								>
									Load more
								</button>
							) : filteredFeedback.length > 0 ? (
								<p className="feedback-all-loaded text-sm text-[#64748b]">
									All {filteredFeedback.length} feedback item{filteredFeedback.length !== 1 ? 's' : ''} loaded.
								</p>
							) : null}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

export default App;
