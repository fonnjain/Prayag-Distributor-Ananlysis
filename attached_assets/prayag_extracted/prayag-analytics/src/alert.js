// src/alert.js — send warn/fail audit verdicts to Slack (if configured) or the console.
async function alert(verdict) {
  const line = `Prayag audit [${verdict.status.toUpperCase()}] (${verdict.fy}) — ${verdict.summary_for_human || ''}`;
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log('[ALERT]', line); return; }
  try {
    const anomalies = (verdict.anomalies || []).map((a) => `• (${a.severity}) ${a.what} → ${a.inspect}`).join('\n');
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${line}${anomalies ? '\n' + anomalies : ''}` }),
    });
  } catch (e) { console.log('[ALERT fallback]', line, e.message); }
}

module.exports = { alert };
