import assert from 'node:assert/strict';
import test from 'node:test';
import { getRegistry } from '@jackwener/opencli/registry';
import { partyUrl, flightForParty } from '../adapters/travel-price/ctrip-flight.js';
import { mapTripHotel } from '../adapters/travel-price/trip-hotel.js';
import { bookingSearchUrl } from '../adapters/travel-price/booking-hotel.js';

test('two adults reach the browser and the returned evidence URL', async () => {
  const navigated = [];
  const page = { tag: 'real-page', goto(url) { navigated.push(url); },
    evaluate() { assert.equal(this.tag, 'real-page'); return []; } };
  const original = 'https://flights.ctrip.com/online/list/oneway-sha-sel?depdate=2027-01-08&adult=1&child=0';
  const base = { func: async (proxy) => {
    await proxy.goto(original);
    await proxy.evaluate('');
    return [{ url: original, price: 1234.5 }];
  } };
  const rows = await flightForParty(page, { adults: 2 }, base);
  assert.equal(new URL(navigated[0]).searchParams.get('adult'), '2');
  assert.equal(new URL(rows[0].url).searchParams.get('adult'), '2');
  assert.equal(new URL(rows[0].url).searchParams.get('depdate'), '2027-01-08');
  assert.equal(rows[0].price, 1234.5); // Never multiply a displayed amount by party size.
  assert.equal(rows[0].requestedAdults, 2);
});

test('invalid party or unrelated URL fails before navigation', async () => {
  for (const adults of [0, -1, 1.5, 10, 'oops']) {
    await assert.rejects(flightForParty({}, { adults }), /adults/);
  }
  assert.throws(() => partyUrl('https://example.com/', 2), /Unexpected/);
});

test('OpenCLI execution context is not mistaken for an upstream adapter', async () => {
  const command = getRegistry().get('travel-price/ctrip-flight');
  const upstream = getRegistry().get('ctrip/flight');
  const original = upstream.func;
  upstream.func = async () => [];
  try {
    assert.deepEqual(await command.func({}, { adults: 2 }, { emit() {} }), []);
  } finally {
    upstream.func = original;
  }
});

test('network timeout can expose loaded flight cards with an explicit partial scope', async () => {
  const url = 'https://flights.ctrip.com/online/list/oneway-sha-sel?depdate=2027-01-08&adult=1';
  let query;
  const page = { goto(value) { query = value; },
    evaluate(expression) {
      return expression.includes('blocked:') ? { url: query, blocked: false } :
        [{ airline: 'Example', price: 919, flightNo: 'EX123', departureAirport: 'PVG', arrivalAirport: 'ICN' }];
    } };
  const base = { func: async p => { await p.goto(url); throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } };
  const rows = await flightForParty(page, { adults: 2, date: '2027-01-08', limit: 5 }, base);
  assert.equal(rows[0].collectionMethod, 'rendered_cards_after_timeout');
  assert.equal(rows[0].exhaustive, false);
});

test('authentication errors never trigger the flight DOM fallback', async () => {
  const page = { goto() {}, evaluate() { throw new Error('must not extract'); } };
  const base = { func: async p => {
    await p.goto('https://flights.ctrip.com/online/list/oneway-sha-sel?adult=1');
    throw Object.assign(new Error('login'), { code: 'AUTH_REQUIRED' });
  } };
  await assert.rejects(flightForParty(page, { adults: 2 }, base), /login/);
});

test('Trip nightly, rounded total and detailed total remain distinct', () => {
  const row = mapTripHotel({hotelInfo: {summary: {hotelId:'123'}, nameInfo: {name:'Example'}},
    roomInfo: [{summary: {physicsName:'Twin', roomQuantity:1},guestInfo:{adultCount:2,childCount:0},
      priceInfo:{price:159,currency:'USD',priceExplanation:'Total price: $347'},
      priceInfoLayer:{payInfo:{total:{content:'$346.82'}}}}]},0,'https://www.trip.com/hotels/list');
  assert.equal(row.price,159);
  assert.equal(row.displayedStayTotal,'$346.82');
  assert.equal(row.observedAdults,2);
});

test('Booking URL keeps its observed destination id, dates, party and currency', () => {
  const url = new URL(bookingSearchUrl({destination:'Seoul, South Korea','city-id':'-716583',
    checkin:'2027-01-08',checkout:'2027-01-10',adults:2,rooms:1,currency:'USD'}));
  assert.equal(url.searchParams.get('dest_id'),'-716583');
  assert.equal(url.searchParams.get('group_adults'),'2');
  assert.equal(url.searchParams.get('selected_currency'),'USD');
  assert.equal(url.pathname,'/searchresults.zh-cn.html');
});
