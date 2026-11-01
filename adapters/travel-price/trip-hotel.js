// Trip.com's current listing embeds the same hotelInfo/roomInfo SSR structure.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { mapHotelRow } from '../../node_modules/@jackwener/opencli/clis/ctrip/utils.js';
import { buildHotelSearchUrl, parseCityId, parseIsoDate, parseListLimit } from '../../node_modules/@jackwener/opencli/clis/trip/utils.js';

export function mapTripHotel(entry, index, searchUrl) {
  const base = mapHotelRow(entry, index);
  const room = entry.roomInfo?.[0] ?? {};
  const price = room.priceInfo ?? {};
  const payment = room.priceInfoLayer?.payInfo ?? {};
  const tags = room.roomTags?.advantageTags ?? [];
  return {
    ...base,
    url: searchUrl,
    roomName: room.summary?.physicsName ?? null,
    bedDescription: room.bedInfo?.contentList?.join(' / ') ?? null,
    observedAdults: room.guestInfo?.adultCount ?? null,
    observedChildren: room.guestInfo?.childCount ?? null,
    observedRooms: room.summary?.roomQuantity ?? null,
    observedCheckIn: room.statusInfo?.checkIn ?? null,
    observedCheckOut: room.statusInfo?.checkOut ?? null,
    displayedStayTotal: payment.total?.content ?? null,
    displayedTaxes: payment.payTax?.content ?? null,
    totalExplanation: price.priceExplanation ?? null,
    paymentLabel: payment.total?.title ?? null,
    roomPolicies: tags.map(tag => tag.tagTitle).filter(Boolean).join(' / ') || null,
    displayedNightlyPrice: price.displayPrice ?? null,
  };
}

cli({
  site: 'travel-price', name: 'trip-hotel', access: 'read',
  description: 'Read Trip.com hotel SSR quotes, room conditions and displayed stay totals',
  domain: 'www.trip.com', strategy: Strategy.COOKIE, browser: true, navigateBefore: false,
  args: [
    { name: 'city', required: true, positional: true },
    { name: 'checkin', required: true }, { name: 'checkout', required: true },
    { name: 'currency', default: 'USD' },
    { name: 'limit', default: 10, type: 'int' },
  ],
  columns: ['hotelId','name','price','currency','roomName','bedDescription',
    'observedAdults','observedChildren','observedRooms','observedCheckIn','observedCheckOut',
    'displayedStayTotal','displayedTaxes','totalExplanation','paymentLabel','roomPolicies',
    'displayedNightlyPrice','url'],
  func: async (page, args) => {
    const city = parseCityId('city', args.city);
    const checkin = parseIsoDate('checkin', args.checkin);
    const checkout = parseIsoDate('checkout', args.checkout);
    const limit = parseListLimit(args.limit);
    if (checkin >= checkout) throw new CommandExecutionError('Check-out must follow check-in');
    const currency = String(args.currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new CommandExecutionError('Expected an ISO currency code');
    const target = new URL(buildHotelSearchUrl(city, checkin, checkout));
    target.searchParams.set('curr', currency);
    const url = target.toString();
    await page.goto(url);
    for (let attempt = 0; attempt < 10; attempt++) {
      const state = await page.evaluate(`(() => ({
        blocked: /captcha/.test(location.pathname),
        rows: window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList ?? null
      }))()`);
      if (state.blocked) throw new AuthRequiredError('trip.com', 'Complete verification in the browser');
      if (Array.isArray(state.rows)) {
        if (!state.rows.length) throw new EmptyResultError('trip-hotel', 'SSR hotel list is empty');
        const rows = state.rows.slice(0, limit).map((row, i) => mapTripHotel(row, i, url));
        if (rows.some(row => !row.hotelId || !row.name)) throw new CommandExecutionError('SSR hotel identity is missing');
        return rows;
      }
      await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('Trip.com did not expose its SSR hotel list');
  },
});
