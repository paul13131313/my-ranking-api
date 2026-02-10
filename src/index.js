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

			return jsonResponse({ error: 'Not found' }, 404);
		} catch (err) {
			return jsonResponse({ error: err.message }, 500);
		}
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(handleDigest(env));
	},
};
