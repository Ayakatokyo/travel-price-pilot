// Deliberately omits cookies, headers, account text and unfiltered URL queries.
import { CDPBridge } from '@jackwener/opencli/browser/cdp';

const bridge = new CDPBridge();
try {
  const page = await bridge.connect();
  const state = await page.evaluate(`(() => {
    const url = new URL(location.href);
    const text = document.body?.innerText || '';
    const isFlight = /^(flights|flight|sijipiao)\\./.test(url.hostname) || url.pathname.startsWith('/iflight/');
    const loginRequired = url.hostname === 'passport.ctrip.com' ||
      (url.hostname === 'account.booking.com' && /sign-in|otp|sign-up/.test(url.pathname)) ||
      (/^(login|passport|user)\\./.test(url.hostname) && /登录|sign in|log in/i.test(text.slice(0,3000)));
    const allowed = new Set(['city','checkin','checkout','depdate','adult','child','infant',
      'cabin','ss','group_adults','group_children','no_rooms','selected_currency',
      'dcity','acity','ddate','quantity','curr','locale','dest_id','dest_type',
      'checkIn','checkOut','adults','rooms','children','currency','regionId','startDate','endDate',
      'inDate','outDate','fromDate','toDate','adultsNumber','intl','stayYear','stayMonth','stayDay','stayCount','adultNum',
      'startServiceDate','endServiceDate','numberOfUnits','numberOfAdults_1','depCity','arrCity','depDate','tripType','goDate','cabinType','flightType']);
    return {
      host: url.hostname, path: url.pathname, visibility: document.visibilityState,
      query: Object.fromEntries([...url.searchParams].filter(([key]) => allowed.has(key))),
      login_required: loginRequired,
      verification_required: !loginRequired && (/captcha/.test(url.pathname) ||
        /请完成验证|拖动滑块|安全验证|verify you are human|checking your browser|security check/i.test(text.slice(0,2000))),
      booking_card_count: document.querySelectorAll('[data-testid=property-card]').length,
      ctrip_ssr_hotel_count: window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList?.length ?? null,
      trip_hotel_card_count: document.querySelectorAll('.hotel-card').length,
      flight_party_text: isFlight ? (text.match(/\\d+成人\\d+儿童\\d+婴儿/)?.[0] ?? text.match(/成人\\s*\\d+/)?.[0] ?? null) : null,
      hotel_party_text: text.match(/\\d+间, \\d+成人, \\d+儿童/)?.[0] ?? null,
      price_login_prompt: /登录以查看会员价|登录后查看价格|请登录查看报价/.test(text)
    };
  })()`);
  console.log(JSON.stringify(state));
} finally {
  await bridge.close();
}
