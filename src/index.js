const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

async function supabaseFetch(env, path, query = '') {
	const url = `${env.SUPABASE_URL}/rest/v1/${path}?${query}`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_ANON_KEY,
			Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Supabase error: ${res.status} ${text}`);
	}
	return res.json();
}

async function sendLinePush(env, message) {
	const res = await fetch('https://api.line.me/v2/bot/message/push', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
		},
		body: JSON.stringify({
			to: env.LINE_USER_ID,
			messages: [{ type: 'text', text: message }],
		}),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LINE API error: ${res.status} ${text}`);
	}
	return res.json();
}

async function handleDigest(env) {
	// 全カテゴリ取得
	const categories = await supabaseFetch(env, 'categories', 'select=id,name,icon&order=display_order.asc');

	// 各カテゴリの1位アイテムを取得
	const allItems = await supabaseFetch(env, 'ranking_items', 'select=title,rank,category_id&rank=eq.1');

	// カテゴリ情報とマージ
	const topItems = allItems.map((item) => {
		const cat = categories.find((c) => c.id === item.category_id);
		return {
			title: item.title,
			categoryName: cat ? cat.name : '不明',
			categoryIcon: cat ? cat.icon : '📋',
		};
	}).filter((item) => item.title);

	if (topItems.length === 0) {
		throw new Error('ランキングデータが見つかりません');
	}

	// ランダムに1つ選択
	const picked = topItems[Math.floor(Math.random() * topItems.length)];

	// Claude APIで豆知識を生成
	const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 256,
			messages: [{
				role: 'user',
				content: `「${picked.title}」（${picked.categoryName}カテゴリの1位）について、面白い豆知識を1つだけ教えてください。50文字程度で、雑学として楽しめる内容にしてください。豆知識の内容だけを返してください。`,
			}],
		}),
	});

	if (!claudeRes.ok) {
		const errText = await claudeRes.text();
		throw new Error(`Claude API error: ${claudeRes.status} ${errText}`);
	}

	const claudeData = await claudeRes.json();
	const trivia = claudeData.content?.[0]?.text || '豆知識を生成できませんでした。';

	// LINEにpushメッセージ送信
	const message = `${picked.categoryIcon} 今日の豆知識\n\n【${picked.categoryName} 1位】${picked.title}\n\n${trivia}`;
	await sendLinePush(env, message);

	return { success: true, item: picked.title, trivia, message };
}

function escapeXml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateOgpSvg(categoryName, categoryIcon, items) {
	const medals = ['🥇', '🥈', '🥉'];
	const top3 = items
		.sort((a, b) => a.rank - b.rank)
		.slice(0, 3);

	const itemLines = top3.map((item, i) => {
		const y = 310 + i * 80;
		return `
			<text x="140" y="${y}" font-size="36" fill="#aaa" font-family="sans-serif">${medals[i] || ''}</text>
			<text x="200" y="${y}" font-size="34" fill="#e8e6e3" font-family="sans-serif" font-weight="600">${escapeXml(item.title)}</text>
		`;
	}).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	<defs>
		<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" style="stop-color:#0a0a0c"/>
			<stop offset="50%" style="stop-color:#141420"/>
			<stop offset="100%" style="stop-color:#0a0a1a"/>
		</linearGradient>
		<linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
			<stop offset="0%" style="stop-color:#f0c040"/>
			<stop offset="100%" style="stop-color:#e8a04c"/>
		</linearGradient>
	</defs>

	<!-- Background -->
	<rect width="1200" height="630" fill="url(#bg)"/>

	<!-- Top accent line -->
	<rect x="0" y="0" width="1200" height="4" fill="url(#accent)"/>

	<!-- Border frame -->
	<rect x="40" y="40" width="1120" height="550" rx="24" fill="none" stroke="#2a2a32" stroke-width="2"/>

	<!-- Logo -->
	<text x="100" y="120" font-size="48" fill="#f0c040" font-family="Georgia, serif" font-weight="700">MY RANKING</text>

	<!-- Divider -->
	<line x1="100" y1="150" x2="1100" y2="150" stroke="#2a2a32" stroke-width="1"/>

	<!-- Category title -->
	<text x="100" y="210" font-size="28" fill="#8a8890" font-family="sans-serif" font-weight="500">${escapeXml(categoryIcon)} ${escapeXml(categoryName)}ランキング</text>

	<!-- Ranking items -->
	${itemLines}

	<!-- Bottom accent -->
	<rect x="100" y="540" width="200" height="3" fill="url(#accent)" rx="2"/>
	<text x="100" y="575" font-size="18" fill="#555" font-family="sans-serif">my-ranking.vercel.app</text>
</svg>`;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const { pathname } = url;

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		try {
			// POST /digest → 豆知識をLINEに送信
			if (request.method === 'POST' && pathname === '/digest') {
				const result = await handleDigest(env);
				return jsonResponse(result);
			}

			// POST /checkout → Stripeチェックアウトセッションを模倣
			if (request.method === 'POST' && pathname === '/checkout') {
				const body = await request.json().catch(() => ({}));
				const planId = body.planId;
				if (!planId || planId === 'free') {
					return jsonResponse({ error: 'Invalid plan' }, 400);
				}
				const sessionId = `mock_sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				return jsonResponse({
					sessionId,
					url: '/pricing?success=true',
					plan: planId,
					status: 'mock_success',
				});
			}

			if (request.method !== 'GET') {
				return jsonResponse({ error: 'Method not allowed' }, 405);
			}

			// GET / → ヘルスチェック
			if (pathname === '/') {
				return jsonResponse({ message: 'MY RANKING API v2.0' });
			}

			// GET /rankings → カテゴリ一覧
			if (pathname === '/rankings') {
				const data = await supabaseFetch(env, 'categories', 'select=id,name,icon,display_order&order=display_order.asc');
				return jsonResponse(data);
			}

			// GET /rankings/:categoryId → ランキングアイテム一覧
			const match = pathname.match(/^\/rankings\/([^/]+)$/);
			if (match) {
				const categoryId = match[1];
				const data = await supabaseFetch(
					env,
					'ranking_items',
					`select=id,title,rank,category_id&category_id=eq.${categoryId}&order=rank.asc`
				);
				return jsonResponse(data);
			}

			// GET /analyze → Claude APIで趣味の傾向を分析
			if (pathname === '/analyze') {
				const categories = await supabaseFetch(env, 'categories', 'select=id,name,icon,display_order&order=display_order.asc');
				const allItems = await supabaseFetch(env, 'ranking_items', 'select=title,rank,category_id&order=rank.asc');

				const rankingData = categories.map((cat) => {
					const items = allItems
						.filter((item) => item.category_id === cat.id)
						.sort((a, b) => a.rank - b.rank)
						.map((item) => `${item.rank}位: ${item.title}`);
					return `【${cat.icon} ${cat.name}】\n${items.join('\n')}`;
				}).join('\n\n');

				const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-api-key': env.ANTHROPIC_API_KEY,
						'anthropic-version': '2023-06-01',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-5-20250929',
						max_tokens: 1024,
						messages: [{
							role: 'user',
							content: `以下はある人の好きなもののランキングデータです。この人の趣味の傾向、好みの特徴、意外な共通点などを300文字程度で分析してください。親しみやすい口調で。\n\n${rankingData}`,
						}],
					}),
				});

				if (!claudeRes.ok) {
					const errText = await claudeRes.text();
					throw new Error(`Claude API error: ${claudeRes.status} ${errText}`);
				}

				const claudeData = await claudeRes.json();
				const analysis = claudeData.content?.[0]?.text || '分析できませんでした。';

				return jsonResponse({ analysis });
			}

			// GET /search/rankings?q=QUERY&rank=N → 全ユーザーのお気に入りから検索
			if (pathname === '/search/rankings') {
				const query = url.searchParams.get('q');
				if (!query) {
					return jsonResponse({ error: 'Missing query parameter "q"' }, 400);
				}
				const rankFilter = url.searchParams.get('rank');

				// Search favorites by title (ilike)
				let favQuery = `select=title,slot,category,user_id,created_at&title=ilike.*${encodeURIComponent(query)}*&order=slot.asc&limit=50`;
				if (rankFilter) {
					favQuery += `&slot=eq.${rankFilter}`;
				}
				const favorites = await supabaseFetch(env, 'favorites', favQuery);

				if (favorites.length === 0) {
					return jsonResponse({ results: [], query });
				}

				// Get unique user IDs and fetch profiles
				const userIds = [...new Set(favorites.map((f) => f.user_id))];
				const profiles = await supabaseFetch(
					env,
					'profiles',
					`select=id,handle,display_name,is_public&id=in.(${userIds.join(',')})`
				);
				const profileMap = {};
				for (const p of profiles) { profileMap[p.id] = p; }

				// Merge and filter out private profiles
				const results = favorites
					.map((f) => {
						const p = profileMap[f.user_id];
						if (!p || !p.is_public) return null;
						return {
							title: f.title,
							rank: f.slot,
							category: f.category,
							user: {
								handle: p.handle,
								display_name: p.display_name || p.handle,
							},
							created_at: f.created_at,
						};
					})
					.filter(Boolean);

				return jsonResponse({ results, query });
			}

			// GET /stats/popular → 全ユーザーで最も多く登録されている作品トップ10
			if (pathname === '/stats/popular') {
				// Fetch all favorites from public users
				const allFavorites = await supabaseFetch(
					env,
					'favorites',
					'select=title,category,slot,user_id&order=created_at.desc&limit=500'
				);

				// Get all public profiles
				const allProfiles = await supabaseFetch(
					env,
					'profiles',
					'select=id,is_public&is_public=eq.true'
				);
				const publicUserIds = new Set(allProfiles.map((p) => p.id));

				// Count titles (only from public users), case-insensitive
				const titleCounts = {};
				const titleMeta = {};
				for (const f of allFavorites) {
					if (!publicUserIds.has(f.user_id)) continue;
					const key = f.title.toLowerCase().trim();
					titleCounts[key] = (titleCounts[key] || 0) + 1;
					if (!titleMeta[key]) {
						titleMeta[key] = { title: f.title, category: f.category };
					}
				}

				// Sort by count and take top 10
				const popular = Object.entries(titleCounts)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 10)
					.map(([key, count], i) => ({
						rank: i + 1,
						title: titleMeta[key].title,
						category: titleMeta[key].category,
						count,
					}));

				return jsonResponse({ popular });
			}

			// GET /ogp/:categoryId → OGP画像(SVG)を生成
			const ogpMatch = pathname.match(/^\/ogp\/([^/]+)$/);
			if (ogpMatch) {
				const categoryId = ogpMatch[1];
				const categories = await supabaseFetch(env, 'categories', `select=id,name,icon&id=eq.${categoryId}`);
				if (!categories.length) {
					return jsonResponse({ error: 'Category not found' }, 404);
				}
				const cat = categories[0];
				const items = await supabaseFetch(
					env,
					'ranking_items',
					`select=title,rank,category_id&category_id=eq.${categoryId}&order=rank.asc&limit=3`
				);
				const svg = generateOgpSvg(cat.name, cat.icon, items);
				return new Response(svg, {
					headers: {
						'Content-Type': 'image/svg+xml',
						'Cache-Control': 'public, max-age=3600',
						...corsHeaders,
					},
				});
			}

			// GET /search/movie?q=QUERY → TMDb APIで映画検索
			if (pathname === '/search/movie') {
				const query = url.searchParams.get('q');
				if (!query) {
					return jsonResponse({ error: 'Missing query parameter "q"' }, 400);
				}

				const tmdbRes = await fetch(
					`https://api.themoviedb.org/3/search/movie?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=ja-JP`
				);

				if (!tmdbRes.ok) {
					const errText = await tmdbRes.text();
					throw new Error(`TMDb API error: ${tmdbRes.status} ${errText}`);
				}

				const tmdbData = await tmdbRes.json();
				const movies = (tmdbData.results || []).map((movie) => ({
					id: movie.id,
					title: movie.title,
					poster_url: movie.poster_path
						? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
						: null,
					release_year: movie.release_date ? movie.release_date.substring(0, 4) : null,
					rating: movie.vote_average,
					overview: movie.overview,
				}));

				return jsonResponse({ results: movies });
			}

			// GET /pricing → プラン情報を返す
			if (pathname === '/pricing') {
				return jsonResponse({
					plans: [
						{
							id: 'free',
							name: 'Free',
							price: 0,
							currency: 'jpy',
							interval: null,
							features: [
								'お気に入り5つまで登録',
								'公開プロフィール',
								'検索・閲覧',
							],
							cta: '現在のプラン',
							current: true,
						},
						{
							id: 'pro',
							name: 'Pro',
							price: 500,
							currency: 'jpy',
							interval: 'month',
							features: [
								'お気に入り無制限',
								'AI趣味分析',
								'カスタムOGP画像',
								'優先サポート',
								'広告非表示',
							],
							cta: 'アップグレード',
							current: false,
							popular: true,
						},
					],
				});
			}

			return jsonResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return jsonResponse({ error: err.message }, 500);
		}
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(handleDigest(env));
	},
};
