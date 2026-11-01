import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CommandExecutionError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, waitFor, numericText} from './browser-utils.js';

export function agodaUrl(args) {
  validateHotelArgs(args);
  if (!/^\d+$/.test(args['city-id'] || '')) throw new ArgumentError('Agoda requires its resolved numeric city-id');
  const url = new URL('https://www.agoda.com/zh-cn/search');
  for (const [key,value] of Object.entries({city:args['city-id'],checkIn:args.checkin,checkOut:args.checkout,
    adults:args.adults,rooms:args.rooms,children:0,currency:args.currency})) url.searchParams.set(key,String(value));
  return url.toString();
}

function readAgoda() {
  const url = new URL(location.href);
  const get = key => url.searchParams.get(key);
  const text = selector => document.querySelector(selector)?.innerText.trim() || null;
  return {
    host:location.hostname,path:location.pathname,currency:window.agoda?.pageConfig?.currencyCode,
    observedSearch:{city_id:get('city'),check_in:get('checkIn'),check_out:get('checkOut'),
      adults:Number(document.querySelector('[data-selenium="adultValue"]')?.dataset.value) || null,
      rooms:Number(document.querySelector('[data-selenium="roomValue"]')?.dataset.value) || null,
      children:get('children') === null ? null : Number(get('children'))},
    queryEvidence:{check_in_text:text('[data-selenium="checkInBox"]'),check_out_text:text('[data-selenium="checkOutBox"]'),
      party_text:text('[data-selenium="occupancyBox"]'),currency_basis:'agoda.pageConfig.currencyCode'},
    cards:[...document.querySelectorAll('[data-selenium="hotel-item"]')].map(card => ({
      hotelId:card.dataset.hotelid,
      name:card.querySelector('[data-selenium="hotel-name"]')?.innerText.trim(),
      priceRaw:card.querySelector('[data-selenium="display-price"]')?.innerText.trim() || null,
      priceLabel:card.querySelector('[data-selenium="per-night-begins-with"]')?.innerText.trim() || null,
      address:card.querySelector('[data-selenium="area-city-text"]')?.innerText.trim() || null,
      policySummary:[...card.querySelectorAll('[data-selenium="room-benefit"]')].map(e=>e.innerText.trim()).join(' / ') || null,
    })).filter(card=>card.hotelId && card.name)
  };
}

export function mapAgoda(state, args, url) {
  if (state.host !== 'www.agoda.com' || !state.path.endsWith('/search')) throw new CommandExecutionError('Agoda redirected away from search');
  if (!/^[A-Z]{3}$/.test(state.currency || '')) throw new CommandExecutionError('Agoda actual currency could not be verified');
  const observed=state.observedSearch;
  const dateText = date => {const [y,m,d]=date.split('-').map(Number); return `${y}年${m}月${d}日`;};
  const verified = observed.city_id === args['city-id'] && observed.check_in === args.checkin && observed.check_out === args.checkout &&
    state.queryEvidence.check_in_text?.includes(dateText(args.checkin)) && state.queryEvidence.check_out_text?.includes(dateText(args.checkout));
  return state.cards.filter(card=>numericText(card.priceRaw) !== null).slice(0,Number(args.limit)).map(card=>({
    ...card,schema:'hotel-observation-v1',price:numericText(card.priceRaw),currency:state.currency,url,
    priceBasis:'nightly_display',listedTaxesIncluded:/税后|含税|including taxes/i.test(card.priceLabel || '') ? true : null,
    displayedStayTotal:null,observedSearch:observed,queryEvidence:state.queryEvidence,
    conditionsVerified:Boolean(verified),partyParameterSupported:true,collectionMethod:'rendered_search_cards',exhaustive:false,
  }));
}

cli({site:'travel-price',name:'agoda-hotel',access:'read',description:'Agoda dated hotel search with actual currency and occupancy',
  domain:'www.agoda.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>{
    const url=agodaUrl(args);
    await navigate(page,url);
    await waitFor(page,'[data-selenium="hotel-item"] [data-selenium="display-price"]');
    for(let i=0;i<Number(args.limit);i++) {
      const found=await page.evaluate(`(() => {const card=document.querySelectorAll('[data-selenium="hotel-item"]')[${i}]; if(!card) return false;card.scrollIntoView({block:'center'});return true;})()`);
      if(!found) break;
      await page.wait({time:0.35});
    }
    return mapAgoda(await page.evaluate('('+readAgoda.toString()+')()'),args,url);
  }
});
