// ============================================================
// COCOON SUITES — Competitor Rate Fetcher
// agents/fetch_comp_rates.js
// Fetches full season rates from Aqua, Kapari, Honeymoon Petra
// via public WebHotelier BAR API — no credentials needed
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const WH_BASE = 'https://rest.reserve-online.net';

// Season: April 1 to October 31
const SEASON_START_MONTH = 3; // April (0-indexed)
const SEASON_END_MONTH = 9;   // October (0-indexed)

const COMPETITORS = [
  {
    name: 'Aqua Luxury Suites',
    code: 'AQUASANTO',
    rooms: [
      { code: 'EXECUT', name: 'Executive Suite', cocoon_room: 'EXESUI' },
      { code: 'SANT',   name: 'Superior Suite',  cocoon_room: 'HONSUI' },
      { code: 'AQUAS',  name: 'Aqua Suite',       cocoon_room: 'CAVE'   },
      { code: 'MARINE', name: 'Aqua Marine Suite', cocoon_room: 'INFSUI' },
      { code: 'GRAND',  name: 'Grand Suite',       cocoon_room: 'GRSUIT' },
    ]
  },
  {
    name: 'Kapari Natural Resort',
    code: 'KAPARI',
    rooms: [
      { code: 'VR',     name: 'Vanilla Room',       cocoon_room: 'JSUI'   },
      { code: 'SPR',    name: 'Premium Spa Room',    cocoon_room: 'HONSUI' },
      { code: 'PRBALC', name: 'Premium Loft',        cocoon_room: 'CAVE'   },
      { code: 'UPH',    name: 'Up & High',           cocoon_room: 'DELUXE' },
    ]
  },
  {
    name: 'Honeymoon Petra Santorini',
    code: 'HONEYMOON',
    rooms: [
      { code: 'HONSUI', name: 'Junior Suite',        cocoon_room: 'JSUI'   },
      { code: 'TRASUI', name: 'Traditional Suite',   cocoon_room: 'HONSUI' },
      { code: 'HONEY',  name: 'Honeymoon Suite',     cocoon_room: 'DELUXE' },
      { code: 'NEST',   name: 'Honeymoon Nest',      cocoon_room: 'INFSUI' },
      { code: 'INFSUI', name: 'Infinity Pool Suite', cocoon_room: 'GRSUIT' },
    ]
  },
];

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function getSeasonDates() {
  const dates = [];
  const year = new Date().getFullYear();
  const today = new Date();
  today.setHours(0,0,0,0);

  // From today until October 31
  const end = new Date(year, 9, 31); // Oct 31

  const current = new Date(today);
  while (current <= end) {
    const month = current.getMonth();
    if (month >= SEASON_START_MONTH && month <= SEASON_END_MONTH) {
      dates.push(formatDate(new Date(current)));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function fetchBAR(propertyCode, date) {
  const url = `${WH_BASE}/bar/${propertyCode}?per=room&date=${date}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function extractRates(barData, competitor, date, checkDate) {
  const rates = [];
  const rateData = barData?.data;
  if (!rateData) return rates;

  // Overall BAR — lowest available rate
  const bar = rateData?.rate?.price || rateData?.price;
  if (bar) {
    rates.push({
      hotel_id: 'cocoon_suites',
      competitor_name: competitor.name,
      competitor_code: competitor.code,
      their_room_code: 'BAR',
      their_room_name: 'Best Available Rate',
      cocoon_room_code: null,
      stay_date: date,
      check_date: checkDate,
      rate: bar,
      currency: 'EUR',
    });
  }

  // Per-room rates
  const rateList = Array.isArray(rateData?.rates) ? rateData.rates :
                   Array.isArray(rateData) ? rateData : [];

  for (const room of competitor.rooms) {
    const match = rateList.find(r =>
      r?.room === room.code ||
      r?.roomCode === room.code
    );
    if (match?.price || match?.retail?.price) {
      rates.push({
        hotel_id: 'cocoon_suites',
        competitor_name: competitor.name,
        competitor_code: competitor.code,
        their_room_code: room.code,
        their_room_name: room.name,
        cocoon_room_code: room.cocoon_room,
        stay_date: date,
        check_date: checkDate,
        rate: match.price || match.retail?.price,
        currency: 'EUR',
      });
    }
  }

  return rates;
}

async function main() {
  console.log('🏨 Cocoon Suites — Competitor Rate Fetcher');
  console.log('==========================================\n');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { transport: ws }
  });
  const dates = getSeasonDates();
  const checkDate = formatDate(new Date());

  console.log(`Season dates to fetch: ${dates.length} (${dates[0]} → ${dates[dates.length-1]})`);
  console.log(`Competitors: ${COMPETITORS.map(c => c.name).join(', ')}\n`);

  let totalRates = 0;
  let errors = 0;
  const allRates = [];

  for (const comp of COMPETITORS) {
    console.log(`\n📍 ${comp.name}`);
    let compRates = 0;

    for (const date of dates) {
      try {
        const data = await fetchBAR(comp.code, date);
        const rates = extractRates(data, comp, date, checkDate);
        allRates.push(...rates);
        compRates += rates.length;
        totalRates += rates.length;

        // Throttle to avoid rate limiting
        await new Promise(r => setTimeout(r, 250));
      } catch(err) {
        errors++;
        if (errors <= 5) console.log(`  ⚠ ${date}: ${err.message}`);
      }
    }
    console.log(`  ✅ ${compRates} rates fetched`);
  }

  // Save to Supabase in batches of 200
  console.log(`\nSaving ${allRates.length} rates to database...`);
  let saved = 0;

  for (let i = 0; i < allRates.length; i += 200) {
    const chunk = allRates.slice(i, i + 200);
    const { error } = await supabase
      .from('comp_rates')
      .upsert(chunk, { onConflict: 'hotel_id,competitor_code,their_room_code,stay_date' });

    if (error) {
      console.log(`  ❌ Batch ${i/200 + 1} error: ${error.message}`);
    } else {
      saved += chunk.length;
    }
  }

  console.log('\n==========================================');
  console.log(`✅ Done — ${saved} rates saved, ${errors} fetch errors`);
  console.log('==========================================\n');

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
