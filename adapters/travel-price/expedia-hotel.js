import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CommandExecutionError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, waitFor} from './browser-utils.js';

export function expediaUrl(args) {
  validateHotelArgs(args);
  if(!/^\d+$/.test(args['city-id']||'')) throw new ArgumentError('Expedia requires a resolved numeric region id');
  if(Number(args.rooms)!==1) throw new ArgumentError('Multi-room Expedia searches have not been verified');
  const url=new URL('https://www.expedia.com/Hotel-Search');
  for(const [key,value] of Object.entries({destination:args.city,regionId:args['city-id'],startDate:args.checkin,endDate:args.checkout,
    d1:args.checkin,d2:args.checkout,adults:args.adults,rooms:args.rooms})) url.searchParams.set(key,String(value));
  return url.toString();
}

function readExpedia() {
  const root=document.querySelector('[data-stid="property-listing-results"]');
  const links=[...(root?.querySelectorAll('a[href*=".Hotel-Information"]')||[])];
  const adults=[...document.querySelectorAll('input[name^="EGDSSearchFormTravelersField-Adult-Room"]')];
  const children=[...document.querySelectorAll('input[id^="uitk-step-children-"]')];
  const value=prefix=>document.querySelector(`input[name^="${prefix}"]`)?.value || null;
  const currency=document.querySelector('[data-stid="button-type-picker-trigger"][data-context="global_navigation"]')?.innerText.match(/\b[A-Z]{3}\b/)?.[0]||null;
  return {host:location.hostname,path:location.pathname,regionId:new URL(location.href).searchParams.get('regionId'),currency,
    observedSearch:{check_in:value('EGDSDateRangePicker-StartDate'),check_out:value('EGDSDateRangePicker-EndDate'),
      adults:adults.length?adults.reduce((n,e)=>n+Number(e.value),0):null,rooms:adults.length||null,
      children:children.length?children.reduce((n,e)=>n+Number(e.value),0):null},
    queryEvidence:{city_text:value('EGDSSearchFormLocationField-Location'),currency_basis:'global_navigation currency picker',
      dates_text:document.querySelector('button[name="EGDSDateRange-date-selector-trigger"]')?.innerText||null},
    cards:links.map(link=>{
      let card=link.parentElement;
      while(card && card!==root && !(card.querySelector('h3') && /(?:current price is|price is) \$[\d,]+(?:\.\d+)? total/.test(card.innerText))) card=card.parentElement;
      if(!card||card===root) return null;
      const text=card.innerText;
      return {name:[...card.querySelectorAll('h3')].find(e=>!e.innerText.startsWith('Photo gallery'))?.innerText.trim(),
        hotelId:link.href.match(/\.h(\d+)\.Hotel-Information/)?.[1],url:link.href,
        total:text.match(/(?:current price is|price is) \$([\d,]+(?:\.\d+)?) total/)?.[1]||null,
        nightly:text.match(/\$([\d,]+(?:\.\d+)?) nightly/)?.[1]||null,
        taxesLabel:text.includes('Total with taxes and fees')?'Total with taxes and fees':null,
        policySummary:text.split('\n').filter(t=>/refundable|pay later|Reserve now|prepayment/i.test(t)).join(' / ')||null};
    }).filter(Boolean)};
}

export function mapExpedia(state,args) {
  if(state.host!=='www.expedia.com'||state.path!=='/Hotel-Search') throw new CommandExecutionError('Expedia redirected away from hotel search');
  if(!/^[A-Z]{3}$/.test(state.currency||'')) throw new CommandExecutionError('Displayed Expedia currency is unknown');
  // The amount parser above is dollar-specific, so never interpret another glyph/currency as USD.
  if(state.currency!=='USD') throw new CommandExecutionError('This Expedia amount extractor is validated for USD only');
  return state.cards.filter(c=>c.name&&c.total).slice(0,Number(args.limit)).map(card=>({...card,
    schema:'hotel-observation-v1',price:card.total.replaceAll(',',''),priceRaw:'$'+card.total+' total',currency:state.currency,
    displayedStayTotal:card.total.replaceAll(',',''),priceBasis:'listed_stay_total',priceLabel:'total',
    listedTaxesIncluded:card.taxesLabel?true:null,observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,
    conditionsVerified:state.regionId===args['city-id'],partyParameterSupported:true,collectionMethod:'rendered_search_cards',exhaustive:false}));
}

cli({site:'travel-price',name:'expedia-hotel',access:'read',description:'Expedia hotel totals with observed party, dates and currency',
  domain:'www.expedia.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>{
    await navigate(page,expediaUrl(args));
    const selector='[data-stid="property-listing-results"] a[href*=".Hotel-Information"]';
    await waitFor(page,selector);
    const rows=new Map();let state;
    for(let i=0;i<7;i++) {
      state=await page.evaluate('('+readExpedia.toString()+')()');
      for(const card of state.cards) if(card.hotelId) rows.set(card.hotelId,card);
      if(rows.size>=Number(args.limit))break;
      await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).item(document.querySelectorAll(${JSON.stringify(selector)}).length-1)?.scrollIntoView({block:'center'})`);
      await page.wait({time:0.7});
    }
    return mapExpedia({...state,cards:[...rows.values()]},args);
  }
});
