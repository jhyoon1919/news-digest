const SUPABASE_URL = 'https://zxihwjolqjdfbyedachb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4aWh3am9scWpkZmJ5ZWRhY2hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODI4NjgsImV4cCI6MjEwMjA1ODg2OH0.B9sXpBT0gR03bRhi96zOjXYIlr1tA_Lhk5J8J-7pHIc';

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[.,!?()"'…·]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreArticle(questionTokens, article) {
  const articleTokens = new Set(tokenize(
    `${article.title} ${article.summary} ${article.category} ${article.region} ${article.acquirer} ${article.target}`
  ));
  let score = 0;
  questionTokens.forEach(t => {
    if (articleTokens.has(t)) score += 1;
  });
  return score;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY가 서버에 설정되어 있지 않습니다. Vercel 프로젝트 환경변수에 등록해주세요.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const question = ((body && body.question) || '').trim().slice(0, 500);
  if (!question) {
    res.status(400).json({ error: '질문이 비어있습니다.' });
    return;
  }

  let articles = [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/news_digest_articles?select=digest_date,region,category,title,summary,outlet,published_at,source_url,acquirer,target,deal_type,deal_status,deal_value_krw_100m,deal_value_note,advisors&order=published_at.desc&limit=300`;
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!resp.ok) throw new Error(`Supabase 조회 실패: ${resp.status}`);
    articles = await resp.json();
  } catch (e) {
    res.status(502).json({ error: '기사 데이터를 불러오지 못했습니다.', detail: String(e) });
    return;
  }

  const questionTokens = tokenize(question);
  const ranked = articles
    .map(a => ({ article: a, score: scoreArticle(questionTokens, a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .filter(r => r.score > 0)
    .map(r => r.article);

  const contextArticles = ranked.length > 0 ? ranked : articles.slice(0, 8);

  const contextText = contextArticles
    .map((a, i) => {
      const value = a.deal_value_krw_100m != null ? `${Number(a.deal_value_krw_100m).toLocaleString('ko-KR')}억원${a.deal_value_note ? `(${a.deal_value_note})` : ''}` : '거래금액 비공개';
      const advisors = a.advisors && a.advisors.length ? `, 자문사: ${a.advisors.join(', ')}` : '';
      return `[${i + 1}] (${a.published_at}, ${a.region}/${a.category}, ${a.outlet}) ${a.acquirer} → ${a.target} (${a.deal_type}${a.deal_status ? `, ${a.deal_status}` : ''}) 거래금액: ${value}${advisors}\n${a.summary}\n원문: ${a.source_url}`;
    })
    .join('\n\n');

  const systemPrompt = '당신은 저장된 M&A 딜 데이터만 근거로 답변하는 M&A 뱅커용 도우미입니다. 아래 제공된 딜 목록에 없는 내용은 추측하지 말고, 목록에서 답을 찾을 수 없으면 "관련 딜을 찾지 못했습니다"라고 답하세요. 답변에는 근거로 삼은 딜의 발표일·인수자·피인수자와, 거래금액이 있다면 억원 단위로 산출 근거(원문 표현)와 함께 언급하세요.';
  const userMessage = `[기사 목록]\n${contextText || '(저장된 기사가 없습니다)'}\n\n[질문]\n${question}`;

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      res.status(502).json({ error: 'Claude API 호출 실패', detail: errText });
      return;
    }

    const claudeData = await claudeResp.json();
    const answer = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '답변을 생성하지 못했습니다.';

    res.status(200).json({
      answer,
      sources: contextArticles.map(a => ({ title: a.title, source_url: a.source_url, digest_date: a.digest_date, outlet: a.outlet })),
    });
  } catch (e) {
    res.status(502).json({ error: 'Claude API 호출 중 오류', detail: String(e) });
  }
};
