// Regenerates data.json from live sources. Run by .github/workflows/refresh-data.yml on a schedule.
// Every section is INDEPENDENT and degrades gracefully — provide whichever secrets you have:
//   SUPABASE_DB_URL .......... product metrics + retention/geo/streaks/stickiness/engagement
//   PLAY_SA_JSON ............. Play reviews, Android Vitals (crash/ANR), AND the reach-out heatmap
//                              (reads the Sheet's ActivityLog tab via Sheets API — requires: enable the
//                               Sheets API in the SA's GCP project + share the Sheet with the SA email)
//   APPSTORE_P8/KEY_ID/ISSUER_ID ... App Store reviews/ratings
//   GH_PAT ................... GitHub commit heatmap across the 4 repos
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

const prev = JSON.parse(readFileSync('data.json', 'utf8'));
const MQ = existsSync('scripts/metric_queries.json') ? JSON.parse(readFileSync('scripts/metric_queries.json', 'utf8')) : {};
const b64url = (s) => Buffer.from(s).toString('base64url');
const SHEET_ID = '1Nl20d89gqiNpca4zzp1T13l4oqtB07rmzVUQ8mQSdeI';
const PLAY_SA = process.env.PLAY_SA_JSON || (existsSync('.secrets/play-service-account.json') ? readFileSync('.secrets/play-service-account.json', 'utf8') : null);

const data = { ...prev, generatedAt: new Date().toISOString() };

async function googleToken(scope) {
  const sa = JSON.parse(PLAY_SA); const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pl = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const assertion = h + '.' + pl + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + pl), sa.private_key).toString('base64url');
  return (await (await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })).json()).access_token;
}

// ===== 1) Product metrics + cohort/geo/streaks/stickiness/engagement (SUPABASE_DB_URL) =====
if (process.env.SUPABASE_DB_URL) {
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    const q = async (sql) => (await db.query(sql)).rows;
    const totals = (await q(`SELECT
      (SELECT count(*) FROM users) app_opens,
      (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'provider' IS NOT NULL) accounts,
      (SELECT count(DISTINCT user_id) FROM prayer_logs) prayed,
      (SELECT count(*) FROM prayer_logs WHERE created_at >= now()-interval '24 hours') checkins24,
      (SELECT count(DISTINCT user_id) FROM prayer_logs WHERE created_at >= now()-interval '30 days') mau30,
      (SELECT count(*) FROM subscriptions WHERE status::text <> 'free') paying`))[0];
    const byType = await q(`WITH u AS (SELECT id, coalesce(raw_app_meta_data->>'provider','anonymous') k FROM auth.users),
      a AS (SELECT DISTINCT user_id FROM prayer_logs)
      SELECT u.k kind, count(*) n, round(100.0*count(x.user_id)/nullif(count(*),0),1) pct
      FROM u LEFT JOIN a x ON x.user_id=u.id GROUP BY 1`);
    const tmap = Object.fromEntries(byType.map(r => [r.kind, r]));
    const dau = await q(`SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') d, count(DISTINCT user_id) dau, count(*) c
      FROM prayer_logs WHERE created_at >= now()-interval '90 days' AND created_at < date_trunc('day',now()) GROUP BY 1 ORDER BY 1`);
    const signups = await q(`SELECT to_char(date_trunc('day',u.created_at),'YYYY-MM-DD') d,
      count(*) FILTER (WHERE au.raw_app_meta_data->>'provider' IS NULL) anon,
      count(*) FILTER (WHERE au.raw_app_meta_data->>'provider'='google') g,
      count(*) FILTER (WHERE au.raw_app_meta_data->>'provider'='apple') a
      FROM users u JOIN auth.users au ON au.id=u.id
      WHERE u.created_at >= now()-interval '140 days' AND u.created_at < date_trunc('day',now()) GROUP BY 1 ORDER BY 1`);
    const outcomes = await q(`SELECT status::text s, count(*) n FROM prayer_logs WHERE created_at >= now()-interval '30 days' GROUP BY 1 ORDER BY 2 DESC`);
    const cohort = await q(`WITH a AS (SELECT DISTINCT user_id FROM prayer_logs)
      SELECT to_char(date_trunc('month',u.created_at),'Mon') m, date_trunc('month',u.created_at) mm,
      round(100.0*count(x.user_id)/nullif(count(*),0),1) pct
      FROM users u LEFT JOIN a x ON x.user_id=u.id WHERE u.created_at >= '2026-02-01' GROUP BY 1,2 ORDER BY 2`);
    const OUTLABEL = { on_time: 'On time', late: 'Late', missed: 'Missed', menstruation: 'Menstruation' };
    data.kpis = { appOpens: +totals.app_opens, accounts: +totals.accounts, activationPct: +(100 * totals.prayed / totals.app_opens).toFixed(1), mau30: +totals.mau30, checkins24: +totals.checkins24, rating: prev.kpis.rating, reviews: prev.kpis.reviews, paying: +totals.paying, dauLatest: dau.length ? +dau[dau.length - 1].dau : prev.kpis.dauLatest, prayedEver: +totals.prayed, leaked: totals.app_opens - totals.prayed, active30: +(100 * totals.mau30 / totals.prayed).toFixed(1) };
    data.signups = signups.map(r => [r.d, +r.anon, +r.g, +r.a]);
    data.dau = dau.map(r => [r.d, +r.dau, +r.c]);
    data.outcomes = outcomes.map(r => [OUTLABEL[r.s] || r.s, +r.n]);
    data.activationByType = [['Anonymous', +(tmap.anonymous?.pct || 0), +(tmap.anonymous?.n || 0)], ['Google', +(tmap.google?.pct || 0), +(tmap.google?.n || 0)], ['Apple', +(tmap.apple?.pct || 0), +(tmap.apple?.n || 0)]];
    data.cohort = cohort.map(r => [r.m, +r.pct]);
    try { const r = await q(MQ.retention); data.retention = r.map(x => ({ cohortWeek: String(x.cohort_week), size: +x.size, d1: x.d1 == null ? null : +x.d1, d7: x.d7 == null ? null : +x.d7, d30: x.d30 == null ? null : +x.d30 })); } catch (e) { console.log('m.retention', e.message); }
    try { const r = await q(MQ.geo); data.geo = { countries: r.map(x => [x.country, +x.cnt]), countries_pct: r.map(x => [x.country, +x.pct]), languages: [] }; } catch (e) { console.log('m.geo', e.message); }
    try { const r = (await q(MQ.streaks))[0]; data.streaks = { buckets: [{ label: '0', users: +r.bucket_0 }, { label: '1-2', users: +r.bucket_1_2 }, { label: '3-6', users: +r.bucket_3_6 }, { label: '7-13', users: +r.bucket_7_13 }, { label: '14-29', users: +r.bucket_14_29 }, { label: '30-59', users: +r.bucket_30_59 }, { label: '60+', users: +r.bucket_60_plus }], total_users: +r.total_users, streak_ge7: { users: +r.streak_ge7, pct: +r.pct_ge7 }, streak_ge30: { users: +r.streak_ge30, pct: +r.pct_ge30 }, max_longest_streak: +r.max_longest_streak }; } catch (e) { console.log('m.streaks', e.message); }
    try { const a = (await q(MQ.stickDauMau))[0]; const s = await q(MQ.stickSeries); data.stickiness = { dauMau: +a.dau_mau, dau: +a.dau, mau: +a.mau, series: s.map(x => [String(x.week_end), x.mau ? +(x.dau / x.mau).toFixed(3) : null]) }; } catch (e) { console.log('m.stick', e.message); }
    try { const r = await q(MQ.engagement); data.engagement = { byPrayer: r.map(x => [x.prayer_name, +x.total, +x.on_time_pct, +x.late_pct, +x.missed_pct]) }; } catch (e) { console.log('m.eng', e.message); }
    console.log('product+metrics refreshed');
  } catch (e) { console.log('DB section error (kept previous):', e.message); }
  finally { try { await db.end(); } catch (e2) {} }
} else { console.log('no SUPABASE_DB_URL — product metrics kept from previous snapshot'); }

// ===== 2) GitHub commit heatmap (GH_PAT) =====
if (process.env.GH_PAT) {
  try {
    const PAT = process.env.GH_PAT;
    const repos = ['GhanyR/fiveprayer-website', 'GhanyR/fiveprayer-backend', 'pislm/fiveprayer-mobile', 'GhanyR/fiveprayer-dashboard'];
    const daily = {}; const perRepo = [];
    for (const r of repos) {
      let n = 0, page = 1;
      while (true) {
        const res = await fetch(`https://api.github.com/repos/${r}/commits?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${PAT}`, 'User-Agent': 'fiveprayer-dashboard' } });
        if (!res.ok) break;
        const arr = await res.json(); if (!arr.length) break;
        for (const c of arr) { const d = c.commit.author.date.slice(0, 10); daily[d] = (daily[d] || 0) + 1; n++; }
        if (arr.length < 100) break; page++;
      }
      perRepo.push([r.split('/')[1], n]);
    }
    data.github = { daily, perRepo, total: Object.values(daily).reduce((a, b) => a + b, 0), activeDays: Object.keys(daily).length };
    console.log('github:', data.github.total, 'commits');
  } catch (e) { console.log('github skipped:', e.message); }
}

// ===== 3) Stores: App Store + Google Play reviews =====
try {
  const p8 = process.env.APPSTORE_P8 || (existsSync('.secrets/AppStoreConnect_AuthKey_2GHDN4JLDT.p8') ? readFileSync('.secrets/AppStoreConnect_AuthKey_2GHDN4JLDT.p8', 'utf8') : null);
  const stores = {};
  if (p8) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.APPSTORE_KEY_ID || '2GHDN4JLDT', typ: 'JWT' }));
    const pl = b64url(JSON.stringify({ iss: process.env.APPSTORE_ISSUER_ID || '0c7e62df-b701-4b2b-9717-7b3c2b3590e6', iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' }));
    const jwt = h + '.' + pl + '.' + crypto.sign('SHA256', Buffer.from(h + '.' + pl), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    let url = 'https://api.appstoreconnect.apple.com/v1/apps/6755536905/customerReviews?limit=200&sort=-createdDate';
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let total = 0, sum = 0, pg2 = 0; const recent = [];
    while (url && pg2 < 8) {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + jwt } }); if (!r.ok) break; const j = await r.json();
      for (const rv of (j.data || [])) { const s = rv.attributes?.rating; if (s) { dist[s]++; total++; sum += s; } if (recent.length < 6) recent.push({ rating: s, title: rv.attributes?.title, body: (rv.attributes?.body || '').slice(0, 120), territory: rv.attributes?.territory }); }
      url = j.links?.next; pg2++;
    }
    stores.ios = { rating: total ? +(sum / total).toFixed(2) : null, reviews: total, dist, recent };
  }
  if (PLAY_SA) {
    const tok = await googleToken('https://www.googleapis.com/auth/androidpublisher');
    const revs = (await (await fetch('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.fiveprayer.app/reviews?maxResults=100', { headers: { Authorization: 'Bearer ' + tok } })).json()).reviews || [];
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let sum = 0, n = 0; const recent = [];
    for (const rv of revs) { const c = rv.comments?.[0]?.userComment; const s = c?.starRating; if (s) { dist[s]++; sum += s; n++; } if (recent.length < 6) recent.push({ rating: s, text: (c?.text || '').slice(0, 120), device: c?.deviceMetadata?.productName, author: rv.authorName }); }
    stores.play = { ratingAllTime: prev.stores?.play?.ratingAllTime || 4.82, reviewsAllTime: prev.stores?.play?.reviewsAllTime || 94261, ratingLast7d: n ? +(sum / n).toFixed(2) : null, distLast7d: dist, recent };
  }
  if (stores.ios || stores.play) { data.stores = { ...prev.stores, ...stores, pulledAt: new Date().toISOString() }; console.log('stores:', stores.ios?.rating, '/', stores.play?.ratingLast7d); }
} catch (e) { console.log('stores skipped:', e.message); }

// ===== 4) Reach-out heatmap: read the Sheet's ActivityLog tab via Sheets API =====
try {
  if (PLAY_SA) {
    const tok = await googleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/ActivityLog!A2:H?majorDimension=ROWS`, { headers: { Authorization: 'Bearer ' + tok } });
    if (r.ok) {
      const rows = (await r.json()).values || [];
      const byDay = {};
      for (const row of rows) { const ts = row[0], ct = row[7]; if (!ts || ct === 'system' || ct === 'error') continue; const day = String(ts).slice(0, 10); byDay[day] = (byDay[day] || 0) + 1; }
      const hist = (data.reachoutHistory && data.reachoutHistory.byDay) || {};
      const merged = { ...hist }; for (const k in byDay) merged[k] = Math.max(merged[k] || 0, byDay[k]);
      data.reachoutHistory = { ...data.reachoutHistory, byDay: merged, liveUpdatedAt: new Date().toISOString(), source: 'Sheet version history + live ActivityLog (Sheets API)' };
      console.log('reachout via Sheets API:', rows.length, 'rows ->', Object.keys(byDay).length, 'days');
    } else { console.log('ActivityLog read', r.status, (await r.text()).slice(0, 140)); }
  }
} catch (e) { console.log('reachout(sheets) skipped:', e.message); }

// ===== 5) Android Vitals (crash + ANR) via Play Reporting API =====
try {
  if (PLAY_SA) {
    const tok = await googleToken('https://www.googleapis.com/auth/playdeveloperreporting');
    const end = new Date(Date.now() - 2 * 86400000), start = new Date(end.getTime() - 27 * 86400000);
    const dt = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    async function vq(ms, metric) {
      const body = { timelineSpec: { aggregationPeriod: 'DAILY', startTime: dt(start), endTime: dt(end) }, metrics: [metric], dimensions: [] };
      const r = await fetch('https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.fiveprayer.app/' + ms + ':query', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 200) return [];
      const j = await r.json();
      return (j.rows || []).map(row => { const d = row.startTime; const date = d.year + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0'); const m = (row.metrics || []).find(x => x.metric === metric); const v = m && (m.decimalValue ? m.decimalValue.value : m.value); return [date, v != null ? +(+v).toFixed(4) : null]; });
    }
    const crash = await vq('crashRateMetricSet', 'crashRate'), anr = await vq('anrRateMetricSet', 'anrRate');
    if (crash.length || anr.length) { data.vitals = { crash, anr, pulledAt: new Date().toISOString() }; console.log('vitals:', crash.length, '/', anr.length); }
  }
} catch (e) { console.log('vitals skipped:', e.message); }

writeFileSync('data.json', JSON.stringify(data));
console.log('done — reachout days', Object.keys((data.reachoutHistory && data.reachoutHistory.byDay) || {}).length, '· dau days', (data.dau || []).length);
