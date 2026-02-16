/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Env {
	FEEDBACK_DB: D1Database;
	AI: Ai;
	ASSETS?: Fetcher;
}

type Summary = {
	overall_summary: string;
	by_source: {
		source: string;
		total_items: number;
		dominant_sentiment: string;
		key_issues: string[];
	}[];
	top_urgent_issues: string[];
};

let cachedSummary: Summary | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

/** Dashboard HTML cache: avoid D1 + AI on every reload. */
let dashboardCache: { date: string; html: string; cachedAt: number } | null = null;
const DASHBOARD_CACHE_TTL_MS = 120_000; // 2 min — repeat loads are instant

/** Executive summary cache: skip Workers AI when summary for today is still fresh. */
let execSummaryCache: { date: string; text: string; cachedAt: number } | null = null;
const EXEC_SUMMARY_CACHE_TTL_MS = 300_000; // 5 min — avoids slow AI call on most reloads

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Extract and parse JSON from AI response, tolerating markdown code blocks. */
function parseAiJson<T>(text: string): T {
	let raw = text.trim();
	if (raw.startsWith('```')) {
		raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
	}
	return JSON.parse(raw) as T;
}

type FeedbackRow = {
	id: number;
	source: string;
	sentiment: string;
	comment: string;
	timestamp: string;
};

/** Build a fully populated Summary from feedback data (for when AI fails or is partial). */
function summaryFromFeedback(items: FeedbackRow[]): Summary {
	const sources = [...new Set(items.map((i) => i.source))];
	const overall_summary =
		items.length === 0
			? 'No feedback has been recorded yet.'
			: `${items.length} feedback item${items.length !== 1 ? 's' : ''} from ${sources.join(', ')}.`;

	const by_source = sources.map((source) => {
		const forSource = items.filter((i) => i.source === source);
		const sentiments = forSource.map((i) => String(i.sentiment ?? '').toLowerCase());
		const pos = sentiments.filter((s) => s === 'positive').length;
		const neg = sentiments.filter((s) => s === 'negative').length;
		const dominant_sentiment =
			neg > forSource.length / 2 ? 'negative' : pos > forSource.length / 2 ? 'positive' : 'neutral';
		return {
			source,
			total_items: forSource.length,
			dominant_sentiment,
			key_issues: forSource.slice(0, 5).map((i) => i.comment.slice(0, 80) + (i.comment.length > 80 ? '…' : '')),
		};
	});

	return {
		overall_summary,
		by_source,
		top_urgent_issues: items.slice(0, 5).map((i) => `${i.source}: ${i.comment.slice(0, 60)}${i.comment.length > 60 ? '…' : ''}`),
	};
}

/** Ensure a Summary has all required fields; fill missing from feedback. */
function normalizeSummary(parsed: Partial<Summary>, feedbackItems: FeedbackRow[]): Summary {
	const fallback = summaryFromFeedback(feedbackItems);
	return {
		overall_summary:
			typeof parsed.overall_summary === 'string' && parsed.overall_summary.length > 0
				? parsed.overall_summary
				: fallback.overall_summary,
		by_source:
			Array.isArray(parsed.by_source) && parsed.by_source.length > 0 ? parsed.by_source : fallback.by_source,
		top_urgent_issues:
			Array.isArray(parsed.top_urgent_issues) && parsed.top_urgent_issues.length > 0
				? parsed.top_urgent_issues
				: fallback.top_urgent_issues,
	};
}

/** Canonical theme labels (short, 2–5 words). Never use raw comments. */
const CANONICAL_THEMES = [
	'Authentication / Login Issues',
	'Support Response Delays',
	'Email Delivery Issues',
	'API Timeout Errors',
	'Link / Validation Errors',
	'Issue / Ticket Status',
	'"Needs Info" Workflow Friction',
	'Documentation Confusion',
] as const;

/** Map keywords (lowercase) to a canonical theme. Order matters: first match wins. */
const KEYWORD_TO_THEME: { keywords: string[]; theme: string }[] = [
	{ keywords: ['login', 'auth', 'password', 'sign-in', 'signin', 'session', 'token', 'sso', 'saml', 'idp'], theme: CANONICAL_THEMES[0] },
	{ keywords: ['delay', 'slow', 'response time', 'wait', 'support', 'reply', 'ticket'], theme: CANONICAL_THEMES[1] },
	{ keywords: ['email', 'delivery', 'inbox', 'notification', 'mail'], theme: CANONICAL_THEMES[2] },
	{ keywords: ['api', 'timeout', '504', 'failing', 'gateway timeout'], theme: CANONICAL_THEMES[3] },
	{ keywords: ['link', 'validation', 'invalid', 'error', 'broken', 'expired', 'verify'], theme: CANONICAL_THEMES[4] },
	{ keywords: ['status', 'confusion', 'update', 'tracking', 'state'], theme: CANONICAL_THEMES[5] },
	{ keywords: ['github', 'needs info', 'workflow', 'triage', 'issue status', 'labels'], theme: CANONICAL_THEMES[6] },
	{ keywords: ['documentation', 'docs', 'guide', 'scattered', 'right page'], theme: CANONICAL_THEMES[7] },
];

/** Preferred order for Source Breakdown. Sources not listed appear after. */
const SOURCE_DISPLAY_ORDER = [
	'Customer Support Tickets',
	'Discord',
	'GitHub issues',
	'email',
	'X/Twitter',
	'community forums',
];

/** Turn raw text into a short abstract label (2–5 words) or map to a canonical theme. Never return full sentences or comments. */
function toAbstractLabel(raw: string): string | null {
	const maxWords = 5;
	const minWords = 2;
	// Strip quotes, IDs (numeric/uuid-like), and normalize
	let s = raw
		.replace(/^["']|["']$/g, '')
		.replace(/\b\d{2,}\b/g, '')
		.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '')
		.trim();
	if (!s || s.length < 3) return null;
	const lower = s.toLowerCase();
	// Map by keyword first
	for (const { keywords, theme } of KEYWORD_TO_THEME) {
		if (keywords.some((k) => lower.includes(k))) return theme;
	}
	// Otherwise take first 2–5 words (no full sentences)
	const words = s.split(/\s+/).filter((w) => w.length > 0).slice(0, maxWords);
	if (words.length < minWords) return null;
	const label = words.join(' ');
	// Reject if it still looks like a full sentence (ends with period, or too long)
	if (label.endsWith('.') || label.length > 50) return words.slice(0, minWords).join(' ') || null;
	return label;
}

type ThemeWithPriority = { theme: string; priority: 'High' | 'Moderate' | 'Low' };

/** Count recurrence: map all key_issues and top_urgent_issues to abstract themes, then count per theme. Never use raw comments. */
function deriveThemeLabelsWithPriority(summary: Summary): ThemeWithPriority[] {
	const MAX_THEMES = 5;
	const MIN_THEMES = 3;
	const counts = new Map<string, number>();

	function addOccurrence(label: string | null) {
		if (!label) return;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}

	// 1) top_urgent_issues – always convert to abstract (never raw)
	const fromTop = Array.isArray(summary.top_urgent_issues) ? summary.top_urgent_issues : [];
	for (const t of fromTop) {
		const text = t.trim();
		if (!text) continue;
		if (/^[A-Za-z0-9 ]+:\s/.test(text) || text.length > 80) {
			addOccurrence(toAbstractLabel(text));
			continue;
		}
		const words = text.split(/\s+/).filter((w) => w.length > 0);
		if (words.length >= 2 && words.length <= 5 && text.length <= 50) {
			addOccurrence(text);
		} else {
			addOccurrence(toAbstractLabel(text));
		}
	}

	// 2) by_source[].key_issues – always abstract
	const bySource = Array.isArray(summary.by_source) ? summary.by_source : [];
	const flattened = bySource.flatMap((s) => (Array.isArray(s.key_issues) ? s.key_issues : []));
	for (const issue of flattened) {
		addOccurrence(toAbstractLabel(issue));
	}

	// 3) Priority: High 4+, Moderate 2–3, Low 1
	function priority(count: number): 'High' | 'Moderate' | 'Low' {
		if (count >= 4) return 'High';
		if (count >= 2) return 'Moderate';
		return 'Low';
	}

	const sorted = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_THEMES)
		.map(([theme, count]) => ({ theme, priority: priority(count) }));

	// 4) Pad to MIN_THEMES with canonical themes (Low) if needed
	const seen = new Set(sorted.map((s) => s.theme));
	for (const theme of CANONICAL_THEMES) {
		if (sorted.length >= MAX_THEMES) break;
		if (seen.has(theme)) continue;
		seen.add(theme);
		sorted.push({ theme, priority: 'Low' });
	}

	return sorted.slice(0, MAX_THEMES);
}

/** Build Source Breakdown list from by_source (source name and count). Ordered by SOURCE_DISPLAY_ORDER then by name. */
function sourceBreakdownList(bySource: Summary['by_source']): { source: string; count: number }[] {
	const order = new Map(SOURCE_DISPLAY_ORDER.map((s, i) => [s.toLowerCase(), i]));
	const items = (bySource ?? []).map((s) => ({ source: s.source, count: s.total_items }));
	return items.sort((a, b) => {
		const ai = order.get(a.source.toLowerCase()) ?? 999;
		const bi = order.get(b.source.toLowerCase()) ?? 999;
		return ai !== bi ? ai - bi : a.source.localeCompare(b.source);
	});
}

/** Sources treated as enterprise (B2B). Others are self-serve. */
const ENTERPRISE_SOURCES = new Set(['customer support tickets', 'email']);

/** UTC date string YYYY-MM-DD for today and yesterday. */
function getTodayYesterdayDates(): { today: string; yesterday: string } {
	const now = new Date();
	const today = now.toISOString().slice(0, 10);
	const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
	return { today, yesterday };
}

/** Extract date part from timestamp (ISO or similar). */
function dateOfTimestamp(ts: string): string {
	const d = new Date(ts);
	return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export type AggregatedTheme = {
	theme: string;
	total_mentions: number;
	enterprise_mentions: number;
	self_serve_mentions: number;
	percent_negative: number;
	yesterday_mentions: number;
	percent_change_vs_yesterday: number;
};

/** Aggregate theme stats from today and yesterday feedback. Maps each row to a theme via toAbstractLabel(comment). */
function aggregateThemes(todayItems: FeedbackRow[], yesterdayItems: FeedbackRow[]): AggregatedTheme[] {
	const themeMap = new Map<
		string,
		{ total: number; enterprise: number; selfServe: number; negative: number }
	>();

	function add(row: FeedbackRow, isToday: boolean) {
		const theme = toAbstractLabel(row.comment);
		const key = theme ?? 'Other';
		if (!themeMap.has(key)) {
			themeMap.set(key, { total: 0, enterprise: 0, selfServe: 0, negative: 0 });
		}
		const rec = themeMap.get(key)!;
		if (!isToday) return;
		rec.total += 1;
		const isEnterprise = ENTERPRISE_SOURCES.has(row.source.toLowerCase());
		if (isEnterprise) rec.enterprise += 1;
		else rec.selfServe += 1;
		if (String(row.sentiment).toLowerCase() === 'negative') rec.negative += 1;
	}

	todayItems.forEach((r) => add(r, true));
	const yesterdayByTheme = new Map<string, number>();
	yesterdayItems.forEach((r) => {
		const theme = toAbstractLabel(r.comment) ?? 'Other';
		yesterdayByTheme.set(theme, (yesterdayByTheme.get(theme) ?? 0) + 1);
	});

	const result: AggregatedTheme[] = [];
	for (const [theme, rec] of themeMap.entries()) {
		const yesterday_mentions = yesterdayByTheme.get(theme) ?? 0;
		let percent_change_vs_yesterday = 0;
		if (yesterday_mentions > 0) {
			percent_change_vs_yesterday = Math.round(((rec.total - yesterday_mentions) / yesterday_mentions) * 100);
		} else if (rec.total > 0) {
			percent_change_vs_yesterday = 100;
		}
		result.push({
			theme,
			total_mentions: rec.total,
			enterprise_mentions: rec.enterprise,
			self_serve_mentions: rec.selfServe,
			percent_negative: rec.total > 0 ? Math.round((rec.negative / rec.total) * 100) : 0,
			yesterday_mentions,
			percent_change_vs_yesterday,
		});
	}
	return result;
}

export type RiskLevel = 'Critical' | 'Monitor' | 'Low Impact';

/** risk_score = +3 per enterprise mention, +1 per self-serve, +2 if majority negative. Then classify. */
function computeRiskScore(agg: AggregatedTheme): { risk_score: number; risk_level: RiskLevel } {
	let risk_score = agg.enterprise_mentions * 3 + agg.self_serve_mentions * 1;
	if (agg.percent_negative >= 50) risk_score += 2;
	// Differentiate so not everything is Critical: higher bar for Critical, Monitor for moderate impact.
	if (risk_score >= 20) return { risk_score, risk_level: 'Critical' };
	if (risk_score >= 10) return { risk_score, risk_level: 'Monitor' };
	return { risk_score, risk_level: 'Low Impact' };
}

function riskIcon(level: RiskLevel): string {
	return level === 'Critical' ? '🔴' : level === 'Monitor' ? '🟡' : '🟢';
}

/** Display source name with consistent capitalization. */
function displaySourceName(source: string): string {
	const lower = source.toLowerCase();
	if (lower === 'email') return 'Email';
	if (lower === 'community forums') return 'Community Forums';
	if (lower === 'github issues') return 'GitHub Issues';
	return source;
}

/** Qualitative trend only (no "vs yesterday"); Trend Snapshot handles the comparison. */
function trendText(percentChange: number, riskLevel?: RiskLevel): string {
	if (percentChange >= 100) return 'significant increase';
	if (percentChange >= 25) return riskLevel === 'Critical' ? 'significant increase' : 'increase';
	if (percentChange > -25) return 'no major change';
	return 'decrease';
}

/** Remove filler prefixes and normalize label. Max 5 words. Clean capitalization. */
function postProcessThemeLabel(raw: string): string {
	let s = raw.trim().replace(/^["']|["']$/g, '').replace(/\n.*/gs, '');
	s = s.replace(/^(Improvement in|Issues with|Problems related to|Problem with|Issue with|Lack of|Difficulty with)\s*/gi, '');
	s = s.replace(/^(The |A )\b/gi, '');
	s = s.trim();
	const words = s.split(/\s+/).filter(Boolean).slice(0, 5);
	const titleWord = (w: string) =>
		w.length >= 2 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
	return words.map(titleWord).join(' ');
}

/** Map AI output to stable product-level cluster. Order matters: more specific first. */
function normalizeToCanonicalCluster(aiLabel: string): string {
	const t = aiLabel.toLowerCase();
	if (/\b(password reset|reset link|forgot password|link expired)\b/.test(t)) return 'Password Reset Issues';
	if (/\b(api|timeout|500|endpoint|rate.?limit)\b/.test(t)) return 'API Timeout Errors';
	if (/\b(login|sso|auth|authenticate|sign.?in|log.?in|token invalid|redirect|idp)\b/.test(t)) return 'Authentication / Login Issues';
	if (/\b(deploy|session|invalid)\b/.test(t)) return 'Deployment / Session Issues';
	if (/\b(ui|interface|ux|design|bug)\b/.test(t)) return 'UI / UX Issues';
	if (/\b(email|notification|alert)\b/.test(t)) return 'Notifications / Alerts';
	if (/\b(recovery|forgot)\b/.test(t)) return 'Account Recovery';
	if (/\b(status|confusion|tracking)\b/.test(t)) return 'Issue / Ticket Status';
	if (/\b(dashboard|latency|slow|performance)\b/.test(t)) return 'Dashboard Latency';
	if (/\b(documentation|docs|guide|scattered)\b/.test(t)) return 'Documentation Confusion';
	return aiLabel;
}

/** Keyword-based theme extraction. Must align with normalizeToCanonicalCluster targets. */
function getThemeForCommentBackend(comment: string): string {
	const text = (comment ?? '').toLowerCase();
	if (/\b(login|sso|auth|password|authenticate|sign.?in|log.?in)\b/.test(text)) return 'Authentication / Login Issues';
	if (/\b(api|rate.?limit|timeout|500|endpoint)\b/.test(text)) return 'API Timeout Errors';
	if (/\b(password reset|reset link|forgot password|link expired)\b/.test(text)) return 'Password Reset Issues';
	if (/\b(deploy|token|session|invalid)\b/.test(text)) return 'Deployment / Session Issues';
	if (/\b(ui|interface|ux|design|bug)\b/.test(text)) return 'UI / UX Issues';
	if (/\b(email|notification|alert)\b/.test(text)) return 'Notifications / Alerts';
	if (/\b(reset|forgot|recovery)\b/.test(text)) return 'Account Recovery';
	if (/\b(status|confusion|tracking)\b/.test(text)) return 'Issue / Ticket Status';
	if (/\b(dashboard|latency|slow|performance)\b/.test(text)) return 'Dashboard Latency';
	if (/\b(documentation|docs|guide|scattered)\b/.test(text)) return 'Documentation Confusion';
	return 'Other';
}

/** Count items in bucket matching a canonical cluster. */
function countForCluster(items: FeedbackRow[], cluster: string): { count: number; enterpriseCount: number } {
	const matching = items.filter((r) => getThemeForCommentBackend(r.comment) === cluster);
	const enterpriseCount = matching.filter((r) => ENTERPRISE_SOURCES.has(r.source.toLowerCase())).length;
	return { count: matching.length, enterpriseCount };
}

/** Themes we never surface on KPI cards (feedback, not inherent "issues"). */
const KPI_EXCLUDED_THEMES = new Set(['Notifications / Alerts', 'Issue / Ticket Status']);

/** Fallback: get top theme and count from keyword grouping when AI fails. */
function fallbackThemeAndCount(
	items: FeedbackRow[],
	excludeThemes: Set<string> = new Set(),
	preferTheme?: string,
): { label: string; count: number; enterpriseCount: number } | null {
	if (items.length === 0) return null;
	const byTheme = new Map<string, FeedbackRow[]>();
	for (const r of items) {
		const theme = getThemeForCommentBackend(r.comment);
		if (theme === 'Other' || excludeThemes.has(theme)) continue;
		if (!byTheme.has(theme)) byTheme.set(theme, []);
		byTheme.get(theme)!.push(r);
	}
	// Prefer a specific theme when it exists in the bucket
	if (preferTheme && byTheme.has(preferTheme)) {
		const rows = byTheme.get(preferTheme)!;
		const enterpriseCount = rows.filter((r) => ENTERPRISE_SOURCES.has(r.source.toLowerCase())).length;
		return { label: preferTheme, count: rows.length, enterpriseCount };
	}
	const sorted = [...byTheme.entries()].sort((a, b) => b[1].length - a[1].length);
	const top = sorted[0];
	if (!top) return null;
	const [label, rows] = top;
	const enterpriseCount = rows.filter((r) => ENTERPRISE_SOURCES.has(r.source.toLowerCase())).length;
	return { label, count: rows.length, enterpriseCount };
}

const LOW_IMPACT_MAX_ISSUES = 3;

/** Get top N themes for Low Impact bucket (keyword-based). Excludes themes from Critical/Monitor. */
function getTopThemesForLowBucket(
	items: FeedbackRow[],
	excludeThemes: Set<string>,
	includeOther = false,
): { label: string; count: number; enterpriseCount: number }[] {
	if (items.length === 0) return [];
	const byTheme = new Map<string, FeedbackRow[]>();
	for (const r of items) {
		const theme = getThemeForCommentBackend(r.comment);
		if ((!includeOther && theme === 'Other') || excludeThemes.has(theme)) continue;
		const key = theme === 'Other' && includeOther ? 'Various feedback' : theme;
		if (!byTheme.has(key)) byTheme.set(key, []);
		byTheme.get(key)!.push(r);
	}
	return [...byTheme.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, LOW_IMPACT_MAX_ISSUES)
		.map(([label, rows]) => {
			const enterpriseCount = rows.filter((r) => ENTERPRISE_SOURCES.has(r.source.toLowerCase())).length;
			return { label, count: rows.length, enterpriseCount };
		});
}

const KPI_MIN_SHARE = 0.05; // 5% of bucket — do not surface one-off complaints

const MONITOR_PREFERRED_THEME = 'Authentication / Login Issues';

/** Workers AI: Identify dominant issue, normalize to cluster, return cluster count. */
async function generateThemeWithCount(
	env: Env,
	items: FeedbackRow[],
	excludeThemes: Set<string> = new Set(),
	preferTheme?: string,
): Promise<{ label: string; count: number; enterpriseCount: number } | null> {
	if (items.length === 0) return null;
	const bucketSize = items.length;
	const comments = items.map((r) => r.comment).slice(0, 50);
	const numbered = comments.map((c, i) => `${i + 1}. ${c}`).join('\n');
	const model = '@cf/meta/llama-3.1-8b-instruct' as keyof AiModels;
	const prompt = `You are analyzing product feedback. From the following comments, identify the single most recurring specific issue affecting enterprise customers or core product reliability. Return only a JSON object in this format:
{
  "issue": "Short 2-5 word label",
  "matching_indices": [1, 2, 5, 7]
}
The matching_indices array must contain the 1-based line numbers of comments that describe this specific issue. Do not return explanations. Do not return generic phrases. The issue must reflect actual user-reported problems. Maximum 5 words.

Comments:
${numbered}`;
	try {
		const result: any = await env.AI.run(model, { prompt });
		const text = typeof result === 'string' ? result : result?.response ?? result?.result ?? '';
		const parsed = parseAiJson<{ issue?: string; matching_indices?: number[] }>(text);
		const rawLabel = typeof parsed?.issue === 'string' ? parsed.issue.trim() : null;
		const indices = Array.isArray(parsed?.matching_indices) ? parsed.matching_indices : [];
		if (!rawLabel || indices.length === 0) return fallbackThemeAndCount(items, excludeThemes, preferTheme);
		const processedLabel = postProcessThemeLabel(rawLabel);
		if (processedLabel.split(/\s+/).length > 5) return fallbackThemeAndCount(items, excludeThemes, preferTheme);
		const canonicalCluster = normalizeToCanonicalCluster(processedLabel);
		if (excludeThemes.has(canonicalCluster)) return fallbackThemeAndCount(items, excludeThemes, preferTheme);
		const { count, enterpriseCount } = countForCluster(items, canonicalCluster);
		if (count < KPI_MIN_SHARE * bucketSize) return fallbackThemeAndCount(items, excludeThemes, preferTheme);
		// Prefer specific theme when it exists in the bucket
		if (preferTheme && !excludeThemes.has(preferTheme)) {
			const preferred = countForCluster(items, preferTheme);
			if (preferred.count >= 1) return { label: preferTheme, count: preferred.count, enterpriseCount: preferred.enterpriseCount };
		}
		return { label: canonicalCluster, count, enterpriseCount };
	} catch {
		return fallbackThemeAndCount(items, excludeThemes, preferTheme);
	}
}

/** Workers AI: 2–3 sentence executive summary. Call once per request. */
async function generateExecutiveSummary(
	env: Env,
	top3: { theme: string; enterprise_mentions: number; total_mentions: number; percent_negative: number; percent_change_vs_yesterday: number; risk_level: RiskLevel }[],
): Promise<string> {
	const model = '@cf/meta/llama-3.1-8b-instruct' as keyof AiModels;
	const context = top3
		.map(
			(t, i) =>
				`${i + 1}. ${t.theme}: ${t.total_mentions} mentions, ${t.enterprise_mentions} enterprise, ${t.risk_level}, ${trendText(t.percent_change_vs_yesterday, t.risk_level)}.`,
		)
		.join(' ');
	const prompt = `Write a concise 2-sentence executive summary of today's product feedback. Focus on what changed, what matters most, and who is affected. Do not include raw numbers, percentages, or meta commentary. Use clear, natural language as if written by a product manager. Output only the 2 sentences—no prefix like "Here's a summary" or explanatory text. Context: ${context}`;
	try {
		const result: any = await env.AI.run(model, { prompt });
		const text = typeof result === 'string' ? result : result?.response ?? result?.result ?? '';
		let cleaned = text.trim().replace(/^["']|["']$/g, '');
		cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
		cleaned = cleaned.replace(/^(Critical Issue|Trend Changes|Summary|Here'?s? (a |the )?\d?-?sentence summary[.:]?|Executive summary:?)\s*/gim, '').trim();
		cleaned = cleaned.replace(/\b\d+\s*(mention|mentions)\s*(of|for)\s*/gi, '').trim();
		return cleaned.slice(0, 600) || 'No executive summary available.';
	} catch {
		return 'Executive summary could not be generated.';
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// -----------------------------
		// Static Assets (React SPA)
		// -----------------------------
		if (env.ASSETS) {
			const assetResponse = await env.ASSETS.fetch(request);
			if (assetResponse.status < 400) {
				return assetResponse;
			}
		}

		// -----------------------------
		// HTML Dashboard (fallback when no assets)
		// -----------------------------
		if (url.pathname === '/') {
			try {
				const { today, yesterday } = getTodayYesterdayDates();
				const now = Date.now();
				if (dashboardCache && dashboardCache.date === today && now - dashboardCache.cachedAt < DASHBOARD_CACHE_TTL_MS) {
					return new Response(dashboardCache.html, {
						headers: { 'Content-Type': 'text/html;charset=utf-8' },
					});
				}

				const { results } = await env.FEEDBACK_DB.prepare(
					'SELECT id, source, sentiment, comment, timestamp FROM feedback ORDER BY timestamp DESC',
				).all();
				const feedbackItems = results as FeedbackRow[];

				if (feedbackItems.length === 0) {
					const emptyHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>Feedback Insights Dashboard</title></head>
<body>
	<h1>Feedback Insights Dashboard</h1>
	<p>No feedback has been recorded yet. Add feedback via the API to see insights here.</p>
</body>
</html>`.trim();
					return new Response(emptyHtml, {
						headers: { 'Content-Type': 'text/html;charset=utf-8' },
					});
				}

				const todayItems = feedbackItems.filter((r) => dateOfTimestamp(r.timestamp) === today);
				const yesterdayItems = feedbackItems.filter((r) => dateOfTimestamp(r.timestamp) === yesterday);

				const todayCount = todayItems.length;
				const todaySourceCount = new Set(todayItems.map((i) => i.source)).size;
				const dailyBriefText = `Today we received ${todayCount} feedback item${todayCount !== 1 ? 's' : ''} across ${todaySourceCount} source${todaySourceCount !== 1 ? 's' : ''}.`;

				const aggregated = aggregateThemes(todayItems, yesterdayItems);
				const aggregatedWithRisk = aggregated.map((a) => {
					const risk = computeRiskScore(a);
					return { ...a, ...risk, icon: riskIcon(risk.risk_level) };
				});

				const byRiskDesc = [...aggregatedWithRisk].sort((a, b) => b.risk_score - a.risk_score);
				const bestLow = [...aggregatedWithRisk].filter((x) => x.risk_level === 'Low Impact').sort((a, b) => b.risk_score - a.risk_score)[0];
				const candidate3 = byRiskDesc.slice(0, 3);
				const hasLowInTop3 = candidate3.some((x) => x.risk_level === 'Low Impact');
				const top3 =
					bestLow && !hasLowInTop3 && candidate3.length >= 3
						? [candidate3[0], candidate3[1], bestLow]
						: candidate3;

				function top3Line(t: (typeof top3)[0]): string {
					const cust = t.total_mentions === 1 ? 'customer' : 'customers';
					const showEnterprise =
						t.enterprise_mentions > 0 &&
						((t.risk_level === 'Critical' || t.risk_level === 'Monitor') || (t.risk_level === 'Low Impact' && t.enterprise_mentions >= 2));
					const ent = t.enterprise_mentions === 1 ? 'enterprise customer' : 'enterprise customers';
					const enterprisePart = showEnterprise ? `, including ${t.enterprise_mentions} ${ent}` : '';
					return `${t.icon} ${t.risk_level}: ${t.total_mentions} ${cust} reported ${t.theme}${enterprisePart}`;
				}

				let executiveSummaryText: string;
				if (execSummaryCache && execSummaryCache.date === today && now - execSummaryCache.cachedAt < EXEC_SUMMARY_CACHE_TTL_MS) {
					executiveSummaryText = execSummaryCache.text;
				} else {
					executiveSummaryText = await generateExecutiveSummary(env, top3);
					execSummaryCache = { date: today, text: executiveSummaryText, cachedAt: Date.now() };
				}

				const recurringByMentions = [...aggregatedWithRisk].sort((a, b) => b.total_mentions - a.total_mentions).slice(0, 5);
				const recurringLines = recurringByMentions.map((r) => `${r.theme} — ${r.total_mentions} ${r.total_mentions === 1 ? 'mention' : 'mentions'}`);

				const sourceCounts = new Map<string, number>();
				for (const r of todayItems) {
					sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
				}
				const sourceBreakdownSorted = [...sourceCounts.entries()]
					.map(([source, count]) => ({ source, count }))
					.sort((a, b) => b.count - a.count);
				const maxSourceCount = Math.max(1, ...sourceBreakdownSorted.map((s) => s.count));

				const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>Product Feedback Dashboard</title></head>
<body>
<h1>Product Feedback Dashboard</h1>
<h2>📬 Daily Brief</h2>
<p>${escapeHtml(dailyBriefText)}</p>
${top3.map((t) => `<p style="margin:0.4em 0">${escapeHtml(top3Line(t))}</p>`).join('')}
<h2>🧠 Executive Summary</h2>
<p>${escapeHtml(executiveSummaryText)}</p>
<h2>📈 Trend Snapshot</h2>
<div style="max-width:520px">
${top3
	.		map((t) => {
		let arrowChar: string;
		let arrowStyle: string;
		if (t.total_mentions > t.yesterday_mentions) {
			arrowChar = '▲';
			arrowStyle = 'color: red;';
		} else if (t.total_mentions < t.yesterday_mentions) {
			arrowChar = '▼';
			arrowStyle = 'color: green;';
		} else {
			arrowChar = '—';
			arrowStyle = 'color: grey;';
		}
		const arrowSpan = `<span style="${arrowStyle}">${arrowChar}</span>`;
		return `<div style="display:flex;align-items:center;white-space:nowrap;margin-bottom:4px"><span style="flex:0 0 220px;min-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(t.theme)}">${escapeHtml(t.theme)}</span> Yesterday: ${t.yesterday_mentions} → Today: ${t.total_mentions} ${arrowSpan}</div>`;
	})
	.join('')}
</div>
<h2>🔁 Top Recurring Themes</h2>
<ul>
${recurringLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
</ul>
<h2>📊 Source Breakdown</h2>
<div style="max-width:520px">
${sourceBreakdownSorted
	.map(
			(s) => {
				const barWidth = Math.round((s.count / maxSourceCount) * 200);
				const label = displaySourceName(s.source);
				return `<div style="display:flex;align-items:center;margin-bottom:4px;white-space:nowrap"><span style="flex:0 0 180px;min-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span style="flex:0 0 ${barWidth}px;height:12px;background:#333;margin:0 8px"></span><span style="flex:0 0 2em">${s.count}</span></div>`;
			},
		)
	.join('')}
</div>
</body>
</html>`;

				dashboardCache = { date: today, html, cachedAt: Date.now() };

				return new Response(html, {
					headers: { 'Content-Type': 'text/html;charset=utf-8' },
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>Dashboard Error</title></head>
<body>
	<h1>Failed to load dashboard</h1>
	<p><strong>Error:</strong> ${escapeHtml(message)}</p>
	<p>Common fixes: run <code>npx wrangler d1 migrations apply FEEDBACK_DB --local</code> for local dev, or <code>--remote</code> for production.</p>
</body>
</html>`.trim();
				return new Response(html, {
					status: 500,
					headers: { 'Content-Type': 'text/html;charset=utf-8' },
				});
			}
		}

		// -----------------------------
		// GET /api/feedback
		// -----------------------------
		if (url.pathname === '/api/feedback') {
			try {
				if (!env.FEEDBACK_DB) {
					return Response.json(
						{ error: 'Missing D1 binding FEEDBACK_DB' },
						{ status: 500 },
					);
				}

				const { results } = await env.FEEDBACK_DB.prepare(
					'SELECT id, source, sentiment, comment, timestamp FROM feedback ORDER BY timestamp DESC',
				).all();

				const typedResults = results as Array<{
					id: number;
					source: string;
					sentiment: string;
					comment: string;
					timestamp: string;
				}>;

				return new Response(JSON.stringify(typedResults), {
					headers: { 'Content-Type': 'application/json;charset=utf-8' },
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json(
					{
						error: 'Failed to read feedback from D1',
						details: message,
						hint: 'If this is a fresh database, run: npx wrangler d1 migrations apply FEEDBACK_DB --remote',
					},
					{ status: 500 },
				);
			}
		}

		// -----------------------------
		// GET /api/summary
		// -----------------------------
		if (url.pathname === '/api/summary') {
			try {
				if (!env.FEEDBACK_DB) {
					return Response.json(
						{ error: 'Missing D1 binding FEEDBACK_DB' },
						{ status: 500 },
					);
				}

				if (!env.AI) {
					return Response.json(
						{
							error: 'Missing AI binding',
							hint: 'Configure the ai binding in wrangler.jsonc',
						},
						{ status: 500 },
					);
				}

				const { results } = await env.FEEDBACK_DB.prepare(
					'SELECT id, source, sentiment, comment, timestamp FROM feedback ORDER BY timestamp DESC',
				).all();

				const feedbackItems = results as FeedbackRow[];

				if (feedbackItems.length === 0) {
					return Response.json(
						{
							overall_summary: 'No feedback has been recorded yet.',
							by_source: [],
							top_urgent_issues: [],
						},
						{ status: 200 },
					);
				}

				const promptLines = feedbackItems.map(
					(item) =>
						`[${item.source}] sentiment=${item.sentiment} comment="${item.comment}" timestamp=${item.timestamp}`,
				);

				const prompt = `
You are helping a product manager understand customer feedback aggregated from multiple channels.

Each line below is a single piece of feedback in the format:
[source] sentiment=<positive|neutral|negative> comment="<user comment>" timestamp=<ISO8601>

Feedback:
${promptLines.join('\n')}

Based on this feedback, respond ONLY with minified JSON (no markdown, no extra text) that matches this TypeScript type:

type Summary = {
  overall_summary: string;
  by_source: {
    source: string;
    total_items: number;
    dominant_sentiment: string;
    key_issues: string[];
  }[];
  top_urgent_issues: string[];
};

Return ONLY valid JSON conforming to Summary.
				`.trim();

				const model =
					'@cf/meta/llama-3.1-8b-instruct' as keyof AiModels;

				const aiResult: any = await env.AI.run(model, { prompt });

				const text =
					typeof aiResult === 'string'
						? aiResult
						: aiResult?.response ??
						  aiResult?.result ??
						  JSON.stringify(aiResult);

				let summary: Summary;
				try {
					const parsed = parseAiJson<Partial<Summary>>(text);
					summary = normalizeSummary(parsed, feedbackItems);
				} catch {
					summary = summaryFromFeedback(feedbackItems);
				}
				return Response.json(summary, {
					headers: {
						'Content-Type': 'application/json;charset=utf-8',
					},
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json(
					{
						error: 'Failed to generate summary from AI',
						details: message,
					},
					{ status: 500 },
				);
			}
		}

		// -----------------------------
		// GET /api/kpi-themes
		// -----------------------------
		if (url.pathname === '/api/kpi-themes') {
			try {
				if (!env.FEEDBACK_DB) {
					return Response.json(
						{ error: 'Missing D1 binding FEEDBACK_DB' },
						{ status: 500 },
					);
				}
				if (!env.AI) {
					return Response.json(
						{ error: 'Missing AI binding' },
						{ status: 500 },
					);
				}

				const { results } = await env.FEEDBACK_DB.prepare(
					'SELECT id, source, sentiment, comment, timestamp FROM feedback ORDER BY timestamp DESC',
				).all();
				const items = results as FeedbackRow[];

				const criticalItems = items.filter((r) => String(r.sentiment).toLowerCase() === 'negative');
				const monitorItems = items.filter((r) => String(r.sentiment).toLowerCase() === 'neutral');
				const lowItems = items.filter((r) => String(r.sentiment).toLowerCase() === 'positive');

				const critical = criticalItems.length > 0 ? fallbackThemeAndCount(criticalItems) : null;
				const monitorExclude = new Set(KPI_EXCLUDED_THEMES);
				if (critical?.label) monitorExclude.add(critical.label);
				const monitor = monitorItems.length > 0 ? fallbackThemeAndCount(monitorItems, monitorExclude, MONITOR_PREFERRED_THEME) : null;
				const lowExclude = new Set(monitorExclude);
				if (monitor?.label) lowExclude.add(monitor.label);
				let lowIssues = getTopThemesForLowBucket(lowItems, lowExclude);
				if (lowIssues.length === 0 && lowItems.length > 0) {
					const fallbackLowExclude = new Set<string>();
					if (critical?.label) fallbackLowExclude.add(critical.label);
					if (monitor?.label) fallbackLowExclude.add(monitor.label);
					lowIssues = getTopThemesForLowBucket(lowItems, fallbackLowExclude);
				}
				if (lowIssues.length === 0 && lowItems.length > 0) {
					const minimalExclude = new Set<string>();
					if (critical?.label) minimalExclude.add(critical.label);
					if (monitor?.label) minimalExclude.add(monitor.label);
					lowIssues = getTopThemesForLowBucket(lowItems, minimalExclude, true);
				}

				return Response.json(
					{
						critical: critical ? { label: critical.label, count: critical.count, enterpriseCount: critical.enterpriseCount } : null,
						monitor: monitor ? { label: monitor.label, count: monitor.count, enterpriseCount: monitor.enterpriseCount } : null,
						low: lowIssues.length > 0 ? { issues: lowIssues } : null,
					},
					{ headers: { 'Content-Type': 'application/json;charset=utf-8' } },
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json(
					{ error: 'Failed to generate KPI themes', details: message },
					{ status: 500 },
				);
			}
		}

		// -----------------------------
		// Fallback
		// -----------------------------
		return new Response(
			'This tool aggregates product feedback from various sources and generates a report on the feedback.',
		);
	},
} satisfies ExportedHandler<Env>;

