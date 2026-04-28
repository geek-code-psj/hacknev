'use strict';
const { detectSignals, buildProfileFromSeed } = require('../profiler');
const store = require('../memory/store');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-6';
const TIMEOUT_MS    = 2500; // 2.5s timeout per spec (p99 <= 3s)

function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  return key;
}

/**
 * Deterministic fallback when LLM times out
 */
function generateFallbackCoaching(signals, trades) {
  if (signals.length === 0) {
    return "You had a clean session with no behavioral red flags detected. Keep maintaining your discipline and sticking to your trading plan. Remember: consistency is key to long-term success.";
  }

  const signalTypes = signals.map(s => s.type);
  if (signalTypes.includes('revenge_trading')) {
    return "I noticed signs of revenge trading in your session. Remember: taking a break after a loss is smarter than trying to 'make it back' immediately. Step away, reset, and come back with a clear mind.";
  }
  if (signalTypes.includes('overtrading')) {
    return "You executed more trades than optimal in this session. Quality over quantity — fewer, well-planned trades usually outperform many impulsive ones. Consider tightening your entry criteria.";
  }
  if (signalTypes.includes('session_tilt')) {
    return "I detected signs of session tilt — your emotional state may have been affecting your decisions. When you feel frustration building, it's okay to end the session early. Preservation beats chasing.";
  }
  if (signalTypes.includes('fomo_entries')) {
    return "Some entries showed FOMO characteristics — chasing moves without waiting for confirmation. Wait for your setup criteria to be met. Patience prevents costly mistakes.";
  }

  return `This session had ${trades.length} trades. Focus on maintaining plan discipline and emotional control. Quality setups lead to better outcomes.`;
}

/**
 * Build the coaching system prompt with memory context and signal evidence.
 * Every claim about the trader must reference a real sessionId or tradeId.
 */
function buildSystemPrompt(userId, signals, memoryContext, profile) {
  const sessionRefs = memoryContext.sessions.map(s =>
    `- Session ${s.sessionId} (${s.storedAt}): ${typeof s.summary === 'string' ? s.summary : JSON.stringify(s.summary)}`
  ).join('\n');

  const signalDesc = signals.map(s =>
    `- [${s.type.toUpperCase()}] ${s.evidence} (session: ${s.sessionId || 'N/A'}, trade: ${s.tradeId || 'N/A'})`
  ).join('\n');

  const profileDesc = profile
    ? `Trader profile: ${profile.name}. Known patterns: ${profile.dominantPathologies?.map(p => p.pathology).join(', ') || 'none yet detected'}.`
    : 'No prior profile available.';

  return `You are NevUp, an AI trading psychology coach. Your role is to help retail day traders recognize and overcome behavioral patterns that harm their performance.

USER: ${userId}
${profileDesc}

DETECTED SIGNALS THIS SESSION:
${signalDesc || 'No signals detected yet.'}

MEMORY FROM PRIOR SESSIONS:
${sessionRefs || 'No prior session memory.'}

RULES:
1. Be direct, empathetic, and specific. Generic advice is worse than silence.
2. Every reference to a past session MUST cite the actual sessionId.
3. Every reference to a specific trade MUST cite the actual tradeId.
4. Do NOT invent trades, sessions, or patterns that are not in the data above.
5. Keep coaching messages under 200 words. Use plain language — no jargon.
6. Focus on one actionable insight per message.
7. If no signals are detected, acknowledge the clean session and reinforce good habits.`;
}

/**
 * Stream coaching tokens via SSE to the response object.
 * Latency target: first token <= 400ms, p99 total <= 3s on warm calls.
 * Falls back to deterministic template on timeout.
 */
async function streamCoaching(res, userId, trades, sessionId) {
  const signals   = detectSignals(trades);
  const context   = store.getContext(userId, signals[0]?.type || '');
  const profile   = store.getProfile(userId) || buildProfileFromSeed(userId);

  const userMessage = signals.length > 0
    ? `I just completed a trading session (${sessionId}). I made ${trades.length} trades. The system detected: ${signals.map(s => s.type).join(', ')}. What should I reflect on?`
    : `I completed a session (${sessionId}) with ${trades.length} trades. How did I do emotionally and behaviorally?`;

  const body = JSON.stringify({
    model:      MODEL,
    max_tokens: 500,
    stream:     true,
    system:     buildSystemPrompt(userId, signals, context, profile),
    messages:   [{ role: 'user', content: userMessage }],
  });

  // Set SSE headers
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('X-Accel-Buffering',           'no');
  res.flushHeaders();

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         getApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      res.write(`event: error\ndata: ${JSON.stringify({ error: err })}\n\n`);
      res.end();
      return { fullText: '', signals };
    }

    const reader   = response.body.getReader();
    const decoder  = new TextDecoder();
    let fullText   = '';
    let buffer     = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const token = event.delta.text;
            fullText += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        } catch {}
      }
    }

    res.write(`event: signals\ndata: ${JSON.stringify({ signals, sessionId })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
    return { fullText, signals };

  } catch (err) {
    clearTimeout(timeoutId);
    // Timeout or error - stream fallback
    const fallback = generateFallbackCoaching(signals, trades);
    const tokens = fallback.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      res.write(`data: ${JSON.stringify({ token: tokens[i] + (i < tokens.length - 1 ? ' ' : '') })}\n\n`);
    }
    res.write(`event: fallback\ndata: ${JSON.stringify({ reason: 'timeout' })}\n\n`);
    res.write(`event: signals\ndata: ${JSON.stringify({ signals, sessionId })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
    return { fullText: fallback, signals, isFallback: true };
  }
}

/**
 * Non-streaming coaching for internal use (eval harness, audit).
 */
async function generateCoaching(userId, trades, sessionId) {
  const signals = detectSignals(trades);
  const context = store.getContext(userId, signals[0]?.type || '');
  const profile = store.getProfile(userId) || buildProfileFromSeed(userId);

  const userMessage = signals.length > 0
    ? `Session ${sessionId}: ${trades.length} trades. Detected: ${signals.map(s => s.type).join(', ')}.`
    : `Session ${sessionId}: ${trades.length} trades. No behavioral signals detected.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         getApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 500,
        system:     buildSystemPrompt(userId, signals, context, profile),
        messages:   [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);

    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    return { text, signals };

  } catch (err) {
    clearTimeout(timeoutId);
    // Return fallback on timeout
    const fallback = generateFallbackCoaching(signals, trades);
    return { text: fallback, signals, isFallback: true };
  }
}

module.exports = { streamCoaching, generateCoaching, detectSignals, generateFallbackCoaching };
