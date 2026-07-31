// ============================================================
// COCOON SUITES — Google Drive Sync Agent
// agents/sync_drive.js
// Reads new weekly tabs from RevReports and saves to Supabase
// Runs daily — skips tabs already saved (safe to re-run)
// ============================================================

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Google OAuth credentials from environment
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Year file IDs
const YEAR_FILES = {
  2021: null, // auto-discovered
  2022: null,
  2023: null,
  2024: '1ZTUbWhzf63pRucpxrtwfQz25ZnQIDFzVM2wESWUofXs',
  2025: '1lpjqkoDvg0JfF0jnFGSshuWZsqn6bLnhTkrYruun0lk',
  2026: '1f72PyqLlIw7qHHfaXSaLB-7BG1bu7flqNBcnhv4Y1EM',
};

const YEAR_FOLDERS = {
  2021: '1osP36W6Djrj7PPjn-o2u7IGoxYSKilNW',
  2022: '1t0qT7XvgE31Hg8KtbcLUT2JZh84LMxOx',
  2023: '1kyeb2yYTVXmK4pqzjnv7Pd7CYkR6N_Ri',
  2024: '1eiv8taKSTpBtYQpkav6O573aPtSsjug8',
  2025: '1wYHj9EJVk4qDt8CVSyUMsOpGnbDusaxD',
  2026: '1wti_9VI3-9vkYFPGuk_bu54M8zNE3olt',
};

// Month trigger words (English + Greek)
const MONTH_TRIGGERS = [
  'april','may','june','july','august','september','october','november',
  'απριλ','μαιο','μάιο','ιουν','ιουλ','αυγο','σεπτ','οκτω','νοεμ',
];

function parseTabDate(tabName) {
  if (!tabName) return null;
  const c = tabName.trim();
  const s = c.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (s) return new Date(2000 + parseInt(s[3]), parseInt(s[2]) - 1, parseInt(s[1]));
  const l = c.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (l) return new Date(parseInt(l[3]), parseInt(l[2]) - 1, parseInt(l[1]));
  return null;
}

function formatDate(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseNumber(str) {
  if (!str || str === '' || str === '-') return null;
  let c = String(str).replace(/[€\s]/g, '').trim().replace('%', '');
  if (c.match(/,\d{1,2}$/)) c = c.replace(/\./g, '').replace(',', '.');
  else c = c.replace(/,/g, '');
  const n = parseFloat(c);
  return isNaN(n) ? null : n;
}

function isMonthHeader(cell) {
  const v = String(cell).toLowerCase().trim();
  return MONTH_TRIGGERS.some(t => v.includes(t));
}

function matchLabel(cell, labels) {
  const v = String(cell).toLowerCase().trim();
  return labels.some(l => v.includes(l));
}

function extractMonthly(row) {
  if (!row) return [null,null,null,null,null,null,null,null];
  return Array.from({length:8}, (_,i) => parseNumber(row[i+1]));
}

function parseSnapshot(rows, year, date) {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i]?.filter(c => c && isMonthHeader(c)).length >= 3) {
      headerIdx = i; break;
    }
  }
  if (headerIdx === -1) return null;

  const data = rows.slice(headerIdx + 1, headerIdx + 25);
  let rnRow, occRow, adrRow, revparRow, roomRevRow, otherRevRow, totalRevRow;
  let lwOccRow, lwRevRow, lwCount = 0;

  for (const row of data) {
    if (!row || !row[0]) continue;
    if (matchLabel(row[0], ['rn sold','διανυ'])) rnRow = row;
    else if (matchLabel(row[0], ['occ %','occ%','πληροτητα'])) occRow = row;
    else if (matchLabel(row[0], ['adr','μεση τιμη'])) adrRow = row;
    else if (matchLabel(row[0], ['revpar'])) revparRow = row;
    else if (matchLabel(row[0], ['room rev','εσοδα δωμ'])) roomRevRow = row;
    else if (matchLabel(row[0], ['other rev','αλλα εσοδα'])) otherRevRow = row;
    else if (matchLabel(row[0], ['total rev','συνολο'])) totalRevRow = row;
    else if (String(row[0]).trim().toLowerCase() === 'last week') {
      lwCount === 0 ? lwOccRow = row : lwRevRow = row;
      lwCount++;
    }
  }

  let chOtaRev=null, chDirRev=null, chOtaPct=null, chDirPct=null;
  for (const row of rows) {
    if (!row || !row[0]) continue;
    const l = String(row[0]).trim().toUpperCase();
    if (l.includes('CHANNEL') || l.includes('ΚΑΝΑΛ')) {
      chOtaRev = parseNumber(row[1]);
      chOtaPct = parseNumber(row[2]);
    }
    if (l === 'DIRECT') {
      chDirRev = parseNumber(row[1]);
      chDirPct = parseNumber(row[2]);
    }
  }

  const tot = row => row ? parseNumber(row[9]) : null;

  return {
    hotel_id: 'cocoon_suites',
    year: parseInt(year),
    snapshot_date: formatDate(date),
    rn_sold: extractMonthly(rnRow),
    occ_pct: extractMonthly(occRow),
    adr: extractMonthly(adrRow),
    revpar: extractMonthly(revparRow),
    room_rev: extractMonthly(roomRevRow),
    other_rev: extractMonthly(otherRevRow),
    total_rev: extractMonthly(totalRevRow),
    last_week_occ: extractMonthly(lwOccRow),
    last_week_rev: extractMonthly(lwRevRow),
    channel_ota_rev: chOtaRev,
    channel_direct_rev: chDirRev,
    channel_ota_pct: chOtaPct,
    channel_direct_pct: chDirPct,
    total_rn_sold: tot(rnRow),
    total_occ_pct: tot(occRow),
    total_adr: tot(adrRow),
    total_revpar: tot(revparRow),
    total_room_rev: tot(roomRevRow),
    total_other_rev: tot(otherRevRow),
    total_total_rev: tot(totalRevRow),
  };
}

async function main() {
  console.log('🏨 Cocoon Suites — Google Drive Sync');
  console.log('==========================================\n');

  // Auth using refresh token (no browser needed in CI)
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
  const drive  = google.drive({ version: 'v3', auth: oAuth2Client });
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { transport: ws }
  });

  // Get already-saved snapshot dates
  const { data: existing } = await supabase
    .from('snapshots')
    .select('year, snapshot_date')
    .eq('hotel_id', 'cocoon_suites');

  const savedDates = new Set(
    (existing || []).map(r => `${r.year}-${r.snapshot_date}`)
  );

  console.log(`Already saved: ${savedDates.size} snapshots\n`);

  let newCount = 0;
  let errors = 0;

  for (const [yearStr, folderId] of Object.entries(YEAR_FOLDERS)) {
    const year = parseInt(yearStr);
    console.log(`📁 Year ${year}`);

    try {
      let fileId = YEAR_FILES[year];

      if (!fileId) {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
          fields: 'files(id,name)',
        });
        const files = res.data.files || [];
        if (!files.length) { console.log('  ⚠ No file found'); continue; }
        fileId = files[0].id;
      }

      const meta = await sheets.spreadsheets.get({
        spreadsheetId: fileId,
        fields: 'sheets.properties.title',
      });

      const tabs = meta.data.sheets
        .map(s => s.properties.title)
        .filter(t => parseTabDate(t));

      // Only process tabs not already saved
      const newTabs = tabs.filter(t => {
        const date = parseTabDate(t);
        return date && !savedDates.has(`${year}-${formatDate(date)}`);
      });

      console.log(`  Tabs: ${tabs.length} total, ${newTabs.length} new`);

      for (const tab of newTabs) {
        const date = parseTabDate(tab);
        try {
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: fileId,
            range: `'${tab}'!A1:L60`,
          });
          const rows = res.data.values || [];
          if (!rows.length) continue;

          const snap = parseSnapshot(rows, year, date);
          if (!snap) { console.log(`  ⚠ ${tab} — could not parse`); errors++; continue; }

          const { error } = await supabase
            .from('snapshots')
            .upsert(snap, { onConflict: 'hotel_id,year,snapshot_date' });

          if (error) {
            console.log(`  ❌ ${tab} — ${error.message}`);
            errors++;
          } else {
            console.log(`  ✅ ${tab} — OCC:${snap.total_occ_pct}% ADR:€${snap.total_adr}`);
            newCount++;
          }

          await new Promise(r => setTimeout(r, 400));
        } catch(e) {
          console.log(`  ❌ ${tab} — ${e.message}`);
          errors++;
        }
      }
    } catch(e) {
      console.log(`  ❌ Year ${year} failed: ${e.message}`);
    }
  }

  console.log('\n==========================================');
  console.log(`✅ Sync complete — ${newCount} new snapshots saved, ${errors} errors`);
  console.log('==========================================\n');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
