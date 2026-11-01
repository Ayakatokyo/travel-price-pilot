// Reuse upstream extraction; add destination resolution, proper CDP waits,
// and evidence for the currency and mandatory charges actually displayed.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { __test__ as booking } from '../../node_modules/@jackwener/opencli/clis/booking/search.js';

export function bookingSearchUrl(args) {
  const checkin = booking.normalizeDate(args.checkin, 'checkin');
  const checkout = booking.normalizeDate(args.checkout, 'checkout');
  if (checkin >= checkout) throw new ArgumentError('Check-out must follow check-in');
  const url = new URL(booking.buildSearchUrl({
    destination: args.destination, checkin, checkout,
    adults: booking.normalizePositiveInt(args.adults, 2, 'adults', 30),
    rooms: booking.normalizePositiveInt(args.rooms, 1, 'rooms', 30), children: 0,
    currency: booking.normalizeCurrency(args.currency), lang: 'zh-cn', offset: 0,
  }));
  if (args['city-id']) {
    if (!/^-?\d+$/.test(args['city-id'])) throw new ArgumentError('city-id must be a Booking destination id');
    url.searchParams.set('dest_id', args['city-id']);
    url.searchParams.set('dest_type', 'city');
  }
  return url.toString();
}

cli({
  site: 'travel-price', name: 'booking-hotel', access: 'read',
  description: 'Booking hotel search with observed currency and taxes',
  domain: 'www.booking.com', strategy: Strategy.COOKIE, browser: true, navigateBefore: false,
  args: [
    { name: 'destination', positional: true, required: true },
    { name: 'city-id' }, { name: 'checkin', required: true }, { name: 'checkout', required: true },
    { name: 'adults', type: 'int', default: 2 }, { name: 'rooms', type: 'int', default: 1 },
    { name: 'currency', default: 'CNY' }, { name: 'limit', type: 'int', default: 10 },
  ],
  columns: ['name','country','slug','price_amount','price_currency','recommended_room',
    'priceForNights','taxesAndCharges','url'],
  func: async (page, args) => {
    const limit = booking.normalizePositiveInt(args.limit, 10, 'limit', 25);
    await page.goto(bookingSearchUrl(args));
    // Upstream passes positional wait args; direct CDP requires an options object.
    try { await page.wait({ selector: '[data-testid=property-card]', timeout: 20 }); } catch {}
    const details = await page.evaluate(`(() => ({
      path: location.pathname,
      currency: document.querySelector('[data-testid=header-currency-picker-trigger]')?.innerText.trim(),
      cards: [...document.querySelectorAll('[data-testid=property-card]')].map(card => ({
        key: new URL(card.querySelector('[data-testid=title-link]').href).pathname.split('/').slice(-2).join('/').split('.')[0],
        priceForNights: card.querySelector('[data-testid=price-for-x-nights]')?.textContent || null,
        taxesAndCharges: card.querySelector('[data-testid=taxes-and-charges]')?.textContent || null
      }))
    }))()`);
    if (!details.path.startsWith('/searchresults')) throw new CommandExecutionError('Booking search redirected away from results');
    if (!/^[A-Z]{3}$/.test(details.currency || '')) throw new CommandExecutionError('Displayed Booking currency could not be verified');
    const data = await page.evaluate(booking.EXTRACTOR);
    if (data.blocked) throw new CommandExecutionError('Booking requires browser verification');
    if (!Array.isArray(data.items)) throw new CommandExecutionError('Unexpected Booking extraction format');
    if (!data.items.length) throw new EmptyResultError('booking-hotel', 'No rendered property cards');
    const byKey = new Map(details.cards.map(card => [card.key, card]));
    return data.items.slice(0, limit).map(row => ({ ...row,
      price_currency: details.currency,
      priceForNights: byKey.get(row.country + '/' + row.slug)?.priceForNights ?? null,
      taxesAndCharges: byKey.get(row.country + '/' + row.slug)?.taxesAndCharges ?? null,
    }));
  },
});
