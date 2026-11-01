// Reuses the pinned OpenCLI adapter. This project only adds explicit party size.
import '../../node_modules/@jackwener/opencli/clis/ctrip/flight.js';
import { cli, getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { buildFlightExtractJs } from '../../node_modules/@jackwener/opencli/clis/ctrip/utils.js';

const upstream = getRegistry().get('ctrip/flight');
if (!upstream?.func) throw new Error('OpenCLI 2.0.2 ctrip/flight adapter is unavailable');

export function partyUrl(raw, adults) {
  const url = new URL(raw);
  if (url.hostname !== 'flights.ctrip.com' || !url.pathname.startsWith('/online/list/oneway-')) {
    throw new Error('Unexpected Ctrip flight search URL');
  }
  url.searchParams.set('adult', String(adults));
  return url.toString();
}

export async function flightForParty(page, kwargs, base = upstream) {
  const adults = Number(kwargs.adults);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
    throw new ArgumentError('--adults must be an integer from 1 to 9');
  }
  // Ctrip's search can remain a skeleton in a hidden tab. CDP mode does not
  // implement the extension's defaultWindowMode, so focus the owned query tab.
  if (typeof page.cdp === 'function') await page.cdp('Page.bringToFront');
  let searchUrl;
  const adapted = new Proxy(page, {
    get(target, key) {
      if (key === 'goto') return (url, ...options) => {
        searchUrl = partyUrl(url, adults);
        return target.goto(searchUrl, ...options);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let rows;
  let method = 'network_batches';
  try {
    rows = await base.func(adapted, kwargs);
  } catch (error) {
    if (error.code !== 'TIMEOUT' || !searchUrl) throw error;
    const state = await page.evaluate(`({url:location.href,blocked:/captcha|login/.test(location.pathname)})`);
    const actual = new URL(state.url);
    const expected = new URL(searchUrl);
    if (state.blocked || actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
        actual.searchParams.get('depdate') !== kwargs.date || actual.searchParams.get('adult') !== String(adults)) throw error;
    rows = await page.evaluate(buildFlightExtractJs('.flight-item', false));
    if (!Array.isArray(rows) || !rows.length) throw error;
    rows = rows.filter(row => Number.isFinite(row.price) && row.price > 0).slice(0, Number(kwargs.limit ?? 20));
    if (!rows.length) throw error;
    method = 'rendered_cards_after_timeout';
    rows = rows.map(row => ({ ...row, url: searchUrl }));
  }
  return rows.map(row => ({ ...row, url: partyUrl(row.url, adults), requestedAdults: adults,
    collectionMethod: method, exhaustive: false }));
}

cli({
  ...upstream,
  site: 'travel-price',
  name: 'ctrip-flight',
  description: '携程单程机票查询，显式传入成人数；展示价格不认定为含税总价',
  args: [...upstream.args, { name: 'adults', required: true, type: 'int', help: 'Adults in this search (1-9)' }],
  columns: [...upstream.columns, 'requestedAdults', 'collectionMethod', 'exhaustive'],
  func: (page, kwargs) => flightForParty(page, kwargs),
});
